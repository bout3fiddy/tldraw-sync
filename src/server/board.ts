// The board is the whole server-side state machine: one sync room, its saved copy on disk, and
// the latest rendered image. It does no I/O of its own. Time and disk are passed in, so the
// simulator can run the exact production logic against a virtual clock and a faulty disk.

import { TLSocketRoom, type RoomSnapshot, type WebSocketMinimal } from '@tldraw/sync-core'
import {
  createTLSchema,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLPage,
  type TLRecord,
} from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern } from '../shared/board_session'
import type {
  CleanedDocument,
  CleanedStatus,
  PreviewJob,
  SketchBounds,
  SketchSnapshot,
} from '../shared/canvas_types'
import {
  document_hash_pattern,
  fetch_wait_ms_max,
  fetch_waiters_count_max,
  image_bounds_units_max,
  image_padding_px,
  image_size_bytes_max,
  preview_wait_ms_max,
  restart_clock_jump,
  save_delay_ms,
  save_delay_ms_max,
  sessions_count_max,
  sync_message_size_bytes_max,
  type Role,
} from '../shared/constants'
import { document_hash, shapes_count, type DocumentRecord } from '../shared/document_hash'
import { png_blank, png_signed } from '../shared/png'
import type { Time, TimerHandle } from '../shared/time'
import type { EventRequest, EventState } from '../shared/whiteboard'
import { BoardEvents } from './board_events'
import {
  Cleaned,
  type PublishRefusal,
  type PublishResult,
  type RestoreResult,
} from './cleaned'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

export { StorageError } from './storage'

// `session` names the board session this board is. A board opened without one is the default
// board, which is what every board was before there were sessions.
export type BoardEnvironment = {
  readonly time: Time
  readonly disk: Disk
  readonly session?: string
}

export type ImageResult =
  | { kind: 'image'; bytes: Uint8Array; document_hash: string }
  | { kind: 'empty' }
  | { kind: 'stale'; reason: 'stage_absent' | 'stage_slow' | 'busy' }

type Session = { role: Role; socket: WebSocketMinimal }
// The page-space bounds the stage rendered travel with the image they describe.
type Image = { document_hash: string; bytes: Uint8Array; bounds: SketchBounds | null }
type DocumentState = { clock: number; hash: string; shapes_count: number }
type Waiter = { resolve: (result: ImageResult) => void; timer: TimerHandle }

// A draft the stage has been asked to render, and its rendering once the stage has sent it.
// It is never saved: a draft is not a revision, and a restart forgets it.
type Preview = { id: string; records: DocumentRecord[]; image: Uint8Array | null }
type PreviewWaiter = { id: string; resolve: (result: PreviewImage) => void; timer: TimerHandle }

// What a preview was accepted as: its id, and what a publish of the same proposal would save.
export type PreviewResult =
  | {
      kind: 'preview'
      preview: string
      base_revision: number
      snapshot: string
      shapes_count: number
      records_hash: string
    }
  | PublishRefusal

export type PreviewImage =
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'unknown' }
  | { kind: 'stale'; reason: 'stage_absent' | 'stage_slow' | 'busy' }

const board_label = '-'
const page_index = 'a1' as TLPage['index']
const schema = createTLSchema()

export class Board {
  private readonly sessions = new Map<string, Session>()
  private readonly waiters: Waiter[] = []
  private readonly preview_waiters: PreviewWaiter[] = []
  private preview: Preview | null = null
  private document_state_cached: DocumentState | null = null
  private save_timer: TimerHandle | null = null
  private save_deadline_ms: number | null = null
  private clock_saved: number
  private closed = false
  private readonly room: TLSocketRoom<TLRecord>
  readonly session: string

  private constructor(
    private readonly environment: BoardEnvironment,
    snapshot: RoomSnapshot,
    private image: Image | null,
    private readonly cleaned: Cleaned,
    readonly events: BoardEvents,
  ) {
    this.room = new TLSocketRoom<TLRecord>({
      schema,
      initialSnapshot: snapshot,
      onDataChange: () => this.save_schedule(),
    })
    this.clock_saved = this.room.getCurrentDocumentClock()
    this.session = environment.session ?? board_default_id
    assert(board_id_pattern.test(this.session), 'the board session is well formed')
  }

