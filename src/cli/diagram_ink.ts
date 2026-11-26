// Sizes the drawings of a semantic diagram before it is laid out. A drawing keeps part of the
// sketch as the person's own pen strokes, at the size they were drawn, so its box is the box of
// those strokes. The strokes are read from the sketch records the snapshot saved beside the
// diagram (`sketch.json`); nothing is asked of the board and no stroke is changed.
//
// One case needs more than the sketch: a publish that changes only the agent's own items, on a
// board whose sketch has moved on since its last reading. Its drawings are the ones already on
// the canvas, and their strokes may be gone from the sketch. The snapshot therefore also saves
// what the canvas holds: the boxes of its drawings and the reading of the sketch they belong
// to. The board makes the same choice when it accepts the publish, and refuses a box that is
// not the box of the strokes it copies, so a wrong or edited file can only fail the publish.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'
import type { Diagram, DiagramProposal, DrawingPrevious } from '../shared/cleanup_types'
import { ink_points_count_max, sketch_file_size_bytes_max } from '../shared/constants'
import { sketch_graph } from '../shared/diagram_check'
import { ink_measure, strokes_equal } from '../shared/ink'
import type { Size } from './diagram_place'
import { file_read_bounded } from './proposal_reader'

type Json = Record<string, unknown>

// What the canvas held when the snapshot was taken, as the snapshot's sketch file records it.
export type CanvasPrevious = { graph: string; drawings: DrawingPrevious[] }

export type DrawingSizes =
  { ok: true; sizes: Map<string, Size> } | { ok: false; path: string; message: string }

type Sketch = { records: Map<string, Json>; canvas: CanvasPrevious | null }

export const sketch_file_name = 'sketch.json'

export function canvas_previous(
  diagram: Diagram | null,
  drawings: readonly DrawingPrevious[],
): CanvasPrevious {
  assert(diagram !== null || drawings.length === 0, 'drawings belong to a diagram')
  return { graph: sketch_graph(diagram), drawings: [...drawings] }
}

// The box of every drawing in the diagram, by node id. `sketch_file` is the snapshot's sketch
// records, read only when the diagram has a drawing. `carry` allows a drawing that is already
// on the canvas to keep its box when the diagram reads the sketch exactly as the canvas does.
export function drawing_sizes(
  proposal: DiagramProposal,
  sketch_file: string,
  carry: boolean,
): DrawingSizes {
  const nodes = proposal.diagram.nodes
  const sizes = new Map<string, Size>()

  if (!nodes.some((node) => node.kind === 'drawing')) return { ok: true, sizes }

  const sketch = sketch_read(sketch_file, proposal.snapshot)

  if (typeof sketch === 'string') return { ok: false, path: 'diagram.nodes', message: sketch }

  const same_reading = carry && sketch.canvas?.graph === sketch_graph(proposal.diagram)
  const carried = same_reading ? (sketch.canvas?.drawings ?? []) : []
  let points_count = 0

  for (const [index, node] of nodes.entries()) {
    if (node.kind !== 'drawing') continue

    const kept = carried.find(
      (drawing) => drawing.id === node.id && strokes_equal(drawing.strokes, node.strokes),
    )

    if (kept !== undefined) {
      sizes.set(node.id, { w: kept.w, h: kept.h })
      continue
    }

    const budget = Math.max(1, ink_points_count_max - points_count)
    const measured = ink_measure(node.strokes, sketch.records, budget)

    if ('index' in measured) {
      const where = `diagram.nodes[${index}].strokes[${measured.index}]`
      return { ok: false, path: where, message: measured.message }
    }

    points_count += measured.points_count
    sizes.set(node.id, { w: measured.w, h: measured.h })
  }

  assert(sizes.size > 0, 'every drawing was sized')
  return { ok: true, sizes }
}

// The sketch file beside a diagram file: where a snapshot puts both.
export function sketch_file_beside(diagram_file: string): string {
  assert(diagram_file.length > 0 && diagram_file !== '-', 'a diagram file is named')
  return path.join(path.dirname(path.resolve(diagram_file)), sketch_file_name)
}

// The snapshot's sketch records, or why they cannot be used. The file is the command line's
// own, written by the snapshot, but it is read as untrusted all the same.
function sketch_read(file: string, snapshot: string): Sketch | string {
  assert(path.isAbsolute(file), 'a sketch file is named by absolute path')
  const from = `Take a new snapshot and write the diagram beside its ${sketch_file_name}.`
  let size_bytes: number

  try {
    size_bytes = fs.statSync(file).size
  } catch {
    return `A drawing is sized from ${file}, which cannot be read. ${from}`
  }

  if (size_bytes > sketch_file_size_bytes_max) return `${file} is too large to read. ${from}`

  // Sized to the file, so reading a small sketch does not reserve the whole limit.
  const read = file_read_bounded(file, Math.max(1, size_bytes))

  if (read.kind !== 'read') return `A drawing is sized from ${file}, which cannot be read. ${from}`

  let json: unknown

  try {
    json = JSON.parse(new TextDecoder().decode(read.bytes))
  } catch {
    return `${file} is not valid JSON. ${from}`
  }

  const root = object_read(json)

  if (root === null || !Array.isArray(root.records)) return `${file} has no records. ${from}`

  if (root.snapshot !== snapshot) return `${file} is from another snapshot. ${from}`

  const records = new Map<string, Json>()

  for (const value of root.records as unknown[]) {
    const record = object_read(value)

    if (record !== null && record.typeName === 'shape' && typeof record.id === 'string') {
      records.set(record.id, record)
    }
  }

  return { records, canvas: canvas_read(root.canvas_previous) }
}

// What the snapshot said the canvas held. Anything malformed reads as nothing held, and every
// drawing is then sized from the sketch.
function canvas_read(value: unknown): CanvasPrevious | null {
  const canvas = object_read(value)

  if (canvas === null || typeof canvas.graph !== 'string' || !Array.isArray(canvas.drawings)) {
    return null
  }

  const drawings: DrawingPrevious[] = []

  for (const item of canvas.drawings as unknown[]) {
    const drawing = object_read(item)

    if (drawing === null) return null

    const { id, strokes, w, h } = drawing
    const sized = typeof w === 'number' && typeof h === 'number' && w >= 1 && h >= 1

    if (typeof id !== 'string' || !Array.isArray(strokes) || !sized) return null

    if (!Number.isFinite(w) || !Number.isFinite(h)) return null

    if (!strokes.every((stroke) => typeof stroke === 'string')) return null

    drawings.push({ id, strokes: strokes as string[], w: w as number, h: h as number })
  }

  return { graph: canvas.graph, drawings }
}

function object_read(value: unknown): Json | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  return value as Json
}
