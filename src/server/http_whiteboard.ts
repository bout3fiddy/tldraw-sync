// The routes of a linked board. An iPad paired by the stage QR may send a request and read the
// board's chat, and nothing else. The Mac stage, on this machine, is handed the same pairing.
// The host, on this machine and holding the board's own token, may poll, acknowledge, read a
// snapshot, have a draft rendered and publish. Every body is untrusted and bounded.

import { assert } from '../shared/assert'
import { chat_item, type ChatResponse } from '../shared/board_chat'
import { document_hash_pattern, proposal_size_bytes_max } from '../shared/constants'
import {
  credential_pattern,
  event_kind_retired,
  event_kinds,
  event_message_valid,
  event_state_terminal,
  event_states,
  header_board_stage,
  owner_pattern,
  request_id_pattern,
  request_size_bytes_max,
  request_text_valid,
  retired_message,
  whiteboard_path,
  whiteboard_protocol,
  type BoardEvent,
} from '../shared/whiteboard'
import type { Board } from './board'
import type { BoardRegistry } from './board_registry'
import {
  body_discard,
  body_read,
  json_error,
  lookup_error,
  preview_response,
  publish_response,
} from './http_canvas'
import { json_no_store } from './http_sessions'
import { authorized, scoped_key } from './whiteboard_keys'

export const header_preview_id = 'x-preview-id'
const preview_id_pattern = /^[0-9a-f-]{36}$/

// An answer of 4000 code points, escaped as JSON by any host, with the fields around it.
const ack_body_bytes_max = 64 * 1024

// What a host is told of a request: the fields it has always had, and `include_sketch` when
// the pad said. The board's own bookkeeping and the status line stay with the board.
export function event_public(event: BoardEvent) {
  const { id, kind, request_id, sketch_hash, created_at_ms, state, text, include_sketch } = event
  const shown = {
    id,
    kind,
    sketch_hash,
    created_at_ms,
    state,
    ...(request_id === undefined ? {} : { request_id }),
    ...(text === undefined ? {} : { text }),
    ...(include_sketch === undefined ? {} : { include_sketch }),
  }
  assert(!('message' in shown) && !('answer_seq' in shown), 'a host sees only the request')
  assert(shown.text === text, 'the words reach the host exactly')
  return shown
}

export const denied = async (request: Request) => {
  await body_discard(request)
  return json_error(403, 'not_authorized', 'This board requires pairing.')
}
const upgrade = () =>
  json_error(409, 'upgrade_required', `Upgrade the host and use protocol ${whiteboard_protocol}.`)
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

  const paired = pad_route({ request, url, registry, session, key, owner, action })

  if (paired !== null) return paired

  if (!local || origin !== null) return denied(request)

  // The Mac stage shows the pairing QR already. Asked from this machine, by a page of this
  // board's own and not across origins, it is handed the same key to read and send the chat.
  if (action === 'stage' && request.method === 'GET') {
    if (owner === null || request.headers.get(header_board_stage) !== 'chat') {
      return denied(request)
    }

    return json_no_store({ session, token: scoped_key(key, 'event', session, owner) })
  }

  if (action === 'link' && request.method === 'POST' && authorized(request, key)) {

    // Link finds or creates an owner's own board. Never ignore an explicit board target.
    if (url.searchParams.has('session')) {
      await body_discard(request)
      return invalid()
    }

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

  assert(lookup.board.session === session, 'a host never crosses an owner boundary')

  if (action === 'poll' && request.method === 'GET') return poll_route(url, lookup.board, owner)

  if (action === 'ack' && request.method === 'POST') return ack_route(request, registry, session)

  return canvas_route(request, url, registry, session, action)
}

type PadRequest = {
  request: Request
  url: URL
  registry: BoardRegistry
  session: string
  key: string
  owner: string | null
  action: string
}

// What the pairing may do, from a pad or the Mac stage: send a request, and read the chat it
// sends to. Null is any other route, for the host's credentials to decide.
function pad_route(pad: PadRequest): Response | Promise<Response> | null {
  const { request, url, registry, session, key, owner, action } = pad

  if (owner === null) return null

  const pairing = scoped_key(key, 'event', session, owner)
  const notifying = action === 'event/v2' || action === 'event'
  assert(owner_pattern.test(owner), 'the pairing names a bound owner')
  assert(credential_pattern.test(pairing), 'a pairing is a whole credential')

  if (notifying && request.method === 'POST') {
    return authorized(request, pairing) ? event_route(request, registry, session) : denied(request)
  }

  if (action === 'chat' && request.method === 'GET') {
    return authorized(request, pairing) ? chat_route(url, registry, session) : denied(request)
  }

  return null
}