  static open(environment: BoardEnvironment): Board {
    const snapshot = snapshot_read(environment.disk) ?? snapshot_empty()
    const image = image_read(environment.disk)
    const cleaned = Cleaned.open(environment.disk)
    const events = BoardEvents.open(environment.disk)
    const board = new Board(environment, snapshot, image, cleaned, events)

    // Pair assertion: what was read from disk is what the room now serves.
    const records = snapshot.documents.map((document) => document.state)
    assert(board.document_state().hash === document_hash(records), 'room matches the disk')

    // The jumped clock is written down before anyone connects. Otherwise two crashes in a row
    // would restart from the same saved clock twice, and a client from the first of those
    // lifetimes could be mistaken for one that is up to date with the second.
    board.save()
    assert(board.clock_saved === board.room.getCurrentDocumentClock(), 'a new board is saved')
    return board
  }

  // Sessions.

  session_open(session_id: string, role: Role, socket: WebSocketMinimal): boolean {
    assert(!this.closed, 'board is open')
    assert(session_id.length > 0, 'session id is not empty')

    // A reloaded page reconnects under its old id before the old socket has closed.
    const session_previous = this.sessions.get(session_id)
    if (session_previous) {
      session_previous.socket.close()
    } else {
      if (this.sessions.size === sessions_count_max) return false
    }

    this.sessions.set(session_id, { role, socket })
    this.room.handleSocketConnect({
      sessionId: session_id,
      socket,
      isReadonly: role === 'stage',
    })
    assert(this.sessions.size <= sessions_count_max, 'sessions are bounded')
    return true
  }

  session_message(session_id: string, socket: WebSocketMinimal, message: string): void {
    assert(!this.closed, 'board is open')
    assert(session_id.length > 0, 'session id is not empty')
    assert(message.length <= sync_message_size_bytes_max, 'message is bounded')
    if (this.sessions.get(session_id)?.socket === socket) {
      this.room.handleSocketMessage(session_id, message)
    }
  }

  // A close for a socket that has already been replaced must not end its replacement.
  session_close(session_id: string, socket: WebSocketMinimal): void {
    assert(session_id.length > 0, 'session id is not empty')
    if (this.closed) return
    if (this.sessions.get(session_id)?.socket === socket) {
      this.sessions.delete(session_id)
      this.room.handleSocketClose(session_id)
    }
  }

  // Nothing depends on this board being in memory: no page is connected and no fetch waits.
  // An idle board can be closed to make room for another, and opened again unchanged.
  idle(): boolean {
    assert(!this.closed, 'board is open')
    assert(this.waiters.length <= fetch_waiters_count_max, 'waiters are bounded')
    const waiting = this.waiters.length + this.preview_waiters.length
    return this.sessions.size === 0 && waiting === 0
  }

