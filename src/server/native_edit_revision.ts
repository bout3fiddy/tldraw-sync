// One logical agent operation on the native shared scene as one reversible revision. A native
// board runs it through `native_scene.ts`: the host edits, and the iPad's Undo and Redo revert.
//
// An edit is an intentional agent transaction. It may create shapes and bindings, and it may
// revise or delete any record, including original human strokes. Authorization to modify comes
// from the transaction itself; concurrency is a separate check. Every updated or deleted record
// names the hash of the bytes the agent read, and the whole edit is refused if any of them, or
// any record its dependency checks read, has changed. Nothing is merged or repaired.
//
// The journal keeps the exact records before and after each applied revision, for the last
// `revisions_retained_max` revisions. Reverting one is a new compensating revision that puts
// back the exact earlier records under their original ids. It is refused when any touched record
// is no longer exactly as the journal last left it (room clock and bytes), or when the result
// would leave a child or binding added since pointing at nothing. Redo is a revert of a revert.
//
// Writes follow the ledger's write-ahead protocol: persist the intent with its full delta, apply
// it in one `updateStore` call guarded by every record the plan read, then persist the settled
// journal. After a crash, `revision_settle(journal, view, 'observe')` resolves the pending
// revision from the room alone, so no applied revision goes untracked while evidence remains.
// The push that applies a revision on a native board also writes `revision_marker` into the
// document's meta. It survives a restart, which empties the room's tombstones, so it is the
// evidence that a revision which only deleted records was applied.

import { TLDOCUMENT_ID } from '@tldraw/tlschema'
import { assert, AssertionError } from '../shared/assert'
import { native_marker_key } from '../shared/native_scene'
import {
  clock_valid,
  id_namespace_pattern,
  record_canonical,
  record_hash,
  record_hash_pattern,
  room_epoch_pattern,
  room_records_max,
  room_view_create,
  type RoomView,
  type SceneRecord,
} from './native_scene_ledger'
import {
  scene_operations_max,
  type SceneRequest,
  type SceneRoom,
  type SceneStore,
} from './native_scene_plan'

export type RevisionChange = {
  readonly id: string
  readonly before: SceneRecord | null
  readonly after: SceneRecord | null
}

// `request_id` and `request_hash` identify an edit request for replay; a revert has neither.
export type RevisionEntry = {
  readonly sequence: number
  readonly request_id: string | null
  readonly request_hash: string | null
  readonly reverts: number | null
  readonly reverted_by: number | null
  readonly write_clock: number
  readonly changes: readonly RevisionChange[]
}

export type RevisionPending = { readonly entry: RevisionEntry; readonly id_sequence_next: number }

// A page reads only `sequence` and `reverts`. The rest names the transaction (its write clock
// and request) and the room lineage it was written in, so a marker from another journal or
// another revision is never taken as evidence.
export type RevisionMarker = {
  readonly sequence: number
  readonly reverts: number | null
  readonly room_epoch: string
  readonly write_clock: number
  readonly request_hash: string | null
}

export type RevisionJournal = {
  readonly room_epoch: string
  readonly id_namespace: string
  readonly clock_observed: number
  readonly sequence_next: number
  readonly id_sequence_next: number
  readonly entries: readonly RevisionEntry[]
  readonly pending: RevisionPending | null
}

export type RevisionConflictReason =
  | 'record_missing'
  | 'stale_base'
  | 'type_changed'
  | 'id_in_use'
  | 'changed_since'
  | 'dependent_kept'
  | 'parent_invalid'
  | 'parent_cycle'
  | 'binding_endpoint_invalid'

export type RevisionConflict = {
  readonly id: string
  readonly reason: RevisionConflictReason
  readonly related_id: string | null
}

export type RevisionProblem =
  | 'room_epoch_mismatch'
  | 'room_clock_regressed'
  | 'revision_pending'
  | 'revision_stale'
  | 'revision_too_large'
  | 'request_id_reused'

export type RevisionGuard = { readonly id: string; readonly hash: string | null }
export type RevisionMinted = { readonly placeholder: string; readonly id: string }

export type RevisionPlan = {
  readonly room_epoch: string
  readonly entry: RevisionEntry
  readonly guards: readonly RevisionGuard[]
  readonly minted: readonly RevisionMinted[]
  readonly id_sequence_next: number
}

export type RevisionPlanOutcome =
  | { readonly kind: 'planned'; readonly plan: RevisionPlan }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'replayed'; readonly sequence: number }
  | { readonly kind: 'already_reverted'; readonly sequence: number }
  | { readonly kind: 'expired' | 'unknown' }
  | {
      readonly kind: 'refused'
      readonly conflicts: readonly RevisionConflict[]
      readonly conflicts_count: number
    }
  | { readonly kind: 'unavailable'; readonly problem: RevisionProblem }

export type RevisionJournalOutcome =
  | { readonly ok: true; readonly journal: RevisionJournal }
  | { readonly ok: false; readonly problem: RevisionProblem }

// Eight revisions match the Agent canvas history. Each holds at most one request of records
// after and the same count before, so a full journal and a pending revision encode within the
// 32 MiB bound storage already reads for `.state` files.
export const revisions_retained_max = 8
export const revision_bytes_max = 2 * 1024 * 1024
export const revision_conflicts_reported_max = 64
export const request_id_pattern = /^[A-Za-z0-9_-]{8,64}$/
const journal_text_bytes_max = 24 * 1024 * 1024
const journal_format = 'native_edit_revisions'
const journal_version = 1
const parent_depth_max = 64
const record_id_length_max = 256
const placeholder_pattern = /^(shape|binding):new-[A-Za-z0-9_-]{1,64}$/

