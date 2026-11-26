// A drawing in a composed diagram: sized from the snapshot's sketch records, never scaled, and
// arranged among the typeset items as it lay in the sketch. The fixture is the sketch that
// escaped: one frame around a small diagram on the left and a landscape on the right.

import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diagram_format, type DiagramProposal, type ProposalShape } from '../shared/cleanup_types'
import { composition_check, sketch_graph } from '../shared/diagram_check'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { sketch_square, sketch_stroke } from '../simulation/test_sketch'
import { diagram_compose } from './diagram_compose'
import {
  canvas_previous,
  drawing_sizes,
  sketch_file_beside,
  sketch_file_name,
} from './diagram_ink'

const snapshot = '0123456789abcdef'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-ink-'))

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

const strokes = [
  sketch_stroke('shape:sun', 520, 60, [[0, 0], [30, 0], [30, 30], [0, 30]], 'red'),
  sketch_stroke('shape:hill', 400, 240, [[0, 0], [60, -40], [140, 0]], 'green'),
  sketch_stroke('shape:person', 470, 180, [[0, 0], [0, 30]]),
  sketch_stroke('shape:house', 430, 160, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]),
]
const scene_ids = strokes.map((stroke) => stroke.id as string)

// The frame, the diagram inside it on the left, and the landscape inside it on the right.
const mixed = {
  nodes: [
    { id: 'frame', kind: 'group', label: '', at: [20, 20, 560, 260] },
    { id: 'api', kind: 'box', label: 'API', parent: 'frame', at: [60, 60, 90, 50] },
    { id: 'blob', kind: 'box', label: 'blob', parent: 'frame', at: [60, 140, 90, 50] },
    { id: 'pg', kind: 'ellipse', label: 'Postgres', parent: 'frame', at: [60, 220, 90, 50] },
    { id: 'scene', kind: 'drawing', parent: 'frame', at: [400, 60, 160, 190], strokes: scene_ids },
  ],
  edges: [
    { id: 'api-blob', from: 'api', to: 'blob', direction: 'forward' },
    { id: 'api-pg', from: 'api', to: 'pg', direction: 'forward' },
  ],
}

function proposal_of(graph: { nodes: unknown[]; edges: unknown[] }): DiagramProposal {
  const header = { format: diagram_format, snapshot, base_revision: 0 }
  const parsed = diagram_proposal_parse({ ...header, ...graph })

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  return parsed.proposal
}

// A snapshot folder as cleanup-snapshot leaves it: the sketch records, and what the canvas held.
function sketch_file(name: string, content: Record<string, unknown>): string {
  const folder = path.join(directory, name)
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, sketch_file_name)
  fs.writeFileSync(file, JSON.stringify(content))
  return file
}

const records = [...strokes, sketch_square('shape:sq', 0)]
const sketch = sketch_file('mixed', { snapshot, records })

function sized(proposal: DiagramProposal, file = sketch, carry = false) {
  const result = drawing_sizes(proposal, file, carry)

  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)

  return result.sizes
}

type Box = { x: number; y: number; w: number; h: number }
const box_of = (shapes: readonly ProposalShape[], id: string) =>
  shapes.find((shape) => shape.id === id) as unknown as Box

test('the sketch file beside a diagram is where its snapshot put it', () => {
  expect(sketch_file_beside(path.join(directory, 'mixed', 'diagram.json'))).toBe(sketch)
  expect(path.isAbsolute(sketch_file_beside('diagram.json'))).toBe(true)
})

test('a drawing is as large as its strokes; a diagram without one reads no file', () => {
  // Sun, hill, person and house: 395.5 to 554.5 across and 55.5 to 244.5 down, pen included.
  expect(sized(proposal_of(mixed)).get('scene')).toEqual({ w: 160, h: 190 })
  const plain = proposal_of({ nodes: mixed.nodes.slice(0, 4), edges: mixed.edges })
  expect(sized(plain, path.join(directory, 'absent', sketch_file_name)).size).toBe(0)
})

