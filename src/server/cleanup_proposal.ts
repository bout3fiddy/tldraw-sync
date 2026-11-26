// An agent's cleanup proposal is untrusted data, never code. This module checks one completely
// before anything changes, and turns a valid one into native tldraw records. A proposal is a
// small structured description: text, rectangles, ellipses, and arrows bound to two of them.
//
// Two formats are read. v1 is what agents wrote by hand. v2 is what the command line composes
// from a semantic diagram: the same shapes with a few bounded styling and routing controls, and
// the diagram itself, which must agree with the shapes exactly (see `diagram_check.ts`).
//
// A v2 proposal may also keep parts of the sketch as they were drawn. On its way to the board
// such a drawing only names its strokes: the board copies them from the sketch (`cleaned_ink.ts`)
// and saves them with the version. A saved version is read back with its strokes, each checked
// against tldraw's own schema. A v2 proposal composed from an empty diagram has no shapes.
//
// Reading never throws on bad input. The reader keeps the first problem it meets, with the path
// to it, and the caller reports that problem as an ordinary error.

import { createTLSchema, toRichText, type TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import {
  diagram_stroke_ids_count_max,
  ink_points_count_max,
  proposal_coordinate_units_max,
  proposal_extent_units_max,
  proposal_shapes_count_max,
  proposal_text_length_max,
} from '../shared/constants'
import {
  cleaned_page_id,
  diagram_format,
  ink_stroke_types,
  proposal_arrowheads,
  proposal_colors,
  proposal_fills,
  proposal_format,
  proposal_format_styled,
  proposal_formats,
  proposal_kinds,
  proposal_kinds_styled,
  proposal_label_aligns,
  proposal_routes,
  proposal_sizes,
  proposal_styles,
  proposal_text_aligns,
  type InkStroke,
  type ProposalAnchor,
  type ProposalFill,
  type ProposalKind,
  type Proposal,
  type ProposalShape,
  type ProposalStyle,
} from '../shared/cleanup_types'
import { composition_check } from '../shared/diagram_check'
import { diagram_read } from '../shared/diagram_parse'
import { header_keys, header_read, JsonReader, type Json } from '../shared/json_reader'
import { style_font } from '../shared/text_measure'

export type ProposalParsed =
  { ok: true; proposal: Proposal } | { ok: false; path: string; message: string }

// Whether a drawing's strokes are only named, as on the way to the board, or held in full, as
// in a saved version.
export type InkMode = 'named' | 'held'

type InkShape = Extract<ProposalShape, { kind: 'ink' }>

const schema = createTLSchema()
const shape_id_pattern = /^[A-Za-z0-9_-]{1,40}$/
const stroke_id_pattern = /^shape:[A-Za-z0-9_-]{1,64}$/
const keys_root_v1 = [...header_keys, 'shapes'] as const
const keys_root_v2 = [...keys_root_v1, 'style', 'diagram'] as const
const keys_by_kind: Record<ProposalKind, readonly string[]> = {
  text: ['kind', 'id', 'x', 'y', 'text', 'w', 'color', 'size'],
  rectangle: ['kind', 'id', 'x', 'y', 'w', 'h', 'text', 'color', 'size'],
  ellipse: ['kind', 'id', 'x', 'y', 'w', 'h', 'text', 'color', 'size'],
  arrow: ['kind', 'id', 'from', 'to', 'text', 'color', 'size'],
}

// The styling and routing controls v2 adds to each kind. A v1 shape gets their defaults.
const keys_geo_style = ['fill', 'label_color', 'label_align', 'label_valign', 'label_bold']
const keys_styled_by_kind: Record<ProposalShape['kind'], readonly string[]> = {
  ink: ['kind', 'id', 'x', 'y', 'w', 'h', 'strokes', 'ink'],
  text: [...keys_by_kind.text, 'align'],
  rectangle: [...keys_by_kind.rectangle, ...keys_geo_style],
  ellipse: [...keys_by_kind.ellipse, ...keys_geo_style],
  arrow: [...keys_by_kind.arrow, 'arrowheads', 'route', 'bend', 'from_anchor', 'to_anchor'],
}
const keys_by_kind_any = [...new Set(Object.values(keys_by_kind).flat())]
const keys_any = [...new Set(Object.values(keys_styled_by_kind).flat())]
const index_digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function proposal_parse(input: unknown, ink: InkMode = 'named'): ProposalParsed {
  const reader = new JsonReader()
  const format = proposal_formats.find((candidate) => candidate === object_format(input))
  const styled = format === proposal_format_styled

  // The format decides every other rule, so a wrong one is the first problem reported.
  if (format === undefined) reader.fail('proposal.format', format_problem(object_format(input)))

  const root = reader.object(input, 'proposal', styled ? keys_root_v2 : keys_root_v1)

  const header = header_read(reader, root, 'proposal')
  const shapes = shapes_read(reader, root.shapes, styled, ink)

  // A v1 proposal, and a v2 one that names no style, is plain: as published before styles.
  const style: ProposalStyle = styled
    ? reader.choice(root, 'style', 'proposal', proposal_styles, false)
    : 'plain'
  const diagram =
    styled && root.diagram !== undefined ? diagram_read(reader, root.diagram, 'diagram') : null

  if (style === 'markerboard') markerboard_ink_check(reader, shapes)

  // Without a diagram there is nothing an empty proposal could mean, or a drawing belong to.
  if (diagram === null) undiagrammed_check(reader, shapes)

  if (reader.problem === null && diagram !== null) {
    const problem = composition_check(diagram, shapes, style_font(style))

    if (problem !== null) reader.fail(problem.path, problem.message)
  }

  if (reader.problem !== null) return { ok: false, ...reader.problem }

  assert(format !== undefined, 'a valid proposal names its format')
  assert(shapes.length <= proposal_shapes_count_max, 'a valid proposal is bounded')
  return { ok: true, proposal: { format, ...header, shapes, style, diagram } }
}

// A semantic diagram sent straight to the board is a common mistake: say how to publish one.
function format_problem(format: unknown): string {
  const expected = `Expected "${proposal_format}" or "${proposal_format_styled}".`
  const message =
    format === diagram_format
      ? `${expected} Publish a semantic diagram with tldraw-sync cleanup-publish, which lays ` +
        'it out first.'
      : expected
  assert(message.endsWith('.'), 'a problem is a full sentence')
  assert(message.startsWith('Expected'), 'a format problem names what is expected')
  return message
}

function object_format(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined

  return (input as Json).format
}

// Without a diagram, a proposal is the shapes an agent chose by hand: at least one, and none
// of them a drawing, which only a diagram's drawing node can name.
function undiagrammed_check(reader: JsonReader, shapes: readonly ProposalShape[]): void {
  const count_max = proposal_shapes_count_max
  assert(shapes.length <= count_max, 'shapes are bounded')

  if (shapes.length === 0) {
    reader.fail('proposal.shapes', `Expected a list of 1 to ${count_max} shapes.`)
  }

  const index = shapes.findIndex((shape) => shape.kind === 'ink')

  if (index >= 0) {
    reader.fail(`shapes[${index}].kind`, 'A drawing is published with its semantic diagram.')
  }

  assert(index < shapes.length, 'a found shape is one of the shapes')
}

function shapes_read(
  reader: JsonReader,
  value: unknown,
  styled: boolean,
  ink: InkMode,
): ProposalShape[] {
  const count_max = proposal_shapes_count_max

  // Only a styled proposal can have no shapes: the composition of an empty diagram.
  if (!Array.isArray(value) || value.length > count_max || (value.length === 0 && !styled)) {
    reader.fail('proposal.shapes', `Expected a list of 1 to ${count_max} shapes.`)
    return []
  }

  const shapes = value.map((item, index) =>
    shape_read(reader, item, `shapes[${index}]`, styled, ink),
  )

  if (ink_points_count(shapes) > ink_points_count_max) {
    reader.fail('proposal.shapes', `Drawings keep at most ${ink_points_count_max} pen samples.`)
  }

  const kinds = new Map<string, ProposalShape['kind']>()
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
  return shapes
}

function shape_read(
  reader: JsonReader,
  value: unknown,
  path: string,
  styled: boolean,
  ink: InkMode,
): ProposalShape {
  const kind_source = reader.object(value, path, styled ? keys_any : keys_by_kind_any)
  const kinds: readonly ProposalShape['kind'][] = styled ? proposal_kinds_styled : proposal_kinds
  const kind = reader.choice(kind_source, 'kind', path, kinds, true)
  const keys = styled || kind === 'ink' ? keys_styled_by_kind[kind] : keys_by_kind[kind]
  const source = reader.object(value, path, keys)
  const id = reader.text(source, 'id', path, 40, null)

  if (!shape_id_pattern.test(id)) {
    reader.fail(`${path}.id`, 'Expected an id of letters, digits, _ or -.')
  }

  if (kind === 'ink') return ink_shape_read(reader, source, path, id, ink)

  const color = reader.choice(source, 'color', path, proposal_colors, false)
  const size = reader.choice(source, 'size', path, proposal_sizes, false)
  const text_fallback = kind === 'text' ? null : ''
  const text = reader.text(source, 'text', path, proposal_text_length_max, text_fallback)

  if (kind === 'text' && text.trim().length === 0) reader.fail(`${path}.text`, 'Text is empty.')

  if (kind === 'arrow') {
    const from = reader.text(source, 'from', path, 40, null)
    const to = reader.text(source, 'to', path, 40, null)
    return { kind, id, from, to, text, color, size, ...arrow_style_read(reader, source, path) }
  }

  const coordinate_max = proposal_coordinate_units_max
  const x = reader.number(source, 'x', path, -coordinate_max, coordinate_max)
  const y = reader.number(source, 'y', path, -coordinate_max, coordinate_max)

  if (kind === 'text') {

    // Without a width, text sizes itself to its content.
    const w =
      source.w === undefined || source.w === null
        ? null
        : reader.number(source, 'w', path, 1, proposal_extent_units_max)
    const align = reader.choice(source, 'align', path, proposal_text_aligns, false)
    return { kind, id, x, y, text, w, color, size, align }
  }

  const w = reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const h = reader.number(source, 'h', path, 1, proposal_extent_units_max)
  assert(kind === 'rectangle' || kind === 'ellipse', 'every kind is read')
  return { kind, id, x, y, w, h, text, color, size, ...geo_style_read(reader, source, path) }
}

// A drawing: the box its strokes fill and the ids of those strokes. Only a saved version holds
// the strokes themselves. A proposal on its way to the board must not carry any: the board takes
// them from the sketch and from nowhere else.
function ink_shape_read(
  reader: JsonReader,
  source: Json,
  path: string,
  id: string,
  mode: InkMode,
): InkShape {
  const coordinate_max = proposal_coordinate_units_max
  const x = reader.number(source, 'x', path, -coordinate_max, coordinate_max)
  const y = reader.number(source, 'y', path, -coordinate_max, coordinate_max)
  const w = reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const h = reader.number(source, 'h', path, 1, proposal_extent_units_max)
  const items = reader.list(source.strokes, `${path}.strokes`, 1, diagram_stroke_ids_count_max)
  const strokes = items.filter(
    (item): item is string => typeof item === 'string' && stroke_id_pattern.test(item),
  )

  if (strokes.length !== items.length || new Set(strokes).size !== strokes.length) {
    reader.fail(`${path}.strokes`, 'Expected different stroke ids such as "shape:abc".')
  }

  assert(strokes.length <= diagram_stroke_ids_count_max, 'stroke ids are bounded')

  if (mode === 'named') {
    if (source.ink !== undefined && source.ink !== null) {
      reader.fail(`${path}.ink`, 'The board copies the strokes from the sketch: send only ids.')
    }

    return { kind: 'ink', id, x, y, w, h, strokes, ink: null }
  }

  const ink = ink_strokes_read(reader, source.ink, `${path}.ink`, strokes.length)
  assert(ink.length <= strokes.length, 'at most one held stroke for each id')
  return { kind: 'ink', id, x, y, w, h, strokes, ink }
}

// The strokes a drawing holds, one for each id it names, each a stroke tldraw can draw. The
// board checks the strokes it copies from the sketch with this too, before it saves them, so
// whatever is saved reads back.
export function ink_strokes_read(
  reader: JsonReader,
  value: unknown,
  path: string,
  count: number,
): InkStroke[] {
  assert(count >= 0 && count <= diagram_stroke_ids_count_max, 'held strokes are bounded')

  if (!Array.isArray(value) || value.length !== count) {
    reader.fail(path, `Expected the ${count} strokes this drawing names.`)
    return []
  }

  const strokes = value.map((item, index) => ink_stroke_read(reader, item, `${path}[${index}]`))
  assert(strokes.length === count, 'every held stroke was read')
  return strokes
}

// Rotation is in radians. A stroke turned by hand stays within a few turns.
const ink_rotation_max = 1000

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
  if (reader.problem === null && !record_valid(ink_record('check', stroke, 0, 'a0', 0, 0), true)) {
    reader.fail(`${path}.props`, 'Expected the props of a tldraw pen stroke.')
  }

  assert(ink_stroke_types.includes(type), 'a held stroke is a pen stroke')
  assert(opacity >= 0 && opacity <= 1, 'a read opacity is a fraction')
  return stroke
}

