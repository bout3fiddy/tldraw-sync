// Reads a canvas saved in the retired formats, once, on the way to native records. Before
// scenes, a published version was saved as a short list of positioned shapes (text, a
// rectangle, an ellipse, an arrow between two of them, or kept pen strokes) in one of two
// looks, and the board made tldraw records from that list every time it opened. Nothing
// writes those shapes any more. This module turns each saved version into the records the
// board always served for it, so an old board looks exactly as it did, and from then on the
// records themselves are what is saved (see `canvas_migration.ts`).
//
// A saved file is untrusted like any input. Reading never throws on bad input: the reader
// keeps the first problem it meets and the caller refuses the file.

import { toRichText, type TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { cleaned_page_id } from '../shared/canvas_types'
import {
  ink_points_count_max,
  proposal_coordinate_units_max,
  proposal_extent_units_max,
  proposal_shapes_count_max,
  proposal_text_length_max,
  scene_stroke_ids_count_max,
} from '../shared/constants'
import { JsonReader, type Json } from '../shared/json_reader'
import { type InkStroke, scene_colors, type SceneColor } from '../shared/scene_types'
import {
  canvas_records_problem,
  index_key,
  index_key_within,
  record_valid,
  shape_points_count,
} from './canvas_records'
import { ink_strokes_read } from './scene_ink'

// The two looks a retired version was published in. 'plain' is solid outlines and sans
// lettering; 'markerboard' is tldraw's hand-drawn line and handwritten face.
export const legacy_styles = ['plain', 'markerboard'] as const
export type LegacyStyle = (typeof legacy_styles)[number]

const legacy_kinds = ['text', 'rectangle', 'ellipse', 'arrow', 'ink'] as const
const legacy_sizes = ['m', 's', 'l', 'xl'] as const
const legacy_fills = ['none', 'semi', 'solid'] as const
const legacy_label_aligns = ['middle', 'start'] as const
const legacy_text_aligns = ['start', 'middle'] as const
const legacy_arrowheads = ['end', 'both', 'none'] as const
const legacy_routes = ['arc', 'elbow'] as const

type Size = (typeof legacy_sizes)[number]
type Anchor = { x: number; y: number }

// One saved shape. Optional fields have been filled with their defaults.
export type LegacyShape =
  | { kind: 'ink'; id: string; x: number; y: number; strokes: string[]; ink: InkStroke[] }
  | {
      kind: 'text'
      id: string
      x: number
      y: number
      text: string
      w: number | null
      color: SceneColor
      size: Size
      align: (typeof legacy_text_aligns)[number]
    }
  | {
      kind: 'rectangle' | 'ellipse'
      id: string
      x: number
      y: number
      w: number
      h: number
      text: string
      color: SceneColor
      size: Size
      fill: (typeof legacy_fills)[number]
      label_color: SceneColor | null
      label_align: (typeof legacy_label_aligns)[number]
      label_valign: (typeof legacy_label_aligns)[number]
      label_bold: boolean
    }
  | {
      kind: 'arrow'
      id: string
      from: string
      to: string
      text: string
      color: SceneColor
      size: Size
      arrowheads: (typeof legacy_arrowheads)[number]
      route: (typeof legacy_routes)[number]
      bend: number
      from_anchor: Anchor | null
      to_anchor: Anchor | null
    }

// What the records of a saved version are made from: its shapes and the look of each.
export type LegacyDrawing = {
  shapes: LegacyShape[]
  style: LegacyStyle

  // The look of the shapes merged in from the second legacy document, when it differed.
  agent_style?: LegacyStyle
}

const shape_id_pattern = /^[A-Za-z0-9_-]{1,40}$/
const stroke_id_pattern = /^shape:[A-Za-z0-9_-]{1,64}$/
const keys_any = [
  'kind',
  'id',
  'x',
  'y',
  'w',
  'h',
  'text',
  'color',
  'size',
  'align',
  'fill',
  'label_color',
  'label_align',
  'label_valign',
  'label_bold',
  'from',
  'to',
  'arrowheads',
  'route',
  'bend',
  'from_anchor',
  'to_anchor',
  'strokes',
  'ink',
] as const

// The shapes and look of one saved version, or the first problem in them.
export function legacy_drawing_read(reader: JsonReader, version: Json): LegacyDrawing {
  const style =
    version.style === undefined
      ? 'plain'
      : reader.choice(version, 'style', 'version', legacy_styles, true)
  const value = version.shapes

  if (!Array.isArray(value) || value.length > proposal_shapes_count_max) {
    reader.fail('version.shapes', `Expected at most ${proposal_shapes_count_max} shapes.`)
    return { shapes: [], style }
  }

  const shapes = value.map((item, index) => shape_read(reader, item, `shapes[${index}]`))
  const kinds = new Map<string, LegacyShape['kind']>()
  shapes.forEach((shape, index) => {
    if (kinds.has(shape.id)) reader.fail(`shapes[${index}].id`, 'Shape ids must be unique.')

    kinds.set(shape.id, shape.kind)
  })
  shapes.forEach((shape, index) => {
    if (shape.kind !== 'arrow') return

    for (const end of ['from', 'to'] as const) {
      const kind = kinds.get(shape[end])

      if (kind === undefined || kind === 'arrow' || kind === 'ink') {
        reader.fail(`shapes[${index}].${end}`, 'An arrow binds to a text, rectangle or ellipse.')
      }
    }

    if (shape.from === shape.to) reader.fail(`shapes[${index}].to`, 'An arrow joins two shapes.')
  })
  assert(shapes.length === value.length, 'every shape was read')
  assert(kinds.size <= shapes.length, 'ids are a subset of shapes')
  return { shapes, style }
}

// The first colour is the default, as it was: black.
const legacy_colors: readonly SceneColor[] = scene_colors

function shape_read(reader: JsonReader, value: unknown, path: string): LegacyShape {
  const source = reader.object(value, path, keys_any)
  const kind = reader.choice(source, 'kind', path, legacy_kinds, true)
  const id = reader.text(source, 'id', path, 40, null)

  if (!shape_id_pattern.test(id)) reader.fail(`${path}.id`, 'Expected a saved shape id.')

  if (kind === 'ink') return ink_shape_read(reader, source, path, id)

  const color = reader.choice(source, 'color', path, legacy_colors, false)
  const size = reader.choice(source, 'size', path, legacy_sizes, false)
  const text_fallback = kind === 'text' ? null : ''
  const text = reader.text(source, 'text', path, proposal_text_length_max, text_fallback)

  if (kind === 'arrow') {
    const from = reader.text(source, 'from', path, 40, null)
    const to = reader.text(source, 'to', path, 40, null)
    return { kind, id, from, to, text, color, size, ...arrow_style_read(reader, source, path) }
  }

  const coordinate_max = proposal_coordinate_units_max
  const x = reader.number(source, 'x', path, -coordinate_max, coordinate_max)
  const y = reader.number(source, 'y', path, -coordinate_max, coordinate_max)

  if (kind === 'text') {
    const w =
      source.w === undefined || source.w === null
        ? null
        : reader.number(source, 'w', path, 1, proposal_extent_units_max)
    const align = reader.choice(source, 'align', path, legacy_text_aligns, false)
    return { kind, id, x, y, text, w, color, size, align }
  }

  const w = reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const h = reader.number(source, 'h', path, 1, proposal_extent_units_max)
  assert(kind === 'rectangle' || kind === 'ellipse', 'every kind is read')
  return { kind, id, x, y, w, h, text, color, size, ...geo_style_read(reader, source, path) }
}

// Kept pen strokes: where their box was put, and the strokes themselves, each checked against
// tldraw's own schema.
function ink_shape_read(reader: JsonReader, source: Json, path: string, id: string): LegacyShape {
  const coordinate_max = proposal_coordinate_units_max
  const x = reader.number(source, 'x', path, -coordinate_max, coordinate_max)
  const y = reader.number(source, 'y', path, -coordinate_max, coordinate_max)
  const items = reader.list(source.strokes, `${path}.strokes`, 1, scene_stroke_ids_count_max)
  const strokes = items.filter(
    (item): item is string => typeof item === 'string' && stroke_id_pattern.test(item),
  )

  if (strokes.length !== items.length) {
    reader.fail(`${path}.strokes`, 'Expected stroke ids such as "shape:abc".')
  }

  const ink = ink_strokes_read(reader, source.ink, `${path}.ink`, strokes.length)
  assert(ink.length <= strokes.length, 'at most one held stroke for each id')
  return { kind: 'ink', id, x, y, strokes, ink }
}

// Absent in a shape of the first format, so each control reads as its default there.
function geo_style_read(reader: JsonReader, source: Json, path: string) {
  const fill = reader.choice(source, 'fill', path, legacy_fills, false)
  const label_color =
    source.label_color === undefined || source.label_color === null
      ? null
      : reader.choice(source, 'label_color', path, legacy_colors, true)
  const label_align = reader.choice(source, 'label_align', path, legacy_label_aligns, false)
  const label_valign = reader.choice(source, 'label_valign', path, legacy_label_aligns, false)
  const label_bold = reader.boolean(source, 'label_bold', path, false)
  assert(legacy_fills.includes(fill), 'a fill is known')
  assert(legacy_label_aligns.includes(label_align), 'an alignment is known')
  return { fill, label_color, label_align, label_valign, label_bold }
}

function arrow_style_read(reader: JsonReader, source: Json, path: string) {
  const arrowheads = reader.choice(source, 'arrowheads', path, legacy_arrowheads, false)
  const route = reader.choice(source, 'route', path, legacy_routes, false)
  const bend_max = proposal_extent_units_max
  const bend =
    source.bend === undefined ? 0 : reader.number(source, 'bend', path, -bend_max, bend_max)
  const from_anchor = anchor_read(reader, source, 'from_anchor', path)
  const to_anchor = anchor_read(reader, source, 'to_anchor', path)
  assert(legacy_arrowheads.includes(arrowheads), 'arrowheads are known')
  assert(legacy_routes.includes(route), 'a route is known')
  return { arrowheads, route, bend, from_anchor, to_anchor }
}

function anchor_read(reader: JsonReader, source: Json, key: string, path: string): Anchor | null {
  assert(key.endsWith('_anchor'), 'an anchor field is named so')
  const value = source[key]

  if (value === undefined || value === null) return null

  const anchor = reader.object(value, `${path}.${key}`, ['x', 'y'])
  const result = {
    x: reader.number(anchor, 'x', `${path}.${key}`, 0, 1),
    y: reader.number(anchor, 'y', `${path}.${key}`, 0, 1),
  }
  assert(result.x >= 0 && result.x <= 1, 'an anchor is on its shape')
  return result
}

// The native records the board always served for a saved version: one shape for each saved
// shape, two bindings for each arrow, and a pen stroke for each stroke a drawing kept. A
// problem here means the saved shapes do not make a canvas this board may serve.
export function legacy_records(drawing: LegacyDrawing): TLRecord[] | string {
  const { shapes } = drawing
  assert(shapes.length <= proposal_shapes_count_max, 'a saved version is bounded')
  const centers = shape_centers(shapes)
  const records: TLRecord[] = []

  shapes.forEach((shape, index) => {
    const merged = shape.id.startsWith('a_')
    const style = merged ? (drawing.agent_style ?? drawing.style) : drawing.style
    const key = index_key(index)

    if (shape.kind === 'ink') {
      shape.ink.forEach((stroke, place) => records.push(ink_record(shape, stroke, place, key)))
      return
    }

    if (shape.kind !== 'arrow') return records.push(shape_record(shape, key, style))

    const from = centers.get(shape.from)
    const to = centers.get(shape.to)
    assert(from !== undefined && to !== undefined, 'a read arrow joins known shapes')
    records.push(arrow_record(shape, key, from, to, style))
    records.push(binding_record(shape.id, 'start', shape.from, shape.from_anchor))
    records.push(binding_record(shape.id, 'end', shape.to, shape.to_anchor))
  })

  if (!records.every((record) => record_valid(record, true))) {
    return 'A saved shape is not a valid tldraw record.'
  }

  let points_count = 0

  for (const record of records) points_count += shape_points_count(record as unknown as Json)

  if (points_count > ink_points_count_max) return 'A saved version holds too many pen samples.'

  return canvas_records_problem(records)?.message ?? records
}

function ink_record(
  shape: Extract<LegacyShape, { kind: 'ink' }>,
  stroke: InkStroke,
  place: number,
  index: string,
): TLRecord {
  assert(Number.isInteger(place) && place >= 0, 'a place is a whole number')
  assert(Number.isFinite(shape.x) && Number.isFinite(shape.y), 'a drawing has a position')
  const order = index_key_within(index, place)
  return {
    ...record_base(shape.id, order, shape.x + stroke.x, shape.y + stroke.y),
    id: `shape:cleaned-${shape.id}.${place}`,
    rotation: stroke.rotation,
    opacity: stroke.opacity,
    type: stroke.type,
    props: stroke.props,
  } as unknown as TLRecord
}

function shape_centers(shapes: readonly LegacyShape[]): Map<string, Anchor> {
  assert(shapes.length <= proposal_shapes_count_max, 'a saved version is bounded')
  const centers = new Map<string, Anchor>()

  for (const shape of shapes) {
    if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
      centers.set(shape.id, { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 })
    } else if (shape.kind === 'text') {
      centers.set(shape.id, { x: shape.x + (shape.w ?? 0) / 2, y: shape.y })
    }
  }

  assert(centers.size <= shapes.length, 'one center per shape at most')
  return centers
}

