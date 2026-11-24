// An agent's cleanup proposal is untrusted data, never code. This module checks one completely
// before anything changes, and turns a valid one into native tldraw records. A proposal is a
// small structured description: text, rectangles, ellipses, and arrows bound to two of them.
//
// Reading never throws on bad input. The reader keeps the first problem it meets, with the path
// to it, and the caller reports that problem as an ordinary error.

import { createTLSchema, toRichText, type TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import {
  document_hash_pattern,
  proposal_coordinate_units_max,
  proposal_extent_units_max,
  proposal_shapes_count_max,
  proposal_summary_length_max,
  proposal_text_length_max,
} from '../shared/constants'
import {
  cleaned_page_id,
  proposal_colors,
  proposal_format,
  proposal_kinds,
  proposal_sizes,
  type Proposal,
  type ProposalShape,
} from '../shared/cleanup_types'

export type ProposalParsed =
  { ok: true; proposal: Proposal } | { ok: false; path: string; message: string }

type Json = Record<string, unknown>

const schema = createTLSchema()
const shape_id_pattern = /^[A-Za-z0-9_-]{1,40}$/
const agent_pattern = /^[A-Za-z0-9 ._:/-]{1,64}$/
const agent_default = 'external agent'
const keys_root = ['format', 'snapshot', 'base_revision', 'agent', 'summary', 'shapes'] as const
const keys_by_kind: Record<ProposalShape['kind'], readonly string[]> = {
  text: ['kind', 'id', 'x', 'y', 'text', 'w', 'color', 'size'],
  rectangle: ['kind', 'id', 'x', 'y', 'w', 'h', 'text', 'color', 'size'],
  ellipse: ['kind', 'id', 'x', 'y', 'w', 'h', 'text', 'color', 'size'],
  arrow: ['kind', 'id', 'from', 'to', 'text', 'color', 'size'],
}
const index_digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

class Reader {
  problem: { path: string; message: string } | null = null

  fail(path: string, message: string): void {
    assert(path.length > 0, 'a problem names where it is')
    assert(message.endsWith('.'), 'a problem is a full sentence')

    if (this.problem === null) this.problem = { path, message }
  }

  object(value: unknown, path: string, keys: readonly string[]): Json {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.fail(path, 'Expected a JSON object.')
      return {}
    }

    const unknown = Object.keys(value).find((key) => !keys.includes(key))

    if (unknown !== undefined) this.fail(`${path}.${unknown}`, 'Unknown field; see the schema.')

    assert(typeof value === 'object', 'an object was read')
    assert(keys.length > 0, 'an object has allowed fields')
    return value as Json
  }

  number(source: Json, key: string, path: string, min: number, max: number): number {
    assert(min < max, 'a number range is not empty')
    const value = source[key]

    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      this.fail(`${path}.${key}`, `Expected a number from ${min} to ${max}.`)
      return min
    }

    assert(value >= min && value <= max, 'a read number is in range')
    return value
  }

  text(source: Json, key: string, path: string, length_max: number, fallback: string | null) {
    assert(length_max > 0, 'a text bound is positive')
    const value = source[key]

    if (value === undefined && fallback !== null) return fallback

    if (typeof value !== 'string' || value.length > length_max) {
      this.fail(`${path}.${key}`, `Expected text of at most ${length_max} characters.`)
      return fallback ?? ''
    }

    assert(value.length <= length_max, 'read text is bounded')
    return value
  }

  // A missing optional choice takes the first option, which is its default.
  choice<T extends string>(
    source: Json,
    key: string,
    path: string,
    values: readonly T[],
    required: boolean,
  ): T {
    assert(values.length > 0, 'a choice has options')
    const value = required ? source[key] : (source[key] ?? values[0])
    const found = values.find((candidate) => candidate === value)

    if (found === undefined) {
      this.fail(`${path}.${key}`, `Expected one of: ${values.join(', ')}.`)
      return values[0] as T
    }

    assert(values.includes(found), 'a read choice is one of the options')
    return found
  }
}

