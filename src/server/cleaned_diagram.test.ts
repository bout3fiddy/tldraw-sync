// Composed diagrams through the production board, on an injected disk and clock: a composed
// publish keeps its styling and its semantic source, the next snapshot offers that source back,
// and both survive restarts, restores, conflicts and a crash in the middle of a write. Layout
// itself happened earlier, in the composer: the board only checks and swaps.

import { expect, test } from 'bun:test'
import fixture from '../../tests/fixtures/nested_groups.diagram.json'
import { diagram_compose } from '../cli/diagram_compose'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { Prng } from '../simulation/prng'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import {
  proposal_example,
  sketch_disk,
  sketch_save,
  sketch_square,
} from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Board } from './board'
import { envelope_decode } from './storage'

const parsed = diagram_proposal_parse(fixture)

if (!parsed.ok) throw new Error(parsed.message)

const composition = await diagram_compose(parsed.proposal)

if (!composition.ok) throw new Error(composition.message)

const composed_text = composition.composed.text
const diagram = parsed.proposal.diagram

// The fixture composed once; each publish names its own snapshot and base revision.
function composed(snapshot: string, base_revision: number): Record<string, unknown> {
  return { ...JSON.parse(composed_text), snapshot, base_revision }
}

function board_open(disk: SimulatedDisk): Board {
  return Board.open({ time: new VirtualTime(), disk })
}

function ink(board: Board) {
  const { clock, hash } = board.document_state()
  return { clock, hash, shapes: JSON.stringify(board.shapes()) }
}

test('a composed diagram publishes with its styling, and the next snapshot offers it back', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const before = ink(board)
  expect(board.sketch_snapshot(before.hash)?.diagram_previous).toBeNull()

  const result = board.cleaned_publish(composed(before.hash, 0))
  expect(result).toEqual({ kind: 'published', revision: 1, shapes_count: 20, title: null })
  expect(ink(board)).toEqual(before)

  const records = board.cleaned_document().records as unknown as Array<{
    id: string
    props?: Record<string, unknown>
  }>
  const group = records.find((record) => record.id === 'shape:cleaned-environments')
  expect(group?.props).toMatchObject({ fill: 'none', verticalAlign: 'start', dash: 'draw' })
  expect(JSON.stringify(group?.props?.richText)).toContain('bold')
  expect(board.sketch_snapshot(before.hash)?.diagram_previous).toEqual(diagram)
  board.destroy()
})

type Record_ = { id: string; type?: string; props?: Record<string, unknown> }

// What tells the two looks apart in a revision's records: the faces and dashes its shapes use.
// Both are black ink, and neither adds a record beyond the diagram's own shapes and bindings.
function look(records: readonly Record_[]) {
  const shapes = records.filter((record) => record.id.startsWith('shape:'))
  return {
    fonts: [...new Set(shapes.map((record) => record.props?.font))].sort(),
    dashes: [...new Set(shapes.map((record) => record.props?.dash).filter(Boolean))].sort(),
    colours: [...new Set(shapes.map((record) => record.props?.color))].sort(),
    extra: shapes.filter((record) => !record.id.startsWith('shape:cleaned-')).map((r) => r.id),
  }
}

// The historical composer's colours: blue solid boxes and ovals inside grey groups.
const plain_look = {
  fonts: ['sans'],
  dashes: ['solid'],
  colours: ['black', 'blue', 'grey'],
  extra: [],
}
const markerboard_look = { fonts: ['draw'], dashes: ['draw'], colours: ['black'], extra: [] }

