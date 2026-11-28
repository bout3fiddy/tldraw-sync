// Plans one atomic agent write to the native shared scene, which the iPad edits and the Mac
// stage reads. Nothing here is wired into the product yet.
//
// The agent asks for additions, updates and deletions of native shapes and bindings. The
// planner grants the whole request or refuses it whole with bounded, precise conflicts; it
// never repairs, merges or undoes anything on the human's behalf. Authority comes from the
// server's ledger and the room's own clocks, never from client-writable `meta`.
//
// A record is touchable only while it is still the agent's (see `ledger_authority`). A human
// edit, delete, reparent, undo or redo of a record adopts it for good. Changing a record also
// changes how its unit renders, so its unit must be the agent's too: its ancestors, its
// descendants, the bindings that touch any of them and those bindings' other shapes. Deletes
// must name their whole dependency closure, so no binding or child is left dangling. New
// records get ids the server mints, so no id can be resurrected and no human undo can land on
// a new agent record. Stacking is the records' own fractional `index`, exactly as given.
//
// Undo is whole-record (see native_scene_semantics.test.ts). The agent never writes a record a
// human has touched, so no agent write sits behind a human undo step, with one residual: a human
// gesture already in flight when the agent writes the same record. The room merges both, and
// that human's undo then restores the pre-gesture record, dropping the agent's write. The
// ledger sees the record adopted afterwards, so the agent is refused from then on.

import { assert, AssertionError } from '../shared/assert'
import {
  agent_id_mint,
  ledger_authority,
  ledger_baseline_problem,
  ledger_entries_max,
  ledger_intend,
  ledger_settle,
  record_canonical,
  record_hash,
  record_hash_pattern,
  room_records_max,
  room_view_create,
  type Authority,
  type Ledger,
  type LedgerPending,
  type LedgerProblem,
  type LedgerPut,
  type RoomSnapshotLike,
  type RoomView,
  type SceneRecord,
} from './native_scene_ledger'

export type SceneUpdate = { readonly record: SceneRecord; readonly base_hash: string }
export type SceneDelete = { readonly id: string; readonly base_hash: string }

// Additions use placeholder ids, `shape:new-<key>` or `binding:new-<key>`, which other records
// in the same request may reference. Updates and deletes name a record and the hash of the
// version the agent read, as returned by `record_hash`.
export type SceneRequest = {
  readonly adds: readonly SceneRecord[]
  readonly updates: readonly SceneUpdate[]
  readonly deletes: readonly SceneDelete[]
}

export type SceneConflictReason =
  | 'record_missing'
  | 'not_agent_record'
  | 'human_edited'
  | 'human_deleted'
  | 'baseline_mismatch'
  | 'stale_base'
  | 'type_changed'
  | 'id_in_use'
  | 'foreign_dependent'
  | 'dependent_kept'
  | 'parent_invalid'
  | 'parent_cycle'
  | 'binding_endpoint_invalid'

export type SceneConflict = {
  readonly id: string
  readonly reason: SceneConflictReason
  readonly related_id: string | null
}

export type SceneGuard = { readonly id: string; readonly hash: string | null }
export type SceneMinted = { readonly placeholder: string; readonly id: string }

export type ScenePlan = {
  readonly room_epoch: string
  readonly base_clock: number
  readonly puts: readonly SceneRecord[]
  readonly deletes: readonly string[]
  readonly guards: readonly SceneGuard[]
  readonly minted: readonly SceneMinted[]
  readonly intent: LedgerPending
}

export type ScenePlanOutcome =
  | { readonly kind: 'planned'; readonly plan: ScenePlan }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'refused'
      readonly conflicts: readonly SceneConflict[]
      readonly conflicts_count: number
    }
  | { readonly kind: 'unavailable'; readonly problem: LedgerProblem }

export type SceneRequestParse =
  | { readonly ok: true; readonly request: SceneRequest }
  | { readonly ok: false; readonly errors: readonly string[] }

// One request is at most the 800 shapes a unified proposal may hold, within its 1 MiB.
export const scene_operations_max = 800
export const scene_record_bytes_max = 64 * 1024
export const scene_request_bytes_max = 1024 * 1024
export const scene_conflicts_reported_max = 64
const record_depth_max = 32
const record_values_max = 20_000
const parent_depth_max = 64
const request_errors_max = 16
const placeholder_pattern = /^(shape|binding):new-[A-Za-z0-9_-]{1,64}$/
const record_type_pattern = /^[A-Za-z0-9_-]{1,64}$/
const record_id_length_max = 256

assert(scene_operations_max <= ledger_entries_max, 'one request fits in an empty ledger')
assert(scene_record_bytes_max <= scene_request_bytes_max, 'one record fits in a request')

