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
import {
  document_hash_pattern,
  fetch_wait_ms_max,
  fetch_waiters_count_max,
  image_size_bytes_max,
  restart_clock_jump,
  save_delay_ms,
  save_delay_ms_max,
  sessions_count_max,
  sync_message_size_bytes_max,
  type Role,
} from '../shared/constants'
import { document_hash, shapes_count, type DocumentRecord } from '../shared/document_hash'
import type { Time, TimerHandle } from '../shared/time'
import { envelope_decode, envelope_encode, type Disk } from './storage'

export type BoardEnvironment = { readonly time: Time; readonly disk: Disk }

export type ImageResult =
  | { kind: 'image'; bytes: Uint8Array; document_hash: string }
  | { kind: 'empty' }
  | { kind: 'stale'; reason: 'stage_absent' | 'stage_slow' | 'busy' }

// The saved board cannot be trusted. This is an operating error: the caller reports it and
// refuses to start, because starting empty would silently discard someone's drawing.
export class StorageError extends Error {}

type Session = { role: Role; socket: WebSocketMinimal }
type Image = { document_hash: string; bytes: Uint8Array }
type DocumentState = { clock: number; hash: string; shapes_count: number }
type Waiter = { resolve: (result: ImageResult) => void; timer: TimerHandle }

const board_label = '-'
const page_index = 'a1' as TLPage['index']
const schema = createTLSchema()

export class Board {
  private readonly sessions = new Map<string, Session>()
  private readonly waiters: Waiter[] = []
  private document_state_cached: DocumentState | null = null
  private save_timer: TimerHandle | null = null
  private save_deadline_ms: number | null = null
  private clock_saved: number
  private closed = false
  private readonly room: TLSocketRoom<TLRecord>

  private constructor(
    private readonly environment: BoardEnvironment,
    snapshot: RoomSnapshot,
    private image: Image | null,
  ) {
    this.room = new TLSocketRoom<TLRecord>({
      schema,
      initialSnapshot: snapshot,
      onDataChange: () => this.save_schedule(),
    })
    this.clock_saved = this.room.getCurrentDocumentClock()
  }

  static open(environment: BoardEnvironment): Board {
    const snapshot = snapshot_read(environment.disk) ?? snapshot_empty()
    const image = image_read(environment.disk)
    const board = new Board(environment, snapshot, image)

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

  image_put(hash: string, bytes: Uint8Array): void {
    assert(!this.closed, 'board is open')
    assert(document_hash_pattern.test(hash), 'hash is well formed')
    assert(bytes.byteLength > 0, 'image is not empty')
    assert(bytes.byteLength <= image_size_bytes_max, 'image is bounded')

    this.image = { document_hash: hash, bytes }
    const encoded = envelope_encode({ kind: 'image', label: hash, payload: bytes })
    this.environment.disk.write_atomic('drawing.image', encoded)
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
  return { document_hash: decoded.envelope.label, bytes: decoded.envelope.payload }
}