// How many pen samples the drawings of these shapes hold. Zero while strokes are only named.
export function ink_points_count(shapes: readonly ProposalShape[]): number {
  let count = 0

  for (const shape of shapes) {
    if (shape.kind !== 'ink' || shape.ink === null) continue

    for (const stroke of shape.ink) {
      const segments = Array.isArray(stroke.props.segments) ? stroke.props.segments : []

      for (const segment of segments as Array<Json | null>) {
        if (Array.isArray(segment?.points)) count += segment.points.length
      }
    }
  }

  assert(Number.isSafeInteger(count) && count >= 0, 'a count is a whole number')
  assert(shapes.length <= proposal_shapes_count_max, 'shapes are bounded')
  return count
}

// Absent in a v1 shape, so each control reads as its default there.
function geo_style_read(reader: JsonReader, source: Json, path: string) {
  const fill = reader.choice(source, 'fill', path, proposal_fills, false)
  const label_color =
    source.label_color === undefined || source.label_color === null
      ? null
      : reader.choice(source, 'label_color', path, proposal_colors, true)
  const label_align = reader.choice(source, 'label_align', path, proposal_label_aligns, false)
  const label_valign = reader.choice(source, 'label_valign', path, proposal_label_aligns, false)
  const label_bold = reader.boolean(source, 'label_bold', path, false)
  assert(proposal_fills.includes(fill), 'a fill is known')
  assert(proposal_label_aligns.includes(label_align), 'an alignment is known')
  return { fill, label_color, label_align, label_valign, label_bold }
}