// Validates untrusted input completely before any planning. Records are checked only for what
// the planner reads; the room validates every record against its schema and refuses the whole
// push if one fails.
export function scene_request_parse(value: unknown): SceneRequestParse {
  const errors: string[] = []

  if (typeof value !== 'object' || value === null) return { ok: false, errors: ['not an object'] }

  const input = value as { adds?: unknown; updates?: unknown; deletes?: unknown }
  const { adds, updates, deletes } = input

  if (!Array.isArray(adds) || !Array.isArray(updates) || !Array.isArray(deletes)) {
    return { ok: false, errors: ['adds, updates and deletes must be arrays'] }
  }

  const operations_count = adds.length + updates.length + deletes.length

  if (operations_count === 0 || operations_count > scene_operations_max) {
    return { ok: false, errors: [`operations must number 1 to ${scene_operations_max}`] }
  }

  const reading: Reading = { errors, bytes: 0, ids: new Set(), placeholders: new Set() }
  const request: SceneRequest = {
    adds: adds_read(reading, adds as unknown[]),
    updates: updates_read(reading, updates as unknown[]),
    deletes: deletes_read(reading, deletes as unknown[]),
  }
  references_validate(reading, request)

  if (errors.length > 0) return { ok: false, errors }

  assert(reading.bytes <= scene_request_bytes_max, 'the request is within its byte bound')
  assert(reading.ids.size === operations_count, 'every operation names a distinct record')
  return { ok: true, request }
}

type Reading = {
  readonly errors: string[]
  bytes: number
  readonly ids: Set<string>
  readonly placeholders: Set<string>
}

function error_add(reading: Reading, message: string): void {
  assert(message.length > 0, 'an error says what is wrong')
  assert(reading.errors.length <= request_errors_max, 'errors are bounded')

  if (reading.errors.length < request_errors_max) reading.errors.push(message)
}

function id_claim(reading: Reading, id: string): boolean {
  assert(id.length > 0, 'a claimed id is not empty')
  assert(reading.ids.size <= scene_operations_max, 'claimed ids are bounded')

  if (reading.ids.has(id)) {
    error_add(reading, `${id} appears more than once`)
    return false
  }

  reading.ids.add(id)
  return true
}

function adds_read(reading: Reading, items: unknown[]): SceneRecord[] {
  assert(items.length <= scene_operations_max, 'adds are bounded')

  const records: SceneRecord[] = []

  for (const item of items) {
    const record = record_read(reading, item)

    if (record === null) continue

    if (!placeholder_pattern.test(record.id)) {
      error_add(reading, `added ${record.id} must use a placeholder id like shape:new-key`)
      continue
    }

    if (!id_claim(reading, record.id)) continue

    reading.placeholders.add(record.id)
    records.push(record)
  }

  assert(records.length <= items.length, 'each add yields at most one record')
  return records
}

function updates_read(reading: Reading, items: unknown[]): SceneUpdate[] {
  assert(items.length <= scene_operations_max, 'updates are bounded')

  const updates: SceneUpdate[] = []

  for (const item of items) {
    const update = item as { record?: unknown; base_hash?: unknown } | null

    if (typeof update !== 'object' || update === null || !hash_valid(update.base_hash)) {
      error_add(reading, 'an update needs a record and a base_hash')
      continue
    }

    const record = record_read(reading, update.record)

    if (record === null) continue

    if (placeholder_pattern.test(record.id)) {
      error_add(reading, `updated ${record.id} cannot use a placeholder id`)
      continue
    }

    if (id_claim(reading, record.id)) updates.push({ record, base_hash: update.base_hash })
  }

  assert(updates.length <= items.length, 'each update yields at most one update')
  return updates
}

function deletes_read(reading: Reading, items: unknown[]): SceneDelete[] {
  assert(items.length <= scene_operations_max, 'deletes are bounded')

  const deletes: SceneDelete[] = []

  for (const item of items) {
    const removal = item as { id?: unknown; base_hash?: unknown } | null

    if (typeof removal !== 'object' || removal === null || !hash_valid(removal.base_hash)) {
      error_add(reading, 'a delete needs an id and a base_hash')
      continue
    }

    const id = removal.id

    if (!record_id_valid(id) || placeholder_pattern.test(id)) {
      error_add(reading, 'a deleted id must name an existing shape or binding')
      continue
    }

    if (id_claim(reading, id)) deletes.push({ id, base_hash: removal.base_hash })
  }

  assert(deletes.length <= items.length, 'each delete yields at most one delete')
  return deletes
}

function hash_valid(value: unknown): value is string {
  return typeof value === 'string' && record_hash_pattern.test(value)
}

function record_id_valid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > record_id_length_max) return false

  return value.startsWith('shape:') || value.startsWith('binding:')
}

