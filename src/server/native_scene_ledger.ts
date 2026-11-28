// The server's own memory of which native records in the shared scene the agent wrote, and how
// each looked when it did. Nothing a client sends is trusted for this: `meta` is client-writable
// and forgeable, so authority comes from the room's per-record change clock and a content hash
// of the record as the agent's write left it.
//
// A record is the agent's exactly while the room still holds it at the clock and bytes the
// ledger recorded. Any human change, including an undo or redo that restores identical bytes,
// moves the room clock, so adoption by a human is permanent without being stored: clocks never
// run backwards within one room epoch. Agent ids are minted here from a durable sequence and are
// never minted twice, so an id the agent once used can never be recreated by the agent.
//
// Writes follow a write-ahead protocol: persist `ledger_intend`, apply the plan through the
// room, then persist `ledger_settle`. Settling reads only the room, so recovery after a crash at
// any point is the same `ledger_settle` call with `write: 'observe'`.

import { createHash } from 'node:crypto'
import { assert } from '../shared/assert'

export type SceneRecord = {
  readonly id: string
  readonly typeName: string
  readonly [key: string]: unknown
}

export type RoomDocument = { readonly state: SceneRecord; readonly lastChangedClock: number }

// A synchronous read of one room. `clock` is the room's logical clock: the next push, including
// one made by `updateStore`, lands at `clock + 1`. `document_clock` is the last document change.
export type RoomView = {
  readonly room_epoch: string
  readonly clock: number
  readonly document_clock: number
  readonly documents: ReadonlyMap<string, RoomDocument>
  readonly tombstones: ReadonlyMap<string, number>
}

// The subset of sync-core's `RoomSnapshot` the ledger reads, as `getCurrentSnapshot()` returns.
export type RoomSnapshotLike = {
  readonly clock: number
  readonly documentClock?: number
  readonly documents: readonly { readonly state: unknown; readonly lastChangedClock: number }[]
  readonly tombstones?: Readonly<Record<string, number>>
}

export type LedgerEntry = { readonly clock: number; readonly hash: string }

export type LedgerPut = { readonly id: string; readonly hash: string }

// A planned write that may or may not have reached the room. Its ids are reserved durably
// before the write, so a crash can never lead to the same id being minted again.
export type LedgerPending = {
  readonly generation: number
  readonly write_clock: number
  readonly id_sequence_next: number
  readonly puts: readonly LedgerPut[]
}

export type Ledger = {
  readonly room_epoch: string
  readonly id_namespace: string
  readonly generation: number
  readonly clock_observed: number
  readonly id_sequence_next: number
  readonly entries: ReadonlyMap<string, LedgerEntry>
  readonly pending: LedgerPending | null
}

export type Authority =
  'agent' | 'human_edited' | 'human_deleted' | 'baseline_mismatch' | 'not_agent_record' | 'absent'

export type LedgerProblem =
  | 'room_epoch_mismatch'
  | 'room_clock_regressed'
  | 'ledger_pending'
  | 'ledger_not_pending'
  | 'ledger_generation_stale'
  | 'ledger_full'

export type LedgerOutcome =
  | { readonly ok: true; readonly ledger: Ledger }
  | { readonly ok: false; readonly problem: LedgerProblem }

export type RoomViewOutcome =
  { readonly ok: true; readonly view: RoomView } | { readonly ok: false; readonly reason: string }

// Live agent records the ledger tracks. Each entry is about 200 bytes encoded, so a full ledger
// stays under one MiB; a request is at most 800 operations, so a full ledger still fits several.
export const ledger_entries_max = 4_096

// The planner indexes a whole room per request; this bounds that work to a few milliseconds.
export const room_records_max = 20_000
export const room_tombstones_max = 20_000
export const room_epoch_pattern = /^[A-Za-z0-9_-]{1,64}$/
export const id_namespace_pattern = /^[a-z0-9]{8,32}$/
export const record_hash_pattern = /^[0-9a-f]{64}$/
const ledger_text_bytes_max = 4 * 1024 * 1024
const ledger_format = 'native_scene_ledger'
const ledger_version = 1
const record_id_length_max = 256