function arrow_style_read(reader: JsonReader, source: Json, path: string) {
  const arrowheads = reader.choice(source, 'arrowheads', path, proposal_arrowheads, false)
  const route = reader.choice(source, 'route', path, proposal_routes, false)
  const bend_max = proposal_extent_units_max
  const bend =
    source.bend === undefined ? 0 : reader.number(source, 'bend', path, -bend_max, bend_max)

  if (route === 'elbow' && bend !== 0) reader.fail(`${path}.bend`, 'Only an arc bends.')

  const from_anchor = anchor_read(reader, source, 'from_anchor', path)
  const to_anchor = anchor_read(reader, source, 'to_anchor', path)
  assert(proposal_arrowheads.includes(arrowheads), 'arrowheads are known')
  assert(proposal_routes.includes(route), 'a route is known')
  return { arrowheads, route, bend, from_anchor, to_anchor }
}

function anchor_read(reader: JsonReader, source: Json, key: string, path: string) {
  assert(key.endsWith('_anchor'), 'an anchor field is named so')
  const value = source[key]

  if (value === undefined || value === null) return null

  const anchor = reader.object(value, `${path}.${key}`, ['x', 'y'])
  const result: ProposalAnchor = {
    x: reader.number(anchor, 'x', `${path}.${key}`, 0, 1),
    y: reader.number(anchor, 'y', `${path}.${key}`, 0, 1),
  }
  assert(result.x >= 0 && result.x <= 1, 'an anchor is on its shape')
  return result
}

