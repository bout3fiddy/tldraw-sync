// A board's conversation as its paired readers see it: each request in the person's words, the
// sketch it carried if any, what became of it, and the agent's answer. Only the private chat
// route serves this, to the pad and the Mac stage paired with the board. The board's public
// status never carries a word of it.

import { assert } from './assert'
import { document_hash_pattern } from './constants'
import {
  event_kinds_stored,
  event_state_terminal,
  event_states,
  message_length_max,
  reply_text_valid,
  request_id_pattern,
  request_text_valid,
  type BoardEvent,
  type EventKindStored,
  type EventState,
} from './whiteboard'

export type ChatItem = {
  readonly id: string
  readonly request_id: string | null
  readonly kind: EventKindStored
  readonly include_sketch: boolean
  readonly text: string | null

  // The sketch that went with the words, as it was: its hash and how many shapes it held.
  readonly sketch_hash: string | null
  readonly shapes_count: number | null
  readonly created_at_ms: number
  readonly state: EventState

  // A status line while the agent works; the agent's answer once the request has ended.
  readonly status: string | null
  readonly reply: string | null

  // The place of the answer in the board's count of answers, and the Agent canvas revision
  // the answer was given at, when the canvas moved while the request was open.
  readonly answer_seq: number | null
  readonly answered_at_ms: number | null
  readonly canvas_revision: number | null
}

export type ChatResponse = {
  readonly session: string
  readonly changes_count: number
  readonly answers_count: number
  readonly items: readonly ChatItem[] | null
}

const count_max = 2 ** 48

// What a paired reader is shown of one durable request. Nothing of the host's replay or
// delivery bookkeeping is added, and nothing is invented: a missing field stays missing.
export function chat_item(event: BoardEvent): ChatItem {
  const terminal = event_state_terminal(event.state)
  const sketch = event.include_sketch !== false
  const sent = event.revision_sent
  const answered = event.revision_answered
  const moved = sent !== undefined && answered !== undefined && answered > sent
  const item: ChatItem = {
    id: event.id,
    request_id: event.request_id ?? null,
    kind: event.kind,
    include_sketch: sketch,
    text: event.text ?? null,
    sketch_hash: sketch ? event.sketch_hash : null,
    shapes_count: sketch ? (event.shapes_count ?? null) : null,
    created_at_ms: event.created_at_ms,
    state: event.state,
    status: terminal ? null : (event.message ?? null),
    reply: terminal ? (event.message ?? null) : null,
    answer_seq: event.answer_seq ?? null,
    answered_at_ms: event.answered_at_ms ?? null,
    canvas_revision: moved ? answered : null,
  }
  assert(item.include_sketch || item.sketch_hash === null, 'words alone name no sketch')
  assert(chat_item_valid(item), 'the board serves only what a reader accepts')
  return item
}

const nullable = <T>(value: unknown, check: (value: unknown) => value is T): value is T | null =>
  value === null || check(value)
const string_valid = (value: unknown): value is string => typeof value === 'string'
const count_valid =
  (minimum: number) =>
  (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) < count_max

// Read by the page from the network: every field is checked before it is shown.
export function chat_item_valid(value: unknown): value is ChatItem {
  const item = value as Record<string, unknown> | null

  if (!item || typeof item !== 'object') return false

  const status = item.status
  const reply = item.reply
  return (
    typeof item.id === 'string' &&
    /^[0-9a-f-]{36}$/.test(item.id) &&
    nullable(item.request_id, string_valid) &&
    (item.request_id === null || request_id_pattern.test(item.request_id as string)) &&
    event_kinds_stored.includes(item.kind as EventKindStored) &&
    typeof item.include_sketch === 'boolean' &&
    (item.text === null || (request_text_valid(item.text) && (item.text as string).length > 0)) &&
    nullable(item.sketch_hash, string_valid) &&
    (item.sketch_hash === null || document_hash_pattern.test(item.sketch_hash as string)) &&
    nullable(item.shapes_count, count_valid(0)) &&
    count_valid(0)(item.created_at_ms) &&
    event_states.includes(item.state as EventState) &&
    (status === null || (typeof status === 'string' && status.length <= message_length_max)) &&
    (reply === null ||
      (typeof reply === 'string' &&
        (reply.length <= message_length_max || reply_text_valid(reply)))) &&
    nullable(item.answer_seq, count_valid(1)) &&
    nullable(item.answered_at_ms, count_valid(0)) &&
    nullable(item.canvas_revision, count_valid(1))
  )
}

assert(count_valid(1)(1) && !count_valid(1)(0), 'an answer is counted from one')
assert(!chat_item_valid(null), 'nothing is not a message')
