// What this tab knows about the requests on one board: one row for each request, changed in
// place as the request moves from this iPad to the Mac, to the agent, and to its end. A row
// never holds the words of a note. The Mac publishes only its newest request, so an older row
// keeps the last state this tab saw and says so.

import { assert } from '../shared/assert'
import {
  event_kinds,
  event_states,
  message_length_max,
  type BoardEvent,
  type EventKind,
  type EventState,
} from '../shared/whiteboard'

// Rows shown and saved for one board in one tab. The oldest row leaves when a new one arrives.
export const inbox_entries_count_max = 16

// The saved rows are a few hundred bytes each. Anything larger is not ours and is not parsed.
const inbox_text_length_max = 32 * 1024
const key_length_max = 64

// Times are whole milliseconds that a Date can show; the Mac bounds its own the same way.
const time_ms_max = 2 ** 48

// States this tab reaches alone, before the Mac has confirmed anything.
const local_states = ['sending', 'unconfirmed', 'refused'] as const
type LocalState = (typeof local_states)[number]
export type InboxState = EventState | LocalState
const inbox_states: readonly InboxState[] = [...event_states, ...local_states]

// A row is about a request of one kind, or about the note being written.
const subjects = [...event_kinds, 'draft'] as const
export type InboxSubject = EventKind | 'draft'

export type InboxEntry = {
  readonly key: string
  readonly event_id: string | null
  readonly subject: InboxSubject
  readonly state: InboxState
  readonly detail: string
  readonly changed_at_ms: number
  readonly unread: boolean
}

// What the composer reports: a step this tab took alone, or the Mac's receipt for a request.
export type InboxPost =
  | { type: 'local'; key: string; subject: InboxSubject; state: LocalState; detail: string }
  | { type: 'confirm'; key: string; event: BoardEvent }

// Time is passed in, never read here. `silent` means the list is open, so the change is seen.
type Stamp = { now_ms: number; silent: boolean }
export type InboxAction =
  | (InboxPost & Stamp)
  | ({ type: 'observe'; event: BoardEvent; baseline: boolean } & Stamp)
  | { type: 'read' }

// A request only moves forward. A reply that arrives late never takes a row back.
const state_rank: Record<InboxState, number> = {
  sending: 0,
  unconfirmed: 0,
  refused: 0,
  queued: 1,
  received: 2,
  working: 3,
  updated: 4,
  failed: 4,
}

const state_labels: Record<InboxState, string> = {
  sending: 'Sending',
  unconfirmed: 'Not confirmed',
  refused: 'Not sent',
  queued: 'Queued on the Mac',
  received: 'Received by your agent',
  working: 'Agent is working',
  updated: 'Done',
  failed: 'Failed',
}

const subject_labels: Record<InboxSubject, string> = {
  sketch_notify: 'Notification',
  interpret_request: 'Interpretation',
  draft: 'Note',
}

export const unconfirmed_detail = 'No confirmation. Notify again to retry the pending request.'
const interrupted = { state: 'unconfirmed', detail: unconfirmed_detail } as const

assert(inbox_entries_count_max > 0, 'the inbox can hold a row')
assert(Object.keys(state_rank).length === inbox_states.length, 'every state has a rank')
assert(unconfirmed_detail.length <= message_length_max, 'a local detail fits a row')

export const inbox_subject_label = (subject: InboxSubject) => subject_labels[subject]
export const inbox_state_label = (state: InboxState) => state_labels[state]

// Whether a row may be out of date: the Mac reports only its newest request, so an earlier
// one that had not ended is shown as last known. A null id means the Mac has not answered.
export function inbox_entry_stale(entry: InboxEntry, latest_event_id: string | null): boolean {
  if (latest_event_id === null || entry.event_id === null) return false

  const settled = entry.state === 'updated' || entry.state === 'failed'
  return !settled && entry.event_id !== latest_event_id
}

export function inbox_apply(
  entries: readonly InboxEntry[],
  action: InboxAction,
): readonly InboxEntry[] {
  assert(entries.length <= inbox_entries_count_max, 'the inbox starts within its bound')
  let next = entries

  if (action.type === 'read') {
    if (entries.some((entry) => entry.unread)) {
      next = entries.map((entry) => ({ ...entry, unread: false }))
    }
  } else if (action.type === 'local') {
    next = local_apply(entries, action)
  } else if (action.type === 'confirm') {
    next = event_valid(action.event) ? confirm_apply(entries, action) : entries
  } else {
    next = event_valid(action.event) ? observe_apply(entries, action) : entries
  }

  const kept = next.length > inbox_entries_count_max ? next.slice(-inbox_entries_count_max) : next
  assert(kept.length <= inbox_entries_count_max, 'the inbox ends within its bound')
  assert(new Set(kept.map((entry) => entry.key)).size === kept.length, 'one row for each request')
  return kept
}

