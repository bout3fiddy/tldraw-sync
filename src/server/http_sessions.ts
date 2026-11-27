// The board session routes: list the boards, make a new one, rename one. Bodies are untrusted
// JSON, bounded like every other body; a name is plain text and is refused, never corrected,
// when it is not one.

import { assert } from '../shared/assert'
import { board_id_pattern, board_name_clean } from '../shared/board_session'
import {
  board_name_length_max,
  board_sessions_count_max,
  session_request_size_bytes_max,
} from '../shared/constants'
import type { BoardRegistry } from './board_registry'
import { body_discard, body_read, json_error, lookup_error } from './http_canvas'

const name_problem = `Send a name of 1 to ${board_name_length_max} characters on one line.`

export function sessions_list_response(registry: BoardRegistry): Response {
  const sessions = registry.list()
  assert(sessions.length > 0, 'the default board is always listed')
  assert(sessions.length <= board_sessions_count_max, 'sessions are bounded')
  return json_no_store({
    sessions,
    count_max: board_sessions_count_max,
    open_count: registry.open_count(),
  })
}

// `{"name": "..."}` names the new board; `{}` or `{"name": null}` leaves it for a title.
export async function session_create_route(
  request: Request,
  registry: BoardRegistry,
): Promise<Response> {
  const body = await body_read(request, session_request_size_bytes_max)

  if (!body.ok) return body.response

  const value = object_read(body.value)
  const name_input = value?.name ?? null
  const name = name_input === null ? null : board_name_clean(name_input, board_name_length_max)

  if (value === null || (name_input !== null && name === null)) {
    return json_error(400, 'invalid_name', name_problem)
  }

  const result = registry.create(name)

  if (result.kind === 'full') {
    const message = `There are ${board_sessions_count_max} boards already, the most there can be.`
    return json_error(409, 'sessions_full', message)
  }

  assert(result.session.name === name, 'the new board has the name asked for')
  return json_no_store({ session: result.session })
}

// `{"session": "<id>", "name": "..."}`. A person's rename always wins over an agent's title.
export async function session_rename_route(
  request: Request,
  registry: BoardRegistry,
): Promise<Response> {
  const body = await body_read(request, session_request_size_bytes_max)

  if (!body.ok) return body.response

  const value = object_read(body.value)
  const id = value?.session

  if (typeof id !== 'string' || !board_id_pattern.test(id)) {
    return json_error(400, 'malformed_session', 'Name the board with a session id.')
  }

  const name = board_name_clean(value?.name, board_name_length_max)

  if (name === null) return json_error(400, 'invalid_name', name_problem)

  const result = registry.rename(id, name)

  if (result.kind === 'not_found') {
    return json_error(404, 'unknown_session', 'No board has that session id. List the boards.')
  }

  assert(result.session.named_by === 'person', 'a rename is a person naming the board')
  return json_no_store({ session: result.session })
}

export async function session_delete_route(request: Request, registry: BoardRegistry) {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')

  if (
    (origin !== null && origin !== new URL(request.url).origin) ||
    site === 'cross-site' ||
    site === 'same-site'
  ) {
    await body_discard(request)
    return json_error(403, 'wrong_origin', 'Delete a board from its own site.')
  }

  const body = await body_read(request, session_request_size_bytes_max)

  if (!body.ok) return body.response

  const value = object_read(body.value)
  const id = value?.session

  if (typeof id !== 'string' || !board_id_pattern.test(id)) {
    return json_error(400, 'malformed_session', 'Name the board with a session id.')
  }

  const session = registry.find(id)

  if (session && value && 'name' in value && session.name !== value.name) {
    return json_error(409, 'name_changed', 'The board was renamed. Check the name and try again.')
  }

  const result = registry.remove(id)

  if (result === 'not_found') return lookup_error({ kind: 'not_found' })

  if (result === 'permanent') {
    return json_error(409, 'permanent_board', 'The default board cannot be deleted.')
  }

  assert(result === 'removed', 'cleanup completed before the acknowledgement')
  assert(registry.board_open(id) === null, 'the deleted room is closed')
  return json_no_store({ deleted: id })
}

function object_read(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null

  assert(typeof value === 'object', 'a read body is an object')
  assert(!Array.isArray(value), 'a read body is not a list')
  return value as Record<string, unknown>
}

export function json_no_store(value: object): Response {
  assert(typeof value === 'object', 'a JSON response is an object')
  assert(value !== null, 'a JSON response is not null')
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}