function legacy_shape_id(id: string): string {
  assert(shape_id_pattern.test(id), 'a saved shape id is well formed')
  const shape_id = `shape:cleaned-${id}`
  assert(shape_id.length <= 64, 'a saved shape id is short')
  return shape_id
}

// Plain is solid and sans; markerboard is tldraw's hand-drawn line and handwritten face.
function style_dash(style: LegacyStyle): 'solid' | 'draw' {
  const dash = style === 'markerboard' ? 'draw' : 'solid'
  assert(legacy_styles.includes(style), 'a style is known')
  assert((style === 'plain') === (dash === 'solid'), 'only the plain style keeps solid lines')
  return dash
}

function style_font(style: LegacyStyle): 'sans' | 'draw' {
  const font = style === 'markerboard' ? 'draw' : 'sans'
  assert(legacy_styles.includes(style), 'a style is known')
  assert((style === 'plain') === (font === 'sans'), 'only the plain style keeps the sans face')
  return font
}

function shape_record(
  shape: Exclude<LegacyShape, { kind: 'arrow' | 'ink' }>,
  index: string,
  style: LegacyStyle,
): TLRecord {
  assert(index.length >= 2, 'an index key has a head and a digit')
  const base = record_base(shape.id, index, shape.x, shape.y)
  const rich_text = toRichText(shape.text)
  const font = style_font(style)
  assert(font === 'sans' || font === 'draw', 'a legacy face is one of two')

  if (shape.kind === 'text') {
    const props = {
      color: shape.color,
      size: shape.size,
      font,
      textAlign: shape.align,
      w: shape.w ?? 8,
      richText: rich_text,
      scale: 1,
      autoSize: shape.w === null,
    }
    return { ...base, type: 'text', props } as unknown as TLRecord
  }

  const props = {
    geo: shape.kind,
    dash: style_dash(style),
    url: '',
    w: shape.w,
    h: shape.h,
    growY: 0,
    scale: 1,
    labelColor: shape.label_color ?? shape.color,
    color: shape.color,
    fill: shape.fill,
    size: shape.size,
    font,
    align: shape.label_align,
    verticalAlign: shape.label_valign,
    richText: shape.label_bold ? rich_text_bold(shape.text) : rich_text,
  }
  return { ...base, type: 'geo', props } as unknown as TLRecord
}

