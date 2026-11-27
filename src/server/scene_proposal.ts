// An agent's scene proposal is untrusted data, never code. This module checks one completely
// before anything changes. A scene is a flat list of positioned elements: text, geometric
// shapes, paths, freehand strokes, arrows, groups, and strokes of the sketch that the board
// copies itself. Nothing in it can name an image, a link, an embed or any other remote thing:
// those fields do not exist, and an unknown field is refused.
//
// The same reader checks a scene saved with a published revision. There a sketch element holds
// the strokes the board copied, each checked against tldraw's own schema, so whatever is saved
// reads back. `scene_elements_write` is the inverse: the scene as an agent may send it again.
//
// Reading never throws on bad input. The reader keeps the first problem it meets, with the
// path to it, and the caller reports that problem as an ordinary error.

import { assert } from '../shared/assert'
import { board_id_pattern } from '../shared/board_session'
import {
  document_hash_pattern,
  ink_points_count_max,
  proposal_coordinate_units_max,
  proposal_extent_units_max,
  proposal_shapes_count_max,
  proposal_text_length_max,
  scene_depth_max,
  scene_path_points_count_max,
  scene_stroke_ids_count_max,
} from '../shared/constants'
import { header_keys, header_read, JsonReader, type Json } from '../shared/json_reader'
import type { SceneControl } from '../shared/scene_controls'
import {
  scene_arrowheads,
  scene_bases,
  scene_colors,
  scene_dashes,
  scene_element_types,
  scene_fills,
  scene_fonts,
  scene_format,
  scene_geos,
  scene_label_aligns,
  scene_routes,
  scene_sizes,
  scene_text_aligns,
  type SceneArrow,
  type SceneElement,
  type SceneElementType,
  type SceneEnd,
  type SceneGeoShape,
  type ScenePath,
  type ScenePoint,
  type SceneProposal,
  type SceneSketch,
  type SceneStroke,
  type SceneText,
} from '../shared/scene_types'
import {
  conditions_read,
  references_check,
  scene_controls_read,
  tap_read,
} from './scene_control_reader'
import { ink_points_count, ink_strokes_read } from './scene_ink'

export type SceneParsed =
  { ok: true; proposal: SceneProposal } | { ok: false; path: string; message: string }

// Whether a sketch element only names its strokes, as on the way to the board, or holds them
// in full, as in a saved revision.
export type SceneMode = 'named' | 'held'

type Common = Pick<
  SceneElement,
  'id' | 'parent' | 'rotation' | 'opacity' | 'visible_when' | 'on_tap'
>

const element_id_pattern = /^[A-Za-z0-9_-]{1,40}$/
const stroke_id_pattern = /^shape:[A-Za-z0-9_-]{1,64}$/

// Rotation is in radians: a little over one full turn either way.
const rotation_max = 7
const keys_root = [...header_keys, 'basis', 'controls', 'elements'] as const
const keys_common = [
  'type',
  'id',
  'parent',
  'rotation',
  'opacity',
  'visible_when',
  'on_tap',
] as const
const keys_by_type: Record<SceneElementType, readonly string[]> = {
  text: ['x', 'y', 'text', 'w', 'color', 'size', 'font', 'align'],
  geo: [
    'geo',
    'x',
    'y',
    'w',
    'h',
    'text',
    'color',
    'label_color',
    'fill',
    'dash',
    'size',
    'font',
    'align',
    'vertical_align',
  ],
  path: ['points', 'curved', 'color', 'dash', 'size'],
  stroke: ['points', 'closed', 'color', 'fill', 'dash', 'size'],
  arrow: [
    'from',
    'to',
    'from_anchor',
    'to_anchor',
    'text',
    'color',
    'label_color',
    'dash',
    'size',
    'font',
    'route',
    'bend',
    'arrowhead_start',
    'arrowhead_end',
  ],
  group: [],
  sketch: ['strokes', 'x', 'y', 'w', 'h', 'source_hash', 'ink'],
}

// What an arrow may end on: an element with an outline of its own.
const bindable_types: readonly SceneElementType[] = ['text', 'geo', 'path', 'stroke']