  sessions_count(role: Role): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.role === role) count += 1
    }
    assert(count <= this.sessions.size, 'a role is a subset of the sessions')
    return count
  }

  // Document.

  document_state(): DocumentState {
    const clock = this.room.getCurrentDocumentClock()
    const cached = this.document_state_cached
    if (cached && cached.clock === clock) return cached

    const records = this.document_records()
    const state = { clock, hash: document_hash(records), shapes_count: shapes_count(records) }
    assert(state.shapes_count < records.length, 'a board holds more than its shapes')
    assert(document_hash_pattern.test(state.hash), 'hash is well formed')
    this.document_state_cached = state
    return state
  }

  shapes(): DocumentRecord[] {
    const shapes = this.document_records().filter((record) => record.typeName === 'shape')
    // Pair assertion: two independent counts of the same thing.
    assert(shapes.length === this.document_state().shapes_count, 'shapes are counted once')
    return shapes
  }

  private document_records(): DocumentRecord[] {
    return this.room.getCurrentSnapshot().documents.map((document) => document.state)
  }

  // Image.

  image_put(hash: string, bytes: Uint8Array, bounds: SketchBounds | null = null): void {
    assert(!this.closed, 'board is open')
    assert(document_hash_pattern.test(hash), 'hash is well formed')
    assert(bytes.byteLength > 0, 'image is not empty')
    assert(bytes.byteLength <= image_size_bytes_max, 'image is bounded')
    assert(bounds === null || bounds_valid(bounds), 'bounds are a finite rectangle')

    this.image = { document_hash: hash, bytes, bounds }
    const encoded = envelope_encode({ kind: 'image', label: hash, payload: bytes })
    this.environment.disk.write_atomic('drawing.image', encoded)
    // The frame names the image it belongs to, so a crash between the two writes leaves an
    // image without bounds, never bounds attached to the wrong image.
    if (bounds !== null) {
      const payload = new TextEncoder().encode(JSON.stringify(bounds))
      const frame = envelope_encode({ kind: 'frame', label: hash, payload })
      this.environment.disk.write_atomic('drawing.frame', frame)
    }
    this.waiters_settle()
  }

  // Resolves at once when the image matches the document. Otherwise it waits, for a bounded
  // time, for the stage to render the change it has not caught up with yet.
  image_get(): Promise<ImageResult> {
    assert(!this.closed, 'board is open')
    const result = this.image_result('stage_slow')
    if (result.kind !== 'stale') return Promise.resolve(result)
    if (this.sessions_count('stage') === 0) {
      return Promise.resolve({ kind: 'stale', reason: 'stage_absent' })
    }
    if (this.waiters.length === fetch_waiters_count_max) {
      return Promise.resolve({ kind: 'stale', reason: 'busy' })
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: this.environment.time.timeout_set(() => {
          const index = this.waiters.indexOf(waiter)
          assert(index >= 0, 'a waiter that times out is still waiting')
          this.waiters.splice(index, 1)
          resolve(this.image_result('stage_slow'))
        }, fetch_wait_ms_max),
      }
      this.waiters.push(waiter)
      assert(this.waiters.length <= fetch_waiters_count_max, 'waiters are bounded')
    })
  }

  private image_result(reason_if_stale: 'stage_slow' | 'busy'): ImageResult {
    const state = this.document_state()
    if (state.shapes_count === 0) return { kind: 'empty' }
    if (this.image && this.image.document_hash === state.hash) {
      assert(this.image.bytes.byteLength > 0, 'a stored image is never empty')
      return { kind: 'image', bytes: this.image.bytes, document_hash: state.hash }
    }
    return { kind: 'stale', reason: reason_if_stale }
  }

  private waiters_settle(): void {
    const result = this.image_result('stage_slow')
    if (result.kind === 'stale') return
    assert(this.waiters.length <= fetch_waiters_count_max, 'waiters are bounded')
    for (const waiter of this.waiters.splice(0)) {
      this.environment.time.timeout_clear(waiter.timer)
      waiter.resolve(result)
    }
    assert(this.waiters.length === 0, 'every waiter was settled')
  }

  // The Agent canvas. It is a document of its own: nothing here touches the room.

  // The records of the sketch as it is, but only while it is the sketch the caller saw in its
  // image. Null means the sketch has moved on, and the caller must fetch the image again.
  sketch_snapshot(hash: string): Omit<SketchSnapshot, 'title_wanted'> | null {
    assert(!this.closed, 'board is open')
    assert(document_hash_pattern.test(hash), 'hash is well formed')
    const state = this.document_state()
    if (state.hash !== hash) return null
    const image = this.image
    const bounds = image !== null && image.document_hash === hash ? image.bounds : null
    const canvas = this.cleaned.status(hash)
    return {
      session: this.session,
      document_hash: hash,
      records: this.document_records().filter((r) => r.typeName === 'shape' ||
        r.typeName === 'binding'),
      bounds,
      image_padding: image_padding_px,
      agent_revision: canvas.revision,
      agent_history: canvas.history,
      agent_source_hash: canvas.current?.source_hash ?? null,
      scene: this.cleaned.scene_current(),
      canvas_legacy: canvas.current?.legacy === true,
    }
  }

  // A Send from the iPad: a note for the agent about the sketch as it is, saved before it is
  // acknowledged. It writes nothing to either canvas. Words alone name no sketch: the hash
  // recorded with them is the board's at that moment, for the record, and is never a reason
  // to refuse them or a request to take a snapshot.
  queue_event(hash: string | null, request: EventRequest = {}) {
    const sketch = request.include_sketch !== false
    assert(sketch === (hash !== null), 'a sketch is named exactly when it goes')
    const current = this.document_state()
    const named = hash ?? current.hash
    const replay = this.events.replay('sketch_notify', named, request)
    if (replay !== null) return replay
    if (current.hash !== named) return 'syncing'
    if (sketch && this.clock_saved !== current.clock) this.save()
    assert(!sketch || this.clock_saved === current.clock, 'the referenced sketch is durable')
    const now = this.environment.time.now_ms()
    const revision = this.cleaned.status(named).revision
    const context = { revision_sent: revision, shapes_count: current.shapes_count }
    const id = crypto.randomUUID()
    const queued = this.events.queue('sketch_notify', named, now, id, request, context)
    assert(this.cleaned.status(named).revision === revision, 'a Send publishes nothing')
    return queued
  }

  // An acknowledgement from the host. An end records the canvas revision it was given at.
  event_ack(id: string, state: EventState, message?: string) {
    assert(!this.closed, 'board is open')
    const now_ms = this.environment.time.now_ms()
    const answered = { revision: this.cleaned_status().revision, now_ms }
    const acked = this.events.ack(id, state, message, answered)
    assert(typeof acked === 'string' || acked.id === id, 'the acknowledgement names its event')
    return acked
  }

  cleaned_status(): CleanedStatus {
    assert(!this.closed, 'board is open')
    const status = this.cleaned.status(this.document_state().hash)
    assert(status.revision >= 0, 'a revision is never negative')
    return status
  }

  cleaned_document(): CleanedDocument {
    assert(!this.closed, 'board is open')
    const document = this.cleaned.document(this.document_state().hash)
    assert(document.revision >= 0, 'a revision is never negative')
    return document
  }

  cleaned_publish(input: unknown): PublishResult {
    assert(!this.closed, 'board is open')
    const before = this.document_state()
    const now_ms = this.environment.time.now_ms()
    // A scene copies sketch strokes from the sketch as it is at this moment.
    const sketch = () => this.document_records()
    const result = this.cleaned.publish(input, before.hash, this.session, now_ms, sketch)
    // Pair assertion: publishing a canvas leaves the human ink exactly as it was.
    const after = this.document_state()
    assert(after.clock === before.clock && after.hash === before.hash, 'ink is untouched')
    return result
  }

  // Drafts. A draft is checked and made exactly as a publish is, and then only rendered: the
  // stage draws its records and sends back the picture. Nothing of it is saved or shown.

  // One draft at a time: a new one replaces the one before it, whose waiters are told.
  preview_create(input: unknown): PreviewResult {
    assert(!this.closed, 'board is open')
    const before = this.document_state()
    const revision = this.cleaned.status(before.hash).revision
    const sketch = () => this.document_records()
    const draft = this.cleaned.draft(input, before.hash, this.session, sketch)
    const after = this.document_state()
    assert(after.clock === before.clock && after.hash === before.hash, 'ink is untouched')
    assert(this.cleaned.status(before.hash).revision === revision, 'a draft publishes nothing')
    if (draft.kind !== 'draft') return draft

    const { records, kind: _, ...facts } = draft
    // An empty canvas has nothing for the stage to draw: its picture is a blank page.
    const image = draft.shapes_count === 0 ? png_blank() : null
    this.preview_waiters_settle({ kind: 'unknown' })
    this.preview = { id: crypto.randomUUID(), records, image }
    return { kind: 'preview', preview: this.preview.id, ...facts }
  }

  // What the stage is asked to render, if anything. `have` is the draft it already has.
  preview_job(have: string | null): PreviewJob {
    assert(!this.closed, 'board is open')
    const preview = this.preview
    if (preview === null || preview.image !== null) return { id: null }
    assert(preview.records.length > 0, 'a draft waiting to be drawn has something to draw')
    return preview.id === have ? { id: preview.id } : { id: preview.id, records: preview.records }
  }

  // The stage's rendering of the draft it was given. False when that draft has been replaced.
  preview_put(id: string, bytes: Uint8Array): boolean {
    assert(!this.closed, 'board is open')
    assert(png_signed(bytes) && bytes.byteLength <= image_size_bytes_max, 'a bounded PNG')
    const preview = this.preview
    if (preview === null || preview.id !== id) return false
    if (preview.image === null) preview.image = bytes
    this.preview_waiters_settle({ kind: 'image', bytes: preview.image })
    return true
  }

  // Resolves at once when the draft has been rendered. Otherwise it waits, for a bounded
  // time, for the stage to render it.
  preview_get(id: string): Promise<PreviewImage> {
    assert(!this.closed, 'board is open')
    assert(id.length > 0, 'a preview is named')
    const preview = this.preview
    if (preview === null || preview.id !== id) return Promise.resolve({ kind: 'unknown' })
    if (preview.image !== null) return Promise.resolve({ kind: 'image', bytes: preview.image })
    if (this.sessions_count('stage') === 0) {
      return Promise.resolve({ kind: 'stale', reason: 'stage_absent' })
    }
    if (this.preview_waiters.length === fetch_waiters_count_max) {
      return Promise.resolve({ kind: 'stale', reason: 'busy' })
    }

    return new Promise((resolve) => {
      const waiter: PreviewWaiter = {
        id,
        resolve,
        timer: this.environment.time.timeout_set(() => {
          const index = this.preview_waiters.indexOf(waiter)
          assert(index >= 0, 'a waiter that times out is still waiting')
          this.preview_waiters.splice(index, 1)
          resolve({ kind: 'stale', reason: 'stage_slow' })
        }, preview_wait_ms_max),
      }
      this.preview_waiters.push(waiter)
      assert(this.preview_waiters.length <= fetch_waiters_count_max, 'waiters are bounded')
    })
  }

  private preview_waiters_settle(result: PreviewImage): void {
    assert(this.preview_waiters.length <= fetch_waiters_count_max, 'waiters are bounded')
    for (const waiter of this.preview_waiters.splice(0)) {
      this.environment.time.timeout_clear(waiter.timer)
      waiter.resolve(result)
    }
    assert(this.preview_waiters.length === 0, 'every waiter was settled')
  }

  cleaned_restore(base_revision: number, revision: number | null): RestoreResult {
    assert(!this.closed, 'board is open')
    const before = this.document_state()
    const result = this.cleaned.restore(base_revision, revision, this.environment.time.now_ms())
    const after = this.document_state()
    assert(after.clock === before.clock && after.hash === before.hash, 'ink is untouched')
    return result
  }

  // Saving.

  private save_schedule(): void {
    if (this.closed) return
    if (this.room.getCurrentDocumentClock() === this.clock_saved) return

    const { time } = this.environment
    const now_ms = time.now_ms()
    if (this.save_deadline_ms === null) this.save_deadline_ms = now_ms + save_delay_ms_max
    assert(this.save_deadline_ms <= now_ms + save_delay_ms_max, 'the deadline never moves out')
    if (this.save_timer !== null) time.timeout_clear(this.save_timer)

    const delay_ms = Math.max(0, Math.min(save_delay_ms, this.save_deadline_ms - now_ms))
    assert(delay_ms <= save_delay_ms, 'a save is never postponed past its delay')
    this.save_timer = time.timeout_set(() => this.save(), delay_ms)
  }

  private save(): void {
    assert(!this.closed, 'board is open')
    const { disk, time } = this.environment
    if (this.save_timer !== null) time.timeout_clear(this.save_timer)
    this.save_timer = null
    this.save_deadline_ms = null

    const snapshot = this.room.getCurrentSnapshot()
    const payload = new TextEncoder().encode(JSON.stringify(snapshot))
    disk.write_atomic('board.snapshot', envelope_encode({
      kind: 'board', label: board_label, payload,
    }))
    this.clock_saved = this.room.getCurrentDocumentClock()

    // Pair assertion: read the file back and check it is the board that was just written.
    const written = disk.read('board.snapshot')
    assert(written !== null, 'saved board exists')
    const decoded = envelope_decode(written, 'board')
    assert(decoded.ok, 'saved board decodes')
    assert(decoded.envelope.payload.byteLength === payload.byteLength, 'saved board is whole')
  }

  // Shutdown.

  // An orderly stop: nothing that was drawn is lost.
  close(): void {
    assert(!this.closed, 'board is open')
    if (this.room.getCurrentDocumentClock() !== this.clock_saved) this.save()
    assert(this.room.getCurrentDocumentClock() === this.clock_saved, 'nothing is unsaved')
    this.destroy()
  }

  // A stop without a save, which is what a crash looks like. Used directly by the simulator.
  destroy(): void {
    assert(!this.closed, 'board is destroyed once')
    this.closed = true
    const { time } = this.environment
    if (this.save_timer !== null) time.timeout_clear(this.save_timer)
    this.save_timer = null
    for (const waiter of this.waiters.splice(0)) {
      time.timeout_clear(waiter.timer)
      waiter.resolve({ kind: 'stale', reason: 'busy' })
    }
    this.preview_waiters_settle({ kind: 'stale', reason: 'busy' })
    this.preview = null
    this.sessions.clear()
    this.room.close()
    assert(this.waiters.length === 0, 'no fetch is left waiting')
    assert(this.room.isClosed(), 'the room is closed')
  }
}

