import { assert } from '../shared/assert'
import { document_hash_pattern, proposal_size_bytes_max } from '../shared/constants'
import {
  event_kinds,
  event_states,
  layers,
  message_length_max,
  owner_pattern,
  whiteboard_path,
} from '../shared/whiteboard'
import type { BoardRegistry } from './board_registry'
import { body_discard, body_read, json_error, lookup_error, publish_response } from './http_cleanup'
import { json_no_store } from './http_sessions'
import { authorized, scoped_key } from './whiteboard_keys'

export const denied = async (request: Request) => {
  await body_discard(request)
  return json_error(403, 'not_authorized', 'This board requires pairing.')
}
const invalid = () => json_error(400, 'invalid_request', 'Check the whiteboard request fields.')

export async function whiteboard_route(
  request: Request,
  registry: BoardRegistry,
  session: string,
  key: string | undefined,
  local: boolean,
): Promise<Response> {
  if (!key) return denied(request)

  const url = new URL(request.url)
  const action = url.pathname.slice(whiteboard_path.length)
  const owner = registry.owner(session)
  const origin = request.headers.get('origin')

  if (origin !== null && origin !== url.origin) return denied(request)

  if (action === 'event' && owner !== null && request.method === 'POST') {
    if (!authorized(request, scoped_key(key, 'event', session, owner))) return denied(request)

    return event_route(request, registry, session)
  }

  if (!local || origin !== null) return denied(request)

  if (action === 'link' && request.method === 'POST' && authorized(request, key)) {
    return link_route(request, registry, key)
  }

  if (
    owner === null ||
    owner !== request.headers.get('x-board-owner') ||
    !authorized(request, scoped_key(key, 'host', session, owner))
  )
    return denied(request)

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const { board } = lookup

  if (action === 'poll' && request.method === 'GET') {
    const events = board.events.outstanding().map(({ message: _, ...rest }) => rest)
    const sketch_hash = board.document_state().hash
    const agent_revision = board.cleaned_status().revision + board.cleaned_status('ideas').revision
    assert(Number.isSafeInteger(agent_revision), 'the change counter remains exact')
    assert(board.session === session, 'poll does not cross an owner boundary')
    return json_no_store({ session, owner, sketch_hash, agent_revision, events })
  }

  if (action === 'ack' && request.method === 'POST') return ack_route(request, registry, session)

  return layer_route(request, url, registry, session, action)
}

async function layer_route(
  request: Request,
  url: URL,
  registry: BoardRegistry,
  session: string,
  action: string,
): Promise<Response> {
  const layer = layers.find((value) => value === url.searchParams.get('layer'))

  if (!layer) return invalid()

  if (action === 'snapshot' && request.method === 'GET') {
    const hash = url.searchParams.get('document_hash') ?? ''

    if (!document_hash_pattern.test(hash)) return invalid()

    const snapshot = registry.sketch_snapshot(session, hash, layer)

    if (!snapshot) return json_error(409, 'sketch_changed', 'Take a fresh snapshot.')

    if ('kind' in snapshot) return lookup_error(snapshot)

    assert(snapshot.session === session, 'layer records belong to the authenticated board')
    assert(snapshot.document_hash === hash, 'layer records describe the rendered image')
    return json_no_store(snapshot)
  }

  if (action === 'publish' && request.method === 'POST') {
    const body = await body_read(request, proposal_size_bytes_max)

    if (!body.ok) return body.response

    if (!(body.value as { diagram?: unknown } | null)?.diagram) {
      return json_error(400, 'invalid_proposal', 'Publish a composed semantic diagram.')
    }

    return publish_response(registry.publish(session, body.value, layer))
  }

  return invalid()
}

async function link_route(request: Request, registry: BoardRegistry, key: string) {
  const body = await body_read(request, 1024)

  if (!body.ok) return body.response

  const owner = (body.value as { owner?: unknown } | null)?.owner

  if (typeof owner !== 'string' || !owner_pattern.test(owner)) return invalid()

  const result = registry.link(owner)

  if (result.kind === 'full') return json_error(409, 'sessions_full', 'Board capacity reached.')

  const session = result.session.id
  assert(registry.owner(session) === owner, 'the board is durably bound before issuing a token')
  return json_no_store({ session, owner, token: scoped_key(key, 'host', session, owner) })
}

async function event_route(request: Request, registry: BoardRegistry, session: string) {
  const body = await body_read(request, 1024)

  if (!body.ok) return body.response

  const value = body.value as { kind?: unknown; sketch_hash?: unknown } | null
  const kind = event_kinds.find((k) => k === value?.kind)
  const hash = value?.sketch_hash

  if (!kind || typeof hash !== 'string' || !document_hash_pattern.test(hash)) return invalid()

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const event = lookup.board.queue_event(kind, hash)

  if (event === 'full') return json_error(409, 'events_full', 'The agent queue is full.')

  if (event === 'syncing') return json_error(409, 'syncing', 'Ink is syncing. Tap again to send.')

  assert(event.kind === kind, 'a notification cannot hide an interpretation request')
  assert(event.sketch_hash === hash, 'the acknowledged event matches the tap')
  return json_no_store(event)
}

async function ack_route(request: Request, registry: BoardRegistry, session: string) {
  const body = await body_read(request, 4096)

  if (!body.ok) return body.response

  const value = body.value as { event?: unknown; state?: unknown; message?: unknown } | null
  const state = event_states.find((s) => s === value?.state)
  const message = value?.message

  if (typeof value?.event !== 'string' || !state || state === 'queued') return invalid()

  if (message !== undefined && (typeof message !== 'string' || message.length > message_length_max))
    return invalid()

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const event = lookup.board.events.ack(value.event, state, message)

  if (event === 'missing') return json_error(404, 'unknown_event', 'No such event on this board.')

  if (event === 'transition') return json_error(409, 'invalid_transition', 'Invalid event state.')

  assert(event.id === value.event && event.state === state, 'the acknowledgement matches the event')
  return json_no_store({ session, event: event.id, state: event.state })
}
