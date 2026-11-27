// The Agent canvas routes of the network edge, and what every JSON route shares. Bodies are
// untrusted: their size is checked before they are kept, and their content is checked whole
// by the board before anything changes. Errors are JSON with a stable code, so the command
// line can tell an agent what to do next.

import { assert } from '../shared/assert'
import { image_size_bytes_max, restore_request_size_bytes_max } from '../shared/constants'
import type {
  BoardLookupFailure,
  BoardRegistry,
  RegistryPreview,
  RegistryPublish,
} from './board_registry'
import type { PublishRefusal } from './cleaned'

type Body = { ok: true; value: unknown } | { ok: false; response: Response }

const no_store = { headers: { 'cache-control': 'no-store' } }

export function publish_response(result: RegistryPublish): Response {
  if (result.kind === 'not_found' || result.kind === 'busy' || result.kind === 'damaged') {
    return lookup_error(result)
  }

  if (result.kind !== 'published') return refusal_response(result)

  assert(result.revision > 0, 'a published revision is positive')
  assert(result.records_hash.length > 0, 'a publish names its records')
  const { kind, revision, shapes_count, records_hash, title_applied } = result
  return Response.json({ kind, revision, shapes_count, records_hash, title_applied }, no_store)
}

// A draft was accepted for rendering. It names the records a publish of it would save.
export function preview_response(result: RegistryPreview, session: string): Response {
  if (result.kind === 'not_found' || result.kind === 'busy' || result.kind === 'damaged') {
    return lookup_error(result)
  }

  if (result.kind !== 'preview') return refusal_response(result)

  assert(result.preview.length > 0, 'a draft is named')
  assert(result.base_revision >= 0, 'a draft builds on a revision')
  const { preview, base_revision, snapshot, shapes_count, records_hash } = result
  const body = { session, preview, base_revision, snapshot, shapes_count, records_hash }
  return Response.json(body, no_store)
}

// Why a scene was not accepted, for a publish and a draft alike. Nothing changed.
function refusal_response(result: PublishRefusal): Response {
  if (result.kind === 'session_mismatch') {
    return json_error(
      409,
      'session_mismatch',
      'The scene was made from a snapshot of another board. Take a snapshot of this board.',
      { session: result.session },
    )
  }

  if (result.kind === 'invalid') {
    return json_error(400, 'invalid_scene', `${result.path}: ${result.message}`, {
      path: result.path,
    })
  }

  if (result.kind === 'sketch_changed') {
    return json_error(
      409,
      'sketch_changed',
      'The sketch changed after the snapshot was taken. Take a new snapshot.',
      { sketch_hash: result.sketch_hash },
    )
  }

  assert(result.kind === 'revision_conflict', 'every refusal is handled')
  assert(result.revision >= 0, 'a conflict names the current revision')
  return json_error(
    409,
    'revision_conflict',
    'The Agent canvas changed after the snapshot was taken. Take a new snapshot.',
    { revision: result.revision },
  )
}

// The board is looked up only once the body has arrived, so a board set aside meanwhile is
// opened again, not written to closed.
export async function cleaned_restore_route(
  request: Request,
  registry: BoardRegistry,
  id: string,
): Promise<Response> {
  const body = await body_read(request, restore_request_size_bytes_max)

  if (!body.ok) return body.response

  const value = (body.value ?? {}) as { base_revision?: unknown; revision?: unknown }
  const revision = value.revision ?? null

  if (
    !Number.isSafeInteger(value.base_revision) ||
    (revision !== null && !Number.isSafeInteger(revision))
  ) {
    return json_error(400, 'invalid_request', 'Send {"base_revision": n, "revision": n|null}.')
  }

  const lookup = registry.board(id)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  const result = lookup.board.cleaned_restore(
    value.base_revision as number,
    revision as number | null,
  )

  if (result.kind === 'revision_conflict') {
    return json_error(
      409,
      'revision_conflict',
      'The Agent canvas changed meanwhile. Nothing was restored.',
      { revision: result.revision },
    )
  }

  if (result.kind === 'not_found') {
    return json_error(404, 'nothing_to_restore', 'That revision is not kept for restoring.')
  }

  assert(result.kind === 'restored', 'every restore result is handled')
  assert(result.revision > result.restored_from, 'a restore makes a newer revision')
  return Response.json(result, no_store)
}