// The same paragraphs as `toRichText`, each run of words marked bold: a group's heading.
function rich_text_bold(text: string) {
  const plain = toRichText(text)
  const content = plain.content.map((value) => {
    const paragraph = value as { type: string; content?: Array<Record<string, unknown>> }
    const runs = paragraph.content

    if (runs === undefined) return paragraph

    return { ...paragraph, content: runs.map((run) => ({ ...run, marks: [{ type: 'bold' }] })) }
  })
  assert(content.length === plain.content.length, 'every paragraph is kept')
  assert(content.length === text.split('\n').length, 'one paragraph per line')
  return { ...plain, content }
}

// The arrow starts at its first shape's center; its bindings make tldraw draw it edge to edge.
function arrow_record(
  shape: Extract<LegacyShape, { kind: 'arrow' }>,
  index: string,
  from: Anchor,
  to: Anchor,
  style: LegacyStyle,
): TLRecord {
  assert(Number.isFinite(from.x) && Number.isFinite(from.y), 'the start is a point')
  assert(Number.isFinite(to.x) && Number.isFinite(to.y), 'the end is a point')
  const props = {
    kind: shape.route === 'elbow' ? 'elbow' : 'arc',
    labelColor: shape.color,
    color: shape.color,
    fill: 'none',
    dash: style_dash(style),
    size: shape.size,
    arrowheadStart: shape.arrowheads === 'both' ? 'arrow' : 'none',
    arrowheadEnd: shape.arrowheads === 'none' ? 'none' : 'arrow',
    font: style_font(style),
    start: { x: 0, y: 0 },
    end: { x: to.x - from.x, y: to.y - from.y },
    bend: shape.bend,
    richText: toRichText(shape.text),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
  }
  const base = record_base(shape.id, index, from.x, from.y)
  return { ...base, type: 'arrow', props } as unknown as TLRecord
}

function binding_record(
  arrow_id: string,
  terminal: 'start' | 'end',
  target_id: string,
  anchor: Anchor | null,
): TLRecord {
  const record = {
    id: `binding:cleaned-${arrow_id}-${terminal}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: legacy_shape_id(arrow_id),
    toId: legacy_shape_id(target_id),
    meta: {},
    props: {
      terminal,
      normalizedAnchor: anchor ?? { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: anchor !== null,
      snap: 'none',
    },
  }
  assert(record.fromId !== record.toId, 'a binding joins an arrow to another shape')
  assert(record.id.startsWith('binding:'), 'a binding id has the binding prefix')
  return record as unknown as TLRecord
}

function record_base(id: string, index: string, x: number, y: number) {
  assert(Number.isFinite(x) && Number.isFinite(y), 'a shape has a position')
  assert(index.length >= 2, 'an index key has a head and a digit')
  return {
    id: legacy_shape_id(id),
    typeName: 'shape',
    x,
    y,
    rotation: 0,
    index,
    parentId: cleaned_page_id,
    isLocked: false,
    opacity: 1,
    meta: {},
  }
}
