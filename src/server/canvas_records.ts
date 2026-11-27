// The native tldraw records of one Agent canvas, and what every canvas may hold. A canvas is
// shapes and arrow bindings on one page: text, geometric shapes, lines, pen strokes, arrows
// and groups. It never holds an image, a video, a bookmark, an embed, a link or an asset, so
// showing a canvas, or copying it into the sketch, loads nothing from anywhere.
//
// Records made here are checked against tldraw's own schema. Records read back from a saved
// canvas are untrusted like any input, and are checked the same way before they are served.

import { createTLSchema, type TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { cleaned_page_id, type CanvasRecord } from '../shared/canvas_types'
import { canvas_records_count_max, ink_points_count_max } from '../shared/constants'
import type { Problem } from '../shared/json_reader'

type Json = Record<string, unknown>

const schema = createTLSchema()
const index_digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// The only shapes a canvas holds. None of them can name a remote thing.
export const canvas_shape_types = [
  'text',
  'geo',
  'line',
  'draw',
  'highlight',
  'arrow',
  'group',
] as const

// Rich text is paragraphs of plain words, some of them bold. Nothing else is drawn.
const rich_text_node_types = ['doc', 'paragraph', 'text']
const rich_text_nodes_count_max = 8192

// Fractional index keys in order: a0..az, then b00..bzz. Plenty for the element limit.
export function index_key(index: number): string {
  const base = index_digits.length
  assert(Number.isInteger(index) && index >= 0, 'an index is a whole number')
  assert(index < base * base, 'an index fits two digits')

  if (index < base) return `a${index_digits[index]}`

  return `b${index_digits[Math.floor(index / base)]}${index_digits[index % base]}`
}

// An index for one of several records made from one element: it sorts after the element's
// earlier records and before the next element. A key followed by two digits and a closing
// letter is a valid fractional index between that key and the next.
export function index_key_within(index: string, place: number): string {
  const base = index_digits.length
  assert(index.length >= 2, 'an index key has a head and a digit')
  assert(Number.isInteger(place) && place >= 0 && place < base * base, 'a place fits two digits')
  return `${index}${index_digits[Math.floor(place / base)]}${index_digits[place % base]}V`
}

// `quiet` is for input that may simply be wrong, such as a saved record being read: there a
// failure is an ordinary problem for the caller to report, not a bug to put in the log.
export function record_valid(record: TLRecord, quiet = false): boolean {
  assert(record !== null && typeof record === 'object', 'a record to judge is an object')

  try {
    if (record.typeName === 'shape') schema.types.shape.validate(record)
    else if (record.typeName === 'binding') schema.types.binding.validate(record)
    else return false

    return true
  } catch (error) {
    if (!quiet) console.error(error)

    return false
  }
}

// Whether these records are a canvas this board may serve, or the first reason they are not.
// Used on records read from disk, and as the last check on records about to be saved.
export function canvas_records_problem(records: readonly CanvasRecord[]): Problem | null {
  if (records.length > canvas_records_count_max) {
    const message = `A canvas holds at most ${canvas_records_count_max} records.`
    return { path: 'records', message }
  }

  const shapes = new Map<string, Json>()
  const ids = new Set<string>()

  for (const [index, record] of records.entries()) {
    const problem = record_problem(record as unknown as Json, ids)

    if (problem !== null) return { path: `records[${index}]`, message: problem }

    ids.add(record.id)

    if (record.typeName === 'shape') shapes.set(record.id, record as unknown as Json)
  }

  const structure = structure_problem(records as unknown as readonly Json[], shapes)
  assert(shapes.size <= records.length, 'shapes are some of the records')
  assert(structure === null || structure.message.endsWith('.'), 'a problem is a sentence')
  return structure
}

// One record alone: a known kind of shape or an arrow binding, valid by tldraw's schema, with
// nothing remote in it.
function record_problem(record: Json | null, ids: ReadonlySet<string>): string | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return 'Expected a record.'
  }

  if (typeof record.id !== 'string' || ids.has(record.id)) return 'Record ids must be unique.'

  assert(!ids.has(record.id), 'a checked record has an id of its own')

  if (!record_valid(record as unknown as TLRecord, true)) return 'Not a valid tldraw record.'

  if (record.typeName === 'binding') return record.type === 'arrow' ? null : 'Not an arrow binding.'

  if (!canvas_shape_types.some((type) => type === record.type)) {
    return 'A canvas holds only text, shapes, lines, strokes, arrows and groups.'
  }

  const props = record.props as Json

  if (props.url !== undefined && props.url !== '') return 'A canvas holds no links.'

  if (props.richText !== undefined && !rich_text_plain(props.richText)) {
    return 'A canvas holds plain text only.'
  }

  assert(record.typeName === 'shape', 'a checked record is a shape or a binding')
  return null
}