// The renderer's style belongs to each revision. A board saved before styles existed holds
// plain revisions whose saved bytes have no style; they render plain after a restart and after
// a restore, while a newly composed revision renders as a markerboard. No revision number or
// global switch decides it.
test('each revision keeps its own look through a restart and restores', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash

  // A plain composed revision, as published before styles existed: the same proposal format,
  // with a diagram, no style, and the colours the composer gave it then.
  const legacy = { ...composed(hash, 0) }
  delete legacy.style
  legacy.shapes = (legacy.shapes as Array<Record<string, unknown>>).map((shape) => {
    if (shape.kind === 'arrow' || shape.kind === 'text') return shape

    const group = diagram.nodes.some((node) => node.id === shape.id && node.kind === 'group')
    return group
      ? { ...shape, color: 'grey', fill: 'solid' }
      : { ...shape, color: 'blue', fill: 'solid' }
  })
  expect(board.cleaned_publish(legacy)).toMatchObject({ kind: 'published', revision: 1 })
  const saved_legacy = JSON.stringify(JSON.parse(state_text(disk)).current)
  expect(saved_legacy).not.toContain('"style"')
  expect(saved_legacy).toContain('"color":"blue"')
  expect(look(records_of(board))).toEqual(plain_look)
  const legacy_records = JSON.stringify(records_of(board))

  expect(board.cleaned_publish(composed(hash, 1))).toMatchObject({ kind: 'published' })
  const markerboard_records = JSON.stringify(records_of(board))
  expect(look(records_of(board))).toEqual(markerboard_look)

  // The legacy revision in history is saved byte for byte as it was.
  const state = JSON.parse(state_text(disk))
  expect(JSON.stringify(state.history[0])).toBe(saved_legacy)
  expect(state.current.style).toBe('markerboard')
  board.destroy()

  const restarted = board_open(disk)
  expect(JSON.stringify(records_of(restarted))).toBe(markerboard_records)
  expect(restarted.cleaned_restore(2, 1)).toMatchObject({ kind: 'restored', revision: 3 })
  expect(look(records_of(restarted))).toEqual(plain_look)
  expect(JSON.stringify(records_of(restarted))).toBe(legacy_records)
  expect(restarted.cleaned_restore(3, 2)).toMatchObject({ kind: 'restored', revision: 4 })
  expect(JSON.stringify(records_of(restarted))).toBe(markerboard_records)
  expect(restarted.sketch_snapshot(hash)?.diagram_previous).toEqual(diagram)
  restarted.destroy()
})

function records_of(board: Board): Record_[] {
  return board.cleaned_document().records as unknown as Record_[]
}

function state_text(disk: SimulatedDisk): string {
  const bytes = disk.read('cleaned.state')

  if (bytes === null) throw new Error('nothing saved')

  const decoded = envelope_decode(bytes, 'cleaned')

  if (!decoded.ok) throw new Error(decoded.reason)

  return new TextDecoder().decode(decoded.envelope.payload)
}

test('styling and the diagram survive a restart and come back with a restore', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(proposal_example(hash, 0, 'Legacy'))
  board.cleaned_publish(composed(hash, 1))
  const kept = JSON.stringify(board.cleaned_document())
  board.destroy()

  const restarted = board_open(disk)
  expect(JSON.stringify(restarted.cleaned_document())).toBe(kept)
  expect(restarted.sketch_snapshot(hash)?.diagram_previous).toEqual(diagram)

  // Restoring the legacy revision brings back its shapes and no diagram; restoring the
  // composed one brings back both, as they were published.
  expect(restarted.cleaned_restore(2, 1)).toMatchObject({ kind: 'restored', revision: 3 })
  expect(restarted.sketch_snapshot(hash)?.diagram_previous).toBeNull()
  expect(JSON.stringify(restarted.cleaned_document().records)).toContain('Legacy')
  expect(restarted.cleaned_restore(3, 2)).toMatchObject({ kind: 'restored', revision: 4 })
  expect(restarted.sketch_snapshot(hash)?.diagram_previous).toEqual(diagram)
  expect(JSON.stringify(restarted.cleaned_document().records)).toBe(
    JSON.stringify(JSON.parse(kept).records),
  )
  restarted.destroy()
})

test('a stale or conflicting composed publish is refused, and a crash keeps the previous', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  expect(board.cleaned_publish(composed('0000000000000000', 0))).toMatchObject({
    kind: 'sketch_changed',
  })
  board.cleaned_publish(composed(hash, 0))
  expect(board.cleaned_publish(composed(hash, 0))).toEqual({
    kind: 'revision_conflict',
    revision: 1,
  })
  const kept = JSON.stringify(board.cleaned_document())

  disk.write_fault_armed = true
  expect(() => board.cleaned_publish(proposal_example(hash, 1, 'Lost'))).toThrow(SimulatedCrash)
  disk.write_fault_armed = false
  expect(JSON.stringify(board.cleaned_document())).toBe(kept)
  board.destroy()

  const restarted = board_open(disk)
  expect(JSON.stringify(restarted.cleaned_document())).toBe(kept)
  expect(restarted.sketch_snapshot(hash)?.diagram_previous).toEqual(diagram)
  restarted.destroy()
})