function record_read(reading: Reading, value: unknown): SceneRecord | null {
  assert(reading.bytes <= scene_request_bytes_max, 'bytes read so far are bounded')

  const structure = value_structure_problem(value)

  if (structure !== null) {
    error_add(reading, structure)
    return null
  }

  const record = value as { id?: unknown; typeName?: unknown; type?: unknown }

  if (!record_id_valid(record.id)) {
    error_add(reading, 'a record id must start with shape: or binding:')
    return null
  }

  const id = record.id

  if (record.typeName !== id.slice(0, id.indexOf(':'))) {
    error_add(reading, `${id} must have the typeName its id names`)
    return null
  }

  if (typeof record.type !== 'string' || !record_type_pattern.test(record.type)) {
    error_add(reading, `${id} must have a type`)
    return null
  }

  const problem = record_fields_problem(value as SceneRecord)

  if (problem !== null) {
    error_add(reading, problem)
    return null
  }

  return record_measured(reading, value as SceneRecord)
}

function record_measured(reading: Reading, record: SceneRecord): SceneRecord | null {
  assert(record_id_valid(record.id), 'the id was validated first')

  const bytes = Buffer.byteLength(record_canonical(record), 'utf8')

  if (bytes > scene_record_bytes_max) {
    error_add(reading, `${record.id} is larger than ${scene_record_bytes_max} bytes`)
    return null
  }

  reading.bytes += bytes

  if (reading.bytes > scene_request_bytes_max) {
    error_add(reading, `the request is larger than ${scene_request_bytes_max} bytes`)
    return null
  }

  assert(bytes > 0, 'a record has bytes')
  return record
}

function record_fields_problem(record: SceneRecord): string | null {
  assert(record.typeName === 'shape' || record.typeName === 'binding', 'type name was checked')

  if (record.typeName === 'shape') {
    const parent_id = record['parentId']
    const valid = typeof parent_id === 'string' && parent_id.length <= record_id_length_max

    if (!valid || !(parent_id.startsWith('shape:') || parent_id.startsWith('page:'))) {
      return `${record.id} must have a page or shape parentId`
    }

    return null
  }

  for (const endpoint of [record['fromId'], record['toId']]) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('shape:')) {
      return `${record.id} must bind shapes by fromId and toId`
    }

    if (endpoint.length > record_id_length_max) return `${record.id} has an overlong endpoint`
  }

  assert(record.typeName === 'binding', 'only bindings reach here')
  return null
}

// JSON data only, bounded in depth and size, without `__proto__` keys; checked with an explicit
// stack so a hostile nesting cannot exhaust the call stack in serialisation.
function value_structure_problem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'a record must be an object'
  }

  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let values_count = 0

  while (pending.length > 0) {
    const item = pending.pop()
    assert(item !== undefined, 'the stack is not empty')
    values_count += 1

    if (values_count > record_values_max) return 'a record holds too many values'

    if (item.depth > record_depth_max) return 'a record is nested too deeply'

    const problem = value_scalar_problem(item.value)

    if (problem !== null) return problem

    if (typeof item.value !== 'object' || item.value === null) continue

    for (const [key, child] of Object.entries(item.value)) {
      if (key === '__proto__') return 'a record may not hold a __proto__ key'

      pending.push({ value: child, depth: item.depth + 1 })
    }
  }

  assert(values_count >= 1, 'the record itself was visited')
  return null
}

function value_scalar_problem(value: unknown): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null

  if (typeof value === 'number') return Number.isFinite(value) ? null : 'a number is not finite'

  if (typeof value !== 'object') return 'a record holds a value JSON cannot carry'

  const prototype = Object.getPrototypeOf(value) as unknown
  const plain = Array.isArray(value) || prototype === Object.prototype || prototype === null
  return plain ? null : 'a record holds a non-plain object'
}

// A placeholder-shaped reference must name an add in this request, of the right kind.
function references_validate(reading: Reading, request: SceneRequest): void {
  assert(reading.placeholders.size === request.adds.length, 'every add has a placeholder')

  const records = [...request.adds, ...request.updates.map((update) => update.record)]

  for (const record of records) {
    for (const reference of record_references(record)) {
      if (!placeholder_pattern.test(reference)) continue

      if (!reference.startsWith('shape:') || !reading.placeholders.has(reference)) {
        error_add(reading, `${record.id} references ${reference}, which this request does not add`)
      }
    }
  }

  assert(records.length <= scene_operations_max, 'references checked are bounded')
}

function record_references(record: SceneRecord): string[] {
  assert(record.typeName === 'shape' || record.typeName === 'binding', 'a scene record')

  const fields = record.typeName === 'shape' ? ['parentId'] : ['fromId', 'toId']
  const references: string[] = []

  for (const field of fields) {
    const reference = record[field]

    if (typeof reference === 'string') references.push(reference)
  }

  assert(references.length === fields.length, 'parsed records carry every reference')
  return references
}