export function scene_parse(input: unknown): SceneParsed {
  const reader = new JsonReader()
  const format = object_field(input, 'format')

  // The format decides every other rule, so a wrong one is the first problem reported.
  if (format !== scene_format) reader.fail('proposal.format', `Expected "${scene_format}".`)

  const root = reader.object(input, 'proposal', keys_root)
  const header = header_read(reader, root, 'proposal')
  const session = header.session ?? ''

  // A scene belongs to the one board its snapshot came from, so it always names it.
  if (!board_id_pattern.test(session)) {
    reader.fail('proposal.session', 'Expected the session from whiteboard-snapshot.')
  }

  const basis = reader.choice(root, 'basis', 'proposal', scene_bases, false)

  // Controls first: the elements refer to them.
  const controls = scene_controls_read(reader, root.controls)
  const elements = scene_elements_read(reader, root.elements, 'named', controls)

  if (reader.problem !== null) return { ok: false, ...reader.problem }

  assert(elements.length <= proposal_shapes_count_max, 'a valid scene is bounded')
  assert(board_id_pattern.test(session), 'a valid scene names its board')
  return { ok: true, proposal: { ...header, session, basis, controls, elements } }
}

function object_field(input: unknown, key: string): unknown {
  assert(key.length > 0, 'a field is named')

  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined

  return (input as Json)[key]
}

// The elements of a scene, each checked alone and then against the others and the scene's
// controls. An empty list is a valid scene: an empty canvas.
export function scene_elements_read(
  reader: JsonReader,
  value: unknown,
  mode: SceneMode,
  controls: readonly SceneControl[] = [],
): SceneElement[] {
  const count_max = proposal_shapes_count_max

  if (!Array.isArray(value) || value.length > count_max) {
    reader.fail('proposal.elements', `Expected a list of 0 to ${count_max} elements.`)
    return []
  }

  const elements = value.map((item, index) =>
    element_read(reader, item, `elements[${index}]`, mode),
  )

  if (reader.problem === null) elements_check(reader, elements)

  if (reader.problem === null) references_check(reader, elements, controls)

  assert(elements.length === value.length, 'every element was read')
  assert(elements.length <= count_max, 'elements are bounded')
  return elements
}

function element_read(reader: JsonReader, value: unknown, path: string, mode: SceneMode) {
  assert(path.startsWith('elements['), 'an element is read at its place in the list')
  const type = scene_element_types.find((candidate) => candidate === object_field(value, 'type'))

  if (type === undefined) {
    reader.fail(`${path}.type`, `Expected one of: ${scene_element_types.join(', ')}.`)
    return group_fallback(path)
  }

  const source = reader.object(value, path, [...keys_common, ...keys_by_type[type]])
  const common = common_read(reader, source, path)

  if (type === 'text') return text_read(reader, source, path, common)

  if (type === 'geo') return geo_read(reader, source, path, common)

  if (type === 'path') return path_read(reader, source, path, common)

  if (type === 'stroke') return stroke_read(reader, source, path, common)

  if (type === 'arrow') return arrow_read(reader, source, path, common)

  if (type === 'sketch') return sketch_read(reader, source, path, common, mode)

  assert(type === 'group', 'every element type is read')
  const group: SceneElement = { type: 'group', ...common }
  return group
}

// What stands in for an element that could not be read. The problem is already kept.
function group_fallback(path: string): SceneElement {
  assert(path.length > 0, 'an element has a path')
  const fallback: SceneElement = {
    type: 'group',
    id: '',
    parent: null,
    rotation: 0,
    opacity: 1,
    visible_when: [],
    on_tap: null,
  }
  assert(!element_id_pattern.test(fallback.id), 'a stand-in is never taken for an element')
  return fallback
}