function snapshot_read(disk: Disk): RoomSnapshot | null {
  const bytes = disk.read('board.snapshot')
  if (bytes === null) return null

  const decoded = envelope_decode(bytes, 'board')
  if (!decoded.ok) throw new StorageError(`board.snapshot is damaged: ${decoded.reason}`)

  const json = new TextDecoder().decode(decoded.envelope.payload)
  const snapshot = JSON.parse(json) as RoomSnapshot
  assert(Array.isArray(snapshot.documents), 'snapshot has documents')
  assert(Number.isSafeInteger(snapshot.clock), 'snapshot has a clock')
  return snapshot_restart(snapshot)
}

// A new board: the document record and one page. The sync room would otherwise invent a page
// with a random id, and a fixed one keeps a fresh board identical from run to run.
function snapshot_empty(): RoomSnapshot {
  const records = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    PageRecordType.create({
      id: PageRecordType.createId('page'), name: 'Page 1', index: page_index,
    }),
  ]
  assert(records.length === 2, 'a new board is a document and one page')
  assert(shapes_count(records) === 0, 'a new board has no shapes')
  return {
    clock: 0,
    schema: schema.serialize(),
    documents: records.map((state) => ({ state, lastChangedClock: 0 })),
  }
}

// A crash can lose the last few seconds of acknowledged changes, so the restored room is on a
// different timeline from the one clients remember. A client reconnecting with a clock from
// the lost timeline would be sent a diff and keep records the server no longer has. Jumping
// the clock, and starting deletion history at the jump, makes every such client reload the
// document in full instead.
function snapshot_restart(snapshot: RoomSnapshot): RoomSnapshot {
  const clock = Math.max(snapshot.clock, snapshot.documentClock ?? 0) + restart_clock_jump
  assert(Number.isSafeInteger(clock), 'restarted clock stays exact')
  assert(clock > snapshot.clock, 'restarted clock moves forward')
  return { ...snapshot, clock, tombstones: {}, tombstoneHistoryStartsAtClock: clock }
}