export function scene_plan(
  ledger: Ledger,
  view: RoomView,
  request: SceneRequest,
): ScenePlanOutcome {
  const operations_count = request.adds.length + request.updates.length + request.deletes.length
  assert(operations_count >= 1, 'a parsed request has an operation')
  assert(operations_count <= scene_operations_max, 'a parsed request is bounded')

  const problem = ledger_baseline_problem(ledger, view)

  if (problem !== null) return { kind: 'unavailable', problem }

  if (ledger.pending !== null) return { kind: 'unavailable', problem: 'ledger_pending' }

  if (ledger.entries.size + request.adds.length > ledger_entries_max) {
    return { kind: 'unavailable', problem: 'ledger_full' }
  }

  const minted = ids_mint(ledger, request.adds)
  const mapping = new Map(minted.map((pair) => [pair.placeholder, pair.id]))
  const adds = request.adds.map((record) => references_rewrite(record, mapping))
  const updates = request.updates.map((update) => ({
    record: references_rewrite(update.record, mapping),
    base_hash: update.base_hash,
  }))
  const planning = planning_create(ledger, view)

  for (const record of adds) planning.final.set(record.id, record)

  for (const update of updates) planning.final.set(update.record.id, update.record)

  for (const removal of request.deletes) {
    planning.final.set(removal.id, null)
    planning.deleted.add(removal.id)
  }

  for (const record of adds) add_check(planning, record)

  for (const update of updates) update_check(planning, update)

  for (const removal of request.deletes) delete_check(planning, removal)

  for (const record of [...adds, ...updates.map((update) => update.record)]) {
    final_check(planning, record)
  }

  if (planning.conflicts_count > 0) {
    return {
      kind: 'refused',
      conflicts: planning.conflicts,
      conflicts_count: planning.conflicts_count,
    }
  }

  return plan_build(planning, { adds, updates, deletes: request.deletes, minted })
}

type Planning = {
  readonly ledger: Ledger
  readonly view: RoomView
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly bindings_by_shape: ReadonlyMap<string, readonly string[]>
  readonly final: Map<string, SceneRecord | null>
  readonly deleted: Set<string>
  readonly hashes: Map<string, string | null>
  readonly guards: Map<string, string | null>
  readonly conflicts: SceneConflict[]
  readonly conflict_keys: Set<string>
  conflicts_count: number
}

// One pass over the room builds the two reverse indexes every closure walk needs.
function planning_create(ledger: Ledger, view: RoomView): Planning {
  assert(view.documents.size <= room_records_max, 'the room view is bounded')

  const children = new Map<string, string[]>()
  const bindings_by_shape = new Map<string, string[]>()

  for (const [id, document] of view.documents) {
    const record = document.state

    if (record.typeName === 'shape' && typeof record['parentId'] === 'string') {
      list_append(children, record['parentId'], id)
    }

    if (record.typeName !== 'binding') continue

    for (const endpoint of [record['fromId'], record['toId']]) {
      if (typeof endpoint === 'string') list_append(bindings_by_shape, endpoint, id)
    }
  }

  const planning: Planning = {
    ledger,
    view,
    children,
    bindings_by_shape,
    final: new Map(),
    deleted: new Set(),
    hashes: new Map(),
    guards: new Map(),
    conflicts: [],
    conflict_keys: new Set(),
    conflicts_count: 0,
  }
  assert(planning.conflicts.length === 0, 'planning starts without conflicts')
  return planning
}

function list_append(lists: Map<string, string[]>, key: string, value: string): void {
  const list = lists.get(key)

  if (list === undefined) lists.set(key, [value])
  else list.push(value)

  assert(lists.has(key), 'the key is indexed')
}

function ids_mint(ledger: Ledger, adds: readonly SceneRecord[]): SceneMinted[] {
  assert(adds.length <= scene_operations_max, 'adds are bounded')

  const minted = adds.map((record, index) => ({
    placeholder: record.id,
    id: agent_id_mint(ledger, record.typeName, ledger.id_sequence_next + index),
  }))
  assert(minted.length === adds.length, 'every add gets one id')
  return minted
}

function references_rewrite(record: SceneRecord, mapping: ReadonlyMap<string, string>) {
  assert(record.typeName === 'shape' || record.typeName === 'binding', 'a scene record')

  const fields = record.typeName === 'shape' ? ['id', 'parentId'] : ['id', 'fromId', 'toId']
  const rewritten: Record<string, unknown> = { ...record }

  for (const field of fields) {
    const reference = record[field]
    assert(typeof reference === 'string', 'parsed references are strings')
    const minted = mapping.get(reference)

    if (placeholder_pattern.test(reference)) assert(minted !== undefined, 'placeholders resolve')

    if (minted !== undefined) rewritten[field] = minted
  }

  return rewritten as SceneRecord
}

