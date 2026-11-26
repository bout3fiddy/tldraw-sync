// Drawings and the empty canvas through the production board, on an injected disk and clock.
//
// The cleanup that escaped had one way to show a sketch: typeset shapes. A landscape drawn
// beside a small diagram came back as scattered boxes and ovals, and a note the agent had
// added earlier stayed on the canvas after the sketch it was about had gone. These tests hold
// the repaired path to what a person sees: a drawing is their own strokes, sample for sample
// and each in its place; a new reading of the sketch holds only what the sketch shows now; a
// sketch with nothing on it gives an empty canvas; and the sketch itself is never touched.

import { expect, test } from 'bun:test'
import { createTLSchema, type TLRecord } from '@tldraw/tlschema'
import { diagram_compose } from '../cli/diagram_compose'
import { diagram_format, type DiagramNode } from '../shared/cleanup_types'
import { ink_points_count_max } from '../shared/constants'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { ink_measure } from '../shared/ink'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import { sketch_disk, sketch_save, sketch_square, sketch_stroke } from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Board, StorageError } from './board'
import { envelope_decode, envelope_encode } from './storage'

type Json = Record<string, unknown>
type Size = { w: number; h: number }
type Drawn = { id: string; type: string; x: number; y: number; props: Json }

const schema = createTLSchema()

// A small diagram on the left, drawn as two pen outlines, and a landscape on the right: a red
// sun, a hill, and a house of two strokes.
const api = sketch_stroke('shape:api', 20, 40, [[0, 0], [90, 0], [90, 50], [0, 50], [0, 0]])
const db = sketch_stroke('shape:db', 20, 160, [[0, 0], [90, 0], [90, 50], [0, 50], [0, 0]])
const sun = sketch_stroke('shape:sun', 420, 20, [[0, 0], [30, 0], [30, 30], [0, 30]], 'red')
const hill = sketch_stroke('shape:hill', 300, 200, [[0, 0], [60, -40], [140, 0]], 'green')
const walls = sketch_stroke('shape:walls', 330, 120, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]])
const roof = sketch_stroke('shape:roof', 325, 120, [[0, 0], [25, -20], [50, 0]], 'blue')
const mixed = [api, db, sun, hill, walls, roof]
const scene_strokes = ['shape:sun', 'shape:hill', 'shape:walls', 'shape:roof']

const diagram_nodes = [
  { id: 'api', kind: 'box', label: 'API', at: [20, 40, 90, 50], strokes: ['shape:api'] },
  { id: 'db', kind: 'ellipse', label: 'Postgres', at: [20, 160, 90, 50] },
]
const diagram_edges = [{ id: 'writes', from: 'api', to: 'db', direction: 'forward' }]
const scene = { id: 'scene', kind: 'drawing', at: [300, 20, 150, 185], strokes: scene_strokes }
const note = {
  id: 'note',
  kind: 'box',
  label: 'Why two stores?',
  origin: 'agent',
  at: [150, 40, 120, 40],
}

function board_open(disk: SimulatedDisk): Board {
  return Board.open({ time: new VirtualTime(), disk })
}

function sketch_of(board: Board) {
  const { clock, hash } = board.document_state()
  return { clock, hash, shapes: JSON.stringify(board.shapes()) }
}

// Composes a diagram as the command line does: each drawing is sized from the sketch as it
// is, or, where `sizes` says so, from what the canvas already holds.
async function composed(
  board: Board,
  graph: { nodes: unknown[]; edges?: unknown[] },
  base_revision: number,
  sizes: ReadonlyMap<string, Size> = new Map(),
): Promise<Json> {
  const snapshot = board.document_state().hash
  const edges = graph.edges ?? []
  const input = { format: diagram_format, snapshot, base_revision, nodes: graph.nodes, edges }
  const parsed = diagram_proposal_parse(input)

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  const records = new Map(board.shapes().map((shape) => [shape.id, shape as unknown as Json]))
  const boxes = new Map(sizes)

  for (const node of parsed.proposal.diagram.nodes) {
    if (node.kind !== 'drawing' || boxes.has(node.id)) continue

    const measured = ink_measure(node.strokes, records, ink_points_count_max)

    if ('index' in measured) throw new Error(measured.message)

    boxes.set(node.id, { w: measured.w, h: measured.h })
  }

  const result = await diagram_compose(parsed.proposal, boxes)

  if (!result.ok) throw new Error(result.message)

  return JSON.parse(result.composed.text) as Json
}