// Records encode as the same JSON their byte count measures; each change adds an id and framing
// of well under 512 bytes.
const change_framing_bytes_max = 512
assert(
  (revisions_retained_max + 1) * (revision_bytes_max + 800 * change_framing_bytes_max) <=
    journal_text_bytes_max,
  'a full journal with a pending revision fits its encoding bound',
)
assert(scene_operations_max <= room_records_max, 'one revision fits in one room')

export function revision_journal_create(options: {
  room_epoch: string
  id_namespace: string
  document_clock: number
}): RevisionJournal {
  assert(room_epoch_pattern.test(options.room_epoch), 'room epoch is well formed')
  assert(id_namespace_pattern.test(options.id_namespace), 'id namespace is well formed')
  assert(clock_valid(options.document_clock), 'document clock is a safe integer')
  return {
    room_epoch: options.room_epoch,
    id_namespace: options.id_namespace,
    clock_observed: options.document_clock,
    sequence_next: 1,
    id_sequence_next: 1,
    entries: [],
    pending: null,
  }
}

// A different epoch means the room's clock lineage was replaced; a lower clock means it was
// rolled back. Every recorded clock is then meaningless, so nothing is planned or settled.
function journal_problem(journal: RevisionJournal, view: RoomView): RevisionProblem | null {
  assert(clock_valid(view.document_clock), 'view document clock is valid')
  assert(view.document_clock <= view.clock, 'document clock never passes the room clock')

  if (view.room_epoch !== journal.room_epoch) return 'room_epoch_mismatch'

  if (view.document_clock < journal.clock_observed) return 'room_clock_regressed'

  return null
}

function plan_precondition(journal: RevisionJournal, view: RoomView): RevisionProblem | null {
  const problem = journal_problem(journal, view)
  assert(journal.entries.length <= revisions_retained_max, 'retained revisions are bounded')

  if (problem !== null) return problem

  if (journal.pending !== null) return 'revision_pending'

  assert(journal.sequence_next >= 1, 'sequences start at one')
  return null
}

// The request content is plain JSON data; hashing it canonically lets a replay with the same
// id be told apart from a different request that reuses the id.
export function request_hash(request: SceneRequest): string {
  const json = { id: 'request', typeName: 'revision_request', ...request }
  const hash = record_hash(json as unknown as SceneRecord)
  assert(record_hash_pattern.test(hash), 'a request hash is a record hash')
  assert(request.adds.length + request.updates.length + request.deletes.length >= 1, 'non-empty')
  return hash
}

export function revision_edit_plan(
  journal: RevisionJournal,
  view: RoomView,
  request_id: string,
  request: SceneRequest,
): RevisionPlanOutcome {
  assert(request_id_pattern.test(request_id), 'request ids are validated by the caller')
  assert(request.adds.length <= scene_operations_max, 'a parsed request is bounded')

  const problem = plan_precondition(journal, view)

  if (problem !== null) return { kind: 'unavailable', problem }

  const hash = request_hash(request)
  const previous = journal.entries.find((entry) => entry.request_id === request_id)

  if (previous !== undefined) {
    if (previous.request_hash !== hash) return { kind: 'unavailable', problem: 'request_id_reused' }

    return { kind: 'replayed', sequence: previous.sequence }
  }

  const minted = ids_mint(journal, request.adds)
  const mapping = new Map(minted.map((pair) => [pair.placeholder, pair.id]))
  const adds = request.adds.map((record) => references_rewrite(record, mapping))
  const updates = request.updates.map((update) => ({
    record: references_rewrite(update.record, mapping),
    base_hash: update.base_hash,
  }))
  const checking = checking_create(view)

  for (const record of adds) checking.final.set(record.id, record)

  for (const update of updates) checking.final.set(update.record.id, update.record)

  for (const removal of request.deletes) checking.final.set(removal.id, null)

  for (const record of adds) add_check(checking, record)

  for (const update of updates) base_check(checking, update.record.id, update.base_hash, update)

  for (const removal of request.deletes) base_check(checking, removal.id, removal.base_hash, null)

  integrity_check(checking)

  if (checking.conflicts_count > 0) return refused(checking)

  const changes = edit_changes(
    checking,
    adds,
    updates.map((update) => update.record),
  )
  const meta = { request_id, request_hash: hash, reverts: null }
  return plan_build(journal, checking, changes, { ...meta, minted })
}

export function revision_revert_plan(
  journal: RevisionJournal,
  view: RoomView,
  sequence: number,
): RevisionPlanOutcome {
  assert(Number.isSafeInteger(sequence), 'a revision sequence is an integer')
  assert(sequence >= 1, 'revision sequences start at one')

  const problem = plan_precondition(journal, view)

  if (problem !== null) return { kind: 'unavailable', problem }

  if (sequence >= journal.sequence_next) return { kind: 'unknown' }

  const target = journal.entries.find((entry) => entry.sequence === sequence)

  if (target === undefined) return { kind: 'expired' }

  if (target.reverted_by !== null) return { kind: 'already_reverted', sequence: target.reverted_by }

  const marks = journal_marks(journal, target)
  const checking = checking_create(view)

  for (const change of target.changes) {
    checking.final.set(change.id, change.before)
    const mark = marks.get(change.id)
    assert(mark !== undefined, 'the target itself marks every record it changed')
    unchanged_since_check(checking, change, mark)
  }

  integrity_check(checking)

  if (checking.conflicts_count > 0) return refused(checking)

  const changes = target.changes.map((change) => ({
    id: change.id,
    before: change.after,
    after: change.before,
  }))
  const meta = { request_id: null, request_hash: null, reverts: target.sequence }
  return plan_build(journal, checking, changes, { ...meta, minted: [] })
}