// The markerboard is thin black ink on white: every outline, connector and word is black, and a
// box or oval is left open or given tldraw's white surface. A markerboard proposal that asks for
// anything else is refused, so the style can never paint a colour, tint or grey surface.
const markerboard_fills: readonly ProposalFill[] = ['none', 'semi']

function markerboard_ink_check(reader: JsonReader, shapes: readonly ProposalShape[]): void {
  assert(shapes.length <= proposal_shapes_count_max, 'shapes are bounded')
  assert(
    markerboard_fills.every((fill) => proposal_fills.includes(fill)),
    'fills are known',
  )

  for (const [index, shape] of shapes.entries()) {
    const path = `shapes[${index}]`

    // A drawing is the person's own ink, in the colours they drew it in. Nothing is painted.
    if (shape.kind === 'ink') continue

    if (shape.color !== 'black') {
      reader.fail(`${path}.color`, 'A markerboard is drawn in black ink only.')
    }

    if (shape.kind !== 'rectangle' && shape.kind !== 'ellipse') continue

    if (shape.label_color !== null && shape.label_color !== 'black') {
      reader.fail(`${path}.label_color`, 'A markerboard is drawn in black ink only.')
    }

    if (!markerboard_fills.includes(shape.fill)) {
      reader.fail(`${path}.fill`, 'A markerboard shape is open or white: fill none or semi.')
    }
  }
}