function hash_current(planning: Planning, id: string): string | null {
  assert(id.length > 0, 'a hashed record is named')

  const cached = planning.hashes.get(id)

  if (cached !== undefined) return cached

  const document = planning.view.documents.get(id)
  const hash = document === undefined ? null : record_hash(document.state)
  planning.hashes.set(id, hash)
  assert(planning.hashes.size <= room_records_max + scene_operations_max, 'hashes are bounded')
  return hash
}

// Every record a decision reads becomes a guard, so the write re-checks it at apply time.
function authority_of(planning: Planning, id: string): Authority {
  const hash = hash_current(planning, id)
  planning.guards.set(id, hash)
  const authority = ledger_authority(planning.ledger, id, planning.view.documents.get(id), hash)

  if (authority === 'agent') assert(hash !== null, 'an agent record exists')

  assert(planning.guards.get(id) === hash, 'the decision is guarded by what it read')
  return authority
}

function conflict_add(
  planning: Planning,
  id: string,
  reason: SceneConflictReason,
  related_id: string | null,
): void {
  assert(id.length > 0, 'a conflict names a record')
  assert(planning.conflicts.length <= scene_conflicts_reported_max, 'reported is bounded')

  const key = `${id}\u0000${reason}\u0000${related_id ?? ''}`

  if (planning.conflict_keys.has(key)) return

  planning.conflict_keys.add(key)
  planning.conflicts_count += 1

  if (planning.conflicts.length < scene_conflicts_reported_max) {
    planning.conflicts.push({ id, reason, related_id })
  }

  assert(planning.conflicts.length <= planning.conflicts_count, 'reported is a subset')
}

function authority_reason(authority: Exclude<Authority, 'agent'>): SceneConflictReason {
  switch (authority) {
    case 'absent':
      return 'record_missing'
    case 'not_agent_record':
    case 'human_edited':
    case 'human_deleted':
    case 'baseline_mismatch':
      return authority
  }
}

function target_check(planning: Planning, id: string, base_hash: string): boolean {
  assert(record_hash_pattern.test(base_hash), 'base hashes were parsed')

  const authority = authority_of(planning, id)

  if (authority !== 'agent') {
    conflict_add(planning, id, authority_reason(authority), null)
    return false
  }

  if (hash_current(planning, id) !== base_hash) {
    conflict_add(planning, id, 'stale_base', null)
    return false
  }

  assert(planning.view.documents.has(id), 'an agent target exists')
  return true
}

function document_state(planning: Planning, id: string): SceneRecord | null {
  const document = planning.view.documents.get(id)

  if (document === undefined) return null

  assert(document.state.id === id, 'documents are indexed by id')
  return document.state
}

// Minted ids are new to this ledger; one already in the room or its tombstones was forged.
function add_check(planning: Planning, record: SceneRecord): void {
  assert(record.id.includes(`:agent-${planning.ledger.id_namespace}-`), 'adds are minted')
  assert(planning.final.get(record.id) === record, 'the add is in the final state')

  const hash = hash_current(planning, record.id)
  planning.guards.set(record.id, hash)

  if (hash !== null || planning.view.tombstones.has(record.id)) {
    conflict_add(planning, record.id, 'id_in_use', null)
  }
}

function update_check(planning: Planning, update: SceneUpdate): void {
  const id = update.record.id
  assert(planning.final.get(id) === update.record, 'the update is in the final state')

  if (!target_check(planning, id, update.base_hash)) return

  const current = document_state(planning, id)
  assert(current !== null, 'a checked target exists')

  if (current.typeName !== update.record.typeName || current['type'] !== update.record['type']) {
    conflict_add(planning, id, 'type_changed', null)
    return
  }

  unit_check(planning, id, current)
}

// The unit a change to `id` affects must be the agent's alone.
function unit_check(planning: Planning, id: string, current: SceneRecord): void {
  assert(current.id === id, 'the current record is the target')

  if (current.typeName === 'binding') {
    for (const endpoint of binding_endpoints(current)) member_require_agent(planning, id, endpoint)

    return
  }

  for (const ancestor of ancestors_current(planning, id)) {
    member_require_agent(planning, id, ancestor)
  }

  const subtree = subtree_collect(planning, id)
  assert(subtree[0] === id, 'a subtree starts at its root')

  for (const member of subtree.slice(1)) member_require_agent(planning, id, member)

  for (const binding_id of bindings_touching(planning, subtree)) {
    member_require_agent(planning, id, binding_id)
    const binding = document_state(planning, binding_id)
    assert(binding !== null, 'indexed bindings exist')

    for (const endpoint of binding_endpoints(binding)) {
      member_require_agent(planning, id, endpoint)
    }
  }
}