// The room clock at which the journal last wrote each record the target changed: the target's
// own write, or a later retained revision's. Eviction is oldest first, so every later revision
// that touched these records is still retained.
function journal_marks(journal: RevisionJournal, target: RevisionEntry): Map<string, number> {
  assert(journal.entries.includes(target), 'the target is retained')

  const marks = new Map<string, number>()
  const ids = new Set(target.changes.map((change) => change.id))

  for (const entry of journal.entries) {
    if (entry.sequence < target.sequence) continue

    for (const change of entry.changes) {
      if (ids.has(change.id)) marks.set(change.id, entry.write_clock)
    }
  }

  assert(marks.size === ids.size, 'every changed record has a mark')
  return marks
}

type Checking = {
  readonly view: RoomView
  readonly final: Map<string, SceneRecord | null>
  readonly guards: Map<string, string | null>
  readonly conflicts: RevisionConflict[]
  readonly conflict_keys: Set<string>
  conflicts_count: number
}

function checking_create(view: RoomView): Checking {
  assert(view.documents.size <= room_records_max, 'the room view is bounded')

  const checking: Checking = {
    view,
    final: new Map(),
    guards: new Map(),
    conflicts: [],
    conflict_keys: new Set(),
    conflicts_count: 0,
  }
  assert(checking.conflicts.length === 0, 'checking starts without conflicts')
  return checking
}

// Every record a decision reads becomes a guard, so the write re-checks it at apply time.
function guard_read(checking: Checking, id: string): SceneRecord | null {
  assert(id.length > 0, 'a guarded record is named')

  const document = checking.view.documents.get(id)
  const state = document === undefined ? null : document.state

  if (!checking.guards.has(id)) checking.guards.set(id, state === null ? null : record_hash(state))

  assert(checking.guards.size <= room_records_max + scene_operations_max, 'guards are bounded')
  return state
}

function conflict_add(
  checking: Checking,
  id: string,
  reason: RevisionConflictReason,
  related_id: string | null,
): void {
  assert(id.length > 0, 'a conflict names a record')
  assert(checking.conflicts.length <= revision_conflicts_reported_max, 'reported is bounded')

  const key = `${id}\u0000${reason}\u0000${related_id ?? ''}`

  if (checking.conflict_keys.has(key)) return

  checking.conflict_keys.add(key)
  checking.conflicts_count += 1

  if (checking.conflicts.length < revision_conflicts_reported_max) {
    checking.conflicts.push({ id, reason, related_id })
  }

  assert(checking.conflicts.length <= checking.conflicts_count, 'reported is a subset')
}

function refused(checking: Checking): RevisionPlanOutcome {
  assert(checking.conflicts_count > 0, 'a refusal has a conflict')
  assert(checking.conflicts.length >= 1, 'a refusal reports a conflict')
  return {
    kind: 'refused',
    conflicts: checking.conflicts,
    conflicts_count: checking.conflicts_count,
  }
}

function ids_mint(journal: RevisionJournal, adds: readonly SceneRecord[]): RevisionMinted[] {
  assert(adds.length <= scene_operations_max, 'adds are bounded')

  const minted = adds.map((record, index) => ({
    placeholder: record.id,
    id: `${record.typeName}:edit-${journal.id_namespace}-${journal.id_sequence_next + index}`,
  }))
  assert(minted.length === adds.length, 'every add gets one id')
  return minted
}

