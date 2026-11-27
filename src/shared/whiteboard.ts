// What a linked board and its host agree on: the protocol number, who may speak for a board,
// and the durable requests an iPad sends. The number is one constant, so the host and the board
// change it in one place. It changes whenever a request or a publish means something new.

import { assert } from './assert'

// Protocol 3: every Send is a `sketch_notify` with an optional note, the Agent canvas is
// published as a freeform scene, and a draft can be previewed without publishing it.
export const whiteboard_protocol = 3

export const owner_pattern = /^[a-zA-Z0-9_-]{1,128}$/
export const credential_pattern = /^[0-9a-f]{64}$/

// The one kind of request a board queues. The note says what is wanted, in the person's words.
export const event_kinds = ['sketch_notify'] as const
export type EventKind = (typeof event_kinds)[number]

// Kinds an older board queued. A journal may still hold them, and a row under the bell may
// still name them. They are never queued again and never handed to a host: see `BoardEvents`.
export const event_kinds_retired = ['interpret_request'] as const
export const event_kinds_stored = [...event_kinds, ...event_kinds_retired] as const
export type EventKindStored = (typeof event_kinds_stored)[number]

export const event_states = ['queued', 'received', 'working', 'updated', 'failed'] as const
export type EventState = (typeof event_states)[number]
export type BoardEvent = {
  id: string
  kind: EventKindStored
  sketch_hash: string
  created_at_ms: number
  state: EventState
  message?: string
  text?: string
  request_id?: string
}

export const request_size_bytes_max = 16 * 1024
export const request_id_pattern = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
export const request_text_valid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 8000 &&
  [...value].length <= 4000 &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]/u.test(value)

export type EventRequest = Pick<BoardEvent, 'request_id' | 'text'>

export const events_count_max = 64
export const message_length_max = 280

// What a retired request is told when it is closed without being run.
export const retired_message = 'Interpret was retired. Send again and say what you want.'

export const whiteboard_path = '/api/whiteboard/'
export type Binding = { session: string; owner: string; token: string }

export function event_kind_retired(kind: unknown): boolean {
  const retired = event_kinds_retired.some((candidate) => candidate === kind)
  assert(!retired || !event_kinds.some((candidate) => candidate === kind), 'a kind is one or other')
  return retired
}

assert(Number.isInteger(whiteboard_protocol) && whiteboard_protocol > 0, 'a protocol is counted')
assert(retired_message.length <= message_length_max, 'the retirement notice fits a row')