function delete_check(planning: Planning, removal: SceneDelete): void {
  const id = removal.id
  assert(planning.deleted.has(id), 'the delete is in the final state')

  if (!target_check(planning, id, removal.base_hash)) return

  const current = document_state(planning, id)
  assert(current !== null, 'a checked target exists')

  if (current.typeName === 'binding') {
    for (const endpoint of binding_endpoints(current)) member_kept_check(planning, id, endpoint)

    return
  }

  for (const ancestor of ancestors_current(planning, id)) {
    member_kept_check(planning, id, ancestor)
  }

  const subtree = subtree_collect(planning, id)

  for (const member of subtree.slice(1)) closure_require_deleted(planning, id, member)

  for (const binding_id of bindings_touching(planning, subtree)) {
    closure_require_deleted(planning, id, binding_id)
    const binding = document_state(planning, binding_id)
    assert(binding !== null, 'indexed bindings exist')

    for (const endpoint of binding_endpoints(binding)) member_kept_check(planning, id, endpoint)
  }
}

// A neighbour that survives the delete must be the agent's: removing a child or a binding
// changes how a group or an arrow renders.
function member_kept_check(planning: Planning, subject: string, member: string): void {
  assert(subject !== member || planning.deleted.has(member), 'the subject is being deleted')

  if (planning.deleted.has(member)) return

  member_require_agent(planning, subject, member)
}

function closure_require_deleted(planning: Planning, subject: string, member: string): void {
  assert(subject !== member, 'a record is not its own dependent')
  assert(planning.deleted.has(subject), 'only deletes have a closure')

  if (planning.deleted.has(member)) return

  const authority = authority_of(planning, member)
  const reason = authority === 'agent' ? 'dependent_kept' : 'foreign_dependent'
  conflict_add(planning, subject, reason, member)
}

function member_require_agent(planning: Planning, subject: string, member: string): void {
  assert(subject.length > 0, 'a subject is named')
  assert(member.length > 0, 'a member is named')

  const state = document_state(planning, member)

  if (state !== null && state.typeName === 'page') {
    planning.guards.set(member, hash_current(planning, member))
    return
  }

  const authority = authority_of(planning, member)

  if (authority !== 'agent') conflict_add(planning, subject, 'foreign_dependent', member)
}

function binding_endpoints(binding: SceneRecord): string[] {
  assert(binding.typeName === 'binding', 'only bindings have endpoints')

  const endpoints: string[] = []

  for (const endpoint of [binding['fromId'], binding['toId']]) {
    if (typeof endpoint === 'string') endpoints.push(endpoint)
  }

  assert(endpoints.length <= 2, 'a binding has two endpoints')
  return endpoints
}

// The current ancestors of a shape below its page, nearest first. A chain that is broken,
// cyclic or too deep stops here; the conflict for it comes from the members it did reach.
function ancestors_current(planning: Planning, id: string): string[] {
  assert(planning.view.documents.has(id), 'ancestors are walked from a present record')

  const ancestors: string[] = []
  let parent = document_state(planning, id)?.['parentId']

  while (typeof parent === 'string' && ancestors.length < parent_depth_max) {
    const state = document_state(planning, parent)

    if (state !== null && state.typeName === 'page') break

    if (ancestors.includes(parent) || parent === id) {
      conflict_add(planning, id, 'parent_cycle', parent)
      break
    }

    ancestors.push(parent)

    if (state === null) break

    parent = state['parentId']
  }

  assert(ancestors.length <= parent_depth_max, 'the walk is bounded')
  return ancestors
}

// Breadth-first over the current children index; each record is visited at most once.
function subtree_collect(planning: Planning, root: string): string[] {
  assert(planning.view.documents.has(root), 'a subtree has a present root')

  const subtree = [root]
  const visited = new Set(subtree)

  for (let index = 0; index < subtree.length; index += 1) {
    const parent = subtree[index]
    assert(parent !== undefined, 'the cursor is within the list')

    for (const child of planning.children.get(parent) ?? []) {
      if (visited.has(child)) continue

      visited.add(child)
      subtree.push(child)
    }
  }

  assert(subtree.length <= planning.view.documents.size, 'a subtree is part of the room')
  return subtree
}

function bindings_touching(planning: Planning, shapes: readonly string[]): string[] {
  assert(shapes.length <= room_records_max, 'shapes are bounded')

  const bindings: string[] = []
  const seen = new Set<string>()

  for (const shape of shapes) {
    for (const binding of planning.bindings_by_shape.get(shape) ?? []) {
      if (seen.has(binding)) continue

      seen.add(binding)
      bindings.push(binding)
    }
  }

  assert(bindings.length === seen.size, 'each binding is listed once')
  return bindings
}

