// The pure half of a native rehearsal (`native_rehearsal.ts`): what the shared scene of the
// native copy holds, made from the legacy board's room and its Agent canvas as shown now.
//
// Every record of the room is kept exactly as saved: the person's strokes, the page and the
// document. A legacy board draws the Agent canvas as a print under the person's ink, in one
// camera (`src/client/surface.tsx`), so its shapes join the same page below every stroke, each
// where the agent put it, in the canvas's own order. Only the index of a shape directly on the
// page changes, to stack it under the sketch; a group's children keep theirs. Nothing is laid
// out, recoloured or dropped. Anything this cannot place without guessing is refused instead.
//
// A canvas whose views differ is carried whole: every element of every view becomes its record
// as the publish made it, with the id each view gives it, marked with the views it is shown in
// (`src/shared/native_views.ts`), and the controls go on the document. Each device then shows
// its own view of the same records, so no hidden element is left behind and no view is saved.

import type { TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { cleaned_page_id, type CanvasRecord } from '../shared/canvas_types'
import { canvas_records_count_max, scene_controls_count_max } from '../shared/constants'
import { view_controls_key, view_shape_key, shape_view_json } from '../shared/native_views'
import { scene_controls_write, type SceneControl } from '../shared/scene_controls'
import type { SceneElement } from '../shared/scene_types'
import { scene_static } from '../shared/scene_view'
import { record_valid } from './canvas_records'
import type { Json } from './canvas_state'
import { room_records_max, type RoomSnapshotLike } from './native_scene_ledger'
import { scene_records, scene_shape_id } from './scene_records'

// A saved room: what the sync room needs besides the fields the ledger reads.
export type RoomSaved = RoomSnapshotLike & { readonly schema?: unknown }

// The current revision of a canvas whose views differ: its controls and its whole scene.
export type CanvasViews = {
  readonly controls: readonly SceneControl[]
  readonly scene: readonly SceneElement[]
}

export type RoomPlan =
  | { readonly ok: true; readonly snapshot: RoomSaved; readonly agent: readonly TLRecord[] }
  | { readonly ok: false; readonly kind: PlanRefusal; readonly message: string }

export type PlanRefusal = 'board_ambiguous' | 'board_unsupported'

// Fractional index keys (tldraw's, compared as plain strings) are an integer part and a
// fraction. The integer's first letter gives its length: `a`..`z` hold 1..26 more digits and
// count up, `A`..`Z` hold 26..1 and count down below `a0`. A fraction never ends in zero.
const index_digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const digits_count = index_digits.length
const digit_last = index_digits[digits_count - 1] as string

// The lowest integer is reserved by the format: nothing is placed at or below it.
const integer_reserved = `A${'0'.repeat(26)}`

// A suffix is three digits, the last never zero, so it is a valid fraction.
const suffix_last_count = digits_count - 1
const suffixes_count_max = digits_count * digits_count * suffix_last_count

// The key tldraw gives a first shape: a sketch with no strokes still stacks below it.
const index_floor = 'a1'

assert(index_digits.length === 62, 'base-62 digits')
assert(canvas_records_count_max < suffixes_count_max, 'every canvas shape gets its own key')

// `controls` are those of a canvas whose views differ, whose records `canvas_views_records`
// made; none for a canvas of one view.
export function room_plan(
  room: RoomSaved,
  canvas: readonly CanvasRecord[],
  controls: readonly SceneControl[] = [],
): RoomPlan {
  assert(canvas.length <= canvas_records_count_max, 'a served canvas is bounded')
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  assert(Array.isArray(room.documents), 'a saved room has documents')
  const states = room.documents.map((document) => document.state as Json)
  const pages = states.filter((state) => state.typeName === 'page')

  // The canvas is drawn on its own page, which matches the sketch's only page by id. A room
  // with other pages would leave the canvas's place a guess.
  if (pages.length !== 1 || pages[0]?.id !== cleaned_page_id) {
    return refused('board_ambiguous', 'The sketch must have exactly its one original page.')
  }

  const ids = new Set(states.map((state) => state.id as string))
  const taken = canvas.find((record) => ids.has(record.id))

  if (taken !== undefined) {
    return refused('board_ambiguous', `The sketch and the Agent canvas both use ${taken.id}.`)
  }

  // The views are told apart by marks no sketch has: one already there would be a guess.
  const marked = controls.length === 0 ? null : views_marked(states)

  if (marked !== null) return refused('board_ambiguous', marked)

  if (states.length + canvas.length > room_records_max) {
    const message = `A native scene holds at most ${room_records_max} records.`
    return refused('board_unsupported', message)
  }

  const bottom = index_bottom(states)

  if (bottom === null) return refused('board_ambiguous', 'A sketch index is malformed.')

  const below = integer_below(bottom)

  if (below === null) return refused('board_ambiguous', 'The sketch has no room below it.')

  const agent = canvas_stacked(canvas, below)
  const clock = Math.max(room.clock, room.documentClock ?? 0) + 1
  const added = agent.map((state) => ({ state, lastChangedClock: clock }))
  const documents = room.documents.map((document) =>
    controls.length > 0 && (document.state as Json).typeName === 'document'
      ? { state: document_with_controls(document.state as Json, controls), lastChangedClock: clock }
      : document,
  )
  const snapshot: RoomSaved = {
    ...room,
    clock,
    documentClock: clock,
    documents: [...documents, ...added],
  }
  assert(snapshot.documents.length === room.documents.length + canvas.length, 'nothing dropped')
  assert(Number.isSafeInteger(clock) && clock > room.clock, 'the clock moves forward')
  return { ok: true, snapshot, agent }
}

// Every record of every view of the canvas, as the publish makes each (`scene_records.ts`),
// each shape marked with the views it is shown in and what a tap on it chooses. A record is
// the same in each view that shows it but for its parent: a group a view dissolves still
// holds it here, and since positions follow the parent, it stays where every view puts it.
export function canvas_views_records(views: CanvasViews): TLRecord[] {
  assert(views.controls.length > 0, 'a canvas with views has controls')
  assert(!scene_static(views.scene), 'a canvas with views hides something in some view')
  const by_shape = new Map<string, SceneElement>()

  for (const element of views.scene) by_shape.set(scene_shape_id(element.id), element)

  const records = scene_records(views.scene).map((record) => {
    if (record.typeName !== 'shape') return record

    // A copied sketch stroke is `<id>.<n>`: every stroke of one element is shown with it.
    const element = by_shape.get(record.id.split('.')[0] as string)
    assert(element !== undefined, 'every shape is made from an element')
    const view = shape_view_json(element)

    if (view === null) return record

    return { ...record, meta: { ...record.meta, [view_shape_key]: view } } as TLRecord
  })
  assert(records.length <= canvas_records_count_max, 'a whole scene is a canvas this board serves')
  return records
}

// Why the sketch cannot hold views told apart by these marks, or null when it can: it has no
// document to keep the controls on, or something in it already bears one of the marks.
function views_marked(states: readonly Json[]): string | null {
  const document = states.find((state) => state.typeName === 'document')

  if (document === undefined) return 'The sketch has no document record to keep its views on.'

  for (const state of states) {
    const meta = (state.meta ?? {}) as Json

    if (Object.hasOwn(meta, view_controls_key) || Object.hasOwn(meta, view_shape_key)) {
      return `The sketch record ${String(state.id).slice(0, 80)} already marks views.`
    }
  }

  assert(document.typeName === 'document', 'the document was found')
  return null
}

function document_with_controls(document: Json, controls: readonly SceneControl[]): Json {
  assert(document.typeName === 'document', 'controls are kept on the document')
  const meta = (document.meta ?? {}) as Json
  assert(!Object.hasOwn(meta, view_controls_key), 'the document had no controls')
  const kept = scene_controls_write(controls)
  const written: Json = { ...document, meta: { ...meta, [view_controls_key]: kept } }
  assert(written.id === document.id && kept.length === controls.length, 'only the meta grows')
  return written
}

// The canvas, with each shape directly on the page keyed within `integer`, which sorts below
// every stroke, in the canvas's own order. Every other record is the same object it was.
function canvas_stacked(canvas: readonly CanvasRecord[], integer: string): TLRecord[] {
  const on_page = canvas
    .filter((record) => record.typeName === 'shape' && parent_of(record) === cleaned_page_id)
    .sort((a, b) => index_compare(index_of(a), index_of(b)))
  const keys = new Map(on_page.map((record, place) => [record.id, index_within(integer, place)]))
  const stacked = canvas.map((record) => {
    const key = keys.get(record.id)
    return (key === undefined ? record : { ...record, index: key }) as TLRecord
  })

  // tldraw's own schema checks every key, so a malformed one can never be saved.
  for (const record of stacked) assert(record_valid(record, true), 'a stacked record is valid')

  assert(stacked.length === canvas.length, 'every canvas record is kept')
  return stacked
}

// The integer part of the lowest key among the shapes directly on the sketch's page, or null
// when a saved key does not even have an integer part.
function index_bottom(states: readonly Json[]): string | null {
  let bottom = index_floor

  for (const state of states) {
    if (state.typeName !== 'shape' || state.parentId !== cleaned_page_id) continue

    const index = state.index

    if (typeof index !== 'string' || !index_shaped(index)) return null

    if (index < bottom) bottom = index
  }

  const integer = bottom.slice(0, integer_length(bottom))
  assert(integer.length >= 2 && integer <= bottom, 'an integer part begins its key')
  assert(bottom <= index_floor, 'the bottom is never above the first key')
  return integer
}

// The integer one below `integer`, or null at the reserved bottom. Counting down past a run of
// zeros moves to the previous letter, whose integers sort below every one of this letter's.
function integer_below(integer: string): string | null {
  const head = integer[0] as string
  const digits = [...integer.slice(1)]
  assert(digits.length === integer_length(integer) - 1, 'an integer has its full length')
  let place = digits.length - 1

  while (place >= 0 && digits[place] === '0') {
    digits[place] = digit_last
    place -= 1
  }

  if (place >= 0) {
    const digit = index_digits.indexOf(digits[place] as string)
    digits[place] = index_digits[digit - 1] as string
    const below = head + digits.join('')
    return below === integer_reserved ? null : below
  }

  if (head === 'A') return null

  const previous = head === 'a' ? 'Z' : String.fromCharCode(head.charCodeAt(0) - 1)
  const below = previous + digit_last.repeat(integer_length(previous) - 1)
  assert(below < integer, 'the previous letter sorts below')
  return below
}

// Whether untrusted text has the shape of a key: digits after a letter, as many as it needs.
function index_shaped(index: string): boolean {
  if (!/^[A-Za-z][0-9A-Za-z]{1,64}$/.test(index)) return false

  assert(index.length >= 2, 'a shaped key has a head and a digit')
  return index.length >= integer_length(index)
}

// How many characters the integer part of a key starting with `key[0]` has.
function integer_length(key: string): number {
  const head = key.charCodeAt(0)
  const lower = head >= 'a'.charCodeAt(0) && head <= 'z'.charCodeAt(0)
  const upper = head >= 'A'.charCodeAt(0) && head <= 'Z'.charCodeAt(0)
  assert(lower || upper, 'a key begins with a letter')
  const length = lower ? head - 'a'.charCodeAt(0) + 2 : 'Z'.charCodeAt(0) - head + 2
  assert(length >= 2 && length <= 27, 'an integer has a head and one to 26 digits')
  return length
}

// A key within `integer`: three fraction digits, the last never zero, in the order of `place`.
function index_within(integer: string, place: number): string {
  assert(Number.isSafeInteger(place) && place >= 0, 'a place is a whole number')
  assert(place < suffixes_count_max, 'a place fits three digits')
  const rest = Math.floor(place / suffix_last_count)
  const first = index_digits[Math.floor(rest / digits_count)] as string
  const second = index_digits[rest % digits_count] as string
  const last = index_digits[1 + (place % suffix_last_count)] as string
  return `${integer}${first}${second}${last}`
}

function index_of(record: CanvasRecord): string {
  const index = (record as unknown as Json).index
  assert(typeof index === 'string', 'a valid shape has an index')
  assert(index.length >= 2, 'a valid key has a head and a digit')
  return index
}

function parent_of(record: CanvasRecord): unknown {
  assert(record.typeName === 'shape', 'only a shape has a parent')
  return (record as unknown as Json).parentId
}

function index_compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function refused(kind: PlanRefusal, message: string): RoomPlan {
  assert(message.endsWith('.'), 'a refusal is a sentence')
  return { ok: false, kind, message }
}