function drawn(board: Board): Drawn[] {
  return board.cleaned_document().records as unknown as Drawn[]
}

function strokes_drawn(board: Board, drawing: string): Drawn[] {
  return drawn(board).filter((record) => record.id.startsWith(`shape:cleaned-${drawing}.`))
}

const shape_of = (proposal: Json, id: string) =>
  (proposal.shapes as Json[]).find((shape) => shape.id === id) as Json

test('a drawing is published as the person\'s own strokes, each in its place', async () => {
  const board = board_open(sketch_disk(mixed))
  const before = sketch_of(board)
  const graph = { nodes: [...diagram_nodes, scene], edges: diagram_edges }
  const proposal = await composed(board, graph, 0)

  // On its way to the board a drawing only names its strokes.
  expect(shape_of(proposal, 'scene')).toMatchObject({ kind: 'ink', strokes: scene_strokes })
  expect(shape_of(proposal, 'scene').ink).toBeNull()
  const result = board.cleaned_publish(proposal, 'canvas')
  expect(result).toEqual({ kind: 'published', revision: 1, shapes_count: 4, title: null })
  expect(sketch_of(board)).toEqual(before)

  // The diagram is typeset; the landscape is four native pen strokes and nothing else.
  const records = drawn(board)
  const kinds = records.map((record) => record.type).filter(Boolean).sort()
  expect(kinds).toEqual(['arrow', 'arrow', 'arrow', 'draw', 'draw', 'draw', 'draw', 'geo', 'geo'])
  const kept = strokes_drawn(board, 'scene')
  const ids = [0, 1, 2, 3].map((place) => `shape:cleaned-scene.${place}`)
  expect(kept.map((record) => record.id)).toEqual(ids)

  // Sample for sample, in the ink they were drawn in: nothing was redrawn or recoloured.
  const originals = [sun, hill, walls, roof] as unknown as Drawn[]
  expect(kept.map((record) => record.props)).toEqual(originals.map((stroke) => stroke.props))
  expect(kept.map((record) => record.props.color)).toEqual(['red', 'green', 'black', 'blue'])

  // One move carries the whole drawing: every stroke is as far from the others as it was.
  const offset = { x: kept[0]!.x - originals[0]!.x, y: kept[0]!.y - originals[0]!.y }

  for (const [index, record] of kept.entries()) {
    expect(record.x - originals[index]!.x).toBe(offset.x)
    expect(record.y - originals[index]!.y).toBe(offset.y)
  }

  for (const record of records as unknown as TLRecord[]) {
    const types = record.typeName === 'shape' ? schema.types.shape : schema.types.binding
    expect(() => types.validate(record)).not.toThrow()
  }

  board.destroy()
})