function common_read(reader: JsonReader, source: Json, path: string): Common {
  const id = reader.text(source, 'id', path, 40, null)

  if (!element_id_pattern.test(id)) {
    reader.fail(`${path}.id`, 'Expected an id of 1 to 40 letters, digits, _ or -.')
  }

  const absent = source.parent === undefined || source.parent === null
  const parent = absent ? null : reader.text(source, 'parent', path, 40, null)
  const rotation = number_or(reader, source, 'rotation', path, -rotation_max, rotation_max, 0)
  const opacity = number_or(reader, source, 'opacity', path, 0, 1, 1)
  const visible_when = conditions_read(reader, source, path)
  const on_tap = tap_read(reader, source, path)
  assert(opacity >= 0 && opacity <= 1, 'a read opacity is a fraction')
  assert(Math.abs(rotation) <= rotation_max, 'a read turn is bounded')
  return { id, parent, rotation, opacity, visible_when, on_tap }
}

// A number that may be left out, which then takes its default.
function number_or(
  reader: JsonReader,
  source: Json,
  key: string,
  path: string,
  min: number,
  max: number,
  fallback: number,
): number {
  assert(min < max, 'a number range is not empty')
  assert(fallback >= min && fallback <= max, 'a default is in range')

  if (source[key] === undefined || source[key] === null) return fallback

  return reader.number(source, key, path, min, max)
}

// A pair such as [x, y], each within the range, or null after a problem.
function pair_read(
  reader: JsonReader,
  value: unknown,
  path: string,
  min: number,
  max: number,
): ScenePoint | null {
  assert(min < max, 'a pair range is not empty')
  const numbers = Array.isArray(value) && value.length === 2 ? (value as unknown[]) : []
  const valid = numbers.filter(
    (number): number is number =>
      typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max,
  )

  assert(valid.length <= 2, 'a pair is at most two numbers')

  if (valid.length !== 2) {
    reader.fail(path, `Expected [x, y], each a number from ${min} to ${max}.`)
    return null
  }

  return { x: valid[0] as number, y: valid[1] as number }
}

function position_read(reader: JsonReader, source: Json, path: string): ScenePoint {
  const coordinate_max = proposal_coordinate_units_max
  const x = reader.number(source, 'x', path, -coordinate_max, coordinate_max)
  const y = reader.number(source, 'y', path, -coordinate_max, coordinate_max)
  assert(Number.isFinite(x) && Number.isFinite(y), 'a read position is a point')
  assert(Math.abs(x) <= coordinate_max && Math.abs(y) <= coordinate_max, 'it is on the page')
  return { x, y }
}

function text_read(reader: JsonReader, source: Json, path: string, common: Common): SceneText {
  const { x, y } = position_read(reader, source, path)
  const text = reader.text(source, 'text', path, proposal_text_length_max, null)

  if (text.trim().length === 0) reader.fail(`${path}.text`, 'Text is empty.')

  // Without a width, text takes the width of its words.
  const w =
    source.w === undefined || source.w === null
      ? null
      : reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const color = reader.choice(source, 'color', path, scene_colors, false)
  const size = reader.choice(source, 'size', path, scene_sizes, false)
  const font = reader.choice(source, 'font', path, scene_fonts, false)
  const align = reader.choice(source, 'align', path, scene_text_aligns, false)
  assert(w === null || w >= 1, 'a read width is positive')
  assert(text.length <= proposal_text_length_max, 'read text is bounded')
  return { type: 'text', ...common, x, y, text, w, color, size, font, align }
}

function geo_read(reader: JsonReader, source: Json, path: string, common: Common): SceneGeoShape {
  const geo = reader.choice(source, 'geo', path, scene_geos, false)
  const { x, y } = position_read(reader, source, path)
  const w = reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const h = reader.number(source, 'h', path, 1, proposal_extent_units_max)
  const text = reader.text(source, 'text', path, proposal_text_length_max, '')
  const color = reader.choice(source, 'color', path, scene_colors, false)

  // A label left without a colour is drawn in the colour of its outline.
  const label_color =
    source.label_color === undefined || source.label_color === null
      ? color
      : reader.choice(source, 'label_color', path, scene_colors, true)
  const fill = reader.choice(source, 'fill', path, scene_fills, false)
  const dash = reader.choice(source, 'dash', path, scene_dashes, false)
  const size = reader.choice(source, 'size', path, scene_sizes, false)
  const font = reader.choice(source, 'font', path, scene_fonts, false)
  const align = reader.choice(source, 'align', path, scene_label_aligns, false)
  const vertical_align = reader.choice(source, 'vertical_align', path, scene_label_aligns, false)
  assert(w >= 1 && h >= 1, 'a read shape has an area')
  assert(scene_geos.includes(geo), 'a read geometry is one tldraw draws')
  const style = { color, label_color, fill, dash, size, font, align, vertical_align }
  return { type: 'geo', ...common, geo, x, y, w, h, text, ...style }
}