// The requests still waiting, as a host is handed them.
function poll_route(url: URL, board: Board, owner: string) {
  if (url.searchParams.get('protocol') !== String(whiteboard_protocol)) return upgrade()

  const session = board.session
  const events = board.events.outstanding().map(event_public)
  const sketch_hash = board.document_state().hash
  const agent_revision = board.cleaned_status().revision
  const protocol = whiteboard_protocol
  assert(Number.isSafeInteger(agent_revision), 'the change counter remains exact')
  assert(
    events.every((event) => !event_kind_retired(event.kind)),
    'a retired kind never wakes',
  )
  assert(events.every((event) => !('message' in event)), 'a host is never handed an answer')
  return json_no_store({ protocol, session, owner, sketch_hash, agent_revision, events })
}

// What the host does with the Agent canvas: read a snapshot, have a draft rendered, publish.
async function canvas_route(
  request: Request,
  url: URL,
  registry: BoardRegistry,
  session: string,
  action: string,
): Promise<Response> {

  // One canvas. The name is accepted where an earlier host still sends it.
  if ((url.searchParams.get('layer') ?? 'canvas') !== 'canvas') {
    await body_discard(request)
    return json_error(400, 'invalid_layer', 'There is one Agent canvas: leave the layer out.')
  }

  if (action === 'snapshot' && request.method === 'GET') {
    const hash = url.searchParams.get('document_hash') ?? ''

    if (!document_hash_pattern.test(hash)) return invalid()

    const snapshot = registry.sketch_snapshot(session, hash)

    if (!snapshot) return json_error(409, 'sketch_changed', 'Take a fresh snapshot.')

    if ('kind' in snapshot) return lookup_error(snapshot)

    assert(snapshot.session === session, 'the snapshot belongs to the authenticated board')
    assert(snapshot.document_hash === hash, 'the snapshot describes the rendered image')
    return json_no_store(snapshot)
  }

  if (action === 'preview-image' && request.method === 'GET') {
    return preview_image_route(url, registry, session)
  }

  if ((action === 'publish' || action === 'preview') && request.method === 'POST') {
    const body = await body_read(request, proposal_size_bytes_max)

    if (!body.ok) return body.response

    return action === 'publish'
      ? publish_response(registry.publish(session, body.value))
      : preview_response(registry.preview(session, body.value), session)
  }

  await body_discard(request)
  return invalid()
}

// The rendering of a draft, once the stage has made it. The request waits a bounded time.
async function preview_image_route(url: URL, registry: BoardRegistry, session: string) {
  const id = url.searchParams.get('id') ?? ''

  if (!preview_id_pattern.test(id)) return invalid()

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const image = await lookup.board.preview_get(id)

  if (image.kind === 'unknown') {
    return json_error(404, 'unknown_preview', 'That draft was replaced. Preview it again.')
  }

  if (image.kind === 'stale') {
    const message =
      image.reason === 'stage_absent'
        ? 'The Mac stage that renders a draft is not open.'
        : 'The Mac stage has not rendered the draft yet.'
    return json_error(503, 'preview_not_ready', message, { reason: image.reason })
  }

  assert(image.bytes.byteLength > 0, 'a rendering is never empty')
  return new Response(image.bytes as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store', [header_preview_id]: id },
  })
}

async function link_route(request: Request, registry: BoardRegistry, key: string) {
  const body = await body_read(request, 1024)

  if (!body.ok) return body.response

  const protocol = whiteboard_protocol

  if ((body.value as { protocol?: unknown } | null)?.protocol !== protocol) return upgrade()

  const owner = (body.value as { owner?: unknown } | null)?.owner

  if (typeof owner !== 'string' || !owner_pattern.test(owner)) return invalid()

  const result = registry.link(owner)

  if (result.kind === 'full') return json_error(409, 'sessions_full', 'Board capacity reached.')

  const session = result.session.id
  assert(registry.owner(session) === owner, 'the board is durably bound before issuing a token')
  const token = scoped_key(key, 'host', session, owner)
  return json_no_store({ protocol, session, owner, token })
}