assert(ledger_entries_max <= room_records_max, 'every tracked record fits in one room')
assert(ledger_entries_max * 512 <= ledger_text_bytes_max, 'a full ledger encodes within bound')

export function ledger_create(options: {
  room_epoch: string
  id_namespace: string
  document_clock: number
}): Ledger {
  assert(room_epoch_pattern.test(options.room_epoch), 'room epoch is well formed')
  assert(id_namespace_pattern.test(options.id_namespace), 'id namespace is well formed')
  assert(clock_valid(options.document_clock), 'document clock is a safe integer')
  return {
    room_epoch: options.room_epoch,
    id_namespace: options.id_namespace,
    generation: 0,
    clock_observed: options.document_clock,
    id_sequence_next: 1,
    entries: new Map(),
    pending: null,
  }
}

// Key order is not part of a record's meaning; sorting keys makes the hash independent of the
// path that built the record. Keys are copied onto prototype-free objects, so a `__proto__` key
// is ordinary data here.
export function record_canonical(record: SceneRecord): string {
  const json = JSON.stringify(record, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value

    const source = value as Record<string, unknown>
    const target = Object.create(null) as Record<string, unknown>

    for (const key of Object.keys(source).sort()) target[key] = source[key]

    return target
  })
  assert(typeof json === 'string', 'a record always serialises')
  assert(json.startsWith('{'), 'a record serialises as an object')
  return json
}

export function record_hash(record: SceneRecord): string {
  const hash = createHash('sha256').update(record_canonical(record), 'utf8').digest('hex')
  assert(record_hash_pattern.test(hash), 'a record hash is 64 lowercase hex characters')
  assert(hash.length === 64, 'sha-256 is 32 bytes')
  return hash
}

export function agent_id_mint(ledger: Ledger, type_name: string, sequence: number): string {
  assert(type_name === 'shape' || type_name === 'binding', 'only shapes and bindings are minted')
  assert(Number.isSafeInteger(sequence) && sequence >= 1, 'sequence is a positive integer')
  assert(sequence >= ledger.id_sequence_next, 'a minted sequence is never reused')
  return `${type_name}:agent-${ledger.id_namespace}-${sequence}`
}

// Whole-ledger preconditions against one room read. A different epoch means the room's clock
// lineage was replaced (restore, reset, migration); a lower clock means it was rolled back.
// Either way every recorded baseline is meaningless, and the host must decide what to do.
export function ledger_baseline_problem(ledger: Ledger, view: RoomView): LedgerProblem | null {
  assert(clock_valid(view.document_clock), 'view document clock is valid')
  assert(view.document_clock <= view.clock, 'document clock never passes the room clock')

  if (view.room_epoch !== ledger.room_epoch) return 'room_epoch_mismatch'

  if (view.document_clock < ledger.clock_observed) return 'room_clock_regressed'

  return null
}

// Who owns a record now. `hash` is the hash of `document.state`, or null when absent.
export function ledger_authority(
  ledger: Ledger,
  id: string,
  document: RoomDocument | undefined,
  hash: string | null,
): Authority {
  assert((document === undefined) === (hash === null), 'a hash is given exactly for a record')

  if (document !== undefined) assert(document.state.id === id, 'the document is the record')

  const entry = ledger.entries.get(id)

  if (entry === undefined) return document === undefined ? 'absent' : 'not_agent_record'

  if (document === undefined) return 'human_deleted'

  if (document.lastChangedClock !== entry.clock) return 'human_edited'

  // Same clock, different bytes: the room is not the lineage the ledger observed.
  if (hash !== entry.hash) return 'baseline_mismatch'

  return 'agent'
}