function references_rewrite(
  record: SceneRecord,
  mapping: ReadonlyMap<string, string>,
): SceneRecord {
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

// Minted ids are new to this journal; one already in the room or its tombstones was forged.
function add_check(checking: Checking, record: SceneRecord): void {
  assert(record.id.includes(':edit-'), 'adds carry minted ids')
  assert(checking.final.get(record.id) === record, 'the add is in the final state')

  const state = guard_read(checking, record.id)

  if (state !== null || checking.view.tombstones.has(record.id)) {
    conflict_add(checking, record.id, 'id_in_use', null)
  }
}

// Any record may be revised, whoever drew it, but only from the exact bytes the agent read.
function base_check(
  checking: Checking,
  id: string,
  base_hash: string,
  update: { readonly record: SceneRecord } | null,
): void {
  assert(record_hash_pattern.test(base_hash), 'base hashes were parsed')
  assert(checking.final.has(id), 'the target is in the final state')

  const state = guard_read(checking, id)

  if (state === null) return conflict_add(checking, id, 'record_missing', null)

  if (checking.guards.get(id) !== base_hash) return conflict_add(checking, id, 'stale_base', null)

  if (update === null) return

  const same_type = state.typeName === update.record.typeName

  if (!same_type || state['type'] !== update.record['type']) {
    conflict_add(checking, id, 'type_changed', null)
  }
}

// A record is reverted only while the room holds it exactly as the journal last left it: the
// same bytes at the journal's write clock, or, for a record it deleted, a tombstone at that
// clock. Any later human or agent edit, delete, undo or recreation moves that clock.
function unchanged_since_check(checking: Checking, change: RevisionChange, mark: number): void {
  assert(clock_valid(mark), 'marks are room clocks')
  assert(change.before !== null || change.after !== null, 'a change changes something')

  const document = checking.view.documents.get(change.id)
  const state = guard_read(checking, change.id)

  if (change.after === null) {
    const tombstone = checking.view.tombstones.get(change.id)

    if (state !== null || tombstone !== mark) {
      conflict_add(checking, change.id, 'changed_since', null)
    }

    return
  }

  assert((document === undefined) === (state === null), 'the guard read the document')

  const same_clock = document !== undefined && document.lastChangedClock === mark

  if (!same_clock || checking.guards.get(change.id) !== record_hash(change.after)) {
    conflict_add(checking, change.id, 'changed_since', null)
  }
}

// The scene after the write must hold together: every put shape's parent and every put
// binding's endpoints exist, and nothing kept still points at a deleted record. The room
// itself checks neither (see native_scene_semantics.test.ts).
function integrity_check(checking: Checking): void {
  assert(checking.final.size <= scene_operations_max, 'the final state is bounded')

  for (const record of checking.final.values()) {
    if (record === null) continue

    if (record.typeName === 'binding') endpoints_check(checking, record)
    else parent_check(checking, record)
  }

  dependents_check(checking)
  assert(checking.conflicts_count >= checking.conflicts.length, 'reported is a subset')
}

// Walks planned parents; an existing unchanged shape or a page ends the walk, since the room
// already holds that chain and `dependents_check` catches a deleted link in it.
function parent_check(checking: Checking, record: SceneRecord): void {
  assert(record.typeName === 'shape', 'only shapes have parents')

  const visited = new Set([record.id])
  let parent: unknown = record['parentId']

  for (let depth = 0; depth <= parent_depth_max; depth += 1) {
    if (typeof parent !== 'string') return conflict_add(checking, record.id, 'parent_invalid', null)

    if (visited.has(parent)) return conflict_add(checking, record.id, 'parent_cycle', parent)

    visited.add(parent)
    const planned = checking.final.get(parent)

    if (planned === null) return conflict_add(checking, record.id, 'parent_invalid', parent)

    if (planned === undefined) {
      const state = guard_read(checking, parent)
      const valid = state !== null && (state.typeName === 'page' || state.typeName === 'shape')

      if (!valid) conflict_add(checking, record.id, 'parent_invalid', parent)

      return
    }

    if (planned.typeName !== 'shape') {
      return conflict_add(checking, record.id, 'parent_invalid', parent)
    }

    parent = planned['parentId']
  }

  assert(visited.size > parent_depth_max, 'only an overlong chain reaches here')
  conflict_add(checking, record.id, 'parent_cycle', null)
}

function endpoints_check(checking: Checking, binding: SceneRecord): void {
  assert(binding.typeName === 'binding', 'only bindings have endpoints')

  const endpoints = [binding['fromId'], binding['toId']]
  assert(endpoints.length === 2, 'a binding has two endpoints')

  for (const endpoint of endpoints) {
    if (typeof endpoint !== 'string') {
      conflict_add(checking, binding.id, 'binding_endpoint_invalid', null)
      continue
    }

    const planned = checking.final.get(endpoint)
    const state = planned === undefined ? guard_read(checking, endpoint) : planned

    if (state === null || state.typeName !== 'shape') {
      conflict_add(checking, binding.id, 'binding_endpoint_invalid', endpoint)
    }
  }
}

// One pass over the room finds every child and binding of a deleted record. A dependent the
// write also changes is checked as a put; an unchanged one would be left dangling.
function dependents_check(checking: Checking): void {
  const deleted = new Set<string>()

  for (const [id, record] of checking.final) {
    if (record === null && checking.view.documents.has(id)) deleted.add(id)
  }

  assert(deleted.size <= checking.final.size, 'deletes are part of the final state')

  if (deleted.size === 0) return

  for (const [id, document] of checking.view.documents) {
    if (checking.final.has(id)) continue

    const state = document.state
    const references =
      state.typeName === 'shape'
        ? [state['parentId']]
        : state.typeName === 'binding'
          ? [state['fromId'], state['toId']]
          : []

    for (const reference of references) {
      if (typeof reference !== 'string' || !deleted.has(reference)) continue

      guard_read(checking, id)
      conflict_add(checking, reference, 'dependent_kept', id)
    }
  }

  assert(checking.view.documents.size <= room_records_max, 'the pass is bounded')
}

function edit_changes(
  checking: Checking,
  adds: readonly SceneRecord[],
  updates: readonly SceneRecord[],
): RevisionChange[] {
  assert(checking.conflicts_count === 0, 'only a conflict-free edit has changes')

  const changes: RevisionChange[] = adds.map((record) => ({
    id: record.id,
    before: null,
    after: record,
  }))

  for (const record of updates) {
    const before = guard_read(checking, record.id)
    assert(before !== null, 'a checked update target exists')

    if (record_hash(record) !== checking.guards.get(record.id)) {
      changes.push({ id: record.id, before, after: record })
    }
  }

  for (const [id, record] of checking.final) {
    if (record !== null) continue

    const before = guard_read(checking, id)
    assert(before !== null, 'a checked delete target exists')
    changes.push({ id, before, after: null })
  }

  assert(changes.length <= checking.final.size, 'each final record changes at most once')
  return changes
}

export function revision_bytes(changes: readonly RevisionChange[]): number {
  assert(changes.length <= scene_operations_max, 'changes are bounded')

  let bytes = 0

  for (const change of changes) {
    for (const record of [change.before, change.after]) {
      if (record !== null) bytes += Buffer.byteLength(record_canonical(record), 'utf8')
    }
  }

  assert(Number.isSafeInteger(bytes), 'byte counts are exact')
  return bytes
}

type EntryMeta = {
  readonly request_id: string | null
  readonly request_hash: string | null
  readonly reverts: number | null
  readonly minted: readonly RevisionMinted[]
}

function plan_build(
  journal: RevisionJournal,
  checking: Checking,
  changes: readonly RevisionChange[],
  meta: EntryMeta,
): RevisionPlanOutcome {
  assert(checking.conflicts_count === 0, 'only a conflict-free revision is planned')
  assert((meta.request_id === null) === (meta.reverts !== null), 'an edit or a revert')

  if (changes.length === 0) return { kind: 'unchanged' }

  if (revision_bytes(changes) > revision_bytes_max) {
    return { kind: 'unavailable', problem: 'revision_too_large' }
  }

  const view = checking.view
  const entry: RevisionEntry = {
    sequence: journal.sequence_next,
    request_id: meta.request_id,
    request_hash: meta.request_hash,
    reverts: meta.reverts,
    reverted_by: null,
    write_clock: view.clock + 1,
    changes,
  }
  const plan: RevisionPlan = {
    room_epoch: view.room_epoch,
    entry,
    guards: [...checking.guards].map(([id, hash]) => ({ id, hash })),
    minted: meta.minted,
    id_sequence_next: journal.id_sequence_next + meta.minted.length,
  }
  assert(plan.guards.length >= changes.length, 'every changed record is guarded')
  assert(Number.isSafeInteger(entry.write_clock), 'the write clock is exact')
  return { kind: 'planned', plan }
}

// Runs synchronously inside `updateStore`, against the snapshot that call took. If any record
// the plan read has changed, nothing is written.
export function revision_apply<R>(
  store: SceneStore<R>,
  plan: RevisionPlan,
): 'applied' | 'diverged' {
  assert(plan.entry.changes.length >= 1, 'a plan writes something')
  assert(plan.guards.length <= room_records_max + scene_operations_max, 'guards are bounded')

  for (const guard of plan.guards) {
    const current = store.get(guard.id) as SceneRecord | null
    const hash = current === null ? null : record_hash(current)

    if (hash !== guard.hash) return 'diverged'
  }

  for (const change of plan.entry.changes) {
    if (change.after === null) store.delete(change.id)
    else store.put(change.after as unknown as R)
  }

  return 'applied'
}

export function revision_intend(
  journal: RevisionJournal,
  plan: RevisionPlan,
): RevisionJournalOutcome {
  assert(plan.room_epoch === journal.room_epoch, 'the plan is for this lineage')
  assert(plan.id_sequence_next >= journal.id_sequence_next, 'a plan never rewinds the ids')

  if (journal.pending !== null) return { ok: false, problem: 'revision_pending' }

  // A plan made from an older journal may name a clock or sequence the journal has since passed.
  if (plan.entry.sequence !== journal.sequence_next) return { ok: false, problem: 'revision_stale' }

  if (plan.entry.write_clock <= journal.clock_observed) {
    return { ok: false, problem: 'revision_stale' }
  }

  const pending: RevisionPending = { entry: plan.entry, id_sequence_next: plan.id_sequence_next }
  const intended = { ...journal, id_sequence_next: plan.id_sequence_next, pending }
  assert(intended.entries === journal.entries, 'intending records no revision')
  return { ok: true, journal: intended }
}

export type RevisionWrite = 'applied' | 'not_applied' | 'observe'

// Resolves the pending revision. Pass 'applied' or 'not_applied' when the caller knows; pass
// 'observe' for recovery after a crash, which counts the revision as applied when the room
// holds any of its records at the write clock with the planned bytes, a tombstone there for a
// record it deleted, or the document there with its exact marker. One push lands at one clock,
// so nothing else produced that evidence.
// Without evidence every touched record has changed since, so a revert would be refused anyway.
export function revision_settle(
  journal: RevisionJournal,
  view: RoomView,
  write: RevisionWrite,
): RevisionJournalOutcome {
  if (write !== 'observe') assert(journal.pending !== null, 'a known write was intended')

  const problem = journal_problem(journal, view)

  if (problem !== null) return { ok: false, problem }

  const pending = journal.pending
  let entries = journal.entries

  if (pending !== null) {
    const applied =
      write === 'applied' || (write === 'observe' && evidence(pending, view, journal.room_epoch))

    if (applied) entries = entries_append(journal.entries, pending.entry)
  }

  const settled: RevisionJournal = {
    ...journal,
    clock_observed: view.document_clock,
    sequence_next: entries === journal.entries ? journal.sequence_next : journal.sequence_next + 1,
    entries,
    pending: null,
  }
  assert(settled.entries.length <= revisions_retained_max, 'retention is bounded')
  assert(settled.id_sequence_next === journal.id_sequence_next, 'minted ids stay reserved')
  return { ok: true, journal: settled }
}

export function revision_marker(room_epoch: string, entry: RevisionEntry): RevisionMarker {
  assert(room_epoch_pattern.test(room_epoch), 'room epoch is well formed')
  assert(clock_valid(entry.write_clock) && entry.sequence >= 1, 'the entry was planned')

  return {
    sequence: entry.sequence,
    reverts: entry.reverts,
    room_epoch,
    write_clock: entry.write_clock,
    request_hash: entry.request_hash,
  }
}

function evidence(pending: RevisionPending, view: RoomView, room_epoch: string): boolean {
  const write_clock = pending.entry.write_clock
  assert(clock_valid(write_clock), 'the write clock is a room clock')

  if (marker_evidence(pending.entry, view, room_epoch)) return true

  for (const change of pending.entry.changes) {
    if (change.after === null) {
      if (view.tombstones.get(change.id) === write_clock) return true

      continue
    }

    const document = view.documents.get(change.id)

    if (document === undefined || document.lastChangedClock !== write_clock) continue

    if (record_hash(document.state) === record_hash(change.after)) return true
  }

  assert(pending.entry.changes.length >= 1, 'a pending revision changes something')
  return false
}

// Only the revision's own push writes the document at its write clock with its exact marker.
// Meta is client-writable, so every field must match, and a later document edit hides it.
function marker_evidence(entry: RevisionEntry, view: RoomView, room_epoch: string): boolean {
  const document = view.documents.get(TLDOCUMENT_ID)

  if (document === undefined || document.lastChangedClock !== entry.write_clock) return false

  const meta = document.state['meta']

  if (typeof meta !== 'object' || meta === null) return false

  const found = (meta as Record<string, unknown>)[native_marker_key]

  if (typeof found !== 'object' || found === null || Array.isArray(found)) return false

  const expected = revision_marker(room_epoch, entry)
  const keys = Object.keys(expected) as (keyof RevisionMarker)[]
  const record = found as Record<string, unknown>
  const matches = Object.keys(record).length === keys.length
  assert(keys.length === 5, 'a marker has five fields')
  return matches && keys.every((key) => record[key] === expected[key])
}

// Appends an applied revision, marks the one it reverts, and expires the oldest beyond the bound.
function entries_append(entries: readonly RevisionEntry[], entry: RevisionEntry): RevisionEntry[] {
  const last = entries[entries.length - 1]

  if (last !== undefined) assert(entry.sequence > last.sequence, 'sequences only grow')

  const appended = entries.map((retained) =>
    retained.sequence === entry.reverts ? { ...retained, reverted_by: entry.sequence } : retained,
  )
  appended.push(entry)

  const kept = appended.slice(Math.max(0, appended.length - revisions_retained_max))
  assert(kept.length <= revisions_retained_max, 'retention is bounded')
  assert(kept[kept.length - 1] === entry, 'the newest revision is kept')
  return kept
}

// Durable, synchronous journal persistence. It throws on failure, before the room is touched
// for an intent and before acknowledging for a settle.
export type RevisionJournalSaver = { save(journal: RevisionJournal): void }

export type RevisionAction =
  | { readonly kind: 'edit'; readonly request_id: string; readonly request: SceneRequest }
  | { readonly kind: 'revert'; readonly sequence: number }

export type RevisionWriteResult = {
  readonly kind:
    Exclude<RevisionPlanOutcome['kind'], 'planned'> | 'written' | 'diverged' | 'rejected'
  readonly journal: RevisionJournal
  readonly plan: RevisionPlanOutcome | null
  readonly sequence: number | null
  readonly room_problem: string | null
}

// The integration path: read, plan, persist the intent, write, persist the room, settle and
// persist again. The read, plan, intent save and `updateStore` call run in one synchronous
// turn, so no client push can land between the decision and the room's snapshot. Calls must be
// serialized per room.
//
// `annotate` adds records outside the revision to the same push, such as a marker pages read;
// it never changes what the journal tracks. `room_save` makes the room durable before the
// settle is saved, so an acknowledged revision survives a crash; it throws on failure.
export async function revision_write<R>(options: {
  room: SceneRoom<R>
  room_epoch: string
  journal: RevisionJournal
  action: RevisionAction
  saver: RevisionJournalSaver
  annotate?: (store: SceneStore<R>, entry: RevisionEntry) => void
  room_save?: () => void
}): Promise<RevisionWriteResult> {
  const { room, room_epoch, journal, action, saver } = options
  const viewed = room_view_create(room.getCurrentSnapshot(), room_epoch)
  const base = { journal, plan: null, sequence: null }

  if (!viewed.ok) return { ...base, kind: 'unavailable', room_problem: viewed.reason }

  const planned =
    action.kind === 'edit'
      ? revision_edit_plan(journal, viewed.view, action.request_id, action.request)
      : revision_revert_plan(journal, viewed.view, action.sequence)

  if (planned.kind !== 'planned') {
    const sequence = 'sequence' in planned ? planned.sequence : null
    return { ...base, kind: planned.kind, plan: planned, sequence, room_problem: null }
  }

  const intended = revision_intend(journal, planned.plan)
  assert(intended.ok, 'a plan made from this journal can be intended')
  saver.save(intended.journal)
  const written = await revision_store_update(room, planned.plan, options.annotate ?? null)
  const after = room_view_create(room.getCurrentSnapshot(), room_epoch)
  const pending_base = { journal: intended.journal, plan: planned, sequence: null }

  // The intent stays saved: recovery settles it once the host has a readable room again.
  if (!after.ok) return { ...pending_base, kind: 'unavailable', room_problem: after.reason }

  // Nothing is acknowledged that a crash could take back. The intent stays pending, so the
  // caller settles it from the room once the room can be saved again.
  if (written === 'applied' && options.room_save !== undefined) {
    try {
      options.room_save()
    } catch (error) {
      if (error instanceof AssertionError) throw error

      return { ...pending_base, kind: 'unavailable', room_problem: 'room_save_failed' }
    }
  }

  const settled = revision_settle(
    intended.journal,
    after.view,
    written === 'applied' ? 'applied' : 'not_applied',
  )

  if (!settled.ok) return { ...pending_base, kind: 'unavailable', room_problem: settled.problem }

  saver.save(settled.journal)
  const sequence = written === 'applied' ? planned.plan.entry.sequence : null
  const kind = written === 'applied' ? 'written' : written
  return { kind, journal: settled.journal, plan: planned, sequence, room_problem: null }
}

async function revision_store_update<R>(
  room: SceneRoom<R>,
  plan: RevisionPlan,
  annotate: ((store: SceneStore<R>, entry: RevisionEntry) => void) | null,
): Promise<'applied' | 'diverged' | 'rejected'> {
  assert(plan.entry.changes.length >= 1, 'a plan writes something')

  const result: { applied: 'applied' | 'diverged' | null } = { applied: null }

  try {
    await room.updateStore((store) => {
      result.applied = revision_apply(store, plan)

      if (result.applied === 'applied' && annotate !== null) annotate(store, plan.entry)
    })
  } catch (error) {

    // The room refuses a push with an invalid record whole; an assertion is never swallowed.
    if (error instanceof AssertionError) throw error

    return 'rejected'
  }

  assert(result.applied !== null, 'the updater ran to completion')
  return result.applied
}

type ChangeJson = [string, SceneRecord | null, SceneRecord | null]

type EntryJson = {
  sequence: number
  request_id: string | null
  request_hash: string | null
  reverts: number | null
  reverted_by: number | null
  write_clock: number
  changes: ChangeJson[]
}

type JournalJson = {
  format: string
  version: number
  room_epoch: string
  id_namespace: string
  clock_observed: number
  sequence_next: number
  id_sequence_next: number
  entries: EntryJson[]
  pending: null | { entry: EntryJson; id_sequence_next: number }
}

function entry_json(entry: RevisionEntry): EntryJson {
  const changes: ChangeJson[] = entry.changes.map((change) => [
    change.id,
    change.before,
    change.after,
  ])
  assert(changes.length === entry.changes.length, 'every change is encoded')
  assert(changes.length <= scene_operations_max, 'encoded changes are bounded')
  return { ...entry, changes }
}

export function revision_journal_encode(journal: RevisionJournal): string {
  assert(journal.entries.length <= revisions_retained_max, 'entries are bounded')

  const pending = journal.pending
  const json: JournalJson = {
    format: journal_format,
    version: journal_version,
    room_epoch: journal.room_epoch,
    id_namespace: journal.id_namespace,
    clock_observed: journal.clock_observed,
    sequence_next: journal.sequence_next,
    id_sequence_next: journal.id_sequence_next,
    entries: journal.entries.map(entry_json),
    pending:
      pending === null
        ? null
        : { entry: entry_json(pending.entry), id_sequence_next: pending.id_sequence_next },
  }
  const text = JSON.stringify(json)
  assert(Buffer.byteLength(text, 'utf8') <= journal_text_bytes_max, 'the encoding is bounded')
  return text
}

export type RevisionJournalDecode =
  | { readonly ok: true; readonly journal: RevisionJournal }
  | { readonly ok: false; readonly reason: string }

// Saved data is untrusted: damage is reported, never repaired by guessing.
export function revision_journal_decode(text: string): RevisionJournalDecode {
  assert(typeof text === 'string', 'the journal is read as text')

  if (Buffer.byteLength(text, 'utf8') > journal_text_bytes_max) {
    return { ok: false, reason: 'the journal is larger than its bound' }
  }

  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the journal is not JSON' }
  }

  const header = journal_header_read(value)

  if (typeof header === 'string') return { ok: false, reason: header }

  const json = value as JournalJson
  const entries = entries_read(json.entries, header)

  if (typeof entries === 'string') return { ok: false, reason: entries }

  const pending = pending_read(json.pending, header)

  if (typeof pending === 'string') return { ok: false, reason: pending }

  const journal: RevisionJournal = { ...header, entries, pending }
  assert(journal.entries.length <= revisions_retained_max, 'decoded entries are bounded')
  return { ok: true, journal }
}

