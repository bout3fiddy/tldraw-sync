// The command line's view of a running board, over HTTP on localhost. The state file says
// which port to ask; the board's own answer is what says it is running.

import { assert } from '../shared/assert'
import { board_query } from '../shared/board_session'
import {
  document_hash_pattern,
  fetch_wait_ms_max,
  header_document_hash,
  path_drawing_png,
  path_pairing,
  path_status,
  status_timeout_ms,
} from '../shared/constants'
import type { BoardStatus } from '../server/http'
import type { Pairing } from '../server/pairing'
import { process_alive, server_state_read, type ServerState } from '../server/server_state'

export type Found =
  | { kind: 'running'; status: BoardStatus }
  | { kind: 'not_running' }
  // A live process holds the data directory but does not answer: starting, or stuck.
  | { kind: 'not_responding'; state: ServerState }

export type ImageFetched =
  | { kind: 'image'; bytes: Uint8Array; document_hash: string }
  | { kind: 'empty' }
  | { kind: 'stale' }
  | { kind: 'unreachable' }

export async function board_find(data_directory: string): Promise<Found> {
  const state = server_state_read(data_directory)
  if (state === null) return { kind: 'not_running' }
  const status = await status_get(state.port)
  if (status !== null && status.pid === state.pid) return { kind: 'running', status }
  if (process_alive(state.pid)) return { kind: 'not_responding', state }
  return { kind: 'not_running' }
}

async function status_get(port: number): Promise<BoardStatus | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path_status}`, {
      signal: AbortSignal.timeout(status_timeout_ms),
    })
    if (!response.ok) return null
    const status = await response.json() as BoardStatus
    // Another program could hold a port the board once used.
    if (status.app !== 'tldraw-sync' || status.port !== port) return null
    assert(Number.isInteger(status.pid), 'a board reports its pid')
    return status
  } catch {
    return null
  }
}

export async function pairing_get(port: number): Promise<Pairing | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path_pairing}`, {
      signal: AbortSignal.timeout(status_timeout_ms),
    })
    return response.ok ? await response.json() as Pairing : null
  } catch {
    return null
  }
}

export type ApiAnswer =
  | { kind: 'answer'; status: number; body: Record<string, unknown> }
  | { kind: 'unreachable' }

// One JSON request to the board. Any answer, success or error, is a JSON object.
export async function api_request(
  port: number,
  pathname: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<ApiAnswer> {
  assert(pathname.startsWith('/api/'), 'only the board API is asked')
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: body === null ? 'GET' : 'POST',
      headers: body === null ? headers : { ...headers, 'content-type': 'application/json' },
      redirect: 'error',
      body,
      signal: AbortSignal.timeout(status_timeout_ms * 10),
    })
  } catch {
    return { kind: 'unreachable' }
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  const object = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  const answer = object ? parsed as Record<string, unknown> : {}
  return { kind: 'answer', status: response.status, body: answer }
}

export async function image_fetch(port: number, session: string): Promise<ImageFetched> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}${path_drawing_png}?${board_query(session)}`, {
      // The board itself waits up to `fetch_wait_ms_max` for a render.
      signal: AbortSignal.timeout(fetch_wait_ms_max + status_timeout_ms),
    })
  } catch {
    return { kind: 'unreachable' }
  }
  if (response.status === 404) return { kind: 'empty' }
  if (response.status !== 200) return { kind: 'stale' }

  const document_hash = response.headers.get(header_document_hash) ?? ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert(document_hash_pattern.test(document_hash), 'an image names its document')
  assert(bytes.byteLength > 0, 'an image is never empty')
  return { kind: 'image', bytes, document_hash }
}