export function ledger_intend(ledger: Ledger, pending: LedgerPending): LedgerOutcome {
  assert(pending.puts.length <= room_records_max, 'pending puts are bounded')
  assert(pending.id_sequence_next >= 1, 'sequences start at one')

  if (ledger.pending !== null) return { ok: false, problem: 'ledger_pending' }

  // A plan made against an older generation may name a clock the ledger has since passed.
  if (pending.generation !== ledger.generation) {
    return { ok: false, problem: 'ledger_generation_stale' }
  }

  assert(pending.write_clock > ledger.clock_observed, 'a write lands after what was observed')
  assert(pending.id_sequence_next >= ledger.id_sequence_next, 'a plan never rewinds the ids')

  let added_count = 0

  for (const put of pending.puts) {
    if (!ledger.entries.has(put.id)) added_count += 1
  }

  if (ledger.entries.size + added_count > ledger_entries_max) {
    return { ok: false, problem: 'ledger_full' }
  }

  const intended = { ...ledger, id_sequence_next: pending.id_sequence_next, pending }
  assert(intended.entries === ledger.entries, 'intending changes no baseline')
  return { ok: true, ledger: intended }
}

export type LedgerWrite = 'observe' | 'not_applied'

// Resolves a pending write from the room alone, then forgets records the room no longer holds.
// A put counts as the agent's only when the room holds it at the write clock with the planned
// bytes; one push lands at one clock, so nothing else can have produced that pair. Pass
// 'not_applied' when the caller knows the write did not happen (a diverged guard or a rejected
// `updateStore`); 'observe' after a successful write and for recovery after a crash.
export function ledger_settle(ledger: Ledger, view: RoomView, write: LedgerWrite): LedgerOutcome {
  assert(ledger.entries.size <= ledger_entries_max, 'ledger entries are bounded')
  assert(view.documents.size <= room_records_max, 'the room view is bounded')

  const problem = ledger_baseline_problem(ledger, view)

  if (problem !== null) return { ok: false, problem }

  const entries = new Map(ledger.entries)
  const pending = ledger.pending

  if (pending !== null && write === 'observe') {
    for (const put of pending.puts) {
      const document = view.documents.get(put.id)

      if (document === undefined) continue

      if (document.lastChangedClock !== pending.write_clock) continue

      if (record_hash(document.state) !== put.hash) continue

      entries.set(put.id, { clock: pending.write_clock, hash: put.hash })
    }
  }

  for (const id of [...entries.keys()]) {
    if (!view.documents.has(id)) entries.delete(id)
  }

  assert(entries.size <= ledger_entries_max, 'intend reserved room for every put')
  const settled: Ledger = {
    ...ledger,
    generation: ledger.generation + 1,
    clock_observed: view.document_clock,
    entries,
    pending: null,
  }
  assert(settled.id_sequence_next >= ledger.id_sequence_next, 'the id sequence never rewinds')
  return { ok: true, ledger: settled }
}

export function room_view_create(snapshot: RoomSnapshotLike, room_epoch: string): RoomViewOutcome {
  assert(room_epoch_pattern.test(room_epoch), 'the server owns a well-formed room epoch')
  assert(typeof snapshot === 'object' && snapshot !== null, 'a snapshot is an object')

  const clock = snapshot.clock
  const document_clock = snapshot.documentClock ?? clock

  if (!clock_valid(clock) || !clock_valid(document_clock)) {
    return { ok: false, reason: 'room clocks must be non-negative safe integers' }
  }

  if (document_clock > clock) return { ok: false, reason: 'document clock passes room clock' }

  if (snapshot.documents.length > room_records_max) {
    return { ok: false, reason: `the room holds more than ${room_records_max} records` }
  }

  const documents = new Map<string, RoomDocument>()

  for (const document of snapshot.documents) {
    const reason = room_document_problem(document, clock)

    if (reason !== null) return { ok: false, reason }

    const state = document.state as SceneRecord

    if (documents.has(state.id)) return { ok: false, reason: `duplicate record ${state.id}` }

    documents.set(state.id, { state, lastChangedClock: document.lastChangedClock })
  }

  const tombstones = tombstones_read(snapshot.tombstones ?? {}, clock)

  if (tombstones === null) return { ok: false, reason: 'tombstones are malformed or too many' }

  const view: RoomView = { room_epoch, clock, document_clock, documents, tombstones }
  assert(view.documents.size === snapshot.documents.length, 'every document is indexed once')
  return { ok: true, view }
}