type JournalHeader = Omit<RevisionJournal, 'entries' | 'pending'>

function journal_header_read(value: unknown): JournalHeader | string {
  assert(journal_version === 1, 'this reader knows one version')

  if (typeof value !== 'object' || value === null) return 'the journal is not an object'

  const json = value as Partial<JournalJson>

  if (json.format !== journal_format || json.version !== journal_version) {
    return 'the journal format or version is unknown'
  }

  if (typeof json.room_epoch !== 'string' || !room_epoch_pattern.test(json.room_epoch)) {
    return 'the room epoch is malformed'
  }

  if (typeof json.id_namespace !== 'string' || !id_namespace_pattern.test(json.id_namespace)) {
    return 'the id namespace is malformed'
  }

  if (!clock_valid(json.clock_observed)) return 'the observed clock is malformed'

  const sequences = [json.sequence_next, json.id_sequence_next]

  if (!sequences.every((sequence) => clock_valid(sequence) && sequence >= 1)) {
    return 'a sequence is malformed'
  }

  const header: JournalHeader = {
    room_epoch: json.room_epoch,
    id_namespace: json.id_namespace,
    clock_observed: json.clock_observed,
    sequence_next: json.sequence_next as number,
    id_sequence_next: json.id_sequence_next as number,
  }
  assert(header.sequence_next >= 1, 'sequences start at one')
  return header
}

