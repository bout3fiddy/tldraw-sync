// Measures the pen strokes a scene keeps from the sketch. The board measures them when it
// copies them, to know the box they fill. Nothing here changes a stroke: its pen samples,
// colour and weight are carried as they are. Only where each stroke sits, relative to the
// corner of that box, is worked out, so the strokes named together keep their shape, their
// size and their place among each other.

import { assert } from './assert'
import { ink_stroke_types, type InkStroke, type InkStrokeType } from './scene_types'

type Json = Record<string, unknown>

// `x` and `y` are the top left corner of the box on the page, where the strokes lie now.
export type InkMeasured = {
  x: number
  y: number
  w: number
  h: number
  ink: InkStroke[]
  points_count: number
}

// Which stroke cannot be kept, by its place in the list, and why.
export type InkProblem = { index: number; message: string }

type Extent = { x0: number; y0: number; x1: number; y1: number }
type Stroke = Omit<InkStroke, 'props'> & { props: Json; reach: number }

// How far the drawn line reaches past its pen samples, in page units before the stroke's own
// scale: tldraw's pen and highlighter widths for each of its sizes, rounded up.
const reach_units: Record<InkStrokeType, Record<string, number>> = {
  draw: { s: 3, m: 4.5, l: 6, xl: 11 },
  highlight: { s: 11, m: 14, l: 21, xl: 25 },
}
const reach_units_max = 25

// The box around these strokes of the sketch, and each stroke placed inside it. `records` are
// the sketch's shapes by id. At most `points_count_max` pen samples are read.
export function ink_measure(
  ids: readonly string[],
  records: ReadonlyMap<string, Json>,
  points_count_max: number,
): InkMeasured | InkProblem {
  assert(ids.length > 0, 'at least one stroke is measured')
  assert(points_count_max > 0, 'some pen samples may be kept')
  const extent: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const strokes: Stroke[] = []
  let points_count = 0

  for (const [index, id] of ids.entries()) {
    const stroke = stroke_read(records.get(id))

    if (typeof stroke === 'string') return { index, message: stroke }

    points_count += stroke_extend(extent, stroke)

    if (points_count > points_count_max) {
      return { index, message: 'These strokes hold more pen samples than one canvas keeps.' }
    }

    strokes.push(stroke)
  }

  assert(points_count <= points_count_max, 'reading stopped at the limit')
  assert(extent.x0 <= extent.x1 && extent.y0 <= extent.y1, 'the box holds every stroke')
  const left = Math.floor(extent.x0)
  const top = Math.floor(extent.y0)
  const ink = strokes.map(({ reach: _, ...stroke }) => ({
    ...stroke,
    x: stroke.x - left,
    y: stroke.y - top,
  }))
  assert(Number.isFinite(left) && Number.isFinite(top), 'measured strokes have a corner')
  assert(ink.length === ids.length, 'every stroke is placed')
  return {
    x: left,
    y: top,
    w: Math.max(1, Math.ceil(extent.x1) - left),
    h: Math.max(1, Math.ceil(extent.y1) - top),
    ink,
    points_count,
  }
}

// A sketch record as a stroke that can be kept, or the reason it cannot be. Only a pen or
// highlighter stroke lying directly on the page is kept: its position is then its page position.
function stroke_read(record: Json | undefined): Stroke | string {
  if (record === undefined) return 'This stroke is not on the sketch.'

  const type = ink_stroke_types.find((candidate) => candidate === record.type)

  if (record.typeName !== 'shape' || type === undefined) {
    return 'Only pen and highlighter strokes can be copied from the sketch.'
  }

  if (typeof record.parentId !== 'string' || !record.parentId.startsWith('page:')) {
    return 'This stroke is inside another shape, not on the page.'
  }

  const props = record.props

  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return 'This stroke has no pen samples.'
  }

  const size = reach_units[type][String((props as Json).size)] ?? reach_units_max
  const scale = Math.abs(number_or((props as Json).scale, 1))
  assert(size > 0 && size <= reach_units_max, 'a pen width is known and bounded')
  assert(Number.isFinite(scale), 'a stroke scale is a number')
  return {
    type,
    x: number_or(record.x, 0),
    y: number_or(record.y, 0),
    rotation: number_or(record.rotation, 0),
    opacity: Math.min(1, Math.max(0, number_or(record.opacity, 1))),
    props: props as Json,
    reach: size * scale,
  }
}

// Widens `extent` to hold the stroke's pen samples on the page, with room for the width of its
// line, and returns how many samples it has. A stroke turns about its own origin, as in tldraw.
function stroke_extend(extent: Extent, stroke: Stroke): number {
  const cos = Math.cos(stroke.rotation)
  const sin = Math.sin(stroke.rotation)
  const segments = Array.isArray(stroke.props.segments) ? (stroke.props.segments as unknown[]) : []
  let points_count = 0
  const point_add = (x: number, y: number): void => {
    const page_x = stroke.x + x * cos - y * sin
    const page_y = stroke.y + x * sin + y * cos
    extent.x0 = Math.min(extent.x0, page_x - stroke.reach)
    extent.y0 = Math.min(extent.y0, page_y - stroke.reach)
    extent.x1 = Math.max(extent.x1, page_x + stroke.reach)
    extent.y1 = Math.max(extent.y1, page_y + stroke.reach)
  }

  for (const segment of segments) {
    const points = (segment as Json | null)?.points

    if (!Array.isArray(points)) continue

    for (const point of points as Array<Json | null>) {
      point_add(number_or(point?.x, 0), number_or(point?.y, 0))
      points_count += 1
    }
  }

  // A stroke without samples is still a mark where the pen touched down.
  if (points_count === 0) point_add(0, 0)

  assert(extent.x0 <= extent.x1 && extent.y0 <= extent.y1, 'an extent holds its stroke')
  assert(points_count >= 0, 'a count is never negative')
  return points_count
}

function number_or(value: unknown, fallback: number): number {
  assert(Number.isFinite(fallback), 'a fallback is a number')
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Whether two lists of stroke ids are the same strokes in the same order.
export function strokes_equal(a: readonly string[], b: readonly string[]): boolean {
  assert(a.length >= 0 && b.length >= 0, 'lists have lengths')
  return a.length === b.length && a.every((id, index) => id === b[index])
}
