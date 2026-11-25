export const layers = ['interpretation', 'ideas'] as const
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
}

export const events_count_max = 64
export const message_length_max = 280
export const idea_nodes_count_max = 64
export const idea_shapes_count_max = 256
export const whiteboard_path = '/api/whiteboard/'
export type Binding = { session: string; owner: string; token: string }
