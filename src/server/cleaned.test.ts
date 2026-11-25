// The cleaned diagram through the production board, on an injected disk and clock: publishing,
// both kinds of conflict, a crash in the middle of a publish, restarts, damage, restores, and a
// seeded run of all of them checked against a model.

import { expect, test } from 'bun:test'
import { cleaned_history_count_max } from '../shared/constants'
import { Prng } from '../simulation/prng'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import {
  proposal_example,
  sketch_disk,
  sketch_save,
  sketch_square,
} from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Board, StorageError } from './board'
import { envelope_encode } from './storage'

function board_open(disk: SimulatedDisk): Board {
  return Board.open({ time: new VirtualTime(), disk })
}

function ink(board: Board) {
  const { clock, hash } = board.document_state()
  return { clock, hash, shapes: JSON.stringify(board.shapes()) }
}

test('a board saved before cleanup existed opens with nothing published', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const status = board.cleaned_status()
  expect(status).toMatchObject({ revision: 0, current: null, stale: false, history: [] })
  expect(board.cleaned_document().records).toEqual([])
  expect(disk.read('cleaned.state')).toBeNull()
  expect(board.shapes().map((shape) => shape.id)).toEqual(['shape:a'])
  board.destroy()
})

test('a publish replaces the cleaned diagram whole and leaves the ink untouched', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const before = ink(board)
  const result = board.cleaned_publish(proposal_example(before.hash, 0))
  expect(result).toEqual({ kind: 'published', revision: 1, shapes_count: 4, title: null })
  expect(ink(board)).toEqual(before)

  const document = board.cleaned_document()
  expect(document.revision).toBe(1)
  expect(document.stale).toBe(false)
  expect(document.current).toMatchObject({
    revision: 1,
    source_hash: before.hash,
    agent: 'test-agent',
    restored_from: null,
    shapes_count: 4,
  })
  expect(document.records.map((record) => record.id).sort()).toEqual([
    'binding:cleaned-writes-end',
    'binding:cleaned-writes-start',
    'shape:cleaned-api',
    'shape:cleaned-db',
    'shape:cleaned-title',
    'shape:cleaned-writes',
  ])
  board.destroy()
})

test('a proposal made from an older sketch is refused, and nothing changes', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const result = board.cleaned_publish(proposal_example('0000000000000000', 0))
  expect(result).toEqual({ kind: 'sketch_changed', sketch_hash: board.document_state().hash })
  expect(board.cleaned_status().revision).toBe(0)
  board.destroy()
})

test('two agents publishing from the same revision: the second is refused', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  expect(board.cleaned_publish(proposal_example(hash, 0, 'First')).kind).toBe('published')
  const second = board.cleaned_publish(proposal_example(hash, 0, 'Second'))
  expect(second).toEqual({ kind: 'revision_conflict', revision: 1 })
  const title = board.cleaned_document().records.find((r) => r.id === 'shape:cleaned-title')
  expect(JSON.stringify(title)).toContain('First')
  board.destroy()
})

test('an invalid proposal is refused before anything is written', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const proposal = proposal_example(board.document_state().hash, 0)
  proposal.shapes[3] = { ...proposal.shapes[3]!, to: 'missing' } as never
  const result = board.cleaned_publish(proposal)
  expect(result).toMatchObject({ kind: 'invalid', path: 'shapes[3].to' })
  expect(disk.read('cleaned.state')).toBeNull()
  board.destroy()
})

test('a crash in the middle of a publish keeps the previous diagram, now and after restart', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(proposal_example(hash, 0, 'Kept'))
  const kept = JSON.stringify(board.cleaned_document())

  disk.write_fault_armed = true
  expect(() => board.cleaned_publish(proposal_example(hash, 1, 'Lost'))).toThrow(SimulatedCrash)
  expect(JSON.stringify(board.cleaned_document())).toBe(kept)
  board.destroy()

  const restarted = board_open(disk)
  expect(restarted.cleaned_document().revision).toBe(1)
  expect(JSON.stringify(restarted.cleaned_document().records)).toContain('Kept')

  // The next publish continues from the revision that survived.
  const again = restarted.cleaned_publish(proposal_example(hash, 1, 'Next'))
  expect(again).toMatchObject({ kind: 'published', revision: 2 })
  restarted.destroy()
})