// Paragraphs of text runs, each run plain or bold: what this board writes and nothing more.
// Walked with an explicit stack, bounded by the nodes it may visit.
function rich_text_plain(value: unknown): boolean {
  const pending: unknown[] = [value]
  let visited_count = 0

  while (pending.length > 0) {
    const node = pending.pop() as Json | null
    visited_count += 1

    if (visited_count > rich_text_nodes_count_max) return false

    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false

    if (!rich_text_node_types.includes(node.type as string)) return false

    const marks = (node.marks ?? []) as unknown

    if (!Array.isArray(marks) || !marks.every((mark) => (mark as Json | null)?.type === 'bold')) {
      return false
    }

    if (node.attrs !== undefined && !attrs_plain(node.attrs)) return false

    if (node.content === undefined) continue

    if (!Array.isArray(node.content)) return false

    for (const child of node.content as unknown[]) pending.push(child)
  }

  assert(visited_count <= rich_text_nodes_count_max, 'the walk is bounded')
  assert(visited_count > 0, 'the walk began at the root')
  return true
}

// tldraw gives a paragraph a text direction. No attribute carries an address.
function attrs_plain(attrs: unknown): boolean {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) return false

  const entries = Object.entries(attrs as Json)
  const plain = entries.every(
    ([key, value]) => key === 'dir' && (value === null || typeof value === 'string'),
  )
  assert(!plain || entries.length <= 1, 'plain attributes are a direction at most')
  return plain
}

// What only the whole set can show: every shape is on the page or in a group of this canvas,
// every binding joins an arrow to another shape here, and the pen samples are bounded.
function structure_problem(
  records: readonly Json[],
  shapes: ReadonlyMap<string, Json>,
): Problem | null {
  assert(shapes.size <= records.length, 'shapes are some of the records')
  let points_count = 0

  for (const [index, record] of records.entries()) {
    const path = `records[${index}]`

    if (record.typeName === 'binding') {
      const from = shapes.get(record.fromId as string)
      const to = shapes.get(record.toId as string)

      if (from?.type !== 'arrow' || to === undefined || to === from) {
        return { path, message: 'A binding joins an arrow to another shape of this canvas.' }
      }

      continue
    }

    const on_page = record.parentId === cleaned_page_id
    const parent = on_page ? null : shapes.get(record.parentId as string)

    if (parent !== null && parent?.type !== 'group') {
      return { path, message: 'A shape is on the page or in a group of this canvas.' }
    }

    points_count += shape_points_count(record)

    if (points_count > ink_points_count_max) {
      return { path, message: `A canvas keeps at most ${ink_points_count_max} pen samples.` }
    }
  }

  assert(points_count <= ink_points_count_max, 'pen samples are bounded')
  return null
}

// How many pen samples one shape record holds: none unless it is a pen stroke.
export function shape_points_count(record: Json): number {
  assert(record !== null && typeof record === 'object', 'a record is an object')
  const segments = (record.props as Json | undefined)?.segments
  let count = 0

  if (!Array.isArray(segments)) return 0

  for (const segment of segments as Array<Json | null>) {
    if (Array.isArray(segment?.points)) count += segment.points.length
  }

  assert(Number.isSafeInteger(count) && count >= 0, 'a count is a whole number')
  return count
}

// How many of these records are shapes: what a revision reports as its size.
export function canvas_shapes_count(records: readonly CanvasRecord[]): number {
  assert(Array.isArray(records), 'a canvas is a list of records')
  let count = 0

  for (const record of records) {
    if (record.typeName === 'shape') count += 1
  }

  assert(count <= records.length, 'shapes are some of the records')
  return count
}