function points_read(
  reader: JsonReader,
  value: unknown,
  path: string,
  count_min: number,
  count_max: number,
): ScenePoint[] {
  const coordinate_max = proposal_coordinate_units_max
  const items = reader.list(value, path, count_min, count_max)
  const points: ScenePoint[] = []

  for (const [index, item] of items.entries()) {
    const point = pair_read(reader, item, `${path}[${index}]`, -coordinate_max, coordinate_max)

    if (point === null) return []

    points.push(point)
  }

  assert(points.length === items.length, 'every point was read')
  assert(points.length <= count_max, 'points are bounded')
  return points
}

function path_read(reader: JsonReader, source: Json, path: string, common: Common): ScenePath {
  const count_max = scene_path_points_count_max
  const points = points_read(reader, source.points, `${path}.points`, 2, count_max)
  const curved = reader.boolean(source, 'curved', path, false)
  const color = reader.choice(source, 'color', path, scene_colors, false)
  const dash = reader.choice(source, 'dash', path, scene_dashes, false)
  const size = reader.choice(source, 'size', path, scene_sizes, false)
  assert(points.length <= count_max, 'a path is bounded')
  assert(points.length !== 1, 'a read path joins points, or was refused')
  return { type: 'path', ...common, points, curved, color, dash, size }
}

function stroke_read(reader: JsonReader, source: Json, path: string, common: Common): SceneStroke {
  const points = points_read(reader, source.points, `${path}.points`, 1, ink_points_count_max)
  const closed = reader.boolean(source, 'closed', path, false)
  const color = reader.choice(source, 'color', path, scene_colors, false)
  const fill = reader.choice(source, 'fill', path, scene_fills, false)
  const dash = reader.choice(source, 'dash', path, scene_dashes, false)
  const size = reader.choice(source, 'size', path, scene_sizes, false)
  assert(points.length <= ink_points_count_max, 'a stroke is bounded')
  assert(scene_fills.includes(fill), 'a read fill is one tldraw draws')
  return { type: 'stroke', ...common, points, closed, color, fill, dash, size }
}

// One end of an arrow: the id of an element, or a point on the page.
function end_read(reader: JsonReader, source: Json, key: 'from' | 'to', path: string): SceneEnd {
  const value = source[key]
  const anchor_value = source[`${key}_anchor`]
  const anchored = anchor_value !== undefined && anchor_value !== null

  if (typeof value === 'string') {
    if (!element_id_pattern.test(value)) {
      reader.fail(`${path}.${key}`, 'Expected an element id, or [x, y] for a point on the page.')
    }

    const anchor = anchored ? pair_read(reader, anchor_value, `${path}.${key}_anchor`, 0, 1) : null
    return { kind: 'element', id: value, anchor }
  }

  const coordinate_max = proposal_coordinate_units_max
  const point = pair_read(reader, value, `${path}.${key}`, -coordinate_max, coordinate_max)

  if (anchored) reader.fail(`${path}.${key}_anchor`, 'Only an end on an element has an anchor.')

  assert(key === 'from' || key === 'to', 'an arrow has two ends')
  assert(point === null || Number.isFinite(point.x + point.y), 'a read end is a point')
  return { kind: 'point', x: point?.x ?? 0, y: point?.y ?? 0 }
}