function entries_read(value: unknown, header: JournalHeader): RevisionEntry[] | string {
  assert(clock_valid(header.clock_observed), 'the header was validated first')

  if (!Array.isArray(value) || value.length > revisions_retained_max) {
    return 'the entries are not a bounded list'
  }

  const entries: RevisionEntry[] = []

  for (const item of value as unknown[]) {
    const entry = entry_read(item)

    if (typeof entry === 'string') return entry

    const previous = entries[entries.length - 1]
    const ordered = previous === undefined || entry.sequence > previous.sequence

    if (!ordered || entry.sequence >= header.sequence_next) return 'entries are out of order'

    if (entry.write_clock > header.clock_observed) return `entry ${entry.sequence} is unobserved`

    if (entry.reverted_by !== null && entry.reverted_by >= header.sequence_next) {
      return `entry ${entry.sequence} names an unknown revert`
    }

    entries.push(entry)
  }

  assert(entries.length === value.length, 'every entry is read once')
  return entries
}

function pending_read(value: unknown, header: JournalHeader): RevisionPending | null | string {
  assert(clock_valid(header.clock_observed), 'the header was validated first')

  if (value === null) return null

  if (typeof value !== 'object') return 'the pending revision is malformed'

  const json = value as { entry?: unknown; id_sequence_next?: unknown }

  if (json.id_sequence_next !== header.id_sequence_next) return 'the pending sequence disagrees'

  const entry = entry_read(json.entry)

  if (typeof entry === 'string') return entry

  if (entry.sequence !== header.sequence_next || entry.reverted_by !== null) {
    return 'the pending revision is not the next one'
  }

  if (entry.write_clock <= header.clock_observed) return 'the pending write clock is malformed'

  const pending = { entry, id_sequence_next: header.id_sequence_next }
  assert(pending.entry.changes.length >= 1, 'a pending revision changes something')
  return pending
}