test('the strokes come from the sketch and from nowhere else', async () => {
  const disk = sketch_disk([...mixed, sketch_square('shape:square', 600)])
  const board = board_open(disk)
  const before = sketch_of(board)
  const saved = disk.read('cleaned.state')
  const refused = async (damage: (proposal: Json, shape: Json) => void) => {
    const proposal = await composed(board, { nodes: [...diagram_nodes, scene] }, 0)
    damage(proposal, shape_of(proposal, 'scene'))
    return board.cleaned_publish(proposal, 'canvas')
  }

  // Pen geometry an agent wrote itself is refused, even a true copy.
  const forged = await refused((_, shape) => {
    shape.ink = scene_strokes.map(() => ({ type: 'draw', x: 0, y: 0, rotation: 0, opacity: 1 }))
  })
  expect(forged).toMatchObject({ kind: 'invalid', path: 'shapes[2].ink' })

  // A stroke the sketch does not have, a shape that is not a stroke, a box of another size.
  const missing = await refused((proposal, shape) => {
    const strokes = [...scene_strokes.slice(0, 3), 'shape:erased']
    shape.strokes = strokes
    ;((proposal.diagram as Json).nodes as DiagramNode[])[2]!.strokes = strokes
  })
  expect(missing).toMatchObject({ kind: 'invalid', path: 'shapes[2].strokes[3]' })
  const typeset = await refused((proposal, shape) => {
    const strokes = [...scene_strokes.slice(0, 3), 'shape:square']
    shape.strokes = strokes
    ;((proposal.diagram as Json).nodes as DiagramNode[])[2]!.strokes = strokes
  })
  expect(typeset).toMatchObject({ kind: 'invalid', path: 'shapes[2].strokes[3]' })
  const resized = await refused((_, shape) => {
    shape.w = (shape.w as number) + 40
  })
  expect(resized).toMatchObject({ kind: 'invalid', path: 'shapes[2]' })

  // A drawing without its diagram node has nothing to say what it keeps.
  const bare = await refused((proposal) => {
    delete proposal.diagram
  })
  expect(bare.kind).toBe('invalid')

  expect(board.cleaned_status().revision).toBe(0)
  expect(disk.read('cleaned.state')).toEqual(saved)
  expect(sketch_of(board)).toEqual(before)
  board.destroy()
})

// The stale note on the escaped canvas: an Interpret rebuilt nothing, so what the agent had
// added stayed for good. A new reading now holds exactly what it is given, and the agent's own
// items stay only while a publish keeps them.
test('a new reading holds what the sketch shows now; an agent edit keeps the drawing', async () => {
  const disk = sketch_disk(mixed)
  let board = board_open(disk)
  const first = board.document_state().hash
  const graph = { nodes: [...diagram_nodes, scene, note], edges: diagram_edges }
  expect(board.cleaned_publish(await composed(board, graph, 0), 'canvas')).toMatchObject({
    kind: 'published',
    revision: 1,
  })
  const kept = strokes_drawn(board, 'scene')
  const box = board.sketch_snapshot(first, 'canvas')!.drawings_previous!
  expect(box).toHaveLength(1)
  expect(box[0]).toMatchObject({ id: 'scene', strokes: scene_strokes })
  board.destroy()

  // The person erases the house and draws on. The sketch has moved on.
  sketch_save(disk, [api, db, sun, hill, sketch_stroke('shape:bird', 380, 60, [[0, 0], [8, 4]])])
  board = board_open(disk)
  expect(board.document_state().hash).not.toBe(first)
  expect(board.cleaned_status().stale).toBe(true)

  // A Notify edit changes only the agent's note. The drawing keeps the strokes the canvas
  // holds, the erased house included: this canvas is still the earlier reading, and says so.
  const edited = { ...note, label: 'Why two stores? Asked again.' }
  const carried = new Map([['scene', { w: box[0]!.w, h: box[0]!.h }]])
  const notify = await composed(
    board,
    { nodes: [...diagram_nodes, scene, edited], edges: diagram_edges },
    1,
    carried,
  )
  expect(board.cleaned_publish(notify, 'canvas')).toMatchObject({ kind: 'published', revision: 2 })
  expect(strokes_drawn(board, 'scene').map((record) => record.props)).toEqual(
    kept.map((record) => record.props),
  )
  expect(board.cleaned_status()).toMatchObject({ stale: true, current: { source_hash: first } })

  // An Interpret reads the sketch anew. The old drawing names a stroke that is gone, so it
  // cannot be published as a new reading, whatever else changed.
  const stale = await composed(board, { nodes: [...diagram_nodes, scene] }, 2, carried)
  expect(board.cleaned_publish(stale, 'canvas')).toMatchObject({
    kind: 'invalid',
    path: 'shapes[2].strokes[2]',
  })
  expect(board.cleaned_status().revision).toBe(2)

  // The faithful reading: what the sketch shows now, and no note from before.
  const now = ['shape:sun', 'shape:hill', 'shape:bird']
  const fresh = { nodes: [...diagram_nodes, { ...scene, strokes: now }], edges: diagram_edges }
  expect(board.cleaned_publish(await composed(board, fresh, 2), 'canvas')).toMatchObject({
    kind: 'published',
    revision: 3,
    shapes_count: 4,
  })
  const records = drawn(board)
  expect(strokes_drawn(board, 'scene')).toHaveLength(3)
  expect(records.some((record) => record.id === 'shape:cleaned-note')).toBe(false)
  expect(JSON.stringify(records)).not.toContain('Why two stores?')
  expect(board.cleaned_status()).toMatchObject({ stale: false, revision: 3 })
  board.close()
})