function arrow_read(reader: JsonReader, source: Json, path: string, common: Common): SceneArrow {
  const from = end_read(reader, source, 'from', path)
  const to = end_read(reader, source, 'to', path)
  const text = reader.text(source, 'text', path, proposal_text_length_max, '')
  const color = reader.choice(source, 'color', path, scene_colors, false)
  const label_color =
    source.label_color === undefined || source.label_color === null
      ? color
      : reader.choice(source, 'label_color', path, scene_colors, true)
  const dash = reader.choice(source, 'dash', path, scene_dashes, false)
  const size = reader.choice(source, 'size', path, scene_sizes, false)
  const font = reader.choice(source, 'font', path, scene_fonts, false)
  const route = reader.choice(source, 'route', path, scene_routes, false)
  const bend_max = proposal_extent_units_max
  const bend = number_or(reader, source, 'bend', path, -bend_max, bend_max, 0)

  if (route === 'elbow' && bend !== 0) reader.fail(`${path}.bend`, 'Only an arc bends.')

  // The default is one arrowhead, at the "to" end.
  const start = source.arrowhead_start ?? 'none'
  const heads = { arrowhead_start: start, arrowhead_end: source.arrowhead_end }
  const arrowhead_start = reader.choice(heads, 'arrowhead_start', path, scene_arrowheads, true)
  const arrowhead_end = reader.choice(heads, 'arrowhead_end', path, scene_arrowheads, false)
  assert(scene_routes.includes(route), 'a route is known')
  assert(Math.abs(bend) <= bend_max, 'a read bend is bounded')
  const style = { color, label_color, dash, size, font, route, bend }
  return { type: 'arrow', ...common, from, to, text, ...style, arrowhead_start, arrowhead_end }
}

// Strokes of the sketch. On the way to the board they are only named: the board measures and
// copies them, so what a proposal says of their box, their source or their samples is not
// read. A saved scene holds all of it, and is read with it.
function sketch_read(
  reader: JsonReader,
  source: Json,
  path: string,
  common: Common,
  mode: SceneMode,
): SceneSketch {
  const items = reader.list(source.strokes, `${path}.strokes`, 1, scene_stroke_ids_count_max)
  const strokes = items.filter(
    (item): item is string => typeof item === 'string' && stroke_id_pattern.test(item),
  )

  if (strokes.length !== items.length || new Set(strokes).size !== strokes.length) {
    reader.fail(`${path}.strokes`, 'Expected different stroke ids such as "shape:abc".')
  }

  const placed = source.x !== undefined && source.x !== null
  const placed_down = source.y !== undefined && source.y !== null

  if (placed !== placed_down) reader.fail(`${path}.y`, 'Give both x and y, or neither.')

  // The strokes are kept as drawn, each with its own turn and opacity.
  if (common.rotation !== 0 || common.opacity !== 1) {
    reader.fail(`${path}.rotation`, 'Sketch strokes are kept as drawn: only their place is set.')
  }

  const position = placed && placed_down ? position_read(reader, source, path) : null
  const base = { type: 'sketch' as const, ...common, strokes }
  assert(strokes.length <= scene_stroke_ids_count_max, 'stroke ids are bounded')
  assert(position === null || (placed && placed_down), 'a read position was given whole')

  if (mode === 'named') {
    if (source.ink !== undefined && source.ink !== null) {
      reader.fail(`${path}.ink`, 'The board copies the strokes from the sketch: send only ids.')
    }

    const { x, y } = position ?? { x: null, y: null }
    return { ...base, x, y, w: null, h: null, source_hash: null, ink: null }
  }

  return sketch_held_read(reader, source, path, base, position)
}

function sketch_held_read(
  reader: JsonReader,
  source: Json,
  path: string,
  base: Pick<SceneSketch, 'type' | 'strokes' | keyof Common>,
  position: ScenePoint | null,
): SceneSketch {
  if (position === null) reader.fail(`${path}.x`, 'A saved sketch element has its position.')

  const w = reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const h = reader.number(source, 'h', path, 1, proposal_extent_units_max)
  const source_hash = reader.text(source, 'source_hash', path, 16, null)

  if (!document_hash_pattern.test(source_hash)) {
    reader.fail(`${path}.source_hash`, 'Expected the hash of the sketch the strokes came from.')
  }

  const ink = ink_strokes_read(reader, source.ink, `${path}.ink`, base.strokes.length)
  assert(ink.length <= base.strokes.length, 'at most one held stroke for each id')
  assert(w >= 1 && h >= 1, 'a held box has an area')
  const { x, y } = position ?? { x: 0, y: 0 }
  return { ...base, x, y, w, h, source_hash, ink }
}