function entry_read(value: unknown): RevisionEntry | string {
  if (typeof value !== 'object' || value === null) return 'an entry is malformed'

  const json = value as Partial<EntryJson>
  const { sequence, write_clock, reverts, reverted_by } = json

  if (!clock_valid(sequence) || sequence < 1 || !clock_valid(write_clock)) {
    return 'an entry sequence or clock is malformed'
  }

  const links_valid = [reverts, reverted_by].every(
    (link) => link === null || (clock_valid(link) && link >= 1),
  )

  if (!links_valid) return `entry ${sequence} has malformed links`

  if (typeof reverts === 'number' && reverts >= sequence) return `entry ${sequence} reverts later`

  if (typeof reverted_by === 'number' && reverted_by <= sequence) {
    return `entry ${sequence} is reverted earlier`
  }

  const request = request_fields_read(json, reverts ?? null)

  if (typeof request === 'string') return request

  const changes = changes_read(json.changes)

  if (typeof changes === 'string') return `entry ${sequence}: ${changes}`

  const entry: RevisionEntry = {
    sequence,
    ...request,
    reverts: reverts ?? null,
    reverted_by: reverted_by ?? null,
    write_clock,
    changes,
  }
  assert(entry.changes.length >= 1, 'a read entry changes something')
  return entry
}