export function proposal_parse(input: unknown): ProposalParsed {
  const reader = new Reader()
  const root = reader.object(input, 'proposal', keys_root)

  if (root.format !== proposal_format) {
    reader.fail('proposal.format', `Expected "${proposal_format}".`)
  }

  const snapshot = reader.text(root, 'snapshot', 'proposal', 16, null)

  if (!document_hash_pattern.test(snapshot)) {
    reader.fail('proposal.snapshot', 'Expected the snapshot token from cleanup-snapshot.')
  }

  const base_revision = reader.number(root, 'base_revision', 'proposal', 0, 2 ** 52)

  if (!Number.isInteger(base_revision)) {
    reader.fail('proposal.base_revision', 'Expected a whole revision number.')
  }

  const agent = reader.text(root, 'agent', 'proposal', 64, agent_default)

  if (!agent_pattern.test(agent)) {
    reader.fail('proposal.agent', 'Expected a short name of letters, digits and . _ - : /.')
  }

  const summary = reader.text(root, 'summary', 'proposal', proposal_summary_length_max, '')
  const shapes = shapes_read(reader, root.shapes)

  if (reader.problem !== null) return { ok: false, ...reader.problem }

  assert(shapes.length > 0, 'a valid proposal has shapes')
  assert(shapes.length <= proposal_shapes_count_max, 'a valid proposal is bounded')
  return { ok: true, proposal: { snapshot, base_revision, agent, summary, shapes } }
}

function shapes_read(reader: Reader, value: unknown): ProposalShape[] {
  const count_max = proposal_shapes_count_max

  if (!Array.isArray(value) || value.length === 0 || value.length > count_max) {
    reader.fail('proposal.shapes', `Expected a list of 1 to ${count_max} shapes.`)
    return []
  }

  const shapes = value.map((item, index) => shape_read(reader, item, `shapes[${index}]`))
  const kinds = new Map<string, ProposalShape['kind']>()
  shapes.forEach((shape, index) => {
    if (kinds.has(shape.id)) reader.fail(`shapes[${index}].id`, 'Shape ids must be unique.')

    kinds.set(shape.id, shape.kind)
  })
  shapes.forEach((shape, index) => {
    if (shape.kind !== 'arrow') return

    for (const end of ['from', 'to'] as const) {
      const kind = kinds.get(shape[end])

      if (kind === undefined || kind === 'arrow') {
        reader.fail(`shapes[${index}].${end}`, 'An arrow binds to a text, rectangle or ellipse.')
      }
    }

    if (shape.from === shape.to) reader.fail(`shapes[${index}].to`, 'An arrow joins two shapes.')
  })
  assert(shapes.length === value.length, 'every shape was read')
  assert(kinds.size <= shapes.length, 'ids are a subset of shapes')
  return shapes
}

function shape_read(reader: Reader, value: unknown, path: string): ProposalShape {
  const kind_source = reader.object(value, path, [
    'kind',
    'id',
    'x',
    'y',
    'w',
    'h',
    'text',
    'from',
    'to',
    'color',
    'size',
  ])
  const kind = reader.choice(kind_source, 'kind', path, proposal_kinds, true)
  const source = reader.object(value, path, keys_by_kind[kind])
  const id = reader.text(source, 'id', path, 40, null)

  if (!shape_id_pattern.test(id)) {
    reader.fail(`${path}.id`, 'Expected an id of letters, digits, _ or -.')
  }

  const color = reader.choice(source, 'color', path, proposal_colors, false)
  const size = reader.choice(source, 'size', path, proposal_sizes, false)
  const text_fallback = kind === 'text' ? null : ''
  const text = reader.text(source, 'text', path, proposal_text_length_max, text_fallback)

  if (kind === 'text' && text.trim().length === 0) reader.fail(`${path}.text`, 'Text is empty.')

  if (kind === 'arrow') {
    const from = reader.text(source, 'from', path, 40, null)
    const to = reader.text(source, 'to', path, 40, null)
    return { kind, id, from, to, text, color, size }
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
    return { kind, id, x, y, text, w, color, size }
  }

  const w = reader.number(source, 'w', path, 1, proposal_extent_units_max)
  const h = reader.number(source, 'h', path, 1, proposal_extent_units_max)
  assert(kind === 'rectangle' || kind === 'ellipse', 'every kind is read')
  return { kind, id, x, y, w, h, text, color, size }
}