test('the mixed sketch composes: diagram typeset, landscape left as drawn', async () => {
  const proposal = proposal_of(mixed)
  const result = await diagram_compose(proposal, sized(proposal))

  if (!result.ok) throw new Error(result.message)

  const { shapes } = result.composed
  expect(composition_check(proposal.diagram, shapes, 'draw')).toBeNull()
  const scene = shapes.find((shape) => shape.id === 'scene')
  expect(scene).toMatchObject({ kind: 'ink', w: 160, h: 190, strokes: scene_ids, ink: null })

  // The diagram keeps its column on the left; the landscape stays to its right, in the frame.
  const [frame, api, blob, pg, art] = ['frame', 'api', 'blob', 'pg', 'scene'].map((id) =>
    box_of(shapes, id),
  ) as [Box, Box, Box, Box, Box]
  expect(api.x).toBe(blob.x)
  expect(blob.x).toBe(pg.x)
  expect(api.y + api.h).toBeLessThan(blob.y)
  expect(blob.y + blob.h).toBeLessThan(pg.y)

  for (const item of [api, blob, pg]) expect(item.x + item.w).toBeLessThan(art.x)

  for (const item of [api, blob, pg, art]) {
    expect(item.x).toBeGreaterThan(frame.x)
    expect(item.y).toBeGreaterThan(frame.y)
    expect(item.x + item.w).toBeLessThan(frame.x + frame.w)
    expect(item.y + item.h).toBeLessThan(frame.y + frame.h)
  }

  // Typeset kinds for the diagram, and no shape standing in for any part of the picture.
  const kinds = shapes.map((shape) => `${shape.id}:${shape.kind}`).sort()
  expect(kinds).toEqual([
    'api-blob:arrow',
    'api-pg:arrow',
    'api:rectangle',
    'blob:rectangle',
    'frame:rectangle',
    'pg:ellipse',
    'scene:ink',
  ])
  expect(result.composed.route_conflicts_count).toBe(0)
})

test('a drawing alone composes at the origin, at its own size, in any layout', async () => {
  const alone = { id: 'scene', kind: 'drawing', strokes: scene_ids }

  for (const node of [alone, { ...alone, at: [400, 60, 160, 190] }]) {
    const proposal = proposal_of({ nodes: [node], edges: [] })
    const result = await diagram_compose(proposal, sized(proposal))

    if (!result.ok) throw new Error(result.message)

    expect(result.composed).toMatchObject({ width_units: 160, height_units: 190 })
    expect(result.composed.shapes).toEqual([
      { kind: 'ink', id: 'scene', x: 0, y: 0, w: 160, h: 190, strokes: scene_ids, ink: null },
    ])
  }

  // Without the box of its strokes a drawing cannot be laid out, and says so.
  const unsized = await diagram_compose(proposal_of({ nodes: [alone], edges: [] }))
  expect(unsized).toMatchObject({ ok: false })
})

// The board measures a drawing's strokes again and refuses a box of any other size, so no
// layout may round it: not the sketch's own arrangement, and not the layout engine's.
test('a drawing keeps its exact box in every layout, beside connected items', async () => {
  const odd = new Map([['art', { w: 41, h: 33 }], ['more', { w: 7, h: 113 }]])

  for (const flow of ['right', 'down']) {
    const proposal = proposal_of({
      flow,
      nodes: [
        { id: 'a', kind: 'box', label: 'A' },
        { id: 'art', kind: 'drawing', strokes: ['shape:sun'] },
        { id: 'group', kind: 'group', label: 'Inside' },
        { id: 'more', kind: 'drawing', strokes: ['shape:hill'], parent: 'group' },
        { id: 'b', kind: 'ellipse', label: 'B', parent: 'group' },
      ],
      edges: [
        { id: 'a-b', from: 'a', to: 'b', direction: 'forward', label: 'feeds' },
        { id: 'a-group', from: 'a', to: 'group', direction: 'both' },
      ],
    } as { nodes: unknown[]; edges: unknown[] })
    const result = await diagram_compose(proposal, odd)

    if (!result.ok) throw new Error(result.message)

    const { shapes } = result.composed
    expect(composition_check(proposal.diagram, shapes, 'draw')).toBeNull()
    expect(box_of(shapes, 'art')).toMatchObject({ w: 41, h: 33 })
    expect(box_of(shapes, 'more')).toMatchObject({ w: 7, h: 113 })
  }
})

