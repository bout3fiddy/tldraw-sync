// What a linked board and its host agree on: the protocol number, who may speak for a board,
// and the durable requests an iPad sends. The number is one constant, so the host and the board
// change it in one place. It changes whenever a request or a publish means something new.

import { assert } from './assert'

// Protocol 4: every Send is still a `sketch_notify`. It says whether the sketch goes with it in
// `include_sketch`: absent is the earlier meaning, the sketch as it is; false is words alone, and
// the host takes no snapshot. The final acknowledgement carries the agent's answer to the pad.
export const whiteboard_protocol = 4

export const owner_pattern = /^[a-zA-Z0-9_-]{1,128}$/
export const credential_pattern = /^[0-9a-f]{64}$/

// The one kind of request a board queues. The note says what is wanted, in the person's words.
export const event_kinds = ['sketch_notify'] as const
export type EventKind = (typeof event_kinds)[number]

// Kinds an older board queued. A journal may still hold them, and a message in the chat may
// still name them. They are never queued again and never handed to a host: see `BoardEvents`.
export const event_kinds_retired = ['interpret_request'] as const
export const event_kinds_stored = [...event_kinds, ...event_kinds_retired] as const
export type EventKindStored = (typeof event_kinds_stored)[number]

export const event_states = ['queued', 'received', 'working', 'updated', 'failed'] as const
export type EventState = (typeof event_states)[number]
export const event_state_terminal = (state: EventState) => state === 'updated' || state === 'failed'

// A durable request and what became of it. `message` is a short status line while the agent
// works, and the agent's answer for the pad once the request has ended. The board alone fills
// `shapes_count`, `revision_sent`, `revision_answered`, `answer_seq` and `answered_at_ms`; a
// host never sees them.
export type BoardEvent = {
  id: string
  kind: EventKindStored
  sketch_hash: string
  created_at_ms: number
  state: EventState
  message?: string
  text?: string
  request_id?: string
  include_sketch?: boolean
  shapes_count?: number
  revision_sent?: number
  revision_answered?: number
  answer_seq?: number
  answered_at_ms?: number
}

export const request_size_bytes_max = 16 * 1024
export const request_id_pattern = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
export const text_code_points_max = 4000
const text_controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]/u

export const request_text_valid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 2 * text_code_points_max &&
  [...value].length <= text_code_points_max &&
  !text_controls.test(value)

// The agent's answer: the same characters a note may use, at most 16 KiB of UTF-8.
export const reply_size_bytes_max = 16 * 1024
export const reply_text_valid = (value: unknown): value is string =>
  request_text_valid(value) &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).length <= reply_size_bytes_max

export type EventRequest = Pick<BoardEvent, 'request_id' | 'text' | 'include_sketch'>

export const events_count_max = 64

// A status line while the agent works. An answer is bounded by `reply_text_valid` instead.
export const message_length_max = 280

// What a retired request is told when it is closed without being run.
export const retired_message = 'Interpret was retired. Send again and say what you want.'

export const whiteboard_path = '/api/whiteboard/'
export type Binding = { session: string; owner: string; token: string }

// The header a Mac stage sends, from this machine only, to be handed its board's chat key.
export const header_board_stage = 'x-board-stage'

// Whether a message fits the state it is sent with: a status line, or an answer.
export function event_message_valid(state: EventState, message: unknown): boolean {
  if (message === undefined) return true

  if (event_state_terminal(state)) return reply_text_valid(message)

  return typeof message === 'string' && message.length <= message_length_max
}

// Words alone need words. A request with the sketch may have none.
export function event_request_complete(request: EventRequest): boolean {
  if (request.include_sketch !== false) return true

  return typeof request.text === 'string' && request.text.trim().length > 0
}

export function event_kind_retired(kind: unknown): boolean {
  const retired = event_kinds_retired.some((candidate) => candidate === kind)
  assert(!retired || !event_kinds.some((candidate) => candidate === kind), 'a kind is one or other')
  return retired
}

assert(Number.isInteger(whiteboard_protocol) && whiteboard_protocol > 0, 'a protocol is counted')
assert(retired_message.length <= message_length_max, 'the retirement notice fits a row')
assert(reply_text_valid(retired_message), 'the retirement notice is a valid answer')
assert(text_code_points_max * 4 <= reply_size_bytes_max, 'any valid answer fits in its bytes')
