// Where a published sketch element gets its strokes. A proposal only names them. The board
// copies them here, from one of two places and from nowhere else:
//
// - the sketch as it is now, when the publish was made from the sketch ("basis": "sketch"),
//   which the board accepts only from a snapshot of the sketch as it is now; or
// - the same element on the current canvas, when the publish changes the canvas alone
//   ("basis": "canvas") and so keeps the strokes that canvas already holds.
//
// So sketch ink on the Agent canvas is always the person's own strokes, sample for sample: an
// agent cannot send pen geometry under the name of the sketch, and a publish made from the
// sketch never keeps a stroke the sketch no longer has. Each copy records the hash of the
// sketch it was taken from. What is about to be saved is checked exactly as a saved scene is
// read, so whatever is committed reads back after a restart.

import type { TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { cleaned_page_id, type CanvasRecord } from '../shared/canvas_types'
import {
  document_hash_pattern,
  ink_points_count_max,
  proposal_coordinate_units_max,
  proposal_shapes_count_max,
  scene_stroke_ids_count_max,
} from '../shared/constants'
import { ink_measure, strokes_equal } from '../shared/ink'
import { JsonReader, type Problem } from '../shared/json_reader'
import {
  ink_stroke_types,
  type InkStroke,
  type SceneElement,
  type SceneSketch,
} from '../shared/scene_types'
import { record_valid } from './canvas_records'
import { ink_record } from './scene_records'

type Json = Record<string, unknown>

// The sketch's records as they are now, asked for only when a scene copies from them.
export type SketchRecords = () => ReadonlyArray<CanvasRecord>

// Where the strokes of this publish come from. `held` is the scene of the current revision,
// or null when the canvas has none.
export type InkSource =
  | { kind: 'sketch'; records: SketchRecords; hash: string }
  | { kind: 'canvas'; held: readonly SceneElement[] | null }

const limit_message = `A canvas keeps at most ${ink_points_count_max} pen samples in all.`
const carry_message =
  'These strokes are not on the canvas as named. Publish with "basis": "sketch" from a new ' +
  'snapshot.'

// Rotation is in radians. A stroke turned by hand stays within a few turns.
const ink_rotation_max = 1000

// The elements with every sketch element holding its strokes, or the first reason one cannot.
export function ink_resolve(
  elements: readonly SceneElement[],
  source: InkSource,
): SceneElement[] | Problem {
  assert(elements.length <= proposal_shapes_count_max, 'a scene is bounded')

  if (!elements.some((element) => element.type === 'sketch')) return [...elements]

  const records = source.kind === 'sketch' ? records_by_id(source.records) : null
  const held = new Map<string, SceneSketch>()

  for (const element of (source.kind === 'canvas' ? source.held : null) ?? []) {
    if (element.type === 'sketch') held.set(element.id, element)
  }

  const resolved: SceneElement[] = []
  let points_count = ink_points_count(elements)

  for (const [index, element] of elements.entries()) {
    if (element.type !== 'sketch') {
      resolved.push(element)
      continue
    }

    const budget = ink_points_count_max - points_count
    const copied =
      records === null || source.kind !== 'sketch'
        ? ink_carry(element, held.get(element.id))
        : ink_copy(element, records, budget, source.hash)

    if ('message' in copied) {
      return { path: `elements[${index}]${copied.path}`, message: copied.message }
    }

    assert(copied.ink !== null, 'a resolved sketch element holds its strokes')
    points_count += ink_points_count([copied])
    resolved.push(copied)
  }

  assert(resolved.length === elements.length, 'every element is kept')
  return ink_saved_problem(resolved) ?? resolved
}

function records_by_id(sketch: SketchRecords): Map<string, Json> {
  const records = new Map<string, Json>()

  for (const record of sketch()) {
    if (record.typeName === 'shape') records.set(record.id, record as unknown as Json)
  }

  assert(records.size >= 0, 'a sketch may be empty')
  assert(
    [...records.keys()].every((id) => id.startsWith('shape:')),
    'only shapes are kept',
  )
  return records
}

// The strokes as they lie on the sketch now, copied so that later ink changes nothing here.
// Left unplaced, they stay where the person drew them.
function ink_copy(
  element: SceneSketch,
  records: ReadonlyMap<string, Json>,
  budget: number,
  hash: string,
): SceneSketch | Problem {
  assert(element.strokes.length > 0, 'a sketch element names its strokes')
  assert(document_hash_pattern.test(hash), 'the sketch hash is well formed')

  if (budget < 1) return { path: '', message: limit_message }

  const measured = ink_measure(element.strokes, records, budget)

  if ('index' in measured) {
    return { path: `.strokes[${measured.index}]`, message: measured.message }
  }

  assert(measured.points_count <= budget, 'the copy stays within the pen samples left')
  assert(measured.ink.length === element.strokes.length, 'one stroke for each id')
  return {
    ...element,
    x: element.x ?? measured.x,
    y: element.y ?? measured.y,
    w: measured.w,
    h: measured.h,
    source_hash: hash,
    ink: JSON.parse(JSON.stringify(measured.ink)) as InkStroke[],
  }
}

// The strokes the same element already holds on the canvas, moved if the proposal says so.
function ink_carry(element: SceneSketch, previous: SceneSketch | undefined): SceneSketch | Problem {
  assert(element.strokes.length > 0, 'a sketch element names its strokes')

  if (
    previous === undefined ||
    previous.ink === null ||
    !strokes_equal(previous.strokes, element.strokes)
  ) {
    return { path: '', message: carry_message }
  }

  assert(previous.ink.length === element.strokes.length, 'one stroke for each id')
  assert(previous.source_hash !== null, 'held strokes say where they came from')
  return {
    ...element,
    x: element.x ?? previous.x,
    y: element.y ?? previous.y,
    w: previous.w,
    h: previous.h,
    source_hash: previous.source_hash,
    ink: previous.ink,
  }
}

// Reads the strokes about to be saved exactly as a saved scene will be read.
function ink_saved_problem(elements: readonly SceneElement[]): Problem | null {
  const reader = new JsonReader()

  for (const [index, element] of elements.entries()) {
    if (element.type !== 'sketch') continue

    ink_strokes_read(reader, element.ink, `elements[${index}].ink`, element.strokes.length)
  }

  if (ink_points_count(elements) > ink_points_count_max) {
    reader.fail('proposal.elements', limit_message)
  }

  assert(reader.problem === null || reader.problem.message.endsWith('.'), 'a problem is said')
  return reader.problem
}

// The strokes a sketch element holds, one for each id it names, each a stroke tldraw can
// draw. The board checks the strokes it copies with this too, before it saves them.
export function ink_strokes_read(
  reader: JsonReader,
  value: unknown,
  path: string,
  count: number,
): InkStroke[] {
  assert(count >= 0 && count <= scene_stroke_ids_count_max, 'held strokes are bounded')

  if (!Array.isArray(value) || value.length !== count) {
    reader.fail(path, `Expected the ${count} strokes this element names.`)
    return []
  }

  const strokes = value.map((item, index) => ink_stroke_read(reader, item, `${path}[${index}]`))
  assert(strokes.length === count, 'every held stroke was read')
  return strokes
}

function ink_stroke_read(reader: JsonReader, value: unknown, path: string): InkStroke {
  const source = reader.object(value, path, ['type', 'x', 'y', 'rotation', 'opacity', 'props'])
  const type = reader.choice(source, 'type', path, ink_stroke_types, true)
  const offset_max = proposal_coordinate_units_max
  const x = reader.number(source, 'x', path, -offset_max, offset_max)
  const y = reader.number(source, 'y', path, -offset_max, offset_max)
  const rotation = reader.number(source, 'rotation', path, -ink_rotation_max, ink_rotation_max)
  const opacity = reader.number(source, 'opacity', path, 0, 1)
  const props = source.props

  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    reader.fail(`${path}.props`, 'Expected the props of a tldraw pen stroke.')
    return { type, x, y, rotation, opacity, props: {} }
  }

  const stroke: InkStroke = { type, x, y, rotation, opacity, props: props as Json }

  // tldraw's own schema decides what a pen stroke is: its samples, colour, size and the rest.
  if (reader.problem === null && !record_valid(probe_record(stroke), true)) {
    reader.fail(`${path}.props`, 'Expected the props of a tldraw pen stroke.')
  }

  assert(ink_stroke_types.includes(type), 'a held stroke is a pen stroke')
  assert(opacity >= 0 && opacity <= 1, 'a read opacity is a fraction')
  return stroke
}