// Native tldraw records for a valid proposal: one shape per proposal shape, and two bindings per
// arrow. Every record is checked against tldraw's own schema; a failure is a bug here.
export function proposal_records(shapes: readonly ProposalShape[]): TLRecord[] {
  assert(shapes.length > 0, 'a proposal has shapes')
  assert(shapes.length <= proposal_shapes_count_max, 'a proposal is bounded')
  const centers = new Map<string, { x: number; y: number }>()

  for (const shape of shapes) {
    if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
      centers.set(shape.id, { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 })
    } else if (shape.kind === 'text') {
      centers.set(shape.id, { x: shape.x + (shape.w ?? 0) / 2, y: shape.y })
    }
  }

  const records: TLRecord[] = []
  shapes.forEach((shape, index) => {
    if (shape.kind !== 'arrow') return records.push(shape_record(shape, index_key(index)))

    const from = centers.get(shape.from)
    const to = centers.get(shape.to)
    assert(from !== undefined && to !== undefined, 'a valid arrow joins known shapes')
    records.push(arrow_record(shape, index_key(index), from, to))
    records.push(binding_record(shape.id, 'start', shape.from))
    records.push(binding_record(shape.id, 'end', shape.to))
  })

  for (const record of records) assert(record_valid(record), `record ${record.id} is valid`)

  assert(records.length >= shapes.length, 'every shape has a record')
  return records
}

export function cleaned_shape_id(id: string): string {
  assert(shape_id_pattern.test(id), 'a proposal id is well formed')
  const shape_id = `shape:cleaned-${id}`
  assert(shape_id.length <= 64, 'a cleaned shape id is short')
  return shape_id
}

function shape_record(shape: ProposalShape, index: string): TLRecord {
  assert(shape.kind !== 'arrow', 'arrows have their own records')
  assert(index.length >= 2, 'an index key has a head and a digit')
  const base = record_base(shape.id, index, shape.x, shape.y)
  const rich_text = toRichText(shape.text)

  if (shape.kind === 'text') {
    return {
      ...base,
      type: 'text',
      props: {
        color: shape.color,
        size: shape.size,
        font: 'sans',
        textAlign: 'start',
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
      dash: 'solid',
      url: '',
      w: shape.w,
      h: shape.h,
      growY: 0,
      scale: 1,
      labelColor: shape.color,
      color: shape.color,
      fill: 'none',
      size: shape.size,
      font: 'sans',
      align: 'middle',
      verticalAlign: 'middle',
      richText: rich_text,
    },
  } as unknown as TLRecord
}

// The arrow starts at its first shape's center; its bindings make tldraw draw it edge to edge.
function arrow_record(
  shape: Extract<ProposalShape, { kind: 'arrow' }>,
  index: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): TLRecord {
  assert(Number.isFinite(from.x) && Number.isFinite(from.y), 'the start is a point')
  assert(Number.isFinite(to.x) && Number.isFinite(to.y), 'the end is a point')
  return {
    ...record_base(shape.id, index, from.x, from.y),
    type: 'arrow',
    props: {
      kind: 'arc',
      labelColor: shape.color,
      color: shape.color,
      fill: 'none',
      dash: 'solid',
      size: shape.size,
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      font: 'sans',
      start: { x: 0, y: 0 },
      end: { x: to.x - from.x, y: to.y - from.y },
      bend: 0,
      richText: toRichText(shape.text),
      labelPosition: 0.5,
      scale: 1,
      elbowMidPoint: 0.5,
    },
  } as unknown as TLRecord
}

function binding_record(arrow_id: string, terminal: 'start' | 'end', target_id: string) {
  const record = {
    id: `binding:cleaned-${arrow_id}-${terminal}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: cleaned_shape_id(arrow_id),
    toId: cleaned_shape_id(target_id),
    meta: {},
    props: {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
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

function record_valid(record: TLRecord): boolean {
  assert(record.typeName === 'shape' || record.typeName === 'binding', 'cleaned records are drawn')

  try {
    if (record.typeName === 'shape') schema.types.shape.validate(record)
    else schema.types.binding.validate(record)

    return true
  } catch (error) {
    console.error(error)
    return false
  }
}