test('both canvases survive a restart, and the sketch changing makes the cleanup stale', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  board.cleaned_publish(proposal_example(board.document_state().hash, 0))
  const published = board.cleaned_document()
  board.close()

  const restarted = board_open(disk)
  expect(restarted.cleaned_document()).toEqual(published)
  restarted.close()

  // The ink changes while the cleaned diagram stays as it was published.
  sketch_save(disk, [sketch_square('shape:a', 0), sketch_square('shape:b', 40)])
  const changed = board_open(disk)
  const status = changed.cleaned_status()
  expect(status.stale).toBe(true)
  expect(status.current?.source_hash).toBe(published.current?.source_hash)
  expect(status.sketch_hash).not.toBe(published.sketch_hash)
  expect(changed.cleaned_document().records).toEqual(published.records)
  changed.destroy()
})

test('a damaged cleaned file stops the board rather than dropping the diagram', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  board.cleaned_publish(proposal_example(board.document_state().hash, 0))
  board.destroy()

  const saved = disk.read('cleaned.state') as Uint8Array
  const flipped = saved.slice()
  flipped[flipped.length - 3] = (flipped[flipped.length - 3] as number) ^ 1
  disk.write_atomic('cleaned.state', flipped)
  expect(() => board_open(disk)).toThrow(StorageError)

  // A file that checks out but holds an invalid diagram is refused the same way.
  const forged = JSON.stringify({
    format: 'tldraw-sync.cleaned.v1',
    revision: 1,
    history: [],
    current: {
      revision: 1,
      source_hash: '0123456789abcdef',
      agent: 'x',
      summary: '',
      published_at_ms: 0,
      restored_from: null,
      shapes: [{ kind: 'script', id: 'x' }],
    },
  })
  const payload = new TextEncoder().encode(forged)
  disk.write_atomic('cleaned.state', envelope_encode({ kind: 'cleaned', label: '-', payload }))
  expect(() => board_open(disk)).toThrow(StorageError)
})

function cleaned_forge(disk: SimulatedDisk, state: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(state))
  disk.write_atomic('cleaned.state', envelope_encode({ kind: 'cleaned', label: '-', payload }))
}

function version_forged(revision: unknown, overrides: Record<string, unknown> = {}) {
  return {
    revision,
    source_hash: '0123456789abcdef',
    agent: 'x',
    summary: '',
    published_at_ms: 0,
    restored_from: null,
    shapes: [{ kind: 'rectangle', id: 'a', x: 0, y: 0, w: 10, h: 10 }],
    ...overrides,
  }
}

function state_forged(revision: unknown, current: unknown, history: unknown) {
  return { format: 'tldraw-sync.cleaned.v1', revision, current, history }
}