// The scene after the write must hold together: every put's parent chain reaches a page through
// agent shapes, and every put binding joins two agent shapes that survive the write.
function final_check(planning: Planning, record: SceneRecord): void {
  assert(planning.final.get(record.id) === record, 'the put is in the final state')

  if (record.typeName === 'binding') {
    for (const endpoint of binding_endpoints(record))
      final_endpoint_check(planning, record, endpoint)

    return
  }

  assert(record.typeName === 'shape', 'puts are shapes or bindings')
  const visited = new Set([record.id])
  let parent = record['parentId']

  for (let depth = 0; depth <= parent_depth_max; depth += 1) {
    if (typeof parent !== 'string') return conflict_add(planning, record.id, 'parent_invalid', null)

    if (visited.has(parent)) return conflict_add(planning, record.id, 'parent_cycle', parent)

    visited.add(parent)
    const step = final_parent_step(planning, record.id, parent)

    if (step === 'stop') return

    parent = step.parentId
  }

  conflict_add(planning, record.id, 'parent_cycle', null)
}

function final_parent_step(
  planning: Planning,
  subject: string,
  parent: string,
): 'stop' | { parentId: unknown } {
  assert(subject !== parent, 'cycles were excluded by the caller')

  const planned = planning.final.get(parent)

  if (planned === null) {
    conflict_add(planning, subject, 'parent_invalid', parent)
    return 'stop'
  }

  if (planned !== undefined) {
    if (planned.typeName !== 'shape') conflict_add(planning, subject, 'parent_invalid', parent)

    return planned.typeName === 'shape' ? { parentId: planned['parentId'] } : 'stop'
  }

  const state = document_state(planning, parent)
  planning.guards.set(parent, hash_current(planning, parent))

  if (state !== null && state.typeName === 'page') return 'stop'

  if (state === null || state.typeName !== 'shape') {
    conflict_add(planning, subject, 'parent_invalid', parent)
    return 'stop'
  }

  if (authority_of(planning, parent) !== 'agent') {
    conflict_add(planning, subject, 'foreign_dependent', parent)
    return 'stop'
  }

  return { parentId: state['parentId'] }
}

function final_endpoint_check(planning: Planning, binding: SceneRecord, endpoint: string): void {
  assert(binding.typeName === 'binding', 'endpoints belong to bindings')
  assert(endpoint.startsWith('shape:'), 'parsed endpoints name shapes')

  const planned = planning.final.get(endpoint)

  if (planned === null) {
    conflict_add(planning, binding.id, 'binding_endpoint_invalid', endpoint)
    return
  }

  if (planned !== undefined) {
    if (planned.typeName !== 'shape') {
      conflict_add(planning, binding.id, 'binding_endpoint_invalid', endpoint)
    }

    return
  }

  const state = document_state(planning, endpoint)

  if (state === null || state.typeName !== 'shape') {
    planning.guards.set(endpoint, hash_current(planning, endpoint))
    conflict_add(planning, binding.id, 'binding_endpoint_invalid', endpoint)
    return
  }

  if (authority_of(planning, endpoint) !== 'agent') {
    conflict_add(planning, binding.id, 'foreign_dependent', endpoint)
  }
}

type PlanParts = {
  readonly adds: readonly SceneRecord[]
  readonly updates: readonly SceneUpdate[]
  readonly deletes: readonly SceneDelete[]
  readonly minted: readonly SceneMinted[]
}

function plan_build(planning: Planning, parts: PlanParts): ScenePlanOutcome {
  assert(planning.conflicts_count === 0, 'only a conflict-free request is planned')

  const puts: SceneRecord[] = []
  const ledger_puts: LedgerPut[] = []
  const changed = parts.updates.filter(
    (update) => record_hash(update.record) !== hash_current(planning, update.record.id),
  )

  for (const record of [...parts.adds, ...changed.map((update) => update.record)]) {
    puts.push(record)
    ledger_puts.push({ id: record.id, hash: record_hash(record) })
  }

  const deletes = parts.deletes.map((removal) => removal.id)

  if (puts.length === 0 && deletes.length === 0) return { kind: 'unchanged' }

  const view = planning.view
  const plan: ScenePlan = {
    room_epoch: view.room_epoch,
    base_clock: view.clock,
    puts,
    deletes,
    guards: [...planning.guards].map(([id, hash]) => ({ id, hash })),
    minted: parts.minted,
    intent: {
      generation: planning.ledger.generation,
      write_clock: view.clock + 1,
      id_sequence_next: planning.ledger.id_sequence_next + parts.adds.length,
      puts: ledger_puts,
    },
  }
  assert(plan.guards.length >= puts.length + deletes.length, 'every target is guarded')
  assert(Number.isSafeInteger(plan.intent.write_clock), 'the write clock is exact')
  return { kind: 'planned', plan }
}

// The store `updateStore` hands its updater. `R` is the room's record type; the room validates
// each put against its schema and refuses the whole push when one fails.
export type SceneStore<R> = {
  get(id: string): R | null
  put(record: R): void
  delete(id: string): void
}

