export const layers = ['canvas', 'interpretation', 'ideas'] as const
export type Layer = (typeof layers)[number]
export const owner_pattern = /^[a-zA-Z0-9_-]{1,128}$/
export const credential_pattern = /^[0-9a-f]{64}$/
export const event_kinds = ['sketch_notify', 'interpret_request'] as const
export type EventKind = (typeof event_kinds)[number]
export const event_states = ['queued', 'received', 'working', 'updated', 'failed'] as const
export type EventState = (typeof event_states)[number]
export type BoardEvent = {
  id: string
  kind: EventKind
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
  typeof value === 'string' && value.length <= 8000 && [...value].length <= 4000 &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]/u.test(value)

export type EventRequest = Pick<BoardEvent, 'request_id' | 'text'>

export const events_count_max = 64
export const message_length_max = 280
export const idea_nodes_count_max = 64
export const idea_shapes_count_max = 256
export const whiteboard_path = '/api/whiteboard/'
export type Binding = { session: string; owner: string; token: string }