// Why a named board cannot be served right now.
export function lookup_error(lookup: BoardLookupFailure): Response {
  if (lookup.kind === 'not_found') {
    return json_error(404, 'unknown_session', 'No board has that session id. List the boards.')
  }

  if (lookup.kind === 'busy') {
    return json_error(
      503,
      'boards_busy',
      'Every board held open is in use. Close the page of a board you are done with.',
    )
  }

  assert(lookup.kind === 'damaged', 'every lookup failure is handled')
  assert(lookup.message.length > 0, 'damage is described')
  return json_error(503, 'storage_damaged', `${lookup.message}. Nothing was overwritten.`)
}

export function json_error(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  assert(status >= 400 && status < 600, 'an error has an error status')
  assert(/^[a-z_]+$/.test(code) && message.endsWith('.'), 'an error has a code and a sentence')
  return Response.json({ ...extra, code, message }, { status, ...no_store })
}

// JSON only: a browser cannot send it from another site without a preflight this server never
// answers, so a page elsewhere on the network cannot publish through a visitor's browser.
export async function body_read(request: Request, size_bytes_max: number): Promise<Body> {
  assert(size_bytes_max > 0, 'a body limit is positive')
  assert(size_bytes_max <= image_size_bytes_max, 'a body limit fits the request limit')
  const refusal = headers_refusal(request, size_bytes_max)

  if (refusal !== null) {
    await body_discard(request)
    return { ok: false, response: refusal }
  }

  const bytes = new Uint8Array(await request.arrayBuffer())

  if (bytes.byteLength > size_bytes_max) {
    return { ok: false, response: too_large_error(size_bytes_max) }
  }

  assert(bytes.byteLength <= size_bytes_max, 'a read body is bounded')
  let value: unknown

  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { ok: false, response: json_error(400, 'invalid_json', 'The body is not valid JSON.') }
  }

  return { ok: true, value }
}

// What the headers alone rule out, decided before any of the body is kept in memory.
function headers_refusal(request: Request, size_bytes_max: number): Response | null {
  assert(size_bytes_max > 0, 'a body limit is positive')
  const content_type = request.headers.get('content-type') ?? ''

  if (!content_type.startsWith('application/json')) {
    return json_error(415, 'not_json', 'Send application/json.')
  }

  const size_declared = Number(request.headers.get('content-length') ?? 'NaN')

  if (!Number.isInteger(size_declared)) {
    return json_error(411, 'length_required', 'Send Content-Length.')
  }

  if (size_declared > size_bytes_max) return too_large_error(size_bytes_max)

  assert(size_declared <= size_bytes_max, 'an accepted body is declared within its limit')
  return null
}

function too_large_error(size_bytes_max: number): Response {
  assert(size_bytes_max > 0, 'a body limit is positive')
  return json_error(413, 'too_large', `The body exceeds ${size_bytes_max} bytes.`)
}

// A refused body is still received, chunk by chunk, and dropped before the refusal is sent.
// Answering while the sender is still writing leaves unread bytes on the connection: it is
// then closed under the sender, who sees a reset or a stall instead of the reason. Nothing
// is kept, so memory stays one chunk, and the server's request limit bounds the work.
export async function body_discard(request: Request): Promise<void> {
  if (request.body === null) return

  const reader = request.body.getReader()
  let size_bytes = 0

  try {
    while (size_bytes <= image_size_bytes_max) {
      const chunk = await reader.read()

      if (chunk.done) return

      size_bytes += chunk.value.byteLength
    }

    await reader.cancel()
  } catch {
    // The sender went away mid-body. There is nobody left to hear the refusal.
  }
}