test('an empty sketch gives an empty canvas: a revision that restores and restarts', async () => {
  const disk = sketch_disk(mixed)
  let board = board_open(disk)
  const graph = { nodes: [...diagram_nodes, scene, note], edges: diagram_edges }
  expect(board.cleaned_publish(await composed(board, graph, 0), 'canvas').kind).toBe('published')
  const full = drawn(board)
  board.destroy()

  // Everything is erased. An empty diagram made from the older sketch is still refused.
  const earlier = board_open(sketch_disk(mixed))
  const emptied = await composed(earlier, { nodes: [] }, 1)
  earlier.destroy()
  sketch_save(disk, [])
  board = board_open(disk)
  expect(board.cleaned_publish(emptied, 'canvas').kind).toBe('sketch_changed')
  const empty = await composed(board, { nodes: [] }, 1)
  expect(empty.shapes).toEqual([])
  expect(board.cleaned_publish(empty, 'canvas')).toEqual({
    kind: 'published',
    revision: 2,
    shapes_count: 0,
    title: null,
  })
  expect(board.cleaned_document()).toMatchObject({
    revision: 2,
    stale: false,
    records: [],
    current: { revision: 2, shapes_count: 0 },
  })
  const snapshot = board.sketch_snapshot(board.document_state().hash, 'canvas')!
  expect(snapshot.diagram_previous).toEqual({ flow: 'right', nodes: [], edges: [] })
  expect(snapshot.drawings_previous).toEqual([])
  board.close()

  // The empty canvas is saved like any revision, and the one before it can be brought back
  // with its strokes.
  board = board_open(disk)
  expect(board.cleaned_document()).toMatchObject({ revision: 2, records: [] })
  expect(board.cleaned_restore(2, 1)).toEqual({ kind: 'restored', revision: 3, restored_from: 1 })
  expect(drawn(board)).toEqual(full)
  board.close()
  board = board_open(disk)
  expect(drawn(board)).toEqual(full)
  board.destroy()
})

test('a canvas with nothing of the sketch on it can still be emptied and annotated', async () => {
  const board = board_open(sketch_disk(mixed))
  const only_note = await composed(board, { nodes: [note] }, 0)
  expect(board.cleaned_publish(only_note, 'canvas')).toMatchObject({ revision: 1 })
  expect(board.cleaned_publish(await composed(board, { nodes: [] }, 1), 'canvas')).toMatchObject({
    revision: 2,
    shapes_count: 0,
  })
  const again = await composed(board, { nodes: [note] }, 2)
  expect(board.cleaned_publish(again, 'canvas')).toMatchObject({ revision: 3, shapes_count: 1 })

  // The plain cleaned diagram takes a drawing too, always read from the sketch as it is.
  board.destroy()
  const plain = board_open(sketch_disk(mixed))
  const proposal = await composed(plain, { nodes: [scene] }, 0)
  expect(plain.cleaned_publish(proposal)).toMatchObject({ kind: 'published', shapes_count: 1 })
  expect(strokes_drawn(plain, 'scene')).toHaveLength(4)
  plain.destroy()
})