function room_document_problem(
  document: { readonly state: unknown; readonly lastChangedClock: number },
  clock: number,
): string | null {
  assert(clock_valid(clock), 'the room clock was validated first')

  const state = document.state

  if (typeof state !== 'object' || state === null) return 'a document state is not an object'

  const record = state as { id?: unknown; typeName?: unknown }

  if (typeof record.id !== 'string' || record.id.length > record_id_length_max) {
    return 'a document id is not a bounded string'
  }

  if (typeof record.typeName !== 'string') return `document ${record.id} has no type name`

  if (!clock_valid(document.lastChangedClock) || document.lastChangedClock > clock) {
    return `document ${record.id} has an invalid change clock`
  }

  return null
}

function tombstones_read(
  tombstones: Readonly<Record<string, number>>,
  clock: number,
): ReadonlyMap<string, number> | null {
  assert(clock_valid(clock), 'the room clock was validated first')

  const ids = Object.keys(tombstones)

  if (ids.length > room_tombstones_max) return null

  const read = new Map<string, number>()

  for (const id of ids) {
    const deleted_clock = tombstones[id]

    if (deleted_clock === undefined || !clock_valid(deleted_clock)) return null

    if (deleted_clock > clock) return null

    read.set(id, deleted_clock)
  }

  assert(read.size === ids.length, 'every tombstone is read once')
  return read
}

export function clock_valid(clock: unknown): clock is number {
  return typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 0
}

type LedgerJson = {
  format: string
  version: number
  room_epoch: string
  id_namespace: string
  generation: number
  clock_observed: number
  id_sequence_next: number
  entries: [string, number, string][]
  pending: null | {
    generation: number
    write_clock: number
    id_sequence_next: number
    puts: [string, string][]
  }
}

export function ledger_encode(ledger: Ledger): string {
  assert(ledger.entries.size <= ledger_entries_max, 'entries are bounded')

  const entries: [string, number, string][] = [...ledger.entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, entry]) => [id, entry.clock, entry.hash])
  const pending = ledger.pending
  const json: LedgerJson = {
    format: ledger_format,
    version: ledger_version,
    room_epoch: ledger.room_epoch,
    id_namespace: ledger.id_namespace,
    generation: ledger.generation,
    clock_observed: ledger.clock_observed,
    id_sequence_next: ledger.id_sequence_next,
    entries,
    pending:
      pending === null
        ? null
        : {
            generation: pending.generation,
            write_clock: pending.write_clock,
            id_sequence_next: pending.id_sequence_next,
            puts: pending.puts.map((put) => [put.id, put.hash]),
          },
  }
  const text = JSON.stringify(json)
  assert(Buffer.byteLength(text, 'utf8') <= ledger_text_bytes_max, 'the encoding is bounded')
  return text
}

export type LedgerDecodeOutcome =
  { readonly ok: true; readonly ledger: Ledger } | { readonly ok: false; readonly reason: string }

// Saved data is untrusted: damage is reported, never repaired by guessing.
export function ledger_decode(text: string): LedgerDecodeOutcome {
  assert(typeof text === 'string', 'the ledger is read as text')

  if (Buffer.byteLength(text, 'utf8') > ledger_text_bytes_max) {
    return { ok: false, reason: 'the ledger is larger than its bound' }
  }

  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the ledger is not JSON' }
  }

  const header = ledger_header_read(value)

  if (typeof header === 'string') return { ok: false, reason: header }

  const json = value as LedgerJson
  const entries = ledger_entries_read(json.entries, header.clock_observed)

  if (typeof entries === 'string') return { ok: false, reason: entries }

  const pending = ledger_pending_read(json.pending, header)

  if (typeof pending === 'string') return { ok: false, reason: pending }

  const ledger: Ledger = { ...header, entries, pending }
  assert(ledger.entries.size <= ledger_entries_max, 'decoded entries are bounded')
  return { ok: true, ledger }
}