// Each of these has a valid checksum and is valid JSON. What is wrong is the shape of the root,
// or a revision, current diagram and history that no publish or restore could have left.
const states_damaged: Array<[string, unknown]> = [
  ['root null', null],
  ['root list', []],
  ['root number', 5],
  ['root text', 'cleaned'],
  ['root without fields', {}],
  ['revision missing', { format: 'tldraw-sync.cleaned.v1', current: null, history: [] }],
  ['revision as text', state_forged('1', version_forged(1), [])],
  ['revision negative', state_forged(-1, null, [])],
  ['revision fractional', state_forged(1.5, version_forged(1.5), [])],
  ['nothing current at a later revision', state_forged(2, null, [])],
  ['nothing current but a history', state_forged(0, null, [version_forged(1)])],
  ['current missing', { format: 'tldraw-sync.cleaned.v1', revision: 0, history: [] }],
  ['current a list', state_forged(1, [], [])],
  ['current a number', state_forged(1, 1, [])],
  ['current at revision zero', state_forged(0, version_forged(0), [])],
  ['current behind the revision', state_forged(3, version_forged(2), [])],
  ['current ahead of the revision', state_forged(2, version_forged(3), [])],
  ['history missing', { format: 'tldraw-sync.cleaned.v1', revision: 0, current: null }],
  ['history an object', state_forged(1, version_forged(1), {})],
  ['history entry null', state_forged(2, version_forged(2), [null])],
  [
    'history over its bound',
    state_forged(
      cleaned_history_count_max + 2,
      version_forged(cleaned_history_count_max + 2),
      Array.from({ length: cleaned_history_count_max + 1 }, (_, index) =>
        version_forged(index + 1),
      ),
    ),
  ],
  [
    'history out of order',
    state_forged(3, version_forged(3), [version_forged(2), version_forged(1)]),
  ],
  [
    'history repeats a revision',
    state_forged(3, version_forged(3), [version_forged(1), version_forged(1)]),
  ],
  [
    'history reaches the current revision',
    state_forged(3, version_forged(3), [version_forged(1), version_forged(3)]),
  ],
  [
    'history newer than the current revision',
    state_forged(3, version_forged(3), [version_forged(4)]),
  ],
  ['restored from itself', state_forged(2, version_forged(2, { restored_from: 2 }), [])],
  ['restored from a later revision', state_forged(2, version_forged(2, { restored_from: 5 }), [])],
  ['restored from revision zero', state_forged(2, version_forged(2, { restored_from: 0 }), [])],
  ['restored from text', state_forged(2, version_forged(2, { restored_from: '1' }), [])],
  ['published at no time', state_forged(1, version_forged(1, { published_at_ms: 'now' }), [])],
  [
    'a version of an unknown format',
    state_forged(1, version_forged(1, { format: 'tldraw-sync.cleanup.v9' }), []),
  ],
  [
    'a legacy version carrying a diagram',
    state_forged(1, version_forged(1, { diagram: { nodes: [], edges: [] } }), []),
  ],
  [
    'a diagram that disagrees with its shapes',
    state_forged(
      1,
      version_forged(1, {
        format: 'tldraw-sync.cleanup.v2',
        diagram: { nodes: [{ id: 'b', kind: 'box', label: '' }], edges: [] },
      }),
      [],
    ),
  ],
]

for (const [name, state] of states_damaged) {
  test(`a checksummed cleaned file with ${name} stops the board with a storage error`, () => {
    const disk = sketch_disk([sketch_square('shape:a', 0)])
    cleaned_forge(disk, state)
    const saved = disk.read('cleaned.state')
    let thrown: unknown = null

    try {
      board_open(disk).destroy()
    } catch (error) {
      thrown = error
    }

    // A StorageError exactly: a TypeError or a failed assertion would be a crash, not a refusal.

    expect(thrown).toBeInstanceOf(StorageError)
    expect((thrown as Error).message).toContain('cleaned.state is damaged')

    // Nothing was overwritten, so the file is still there to be repaired.
    expect(disk.read('cleaned.state')).toEqual(saved)
  })
}

test('a forged cleaned file that is coherent opens, so each refusal is for its cause', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  cleaned_forge(
    disk,
    state_forged(3, version_forged(3, { restored_from: 1 }), [
      version_forged(1),
      version_forged(2),
    ]),
  )
  const board = board_open(disk)
  const status = board.cleaned_status()
  expect(status.revision).toBe(3)
  expect(status.current).toMatchObject({ revision: 3, restored_from: 1, shapes_count: 1 })
  expect(status.history.map((version) => version.revision)).toEqual([1, 2])
  expect(board.cleaned_restore(3, 2)).toMatchObject({ kind: 'restored', revision: 4 })
  board.destroy()

  // Nothing published is coherent too, and is where a first publish starts from.
  cleaned_forge(disk, state_forged(0, null, []))
  const empty = board_open(disk)
  expect(empty.cleaned_status()).toMatchObject({ revision: 0, current: null, history: [] })
  empty.destroy()
})

test('a restore brings back an earlier revision as a new one, guarded by the base revision', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  board.cleaned_publish(proposal_example(hash, 0, 'One'))
  board.cleaned_publish(proposal_example(hash, 1, 'Two'))

  expect(board.cleaned_restore(1, null)).toEqual({ kind: 'revision_conflict', revision: 2 })
  expect(board.cleaned_restore(2, 7)).toEqual({ kind: 'not_found' })
  expect(board.cleaned_status().revision).toBe(2)

  const before = ink(board)
  expect(board.cleaned_restore(2, null)).toEqual({
    kind: 'restored',
    revision: 3,
    restored_from: 1,
  })
  expect(ink(board)).toEqual(before)
  const document = board.cleaned_document()
  expect(document.current).toMatchObject({ revision: 3, restored_from: 1 })
  expect(JSON.stringify(document.records)).toContain('One')

  // Nothing was lost: the revision that was replaced can itself be restored.
  expect(document.history.map((version) => version.revision)).toEqual([1, 2])
  expect(board.cleaned_restore(3, 2)).toMatchObject({ kind: 'restored', revision: 4 })
  board.destroy()
})