test('a crash while publishing a drawing keeps the canvas, now and after restart', async () => {
  const disk = sketch_disk(mixed)
  let board = board_open(disk)
  expect(board.cleaned_publish(await composed(board, { nodes: [scene] }, 0), 'canvas').kind).toBe(
    'published',
  )
  const before = drawn(board)
  const next = await composed(board, { nodes: [...diagram_nodes, scene] }, 1)
  disk.write_fault_armed = true
  expect(() => board.cleaned_publish(next, 'canvas')).toThrow(SimulatedCrash)
  expect(disk.write_fault_armed).toBe(false)
  expect(drawn(board)).toEqual(before)
  board.destroy()
  board = board_open(disk)
  expect(board.cleaned_status().revision).toBe(1)
  expect(drawn(board)).toEqual(before)
  board.destroy()
})

test('a canvas keeps a bounded number of pen samples, and says so', async () => {
  const samples = Array.from({ length: ink_points_count_max + 1 }, (_, n) => [n % 500, 0] as const)
  const long = sketch_stroke('shape:long', 0, 0, samples)
  const board = board_open(sketch_disk([long, sun]))
  const within = await composed(board, { nodes: [{ ...scene, strokes: ['shape:sun'] }] }, 0)
  const over = JSON.parse(JSON.stringify(within)) as Json
  shape_of(over, 'scene').strokes = ['shape:long']
  ;((over.diagram as Json).nodes as DiagramNode[])[0]!.strokes = ['shape:long']
  const result = board.cleaned_publish(over, 'canvas')
  expect(result).toMatchObject({ kind: 'invalid', path: 'shapes[0].strokes[0]' })
  expect(board.cleaned_status().revision).toBe(0)
  expect(board.cleaned_publish(within, 'canvas')).toMatchObject({ kind: 'published' })
  board.destroy()
})

// The saved strokes are untrusted like the rest of the file: a stroke tldraw could not draw
// stops the board, rather than reaching a page or being dropped without a word.
test('a saved drawing that is not pen strokes stops the board with a storage error', async () => {
  const disk = sketch_disk(mixed)
  const board = board_open(disk)
  expect(board.cleaned_publish(await composed(board, { nodes: [scene] }, 0), 'canvas').kind).toBe(
    'published',
  )
  board.close()
  const good = disk.read('cleaned.state')!
  const decoded = envelope_decode(good, 'cleaned')

  if (!decoded.ok) throw new Error(decoded.reason)

  const damages: Array<(shape: { strokes: string[]; ink: Json[] | null }) => void> = [
    (shape) => (shape.ink![0]!.props = { ...(shape.ink![0]!.props as Json), color: 'chartreuse' }),
    (shape) => (shape.ink![1]!.type = 'geo'),
    (shape) => (shape.ink![2]!.x = 'left'),
    (shape) => shape.ink!.pop(),
    (shape) => (shape.ink = null),
    (shape) => shape.strokes.push('not a stroke id'),
  ]

  for (const damage of damages) {
    const state = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
    damage(state.current.shapes[0])
    const payload = new TextEncoder().encode(JSON.stringify(state))
    disk.write_atomic('cleaned.state', envelope_encode({ kind: 'cleaned', label: '-', payload }))
    expect(() => board_open(disk)).toThrow(StorageError)
  }

  disk.write_atomic('cleaned.state', good)
  const reopened = board_open(disk)
  expect(strokes_drawn(reopened, 'scene')).toHaveLength(4)
  reopened.destroy()
})