// A Send from a paired pad: a replay key, the words in the person's own hand, and whether the
// sketch goes with them. With the sketch it names the hash it shows, and the words may be
// left out. Words alone name no sketch, and need words. There is one kind of request.
async function event_route(request: Request, registry: BoardRegistry, session: string) {
  const body = await body_read(request, request_size_bytes_max)

  if (!body.ok) return body.response

  const value = body.value as Record<string, unknown> | null
  const hash = value?.sketch_hash
  const include_sketch = value?.include_sketch

  // A page from before the upgrade may still ask for an interpretation. Nothing is queued.
  if (event_kind_retired(value?.kind)) return json_error(409, 'retired', retired_message)

  const kind = event_kinds.find((k) => k === value?.kind)

  if (include_sketch !== undefined && typeof include_sketch !== 'boolean') return invalid()

  const sketch = include_sketch !== false
  const hash_valid = typeof hash === 'string' && document_hash_pattern.test(hash)

  if (!kind || (sketch ? !hash_valid : hash !== undefined)) return invalid()

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const request_id = value?.request_id
  const text = value?.text

  if (typeof request_id !== 'string' || !request_id_pattern.test(request_id)) return upgrade()

  if (text !== undefined && !request_text_valid(text)) {
    return json_error(400, 'invalid_text', 'Use up to 4000 Unicode characters without controls.')
  }

  const fields = ['text', 'kind', 'request_id', 'sketch_hash', 'include_sketch']

  if (Object.keys(value ?? {}).some((k) => !fields.includes(k))) {
    return invalid()
  }

  if (!sketch && (typeof text !== 'string' || text.trim() === '')) {
    return json_error(400, 'text_required', 'Write a message, or add the sketch to send it.')
  }

  const fields_sent = {
    request_id,
    ...(text ? { text } : {}),
    ...(include_sketch === undefined ? {} : { include_sketch }),
  }
  const event = lookup.board.queue_event(sketch ? (hash as string) : null, fields_sent)

  if (event === 'clock') return json_error(400, 'check_clock', 'Check the date on your iPad.')

  if (event === 'expired') return json_error(409, 'expired', 'Retry expired. Check board status.')

  if (event === 'conflict') return json_error(409, 'conflict', 'Request ID already used.')

  if (event === 'full') return json_error(409, 'events_full', 'The agent queue is full.')

  if (event === 'syncing') return json_error(409, 'syncing', 'Ink is syncing. Tap again to send.')

  assert(event.kind === kind, 'the acknowledged event is the notification that was sent')
  assert(!sketch || event.sketch_hash === hash, 'the acknowledged event matches the tap')
  assert(event.request_id === request_id, 'receipt identifies the durable request')
  assert(event.text === (text || undefined), 'receipt echoes exact text, omitting empty notes')
  assert((event.include_sketch !== false) === sketch, 'receipt says whether the sketch went')
  return json_no_store(event_public(event))
}

// The board's conversation, for a paired reader. `since` is the change count the reader last
// saw: when nothing has changed since, the answer is that number alone.
function chat_route(url: URL, registry: BoardRegistry, session: string) {
  const since = url.searchParams.get('since')

  if (since !== null && !/^\d{1,15}$/.test(since)) return invalid()

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const { changes_count, answers_count, events } = lookup.board.events.chat()
  const unchanged = since !== null && Number(since) === changes_count
  const items = unchanged ? null : events.map(chat_item)
  const chat: ChatResponse = { session, changes_count, answers_count, items }
  assert(lookup.board.session === session, 'a chat is read from its own board only')
  assert(items === null || items.length === events.length, 'every request is shown once')
  return json_no_store({ protocol: whiteboard_protocol, ...chat })
}

async function ack_route(request: Request, registry: BoardRegistry, session: string) {
  const body = await body_read(request, ack_body_bytes_max)

  if (!body.ok) return body.response

  const value = body.value as { event?: unknown; state?: unknown; message?: unknown } | null
  const state = event_states.find((s) => s === value?.state)
  const message = value?.message

  if (typeof value?.event !== 'string' || !state || state === 'queued') return invalid()

  if (!event_message_valid(state, message)) {
    return event_state_terminal(state)
      ? json_error(400, 'invalid_message', 'An answer is 1 to 4000 characters without controls.')
      : json_error(400, 'invalid_message', 'A status line is up to 280 characters.')
  }

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const event = lookup.board.event_ack(value.event, state, message as string | undefined)

  if (event === 'missing') return json_error(404, 'unknown_event', 'No such event on this board.')

  if (event === 'transition') return json_error(409, 'invalid_transition', 'Invalid event state.')

  assert(event.id === value.event && event.state === state, 'the acknowledgement matches the event')
  return json_no_store({ session, event: event.id, state: event.state })
}
