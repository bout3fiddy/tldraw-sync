// A short description of each sketch shape for an agent interpreting the sketch: its id, its
// type and its page bounds, without every pen sample. The agent cites these ids as the source of
// what it recognised, and reads the full records only when it needs a closer look.

import { assert } from '../shared/assert'
import { stroke_summaries_count_max } from '../shared/constants'

export type StrokeSummary = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  points_count: number
}

export type StrokeSummaries = { strokes: StrokeSummary[]; truncated: boolean }

type Json = Record<string, unknown>

// Records are the board's own, but are read defensively: a shape without readable geometry is
// summarised by its position alone rather than dropped.
export function strokes_summarize(records: ReadonlyArray<Json>): StrokeSummaries {
  const shapes = records.filter((record) => record.typeName === 'shape')
  const kept = shapes.slice(0, stroke_summaries_count_max)
  const strokes = kept.map(stroke_summarize)
  assert(strokes.length <= stroke_summaries_count_max, 'summaries are bounded')
  assert(strokes.length === Math.min(shapes.length, stroke_summaries_count_max), 'none dropped')
  return { strokes, truncated: shapes.length > kept.length }
}

function stroke_summarize(record: Json): StrokeSummary {
  const x = number_or(record.x, 0)
  const y = number_or(record.y, 0)
  const props = (record.props ?? {}) as Json
  const scale = number_or(props.scale, 1)
  const points = points_read(props)
  const id = String(record.id)
  const type = String(record.type)

  if (points.length > 0) {

    // A loop, not a spread: a long stroke has more points than a call can take arguments.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]

    for (const point of points) {
      x0 = Math.min(x0, point.x * scale)
      y0 = Math.min(y0, point.y * scale)
      x1 = Math.max(x1, point.x * scale)
      y1 = Math.max(y1, point.y * scale)
    }

    const bounds = { x: x + x0, y: y + y0, w: x1 - x0, h: y1 - y0 }
    assert(bounds.w >= 0 && bounds.h >= 0, 'stroke bounds have a size')
    return { id, type, ...rounded(bounds), points_count: points.length }
  }

  const w = number_or(props.w, 0) * scale
  const h = (number_or(props.h, 0) + number_or(props.growY, 0)) * scale
  assert(Number.isFinite(w) && Number.isFinite(h), 'a shape size is finite')
  return { id, type, ...rounded({ x, y, w, h }), points_count: 0 }
}

// Pen samples of draw and highlight shapes: segments of points.
function points_read(props: Json): Array<{ x: number; y: number }> {
  const segments = Array.isArray(props.segments) ? (props.segments as unknown[]) : []
  const points: Array<{ x: number; y: number }> = []

  for (const segment of segments) {
    const list = (segment as Json | null)?.points

    if (!Array.isArray(list)) continue

    for (const point of list as Json[]) {
      const px = number_or(point?.x, NaN)
      const py = number_or(point?.y, NaN)

      if (Number.isFinite(px) && Number.isFinite(py)) points.push({ x: px, y: py })
    }
  }

  assert(
    points.every((point) => Number.isFinite(point.x)),
    'points are finite',
  )
  return points
}

function number_or(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function rounded(box: { x: number; y: number; w: number; h: number }) {
  assert(Number.isFinite(box.x) && Number.isFinite(box.y), 'a box has a position')
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }
}