function local_apply(
  entries: readonly InboxEntry[],
  action: Extract<InboxAction, { type: 'local' }>,
): readonly InboxEntry[] {
  assert(action.key.length > 0 && action.key.length <= key_length_max, 'a row key is bounded')
  assert(action.now_ms >= 0 && action.now_ms < time_ms_max, 'the clock reads a real time')
  const prior = entries.find((entry) => entry.key === action.key)

  // The Mac already answered for this request: what this tab thinks alone no longer counts.
  if (prior && state_rank[prior.state] > 0) return entries

  const entry: InboxEntry = {
    key: action.key,
    event_id: null,
    subject: action.subject,
    state: action.state,
    detail: action.detail.slice(0, message_length_max),
    changed_at_ms: action.now_ms,
    unread: action.state !== 'sending' && !action.silent,
  }
  return prior ? entries.map((item) => (item === prior ? entry : item)) : [...entries, entry]
}

function confirm_apply(
  entries: readonly InboxEntry[],
  action: Extract<InboxAction, { type: 'confirm' }>,
): readonly InboxEntry[] {
  const { event, key } = action

  // The status poll may have shown this request before its own receipt arrived. Fold that row
  // into the request's row, and keep whichever state is further along.
  const seen = entries.find((entry) => entry.event_id === event.id && entry.key !== key)
  const ahead = seen !== undefined && state_rank[seen.state] > state_rank[event.state]
  const entry: InboxEntry = {
    key,
    event_id: event.id,
    subject: event.kind,
    state: ahead ? seen.state : event.state,
    detail: ahead ? seen.detail : (event.message ?? ''),
    changed_at_ms: action.now_ms,
    unread: !action.silent,
  }
  const rest = entries.filter((item) => item !== seen)
  const prior = rest.find((item) => item.key === key)
  assert(rest.every((item) => item.event_id !== event.id || item === prior), 'one row per event')
  return prior ? rest.map((item) => (item === prior ? entry : item)) : [...rest, entry]
}

function observe_apply(
  entries: readonly InboxEntry[],
  action: Extract<InboxAction, { type: 'observe' }>,
): readonly InboxEntry[] {
  const { event } = action
  const detail = event.message ?? ''
  const prior = entries.find((entry) => entry.event_id === event.id)

  if (!prior) {

    // A request made before this page opened, or from another iPad. On the first look it is
    // history, not news, and its own time is the best one known.
    const entry: InboxEntry = {
      key: event.id,
      event_id: event.id,
      subject: event.kind,
      state: event.state,
      detail,
      changed_at_ms: action.baseline ? event.created_at_ms : action.now_ms,
      unread: !action.baseline && !action.silent,
    }
    return [...entries.filter((item) => item.key !== entry.key), entry]
  }

  const forward = state_rank[event.state] > state_rank[prior.state]
  const reworded = event.state === prior.state && detail !== prior.detail

  if (!forward && !reworded) return entries

  const entry = {
    ...prior,
    state: event.state,
    detail,
    changed_at_ms: action.now_ms,
    unread: !action.silent,
  }
  return entries.map((item) => (item === prior ? entry : item))
}

// The status reply is read from the network: check it before a row is made from it.
function event_valid(event: BoardEvent): boolean {
  return (
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    event.id.length <= key_length_max &&
    event_kinds.includes(event.kind) &&
    event_states.includes(event.state) &&
    Number.isSafeInteger(event.created_at_ms) &&
    event.created_at_ms >= 0 &&
    event.created_at_ms < time_ms_max &&
    (event.message === undefined ||
      (typeof event.message === 'string' && event.message.length <= message_length_max))
  )
}

function entry_valid(value: unknown): value is InboxEntry {
  const entry = value as InboxEntry | null
  return (
    !!entry &&
    typeof entry.key === 'string' &&
    entry.key.length > 0 &&
    entry.key.length <= key_length_max &&
    (entry.event_id === null ||
      (typeof entry.event_id === 'string' && entry.event_id.length <= key_length_max)) &&
    subjects.includes(entry.subject) &&
    inbox_states.includes(entry.state) &&
    typeof entry.detail === 'string' &&
    entry.detail.length <= message_length_max &&
    Number.isSafeInteger(entry.changed_at_ms) &&
    entry.changed_at_ms >= 0 &&
    entry.changed_at_ms < time_ms_max &&
    typeof entry.unread === 'boolean'
  )
}

// Saved rows are a convenience, not a record: rows that cannot be read are left out. A row
// left mid-send by a reload is unconfirmed if its request can still be retried, and gone if not.
export function inbox_restore(text: string | null, pending_key: string | null): InboxEntry[] {
  if (text === null || text.length > inbox_text_length_max) return []

  let saved: unknown

  try {
    saved = JSON.parse(text)
  } catch {
    return []
  }

  if (!Array.isArray(saved) || saved.length > inbox_entries_count_max) return []

  if (!saved.every(entry_valid)) return []

  const entries: InboxEntry[] = []

  for (const entry of saved) {
    const duplicate = entries.some(
      (item) => item.key === entry.key || (entry.event_id && item.event_id === entry.event_id),
    )
    const waiting = entry.state === 'sending' || entry.state === 'unconfirmed'

    if (duplicate || (waiting && entry.key !== pending_key)) continue

    entries.push(entry.state === 'sending' ? { ...entry, ...interrupted } : entry)
  }

  assert(entries.length <= inbox_entries_count_max, 'restored rows fit the inbox')
  assert(entries.every((entry) => entry.state !== 'sending'), 'no restored row is mid-send')
  return entries
}
