// Native tldraw records for a valid scene: what a publish saves, what a preview renders and
// what every page shows. One function makes all three, so a draft is rendered exactly as it
// would be published.
//
// Each element becomes one shape where the agent put it. An arrow also gets a binding for each
// end that lies on another element, and a sketch element becomes one pen stroke for each
// stroke the board copied, each marked with the sketch stroke it came from. A scene gives page
// positions throughout; tldraw places a grouped shape relative to its group, so that is worked
// out here. Every record is checked against tldraw's own schema: a failure is a bug here.

import { toRichText, type TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { cleaned_page_id } from '../shared/canvas_types'
import { proposal_shapes_count_max, scene_depth_max } from '../shared/constants'
import type {
  InkStroke,
  SceneArrow,
  SceneElement,
  SceneEnd,
  SceneGeoShape,
  ScenePath,
  ScenePoint,
  SceneSketch,
  SceneStroke,
  SceneText,
} from '../shared/scene_types'
import { canvas_records_problem, index_key, index_key_within, record_valid } from './canvas_records'

type Placed = { id: string; index: string; parent_id: string; x: number; y: number }
type Origins = ReadonlyMap<string, ScenePoint>

const element_id_pattern = /^[A-Za-z0-9_-]{1,40}$/
const page_origin: ScenePoint = { x: 0, y: 0 }

export function scene_shape_id(id: string): string {
  assert(element_id_pattern.test(id), 'an element id is well formed')
  const shape_id = `shape:scene-${id}`
  assert(shape_id.length <= 64, 'a scene shape id is short')
  return shape_id
}

export function scene_records(elements: readonly SceneElement[]): TLRecord[] {
  assert(elements.length <= proposal_shapes_count_max, 'a scene is bounded')
  const by_id = new Map(elements.map((element) => [element.id, element]))
  assert(by_id.size === elements.length, 'a valid scene has unique ids')
  const origins = origins_place(elements, by_id)
  const records: TLRecord[] = []

  for (const [index, element] of elements.entries()) {
    const origin = origins.get(element.id)
    const parent = element.parent === null ? page_origin : origins.get(element.parent)
    assert(origin !== undefined && parent !== undefined, 'every element has a place')
    const placed: Placed = {
      id: element.id,
      index: index_key(index),
      parent_id: element.parent === null ? cleaned_page_id : scene_shape_id(element.parent),
      x: origin.x - parent.x,
      y: origin.y - parent.y,
    }
    element_records(element, placed, by_id, records)
  }

  for (const record of records) assert(record_valid(record), `record ${record.id} is valid`)

  assert(canvas_records_problem(records) === null, 'a scene makes a canvas this board serves')
  return records
}

function element_records(
  element: SceneElement,
  placed: Placed,
  by_id: ReadonlyMap<string, SceneElement>,
  records: TLRecord[],
): void {
  const { rotation, opacity } = element

  if (element.type === 'sketch') {
    for (const record of ink_records(element, placed)) records.push(record)

    return
  }

  const base = { ...record_base(placed), rotation, opacity }

  if (element.type === 'group') {
    records.push({ ...base, type: 'group', props: {} } as unknown as TLRecord)
    return
  }

  if (element.type === 'arrow') {
    const from = end_point(element.from, by_id)
    const to = end_point(element.to, by_id)
    const end = { x: to.x - from.x, y: to.y - from.y }
    const props = arrow_props(element, end)
    records.push({ ...base, type: 'arrow', props } as unknown as TLRecord)

    for (const terminal of ['start', 'end'] as const) {
      const bound = terminal === 'start' ? element.from : element.to

      if (bound.kind === 'element') records.push(binding_record(element.id, terminal, bound))
    }

    return
  }

  const [type, props] = shape_props(element)
  assert(typeof type === 'string' && typeof props === 'object', 'every element has a shape')
  records.push({ ...base, type, props } as unknown as TLRecord)
}

// Where each element's own origin is on the page. A leaf says so itself; a group begins at
// the left and top of what it holds, so groups are placed from the innermost outward.
function origins_place(
  elements: readonly SceneElement[],
  by_id: ReadonlyMap<string, SceneElement>,
): Origins {
  const origins = new Map<string, ScenePoint>()
  const depths = new Map<string, number>()

  for (const element of elements) {
    depths.set(element.id, depth_of(element, by_id))

    if (element.type !== 'group') origins.set(element.id, leaf_origin(element, by_id))
  }

  for (let depth = scene_depth_max; depth >= 0; depth -= 1) {
    for (const group of elements) {
      if (group.type !== 'group' || depths.get(group.id) !== depth) continue

      let [x, y] = [Infinity, Infinity]

      for (const child of elements) {
        const origin = child.parent === group.id ? origins.get(child.id) : undefined

        if (origin === undefined) continue

        x = Math.min(x, origin.x)
        y = Math.min(y, origin.y)
      }

      assert(Number.isFinite(x) && Number.isFinite(y), 'a valid group holds placed elements')
      origins.set(group.id, { x, y })
    }
  }

  assert(origins.size === elements.length, 'every element was placed')
  return origins
}

// How many groups an element is inside. A valid scene nests within the limit.
function depth_of(element: SceneElement, by_id: ReadonlyMap<string, SceneElement>): number {
  let depth = 0
  let parent = element.parent

  while (parent !== null && depth <= scene_depth_max) {
    const group = by_id.get(parent)
    assert(group !== undefined && group.type === 'group', 'a valid parent is a group')
    parent = group.parent
    depth += 1
  }

  assert(depth <= scene_depth_max, 'a valid scene nests within the limit')
  return depth
}

function leaf_origin(
  element: Exclude<SceneElement, { type: 'group' }>,
  by_id: ReadonlyMap<string, SceneElement>,
): ScenePoint {
  if (element.type === 'path' || element.type === 'stroke') {
    const first = element.points[0]
    assert(first !== undefined, 'a valid path or stroke has a first point')
    return first
  }

  if (element.type === 'arrow') return end_point(element.from, by_id)

  assert(element.x !== null && element.y !== null, 'a published element has its position')
  return { x: element.x, y: element.y }
}

// Where an arrow's end is on the page: the point given, or the middle of the element it is on.
// tldraw draws a bound end to the element's outline; this is only where it starts from.
function end_point(end: SceneEnd, by_id: ReadonlyMap<string, SceneElement>): ScenePoint {
  if (end.kind === 'point') return { x: end.x, y: end.y }

  const target = by_id.get(end.id)
  assert(target !== undefined, 'a valid arrow ends on a known element')

  if (target.type === 'geo') return { x: target.x + target.w / 2, y: target.y + target.h / 2 }

  if (target.type === 'text') return { x: target.x + (target.w ?? 0) / 2, y: target.y }

  assert(target.type === 'path' || target.type === 'stroke', 'a valid arrow ends on an outline')
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]

  for (const point of target.points) {
    x0 = Math.min(x0, point.x)
    y0 = Math.min(y0, point.y)
    x1 = Math.max(x1, point.x)
    y1 = Math.max(y1, point.y)
  }

  assert(Number.isFinite(x0) && Number.isFinite(y1), 'a path or stroke has points')
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
}