// The stroke as the record it would be published as, for tldraw's schema to judge.
function probe_record(stroke: InkStroke): TLRecord {
  const placed = { id: 'probe', index: 'a0', parent_id: cleaned_page_id, x: 0, y: 0 }
  const meta = { sketch_stroke: 'shape:probe', sketch_hash: '0'.repeat(16) }
  assert(document_hash_pattern.test(meta.sketch_hash), 'a probe has a well-formed source')
  return ink_record(stroke, 0, placed, meta)
}

// How many pen samples these elements hold: the agent's own strokes, and the sketch strokes a
// sketch element holds. Zero for a sketch element whose strokes are only named.
export function ink_points_count(elements: readonly SceneElement[]): number {
  let count = 0

  for (const element of elements) {
    if (element.type === 'stroke') count += element.points.length

    if (element.type !== 'sketch' || element.ink === null) continue

    for (const stroke of element.ink) {
      const segments = Array.isArray(stroke.props.segments) ? stroke.props.segments : []

      for (const segment of segments as Array<Json | null>) {
        if (Array.isArray(segment?.points)) count += segment.points.length
      }
    }
  }

  assert(Number.isSafeInteger(count) && count >= 0, 'a count is a whole number')
  assert(elements.length <= proposal_shapes_count_max, 'elements are bounded')
  return count
}
