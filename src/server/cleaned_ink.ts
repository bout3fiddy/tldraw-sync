// Where a published drawing gets its strokes. A proposal only names them. The board copies them
// here, from one of two places and from nowhere else:
//
// - the sketch as it is now, when the publish reads the sketch anew. That is a source edit,
//   which the board accepts only from a snapshot of the sketch as it is now; or
// - the same drawing on the current canvas, when the publish changes only the agent's own
//   items and so leaves the reading of the sketch, drawings included, exactly as it was.
//
// So ink on the Agent canvas is always the person's own strokes, sample for sample: an agent
// cannot send pen geometry of its own, and a drawing never outlives a new reading of a sketch
// that no longer has its strokes. The box a drawing was laid out in must be the box of its
// strokes, measured here again. What is about to be saved is checked exactly as a saved version
// is read, so whatever is committed reads back after a restart.

import { assert } from '../shared/assert'
import { ink_points_count_max, proposal_shapes_count_max } from '../shared/constants'
import type { DrawingPrevious, ProposalShape } from '../shared/cleanup_types'
import { ink_measure, strokes_equal } from '../shared/ink'
import { JsonReader, type Problem } from '../shared/json_reader'
import { ink_points_count, ink_strokes_read } from './cleanup_proposal'

type InkShape = Extract<ProposalShape, { kind: 'ink' }>
type Json = Record<string, unknown>

// The sketch's records as they are now, asked for only when a drawing needs them.
export type SketchRecords = () => ReadonlyArray<{ id: string; typeName: string }>

const size_message = 'Its box is not the box of its strokes. Compose it from a new snapshot.'
const limit_message = `Drawings keep at most ${ink_points_count_max} pen samples in all.`

// The shapes with every drawing holding its strokes, or the first reason one cannot. `sketch`
// is null when the publish leaves the reading of the sketch as it was: drawings then keep the
// strokes they hold on the `current` canvas.
export function ink_resolve(
  shapes: readonly ProposalShape[],
  sketch: SketchRecords | null,
  current: readonly ProposalShape[],
): ProposalShape[] | Problem {
  assert(shapes.length <= proposal_shapes_count_max, 'a proposal is bounded')
  assert(current.length <= proposal_shapes_count_max, 'the current canvas is bounded')

  if (!shapes.some((shape) => shape.kind === 'ink')) return [...shapes]

  const records = sketch === null ? null : records_by_id(sketch)
  const held = new Map<string, InkShape>()

  for (const shape of current) {
    if (shape.kind === 'ink') held.set(shape.id, shape)
  }

  const resolved: ProposalShape[] = []
  let points_count = 0

  for (const [index, shape] of shapes.entries()) {
    if (shape.kind !== 'ink') {
      resolved.push(shape)
      continue
    }

    const budget = ink_points_count_max - points_count
    const drawing =
      records === null ? ink_carry(shape, held.get(shape.id)) : ink_copy(shape, records, budget)

    if ('message' in drawing) {
      return { path: `shapes[${index}]${drawing.path}`, message: drawing.message }
    }

    assert(drawing.ink !== null, 'a resolved drawing holds its strokes')
    points_count += ink_points_count([drawing])
    resolved.push(drawing)
  }

  assert(resolved.length === shapes.length, 'every shape is kept, drawings with their strokes')
  return ink_saved_problem(resolved) ?? resolved
}

function records_by_id(sketch: SketchRecords): Map<string, Json> {
  const records = new Map<string, Json>()

  for (const record of sketch()) {
    if (record.typeName === 'shape') records.set(record.id, record as Json)
  }

  assert(records.size >= 0, 'a sketch may be empty')
  assert([...records.keys()].every((id) => id.startsWith('shape:')), 'only shapes are kept')
  return records
}

// The strokes as they lie on the sketch now, copied so that later ink changes nothing here.
function ink_copy(
  shape: InkShape,
  records: ReadonlyMap<string, Json>,
  budget: number,
): InkShape | Problem {
  assert(shape.strokes.length > 0, 'a drawing names its strokes')

  if (budget < 1) return { path: '', message: limit_message }

  const measured = ink_measure(shape.strokes, records, budget)

  if ('index' in measured) {
    return { path: `.strokes[${measured.index}]`, message: measured.message }
  }

  if (measured.w !== shape.w || measured.h !== shape.h) return { path: '', message: size_message }

  assert(measured.points_count <= budget, 'the copy stays within the pen samples left')
  assert(measured.ink.length === shape.strokes.length, 'one stroke for each id')
  return { ...shape, ink: JSON.parse(JSON.stringify(measured.ink)) as InkShape['ink'] }
}

// The strokes the same drawing already holds on the canvas.
function ink_carry(shape: InkShape, previous: InkShape | undefined): InkShape | Problem {
  assert(shape.strokes.length > 0, 'a drawing names its strokes')

  if (
    previous === undefined ||
    previous.ink === null ||
    !strokes_equal(previous.strokes, shape.strokes)
  ) {
    return { path: '', message: 'This drawing is not on the canvas. Take a new snapshot.' }
  }

  if (previous.w !== shape.w || previous.h !== shape.h) return { path: '', message: size_message }

  assert(previous.ink.length === shape.strokes.length, 'one stroke for each id')
  return { ...shape, ink: previous.ink }
}

// Reads the strokes about to be saved exactly as a saved version will be read.
function ink_saved_problem(shapes: readonly ProposalShape[]): Problem | null {
  const reader = new JsonReader()

  for (const [index, shape] of shapes.entries()) {
    if (shape.kind !== 'ink') continue

    ink_strokes_read(reader, shape.ink, `shapes[${index}].ink`, shape.strokes.length)
  }

  if (ink_points_count(shapes) > ink_points_count_max) reader.fail('proposal.shapes', limit_message)

  assert(reader.problem === null || reader.problem.message.endsWith('.'), 'a problem is said')
  return reader.problem
}

// The drawings of a published version, for the command line to size them when they are
// carried over to the next publish.
export function drawings_list(shapes: readonly ProposalShape[]): DrawingPrevious[] {
  const drawings = shapes.flatMap((shape) =>
    shape.kind === 'ink' ? [{ id: shape.id, strokes: shape.strokes, w: shape.w, h: shape.h }] : [],
  )
  assert(drawings.length <= shapes.length, 'drawings are some of the shapes')
  assert(drawings.every((drawing) => drawing.w > 0 && drawing.h > 0), 'a drawing has a box')
  return drawings
}