test('a stroke that cannot be kept is named; the sketch file must be the snapshot\'s', () => {
  const with_strokes = (ids: string[]) =>
    proposal_of({ nodes: [{ id: 'scene', kind: 'drawing', strokes: ids }], edges: [] })
  expect(drawing_sizes(with_strokes(['shape:sun', 'shape:gone']), sketch, false)).toMatchObject({
    ok: false,
    path: 'diagram.nodes[0].strokes[1]',
  })
  expect(drawing_sizes(with_strokes(['shape:sq']), sketch, false)).toMatchObject({
    ok: false,
    path: 'diagram.nodes[0].strokes[0]',
  })

  const files = {
    absent: path.join(directory, 'nowhere', sketch_file_name),
    folder: directory,
    garbage: sketch_file('garbage', {}),
    other: sketch_file('other', { snapshot: 'f'.repeat(16), records: strokes }),
  }
  fs.writeFileSync(files.garbage, 'not json')

  for (const file of Object.values(files)) {
    const result = drawing_sizes(with_strokes(['shape:sun']), file, false)
    expect(result).toMatchObject({ ok: false, path: 'diagram.nodes' })

    if (!result.ok) expect(result.message.endsWith('.')).toBe(true)
  }
})

// A Notify edit after the sketch has moved on: the drawing is the one on the canvas, and its
// strokes may be gone from the sketch. Its box comes from what the snapshot says the canvas
// holds, but only while the diagram still reads the sketch exactly as the canvas does.
test('a carried drawing keeps the box the canvas holds, only for the same reading', () => {
  const scene = { id: 'scene', kind: 'drawing', strokes: ['shape:sun', 'shape:erased'] }
  const reading = proposal_of({ nodes: [scene], edges: [] })
  const held = canvas_previous(reading.diagram, [{ ...scene, w: 222, h: 111 }])
  expect(held.graph).toBe(sketch_graph(reading.diagram))
  const moved_on = sketch_file('moved', { snapshot, records: strokes, canvas_previous: held })

  // The same reading with a note of the agent's own: carried, at the box the canvas holds.
  const note = { id: 'note', kind: 'text', label: 'Nice sun', origin: 'agent' }
  const annotated = proposal_of({ nodes: [scene, note], edges: [] })
  expect(sized(annotated, moved_on, true).get('scene')).toEqual({ w: 222, h: 111 })

  // Not carried: a plain cleanup always reads the sketch, where one stroke is gone.
  expect(drawing_sizes(annotated, moved_on, false)).toMatchObject({
    ok: false,
    path: 'diagram.nodes[0].strokes[1]',
  })

  // Another reading of the sketch is measured from the sketch, whatever the canvas holds.
  const reread = proposal_of({
    nodes: [{ id: 'scene', kind: 'drawing', strokes: ['shape:sun'] }],
    edges: [],
  })
  expect(sized(reread, moved_on, true).get('scene')).toEqual({ w: 40, h: 40 })

  // A malformed note of what the canvas holds reads as nothing held.
  const damaged = { graph: held.graph, drawings: [{ id: 'scene', strokes: 'all', w: 1, h: 1 }] }
  const file = sketch_file('damaged', { snapshot, records: strokes, canvas_previous: damaged })
  expect(drawing_sizes(annotated, file, true)).toMatchObject({ ok: false })
})