function record_base(placed: Placed) {
  assert(Number.isFinite(placed.x) && Number.isFinite(placed.y), 'a shape has a position')
  assert(placed.index.length >= 2, 'an index key has a head and a digit')
  return {
    id: scene_shape_id(placed.id),
    typeName: 'shape',
    x: placed.x,
    y: placed.y,
    rotation: 0,
    index: placed.index,
    parentId: placed.parent_id,
    isLocked: false,
    opacity: 1,
    meta: {},
  }
}

type Shaped = SceneText | SceneGeoShape | ScenePath | SceneStroke

function shape_props(element: Shaped): [string, object] {
  if (element.type === 'text') return ['text', text_props(element)]

  if (element.type === 'geo') return ['geo', geo_props(element)]

  if (element.type === 'path') return ['line', line_props(element)]

  assert(element.type === 'stroke', 'every shaped element is drawn')
  return ['draw', draw_props(element)]
}

function text_props(element: SceneText) {
  assert(element.text.trim().length > 0, 'valid text is not empty')
  assert(element.w === null || element.w >= 1, 'a valid width is positive')
  return {
    color: element.color,
    size: element.size,
    font: element.font,
    textAlign: element.align,
    w: element.w ?? 8,
    richText: toRichText(element.text),
    scale: 1,
    autoSize: element.w === null,
  }
}

// `url` is always empty: a scene has no field that could set it.
function geo_props(element: SceneGeoShape) {
  assert(element.w >= 1 && element.h >= 1, 'a valid shape has an area')
  return {
    geo: element.geo,
    dash: element.dash,
    url: '',
    w: element.w,
    h: element.h,
    growY: 0,
    scale: 1,
    labelColor: element.label_color,
    color: element.color,
    fill: element.fill,
    size: element.size,
    font: element.font,
    align: element.align,
    verticalAlign: element.vertical_align,
    richText: toRichText(element.text),
  }
}