function request_fields_read(
  json: Partial<EntryJson>,
  reverts: number | null,
): { request_id: string | null; request_hash: string | null } | string {
  assert(reverts === null || reverts >= 1, 'links were validated first')

  const { request_id, request_hash } = json

  if (reverts !== null) {
    if (request_id !== null || request_hash !== null) return 'a revert carries a request id'

    return { request_id: null, request_hash: null }
  }

  const id_valid = typeof request_id === 'string' && request_id_pattern.test(request_id)
  const hash_valid = typeof request_hash === 'string' && record_hash_pattern.test(request_hash)

  if (!id_valid || !hash_valid) return 'an edit needs a request id and hash'

  assert(request_id !== null, 'the id was validated')
  return { request_id, request_hash }
}

function changes_read(value: unknown): RevisionChange[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > scene_operations_max) {
    return 'changes are not a bounded list'
  }

  const changes: RevisionChange[] = []
  const ids = new Set<string>()

  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || item.length !== 3) return 'a change is malformed'

    const [id, before, after] = item as unknown[]

    if (typeof id !== 'string' || id.length > record_id_length_max || ids.has(id)) {
      return 'a change id is malformed or repeated'
    }

    if (!saved_record_valid(id, before) || !saved_record_valid(id, after)) {
      return `change ${id} holds a malformed record`
    }

    if (before === null && after === null) return `change ${id} changes nothing`

    ids.add(id)
    changes.push({ id, before: before as SceneRecord | null, after: after as SceneRecord | null })
  }

  assert(changes.length === ids.size, 'every change names a distinct record')
  return changes
}

// The room validates every record against its schema when a revert puts it back; here a saved
// record only has to be the shape or binding its change names.
function saved_record_valid(id: string, value: unknown): boolean {
  assert(id.length > 0, 'a change names a record')

  if (value === null) return true

  if (typeof value !== 'object' || Array.isArray(value)) return false

  const record = value as { id?: unknown; typeName?: unknown }
  const type_name = id.slice(0, id.indexOf(':'))
  const valid = record.id === id && record.typeName === type_name
  return valid && (type_name === 'shape' || type_name === 'binding')
}