type LedgerHeader = Omit<Ledger, 'entries' | 'pending'>

function ledger_header_read(value: unknown): LedgerHeader | string {
  assert(ledger_version === 1, 'this reader knows one version')

  if (typeof value !== 'object' || value === null) return 'the ledger is not an object'

  const json = value as Partial<LedgerJson>

  if (json.format !== ledger_format || json.version !== ledger_version) {
    return 'the ledger format or version is unknown'
  }

  if (typeof json.room_epoch !== 'string' || !room_epoch_pattern.test(json.room_epoch)) {
    return 'the room epoch is malformed'
  }

  if (typeof json.id_namespace !== 'string' || !id_namespace_pattern.test(json.id_namespace)) {
    return 'the id namespace is malformed'
  }

  if (!clock_valid(json.generation) || !clock_valid(json.clock_observed)) {
    return 'the generation or observed clock is malformed'
  }

  if (!clock_valid(json.id_sequence_next) || json.id_sequence_next < 1) {
    return 'the id sequence is malformed'
  }

  const header: LedgerHeader = {
    room_epoch: json.room_epoch,
    id_namespace: json.id_namespace,
    generation: json.generation,
    clock_observed: json.clock_observed,
    id_sequence_next: json.id_sequence_next,
  }
  assert(header.id_sequence_next >= 1, 'sequences start at one')
  return header
}

function ledger_entries_read(
  value: unknown,
  clock_observed: number,
): ReadonlyMap<string, LedgerEntry> | string {
  assert(clock_valid(clock_observed), 'the observed clock was validated first')

  if (!Array.isArray(value) || value.length > ledger_entries_max) {
    return 'the entries are not a bounded list'
  }

  const entries = new Map<string, LedgerEntry>()

  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || item.length !== 3) return 'an entry is malformed'

    const [id, clock, hash] = item as unknown[]

    if (typeof id !== 'string' || id.length > record_id_length_max || entries.has(id)) {
      return 'an entry id is malformed or repeated'
    }

    if (!clock_valid(clock) || clock > clock_observed) return `entry ${id} has an invalid clock`

    if (typeof hash !== 'string' || !record_hash_pattern.test(hash)) {
      return `entry ${id} has a malformed hash`
    }

    entries.set(id, { clock, hash })
  }

  assert(entries.size === value.length, 'every entry is read once')
  return entries
}

function ledger_pending_read(value: unknown, header: LedgerHeader): LedgerPending | null | string {
  assert(clock_valid(header.clock_observed), 'the header was validated first')

  if (value === null) return null

  if (typeof value !== 'object') return 'the pending write is malformed'

  const json = value as Partial<NonNullable<LedgerJson['pending']>>

  if (json.generation !== header.generation) return 'the pending write is from another generation'

  if (json.id_sequence_next !== header.id_sequence_next) return 'the pending sequence disagrees'

  if (!clock_valid(json.write_clock) || json.write_clock <= header.clock_observed) {
    return 'the pending write clock is malformed'
  }

  if (!Array.isArray(json.puts) || json.puts.length > room_records_max) {
    return 'the pending puts are not a bounded list'
  }

  const puts: LedgerPut[] = []

  for (const item of json.puts as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) return 'a pending put is malformed'

    const [id, hash] = item as unknown[]

    if (typeof id !== 'string' || typeof hash !== 'string' || !record_hash_pattern.test(hash)) {
      return 'a pending put is malformed'
    }

    puts.push({ id, hash })
  }

  const pending = {
    generation: header.generation,
    write_clock: json.write_clock,
    id_sequence_next: header.id_sequence_next,
    puts,
  }
  assert(pending.puts.length === json.puts.length, 'every pending put is read once')
  return pending
}