// What only the whole list can show: ids, nesting, arrow ends, and the totals.
function elements_check(reader: JsonReader, elements: readonly SceneElement[]): void {
  assert(elements.length <= proposal_shapes_count_max, 'elements are bounded')
  const by_id = new Map<string, SceneElement>()

  for (const [index, element] of elements.entries()) {
    if (by_id.has(element.id)) reader.fail(`elements[${index}].id`, 'Element ids must be unique.')

    by_id.set(element.id, element)
  }

  nesting_check(reader, elements, by_id)
  arrows_check(reader, elements, by_id)
  totals_check(reader, elements)
  assert(by_id.size <= elements.length, 'ids are a subset of the elements')
}

// Every parent is a group of this scene, no group holds itself, and a group holds at least
// two things: tldraw dissolves a group of one.
function nesting_check(
  reader: JsonReader,
  elements: readonly SceneElement[],
  by_id: ReadonlyMap<string, SceneElement>,
): void {
  assert(elements.length <= proposal_shapes_count_max, 'elements are bounded')
  const children_count = new Map<string, number>()

  for (const [index, element] of elements.entries()) {
    let parent = element.parent
    let depth = 0

    if (parent !== null) {
      const held = element.type === 'sketch' ? element.strokes.length : 1
      children_count.set(parent, (children_count.get(parent) ?? 0) + held)
    }

    while (parent !== null && depth <= scene_depth_max) {
      const group = by_id.get(parent)

      if (group === undefined || group.type !== 'group') {
        reader.fail(`elements[${index}].parent`, 'A parent is the id of a group in this scene.')
        return
      }

      parent = group.parent
      depth += 1
    }

    if (depth > scene_depth_max) {
      const message = `Groups nest at most ${scene_depth_max} deep and never hold themselves.`
      reader.fail(`elements[${index}].parent`, message)
    }
  }

  elements.forEach((element, index) => {
    if (element.type === 'group' && (children_count.get(element.id) ?? 0) < 2) {
      reader.fail(`elements[${index}]`, 'A group holds at least two elements.')
    }

    if (element.type === 'group' && element.rotation !== 0) {
      reader.fail(`elements[${index}].rotation`, 'A group is not turned: turn its elements.')
    }
  })
  assert(children_count.size <= elements.length, 'parents are some of the elements')
}

function arrows_check(
  reader: JsonReader,
  elements: readonly SceneElement[],
  by_id: ReadonlyMap<string, SceneElement>,
): void {
  assert(elements.length <= proposal_shapes_count_max, 'elements are bounded')

  for (const [index, element] of elements.entries()) {
    if (element.type !== 'arrow') continue

    for (const key of ['from', 'to'] as const) {
      const end = element[key]

      if (end.kind !== 'element') continue

      const target = by_id.get(end.id)

      if (target === undefined || !bindable_types.includes(target.type)) {
        const message = 'An arrow ends on a text, geo, path or stroke element, or at [x, y].'
        reader.fail(`elements[${index}].${key}`, message)
      }
    }

    const { from, to } = element
    const same_element = from.kind === 'element' && to.kind === 'element' && from.id === to.id
    const same_point =
      from.kind === 'point' && to.kind === 'point' && from.x === to.x && from.y === to.y

    if (same_element || same_point) {
      reader.fail(`elements[${index}].to`, 'An arrow joins two different places.')
    }
  }

  assert(by_id.size <= elements.length, 'ids are a subset of the elements')
}