test('a composed proposal whose shapes disagree with its diagram is refused unwritten', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const proposal = composed(board.document_state().hash, 0) as { shapes: Array<{ id: string }> }
  const prod = proposal.shapes.find((shape) => shape.id === 'prod') as unknown as { text: string }
  prod.text = 'Production'
  expect(board.cleaned_publish(proposal)).toMatchObject({
    kind: 'invalid',
    path: 'diagram.nodes[2]',
  })
  expect(disk.read('cleaned.state')).toBeNull()
  board.destroy()
})

// Malformed composed shapes after a good publish: each is refused as an ordinary invalid result,
// nothing is written, and the published diagram and the diagram offered back stay as they were.
test('a malformed composed publish leaves the published state untouched', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  expect(board.cleaned_publish(composed(hash, 0))).toMatchObject({ kind: 'published' })
  const kept_document = JSON.stringify(board.cleaned_document())
  const kept_disk = disk.read('cleaned.state')
  const tamperings: Array<[string, (shape: Record<string, unknown>) => void, string]> = [
    ['review', (shape) => (shape.h = 30), 'diagram.nodes[7]'],
    ['review', (shape) => (shape.w = 20), 'diagram.nodes[7]'],
    ['prod', (shape) => (shape.size = 'xl'), 'diagram.nodes[2]'],
    ['alerts', (shape) => (shape.text = 'Alarms'), 'diagram.nodes[5]'],
  ]

  for (const [id, tamper, path] of tamperings) {
    const proposal = composed(hash, 1) as { shapes: Array<Record<string, unknown>> }
    tamper(proposal.shapes.find((shape) => shape.id === id) as Record<string, unknown>)
    expect(board.cleaned_publish(proposal), `${id} ${path}`).toMatchObject({
      kind: 'invalid',
      path,
    })
    expect(JSON.stringify(board.cleaned_document())).toBe(kept_document)
    expect(disk.read('cleaned.state')).toEqual(kept_disk)
    expect(board.sketch_snapshot(hash)?.diagram_previous).toEqual(diagram)
  }

  board.destroy()
})

// Mixed legacy and composed publishes, restores, sketch changes and restarts. After each step
// the diagram a snapshot offers is the one behind the current revision, here and after reopening.
test('a seeded run keeps the offered diagram with its revision', () => {
  const seed = Number(process.env.SEED ?? 9)
  const prng = new Prng(seed)
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  let board = board_open(disk)
  let revision = 0
  const diagrams: Array<boolean> = [false]

  for (let step = 0; step < 40; step += 1) {
    const hash = board.document_state().hash
    const roll = prng.below(100)
    const label = `seed ${seed} step ${step}`

    if (roll < 50) {
      const rich = prng.chance(0.5)
      const proposal = rich ? composed(hash, revision) : proposal_example(hash, revision)

      if (board.cleaned_publish(proposal).kind === 'published') {
        revision += 1
        diagrams[revision] = rich
      }
    } else if (roll < 75) {
      const result = board.cleaned_restore(revision, null)

      if (result.kind === 'restored') {
        revision += 1
        diagrams[revision] = diagrams[result.restored_from] as boolean
      }
    } else if (roll < 85) {
      board.destroy()
      sketch_save(disk, [sketch_square('shape:a', prng.below(100))])
      board = board_open(disk)
    } else {
      board.close()
      board = board_open(disk)
    }

    const now_hash = board.document_state().hash
    const offered = board.sketch_snapshot(now_hash)?.diagram_previous ?? null
    expect(offered === null ? false : true, label).toBe(diagrams[revision] as boolean)

    if (offered !== null) expect(offered, label).toEqual(diagram)

    const reopened = board_open(disk)
    expect(reopened.sketch_snapshot(now_hash)?.diagram_previous ?? null, label).toEqual(offered)
    reopened.destroy()
  }

  board.destroy()
})