// Runs synchronously inside `updateStore`, against the snapshot that call took. If any record
// the plan read has changed, nothing is written.
export function scene_plan_apply<R>(store: SceneStore<R>, plan: ScenePlan): 'applied' | 'diverged' {
  assert(plan.guards.length <= room_records_max + scene_operations_max, 'guards are bounded')
  assert(plan.puts.length + plan.deletes.length >= 1, 'a plan writes something')

  for (const guard of plan.guards) {
    const current = store.get(guard.id) as SceneRecord | null
    const hash = current === null ? null : record_hash(current)

    if (hash !== guard.hash) return 'diverged'
  }

  for (const record of plan.puts) store.put(record as unknown as R)

  for (const id of plan.deletes) store.delete(id)

  return 'applied'
}

// The room surface a write needs; `TLSocketRoom` provides it. Calls must be serialized by the
// caller: `updateStore` snapshots the room when called, so overlapping writes lose each other.
export type SceneRoom<R> = {
  getCurrentSnapshot(): RoomSnapshotLike
  updateStore(updater: (store: SceneStore<R>) => void): Promise<void>
}

// Durable, synchronous ledger persistence. It throws on failure, before the room is touched
// for an intent and before acknowledging for a settle.
export type SceneLedgerSaver = { save(ledger: Ledger): void }

export type SceneWriteOutcome =
  | { readonly kind: 'written'; readonly ledger: Ledger; readonly minted: readonly SceneMinted[] }
  | { readonly kind: 'diverged' | 'rejected'; readonly ledger: Ledger }
  | { readonly kind: 'unchanged' | 'refused' | 'unavailable'; readonly ledger: Ledger }

export type SceneWriteResult = {
  readonly outcome: SceneWriteOutcome
  readonly plan: ScenePlanOutcome | null
  readonly room_problem: string | null
}

// The integration path: read, plan, persist the intent, write, settle and persist again. The
// read, plan, intent save and `updateStore` call run in one synchronous turn, so no client push
// can land between the decision and the room's snapshot.
export async function scene_write<R>(options: {
  room: SceneRoom<R>
  room_epoch: string
  ledger: Ledger
  request: SceneRequest
  ledger_saver: SceneLedgerSaver
}): Promise<SceneWriteResult> {
  const { room, room_epoch, ledger, ledger_saver } = options
  const viewed = room_view_create(room.getCurrentSnapshot(), room_epoch)

  if (!viewed.ok)
    return { outcome: { kind: 'unavailable', ledger }, plan: null, room_problem: viewed.reason }

  const planned = scene_plan(ledger, viewed.view, options.request)

  if (planned.kind !== 'planned') {
    return { outcome: { kind: planned.kind, ledger }, plan: planned, room_problem: null }
  }

  assert(planned.plan.room_epoch === ledger.room_epoch, 'the plan is for this lineage')
  const intended = ledger_intend(ledger, planned.plan.intent)
  assert(intended.ok, 'a plan made from this ledger can be intended')
  ledger_saver.save(intended.ledger)
  const written = await scene_store_update(room, planned.plan)
  const after = room_view_create(room.getCurrentSnapshot(), room_epoch)

  // The intent stays saved: recovery settles it once the host has a readable room again.
  if (!after.ok)
    return {
      outcome: { kind: 'unavailable', ledger: intended.ledger },
      plan: planned,
      room_problem: after.reason,
    }

  const settled = ledger_settle(
    intended.ledger,
    after.view,
    written === 'applied' ? 'observe' : 'not_applied',
  )

  if (!settled.ok) {
    return {
      outcome: { kind: 'unavailable', ledger: intended.ledger },
      plan: planned,
      room_problem: settled.problem,
    }
  }

  ledger_saver.save(settled.ledger)
  const outcome: SceneWriteOutcome =
    written === 'applied'
      ? { kind: 'written', ledger: settled.ledger, minted: planned.plan.minted }
      : { kind: written, ledger: settled.ledger }
  return { outcome, plan: planned, room_problem: null }
}

async function scene_store_update<R>(
  room: SceneRoom<R>,
  plan: ScenePlan,
): Promise<'applied' | 'diverged' | 'rejected'> {
  assert(plan.puts.length + plan.deletes.length >= 1, 'a plan writes something')

  const result: { applied: 'applied' | 'diverged' | null } = { applied: null }

  try {
    await room.updateStore((store) => {
      result.applied = scene_plan_apply(store, plan)
    })
  } catch (error) {

    // The room refuses a push with an invalid record whole; an assertion is never swallowed.
    if (error instanceof AssertionError) throw error

    return 'rejected'
  }

  assert(result.applied !== null, 'the updater ran to completion')
  return result.applied
}