// What the renderer draws: the validated shapes and the style to draw them in.
export type Drawing = Pick<Proposal, 'shapes' | 'style'> & { agent_style?: ProposalStyle }

// Native tldraw records for a valid proposal: one shape per proposal shape and two bindings per
// arrow, nothing else, except that a drawing gives one native pen stroke for each stroke it
// holds. Every record is checked against tldraw's own schema; a failure is a bug here. A plain
// drawing gets exactly the records it always did, so earlier revisions render unchanged; a
// markerboard differs only in its dash and lettering face.
export function proposal_records(drawing: Drawing): TLRecord[] {
  const { shapes } = drawing
  assert(shapes.length <= proposal_shapes_count_max, 'a proposal is bounded')
  const centers = shape_centers(shapes)
  const records: TLRecord[] = []
  let strokes_count = 0

  shapes.forEach((shape, index) => {
    const style = shape.id.startsWith('a_') ? (drawing.agent_style ?? drawing.style) : drawing.style

    if (shape.kind === 'ink') {
      assert(shape.ink !== null, 'a published drawing holds its strokes')
      const { id, x, y } = shape
      const key = index_key(index)
      shape.ink.forEach((stroke, place) => records.push(ink_record(id, stroke, place, key, x, y)))
      strokes_count += shape.ink.length
      return
    }

    if (shape.kind !== 'arrow') return records.push(shape_record(shape, index_key(index), style))

    const from = centers.get(shape.from)
    const to = centers.get(shape.to)
    assert(from !== undefined && to !== undefined, 'a valid arrow joins known shapes')
    records.push(arrow_record(shape, index_key(index), from, to, style))
    records.push(binding_record(shape.id, 'start', shape.from, shape.from_anchor))
    records.push(binding_record(shape.id, 'end', shape.to, shape.to_anchor))
  })

  for (const record of records) assert(record_valid(record), `record ${record.id} is valid`)

  const arrows_count = shapes.filter((shape) => shape.kind === 'arrow').length
  const drawings_count = shapes.filter((shape) => shape.kind === 'ink').length
  assert(
    records.length === shapes.length - drawings_count + strokes_count + arrows_count * 2,
    'a shape each, two bindings an arrow, and a stroke for each a drawing holds',
  )
  return records
}

// One kept stroke as a native tldraw shape: the stroke as it was drawn, moved with its drawing.
// Its id joins the drawing's id and the stroke's place with a dot, which no proposal id holds,
// so it meets no other shape's. Its index sorts it after the drawing's earlier strokes and
// before the next shape: an index key followed by two digits and a closing letter is a valid
// fractional index between that key and the next.
function ink_record(
  drawing_id: string,
  stroke: InkStroke,
  place: number,
  index: string,
  x: number,
  y: number,
): TLRecord {
  const base = index_digits.length
  assert(Number.isInteger(place) && place >= 0 && place < base * base, 'a place fits two digits')
  assert(Number.isFinite(x) && Number.isFinite(y), 'a drawing has a position')
  const order = `${index}${index_digits[Math.floor(place / base)]}${index_digits[place % base]}V`
  return {
    ...record_base(drawing_id, order, x + stroke.x, y + stroke.y),
    id: `shape:cleaned-${drawing_id}.${place}`,
    rotation: stroke.rotation,
    opacity: stroke.opacity,
    type: stroke.type,
    props: stroke.props,
  } as unknown as TLRecord
}