// tldraw's line: its points by key, in order, each relative to the first.
function line_props(element: ScenePath) {
  const first = element.points[0]
  assert(first !== undefined && element.points.length >= 2, 'a valid path joins two points')
  const points: Record<string, { id: string; index: string; x: number; y: number }> = {}

  for (const [place, point] of element.points.entries()) {
    const key = index_key(place)
    points[key] = { id: key, index: key, x: point.x - first.x, y: point.y - first.y }
  }

  return {
    color: element.color,
    dash: element.dash,
    size: element.size,
    spline: element.curved ? 'cubic' : 'line',
    points,
    scale: 1,
  }
}

// tldraw's freehand stroke. The agent's strokes have no pen pressure of their own, so tldraw
// draws them at an even weight.
function draw_props(element: SceneStroke) {
  const first = element.points[0]
  assert(first !== undefined, 'a valid stroke has a point')
  const points = element.points.map((point) => {
    return { x: point.x - first.x, y: point.y - first.y, z: 0.5 }
  })
  assert(points.length === element.points.length, 'every sample is kept')
  return {
    color: element.color,
    fill: element.fill,
    dash: element.dash,
    size: element.size,
    segments: [{ type: 'free', points }],
    isComplete: true,
    isClosed: element.closed,
    isPen: false,
    scale: 1,
  }
}

function arrow_props(element: SceneArrow, end: ScenePoint) {
  assert(Number.isFinite(end.x) && Number.isFinite(end.y), 'the end is a point')
  assert(element.route === 'arc' || element.bend === 0, 'only an arc bends')
  return {
    kind: element.route,
    labelColor: element.label_color,
    color: element.color,
    fill: 'none',
    dash: element.dash,
    size: element.size,
    arrowheadStart: element.arrowhead_start,
    arrowheadEnd: element.arrowhead_end,
    font: element.font,
    start: { x: 0, y: 0 },
    end,
    bend: element.bend,
    richText: toRichText(element.text),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
  }
}

// A null anchor aims at the middle, and tldraw stops the arrow at the outline. A given anchor
// is where on the element the arrow meets it.
function binding_record(
  arrow_id: string,
  terminal: 'start' | 'end',
  end: Extract<SceneEnd, { kind: 'element' }>,
): TLRecord {
  const record = {
    id: `binding:scene-${arrow_id}-${terminal}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: scene_shape_id(arrow_id),
    toId: scene_shape_id(end.id),
    meta: {},
    props: {
      terminal,
      normalizedAnchor: end.anchor ?? { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: end.anchor !== null,
      snap: 'none',
    },
  }
  assert(record.fromId !== record.toId, 'a binding joins an arrow to another shape')
  assert(record.id.startsWith('binding:'), 'a binding id has the binding prefix')
  return record as unknown as TLRecord
}

// The strokes a sketch element holds, as native pen strokes: each as it was drawn, moved with
// the element, and marked with where it came from. An id joins the element's id and the
// stroke's place with a dot, which no element id holds, so it meets no other shape's.
function ink_records(element: SceneSketch, placed: Placed): TLRecord[] {
  assert(element.ink !== null, 'a published sketch element holds its strokes')
  assert(element.ink.length === element.strokes.length, 'one held stroke for each id')
  return element.ink.map((stroke, place) =>
    ink_record(stroke, place, placed, {
      sketch_stroke: element.strokes[place] ?? '',
      sketch_hash: element.source_hash ?? '',
    }),
  )
}

// One kept stroke as a native tldraw shape. Its turn and opacity are the stroke's own.
export function ink_record(
  stroke: InkStroke,
  place: number,
  placed: Placed,
  meta: { sketch_stroke: string; sketch_hash: string },
): TLRecord {
  assert(Number.isInteger(place) && place >= 0, 'a place is a whole number')
  assert(Number.isFinite(stroke.x) && Number.isFinite(stroke.y), 'a stroke has a position')
  return {
    ...record_base(placed),
    id: `${scene_shape_id(placed.id)}.${place}`,
    x: placed.x + stroke.x,
    y: placed.y + stroke.y,
    index: index_key_within(placed.index, place),
    rotation: stroke.rotation,
    opacity: stroke.opacity,
    type: stroke.type,
    props: stroke.props,
    meta,
  } as unknown as TLRecord
}