// A stroke of the sketch is kept once, and one canvas keeps a bounded number of pen samples.
function totals_check(reader: JsonReader, elements: readonly SceneElement[]): void {
  assert(elements.length <= proposal_shapes_count_max, 'elements are bounded')
  const stroke_ids = new Set<string>()
  let stroke_ids_count = 0

  for (const [index, element] of elements.entries()) {
    if (element.type !== 'sketch') continue

    for (const id of element.strokes) stroke_ids.add(id)

    stroke_ids_count += element.strokes.length

    if (stroke_ids.size !== stroke_ids_count) {
      reader.fail(`elements[${index}].strokes`, 'A stroke is kept by one sketch element only.')
      return
    }
  }

  if (stroke_ids_count > scene_stroke_ids_count_max) {
    const message = `A scene names at most ${scene_stroke_ids_count_max} sketch strokes.`
    reader.fail('proposal.elements', message)
  }

  if (ink_points_count(elements) > ink_points_count_max) {
    const message = `A canvas keeps at most ${ink_points_count_max} pen samples in all.`
    reader.fail('proposal.elements', message)
  }

  assert(stroke_ids.size <= stroke_ids_count, 'distinct ids are some of the ids')
}

// The scene as JSON, in the form the reader takes. `ink` says whether a sketch element is
// written with the strokes it holds, as a saved revision is, or without them, as an agent is
// shown it: an agent only ever names strokes.
export function scene_elements_write(
  elements: readonly SceneElement[],
  ink: 'with_ink' | 'without_ink',
): Json[] {
  assert(elements.length <= proposal_shapes_count_max, 'a scene is bounded')
  const written = elements.map((element) => element_write(element, ink === 'with_ink'))
  assert(written.length === elements.length, 'every element is written')
  return written
}

const pair = (point: ScenePoint): [number, number] => [point.x, point.y]

function end_write(end: SceneEnd, key: 'from' | 'to'): Json {
  assert(key === 'from' || key === 'to', 'an arrow has two ends')

  if (end.kind === 'point') return { [key]: [end.x, end.y] }

  assert(element_id_pattern.test(end.id), 'a written end names an element')

  if (end.anchor === null) return { [key]: end.id }

  return { [key]: end.id, [`${key}_anchor`]: pair(end.anchor) }
}

// The fields that refer to controls are written only when set, so a scene without controls is
// written exactly as it was before controls existed.
function element_write(element: SceneElement, with_ink: boolean): Json {
  const written = element_fields_write(element, with_ink)
  delete written.visible_when
  delete written.on_tap

  if (element.visible_when.length > 0) {
    written.visible_when = element.visible_when.map(({ control, values }) => {
      return { control, values: [...values] }
    })
  }

  if (element.on_tap !== null) written.on_tap = { ...element.on_tap }

  assert(written.type === element.type && written.id === element.id, 'the element is written')
  assert(element.on_tap !== null || written.on_tap === undefined, 'no tap is written as none')
  return written
}

function element_fields_write(element: SceneElement, with_ink: boolean): Json {
  const { type, id, parent, rotation, opacity, ...rest } = element
  const common: Json = { type, id }

  if (parent !== null) common.parent = parent

  if (rotation !== 0) common.rotation = rotation

  if (opacity !== 1) common.opacity = opacity

  assert(scene_element_types.includes(type), 'a written element has a known type')
  assert(element_id_pattern.test(id), 'a written element has a valid id')

  if (element.type === 'path' || element.type === 'stroke') {
    return { ...common, ...rest, points: element.points.map(pair) }
  }

  if (element.type === 'arrow') {
    const { from, to, ...style } = element
    const { type: _t, id: _i, parent: _p, rotation: _r, opacity: _o, ...kept } = style
    return { ...common, ...end_write(from, 'from'), ...end_write(to, 'to'), ...kept }
  }

  if (element.type === 'sketch') {
    const { ink, ...kept } = element
    const { type: _t, id: _i, parent: _p, rotation: _r, opacity: _o, ...fields } = kept
    return with_ink ? { ...common, ...fields, ink } : { ...common, ...fields }
  }

  if (element.type === 'text' && element.w === null) {
    const { w: _w, ...kept } = rest as Json
    return { ...common, ...kept }
  }

  return { ...common, ...rest }
}