// The image is derived data: the stage can always render it again. A damaged image file is
// therefore dropped, where a damaged board file stops the server.
function image_read(disk: Disk): Image | null {
  const bytes = disk.read('drawing.image')
  if (bytes === null) return null

  const decoded = envelope_decode(bytes, 'image')
  if (!decoded.ok) return null
  if (!document_hash_pattern.test(decoded.envelope.label)) return null
  if (decoded.envelope.payload.byteLength === 0) return null
  assert(decoded.envelope.kind === 'image', 'the image file holds an image')
  assert(decoded.envelope.payload.byteLength < bytes.byteLength, 'payload lies inside the file')
  const hash = decoded.envelope.label
  return { document_hash: hash, bytes: decoded.envelope.payload, bounds: frame_read(disk, hash) }
}

// The bounds of a saved image, if they were saved for that same image. Derived data, like the
// image: anything missing or damaged is dropped, and the stage's next render replaces it.
function frame_read(disk: Disk, hash: string): SketchBounds | null {
  assert(document_hash_pattern.test(hash), 'hash is well formed')
  const bytes = disk.read('drawing.frame')
  if (bytes === null) return null
  const decoded = envelope_decode(bytes, 'frame')
  if (!decoded.ok || decoded.envelope.label !== hash) return null
  let bounds: unknown
  try {
    bounds = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
  } catch {
    return null
  }
  if (!bounds_valid(bounds)) return null
  assert(bounds.w >= 0 && bounds.h >= 0, 'valid bounds have a size')
  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
}

export function bounds_valid(value: unknown): value is SketchBounds {
  if (value === null || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  const numbers = [bounds.x, bounds.y, bounds.w, bounds.h]
  const finite = numbers.every((number) => {
    return typeof number === 'number' && Number.isFinite(number)
      && Math.abs(number) <= image_bounds_units_max
  })
  assert(numbers.length === 4, 'a rectangle has four numbers')
  assert(image_bounds_units_max > 0, 'the bounds limit is positive')
  return finite && (bounds.w as number) >= 0 && (bounds.h as number) >= 0
}