function shape_centers(shapes: readonly ProposalShape[]): Map<string, { x: number; y: number }> {
  assert(shapes.length <= proposal_shapes_count_max, 'a proposal is bounded')
  const centers = new Map<string, { x: number; y: number }>()

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

export function cleaned_shape_id(id: string): string {
  assert(shape_id_pattern.test(id), 'a proposal id is well formed')
  const shape_id = `shape:cleaned-${id}`
  assert(shape_id.length <= 64, 'a cleaned shape id is short')
  return shape_id
}

// How each style draws: plain is solid and sans, markerboard is tldraw's fine hand-drawn line,
// with gently rounded corners and slightly imperfect ovals, and its upright handwritten face.
// Both are tldraw's own deterministic renderings, seeded by the shape's id.
function style_dash(style: ProposalStyle): 'solid' | 'draw' {
  const dash = style === 'markerboard' ? 'draw' : 'solid'
  assert(proposal_styles.includes(style), 'a style is known')
  assert((style === 'plain') === (dash === 'solid'), 'only the plain style keeps solid lines')
  return dash
}

function shape_record(
  shape: Exclude<ProposalShape, { kind: 'arrow' | 'ink' }>,
  index: string,
  style: ProposalStyle,
): TLRecord {
  assert(proposal_kinds.includes(shape.kind), 'arrows and drawings have their own records')
  assert(index.length >= 2, 'an index key has a head and a digit')
  const base = record_base(shape.id, index, shape.x, shape.y)
  const rich_text = toRichText(shape.text)
  const font = style_font(style)

  if (shape.kind === 'text') {
    return {
      ...base,
      type: 'text',
      props: {
        color: shape.color,
        size: shape.size,
        font,
        textAlign: shape.align,
        w: shape.w ?? 8,
        richText: rich_text,
        scale: 1,
        autoSize: shape.w === null,
      },
    } as unknown as TLRecord
  }

  return {
    ...base,
    type: 'geo',
    props: {
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
    },
  } as unknown as TLRecord
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
  shape: Extract<ProposalShape, { kind: 'arrow' }>,
  index: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  style: ProposalStyle,
): TLRecord {
  assert(Number.isFinite(from.x) && Number.isFinite(from.y), 'the start is a point')
  assert(Number.isFinite(to.x) && Number.isFinite(to.y), 'the end is a point')
  return {
    ...record_base(shape.id, index, from.x, from.y),
    type: 'arrow',
    props: {
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
    },
  } as unknown as TLRecord
}

// A null anchor aims at the center, as v1 arrows do. A precise anchor is where the composer's
// router attached the connection, so tldraw leaves and enters each shape on that side.
function binding_record(
  arrow_id: string,
  terminal: 'start' | 'end',
  target_id: string,
  anchor: ProposalAnchor | null,
) {
  const record = {
    id: `binding:cleaned-${arrow_id}-${terminal}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: cleaned_shape_id(arrow_id),
    toId: cleaned_shape_id(target_id),
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
    id: cleaned_shape_id(id),
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

// Fractional index keys in order: a0..az, then b00..bzz. Plenty for the shape limit.
export function index_key(index: number): string {
  const base = index_digits.length
  assert(Number.isInteger(index) && index >= 0, 'an index is a whole number')
  assert(index < base * base, 'an index fits two digits')

  if (index < base) return `a${index_digits[index]}`

  return `b${index_digits[Math.floor(index / base)]}${index_digits[index % base]}`
}

// `quiet` is for input that may simply be wrong, such as a held stroke being read: there a
// failure is an ordinary problem for the caller to report, not a bug to put in the log.
function record_valid(record: TLRecord, quiet = false): boolean {
  assert(record.typeName === 'shape' || record.typeName === 'binding', 'cleaned records are drawn')

  try {
    if (record.typeName === 'shape') schema.types.shape.validate(record)
    else schema.types.binding.validate(record)

    return true
  } catch (error) {
    if (!quiet) console.error(error)

    return false
  }
}