test('history keeps only the most recent revisions', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  const publishes_count = cleaned_history_count_max + 5

  for (let revision = 0; revision < publishes_count; revision += 1) {
    board.cleaned_publish(proposal_example(hash, revision, `Title ${revision}`))
  }

  const { history, revision } = board.cleaned_status()
  expect(revision).toBe(publishes_count)
  expect(history).toHaveLength(cleaned_history_count_max)
  expect(history.at(-1)?.revision).toBe(publishes_count - 1)
  expect(board.cleaned_restore(revision, 1)).toEqual({ kind: 'not_found' })
  board.destroy()
})

// Random publishes, conflicts, invalid proposals, restores, sketch changes, crashes during a
// write, and restarts. After every step, the board agrees with a model of what was committed,
// and a board reopened from the disk agrees with both.
test('a seeded run of cleanup operations keeps every invariant', () => {
  const seed = Number(process.env.SEED ?? 3)
  const runs_count = process.env.SEED === undefined ? 20 : 1

  for (let run = 0; run < runs_count; run += 1) cleanup_run(seed + run)
})

function cleanup_run(seed: number): void {
  const prng = new Prng(seed)
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  let board = board_open(disk)
  let model = { revision: 0, history_count: 0, records: '[]' }
  const label = (step: number) => `seed ${seed} step ${step}`

  for (let step = 0; step < 60; step += 1) {
    const before = ink(board)
    const roll = prng.below(100)

    // Only a publish or a restore writes here, so only those meet an injected crash.
    const crash = roll < 70 && prng.chance(0.15)
    disk.write_fault_armed = crash
    let committed = false

    try {
      if (roll < 45) {
        const snapshot = prng.chance(0.8) ? before.hash : '0000000000000000'
        const base = prng.chance(0.8) ? model.revision : prng.below(model.revision + 2)
        const proposal = proposal_example(snapshot, base, `Step ${step}`)

        if (prng.chance(0.15)) proposal.shapes[1] = { ...proposal.shapes[1]!, w: -1 } as never

        committed = board.cleaned_publish(proposal).kind === 'published'
      } else if (roll < 70) {
        const base = prng.chance(0.8) ? model.revision : prng.below(model.revision + 2)
        committed = board.cleaned_restore(base, null).kind === 'restored'
      } else if (roll < 85) {
        board.destroy()
        sketch_save(disk, [sketch_square('shape:a', prng.below(100))])
        board = board_open(disk)
      } else {
        board.close()
        board = board_open(disk)
      }
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error

      expect(crash, label(step)).toBe(true)
    }

    disk.write_fault_armed = false

    if (roll < 70) expect(ink(board), label(step)).toEqual(before)

    if (committed) {
      model = {
        revision: model.revision + 1,
        history_count: Math.min(
          cleaned_history_count_max,
          model.history_count + (model.revision > 0 ? 1 : 0),
        ),
        records: JSON.stringify(board.cleaned_document().records),
      }
    }

    cleanup_check(board, model, label(step))
    const reopened = board_open(disk)
    expect(JSON.stringify(reopened.cleaned_document().records), label(step)).toBe(model.records)
    reopened.destroy()
  }

  board.destroy()
}

function cleanup_check(
  board: Board,
  model: { revision: number; history_count: number; records: string },
  label: string,
): void {
  const document = board.cleaned_document()
  expect(document.revision, label).toBe(model.revision)
  expect(document.history.length, label).toBe(model.history_count)
  expect(JSON.stringify(document.records), label).toBe(model.records)
  expect(document.stale, label).toBe(
    document.current !== null && document.current.source_hash !== board.document_state().hash,
  )
  const revisions = document.history.map((version) => version.revision)
  expect(revisions, label).toEqual([...revisions].sort((a, b) => a - b))
}
