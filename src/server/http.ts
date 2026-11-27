// The network edge. Everything arriving here is untrusted, so it is validated and bounded
// before it reaches the board, which only asserts.
//
// Every board route names its board with `?session=<id>`; without it, a route serves the
// default board, so every address from before sessions works as it did. The server has no
// active board: two pages, or a page and an agent, can each work on a board of their own.

import fs from 'node:fs'
import path from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import type { WebSocketMinimal } from '@tldraw/sync-core'
import { assert, AssertionError } from '../shared/assert'
import {
  board_default_id,
  board_draw_path,
  board_id_pattern,
  board_page_parse,
  board_stage_path,
} from '../shared/board_session'
import type { SketchBounds } from '../shared/canvas_types'
import {
  document_hash_pattern,
  header_document_hash,
  image_size_bytes_max,
  path_cleaned_json,
  path_cleaned_restore,
  path_cleaned_status,
  path_drawing_json,
  path_drawing_png,
  path_pairing,
  path_preview_json,
  path_preview_png,
  path_sessions,
  path_sessions_rename,
  path_status,
  path_sync,
  roles,
  sync_message_size_bytes_max,
  type Role,
} from '../shared/constants'
import { png_signed } from '../shared/png'
import { bounds_valid, type Board, type ImageResult } from './board'
import type { BoardRegistry } from './board_registry'
import { body_discard, cleaned_restore_route, json_error, lookup_error } from './http_canvas'
import {
  json_no_store,
  session_create_route,
  session_rename_route,
  sessions_list_response,
} from './http_sessions'
import { whiteboard_path, whiteboard_protocol } from '../shared/whiteboard'
import { authorized, scoped_key } from './whiteboard_keys'
import { whiteboard_route, denied } from './http_whiteboard'
import { pairing_board, type Pairing } from './pairing'

export type ServerOptions = {
  readonly registry: BoardRegistry
  readonly machine_key?: string
  readonly port: number
  readonly hostname: string
  readonly static_files: StaticFiles

  // The default board's pairing. Every other board's QR code is made from it.
  readonly pairing: Pairing

  // A failed assertion must stop the process, not turn into a 500 that hides it.
  readonly on_fatal: (error: AssertionError) => void
}

export type StaticFiles = ReadonlyMap<string, string>

// What the command line reads to find the board and report on it: one board session.
export type BoardStatus = {
  readonly app: 'tldraw-sync'
  readonly pid: number
  readonly port: number
  readonly session: string
  readonly session_name: string | null
  readonly draw_url: string
  readonly stage_url: string
  readonly pen_connected: boolean
  readonly stage_connected: boolean
  readonly shapes_count: number
  readonly document_hash: string
  // The Agent canvas: its revision (0 when none) and whether the sketch moved on since.
  readonly linked: boolean
  readonly protocol: number
  readonly agent_revision: number
  readonly cleaned_revision: number
  readonly cleaned_stale: boolean
}

// `session_id` is the sync library's id for one page's connection; `board` is the board session
// the connection draws on or presents.
type SocketData = { session_id: string; role: Role; board: string }
type Socket = ServerWebSocket<SocketData>
type Route = Response | Promise<Response> | undefined

const static_files_count_max = 4096
const session_id_pattern = /^[A-Za-z0-9_-]{1,64}$/
const preview_id_pattern = /^[0-9a-f-]{36}$/

export function server_start(options: ServerOptions): Server<SocketData> {
  assert(options.static_files.has('/index.html'), 'the client has been built')
  const { registry } = options
  const guard = guard_create(options.on_fatal)

  return Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname,
    // The largest body any route accepts is an image upload.
    maxRequestBodySize: image_size_bytes_max,
    fetch: (request, server) => {
      return guard(() => route(request, server, options), () => text(500, 'Internal error.'))
    },
    websocket: {
      maxPayloadLength: sync_message_size_bytes_max,
      open: (socket) => guard(() => socket_open(registry, socket), () => undefined),
      message: (socket, message) => guard(() => {
        const message_text = typeof message === 'string' ? message : message.toString('utf8')
        const board = registry.board_open(socket.data.board)
        board?.session_message(socket.data.session_id, socket_minimal(socket), message_text)
      }, () => undefined),
      close: (socket) => guard(() => {
        const board = registry.board_open(socket.data.board)
        board?.session_close(socket.data.session_id, socket_minimal(socket))
      }, () => undefined),
    },
  })
}

// The board is opened when its first page connects. A connection it has no room for is
// closed with a reason, and the page reconnects later.
function socket_open(registry: BoardRegistry, socket: Socket): void {
  assert(board_id_pattern.test(socket.data.board), 'an upgraded socket names a valid board')
  const lookup = registry.board(socket.data.board)
  if (lookup.kind !== 'board') {
    socket.close(1013, 'The board cannot be opened right now.')
    return
  }
  const accepted = lookup.board.session_open(
    socket.data.session_id, socket.data.role, socket_minimal(socket),
  )
  if (!accepted) socket.close(1013, 'The board has too many connections.')
}

// Bun's socket already has the three members the sync room uses: readyState, send, close.
function socket_minimal(socket: Socket): WebSocketMinimal {
  assert(typeof socket.readyState === 'number', 'the socket reports its state')
  assert(typeof socket.send === 'function', 'the socket can send')
  return socket as unknown as WebSocketMinimal
}

function guard_create(on_fatal: (error: AssertionError) => void) {
  return function guard<T>(run: () => T, recover: () => T): T {
    try {
      return run()
    } catch (error) {
      if (error instanceof AssertionError) on_fatal(error)
      console.error(error)
      return recover()
    }
  }
}

function route(request: Request, server: Server<SocketData>, options: ServerOptions): Route {
  const url = new URL(request.url)
  const pathname = url.pathname
  assert(pathname.startsWith('/'), 'a request path is absolute')

  if (pathname === path_sessions || pathname === path_sessions_rename) {
    return sessions_route(request, options.registry)
  }

  if (pathname.startsWith('/api/') || pathname === path_sync) {
    const id = board_param(url)
    if (id === null) {
      return json_error(400, 'malformed_session', 'A session id is 16 hex digits, or default.')
    }
    return board_route(request, url, id, server, options)
  }

  if (request.method !== 'GET') return text(405, 'Method not allowed.')
  const page = board_page_parse(pathname) === null ? pathname : '/index.html'
  return static_response(options.static_files, page)
}

// The board a request names, the default one when it names none, or null when it is malformed.
function board_param(url: URL): string | null {
  const id = url.searchParams.get('session') ?? board_default_id
  if (!board_id_pattern.test(id)) return null
  assert(id.length > 0, 'a valid board id is not empty')
  return id
}

function sessions_route(request: Request, registry: BoardRegistry): Route {
  const pathname = new URL(request.url).pathname
  assert(pathname === path_sessions || pathname === path_sessions_rename, 'a sessions route')
  if (request.method === 'POST') {
    if (pathname === path_sessions) return session_create_route(request, registry)
    return session_rename_route(request, registry)
  }
  if (request.method !== 'GET' || pathname !== path_sessions) {
    return text(405, 'Use GET to list boards, and POST to create or rename one.')
  }
  return sessions_list_response(registry)
}

function board_route(
  request: Request,
  url: URL,
  id: string,
  server: Server<SocketData>,
  options: ServerOptions,
): Route {
  const { registry } = options
  const method = request.method
  const pathname = url.pathname
  assert(board_id_pattern.test(id), 'a routed board id is well formed')

  const local = loopback_request(url, server, request)
  const owner = registry.owner(id)
  if (pathname.startsWith(whiteboard_path)) {
    return whiteboard_route(request, registry, id, options.machine_key, local).catch((error) => {
      if (error instanceof AssertionError) options.on_fatal(error)
      return json_error(503, 'storage_failure', 'Board operation failed. Check storage and retry.')
    })
  }
  if (owner && method === 'POST' &&
      (pathname === path_cleaned_json || pathname === path_cleaned_restore)) {
    if (!local || request.headers.has('origin') || !options.machine_key ||
      !authorized(request, options.machine_key)) return denied(request)
  }
  if (pathname === path_sync) return sync_upgrade(request, url, id, server, registry)
  if (pathname === path_preview_json || pathname === path_preview_png) {
    return preview_route(request, url, registry, id, local)
  }
  if (pathname === path_drawing_png) {
    if (method === 'GET') return board_with(registry, id, (board) => image_get(board))
    if (method === 'PUT') return image_put(request, url, registry, id)
    return text(405, 'Use GET to fetch the drawing.')
  }
  if (pathname === path_cleaned_json && method === 'POST') {
    // The formats this address took are retired. Nothing is read and nothing changes.
    return body_discard(request).then(() => json_error(410, 'retired',
      'Shape proposals and semantic diagrams are retired. Link the board and publish a scene.'))
  }
  if (pathname === path_cleaned_restore) {
    if (method === 'POST') return cleaned_restore_route(request, registry, id)
    return text(405, 'Use POST to restore a cleaned revision.')
  }
  if (method !== 'GET') return text(405, 'Method not allowed.')
  if (pathname === path_pairing) {
    if (registry.find(id) === null) return lookup_error({ kind: 'not_found' })
    const page = board_draw_path(id)
    if (local && owner && options.machine_key && request.headers.get('x-board-stage') === 'qr') {
      const token = scoped_key(options.machine_key, 'event', id, owner)
      const paired = pairing_board(options.pairing, `${page}#pair=${token}`)
      return json_no_store({ ...paired, url: paired.url.split('#')[0] })
    }
    return json_no_store(pairing_board(options.pairing, page))
  }
  return board_with(registry, id, (board) => {
    if (pathname === path_drawing_json) return Response.json(board.shapes())
    if (pathname === path_cleaned_json || pathname === path_cleaned_status) {
      const layer = url.searchParams.get('layer') ?? 'canvas'
      if (layer !== 'canvas' && layer !== 'interpretation') {
        return json_error(400, 'invalid_layer', 'Reload and use the unified Agent canvas.')
      }
      if (pathname === path_cleaned_json) return json_no_store(board.cleaned_document())
      return public_canvas_status(board, owner !== null)
    }
    if (pathname === path_status) return Response.json(status_read(options, board, server.port))
    return text(404, 'Not found.')
  })
}

function public_canvas_status(board: Board, linked: boolean) {
  const event = board.events.latest()
  const last_event = event && { id: event.id, kind: event.kind, state: event.state,
    created_at_ms: event.created_at_ms, message: event.message }
  if (last_event) {
    assert(!('text' in last_event), 'the paired note is never a public status message')
    assert(!('request_id' in last_event), 'the replay key stays private')
  }
  return json_no_store({ ...board.cleaned_status(), linked, protocol: whiteboard_protocol,
    last_event: last_event ?? null })
}

// A draft for the stage to render, and the stage's rendering of it. Only a stage on this Mac
// is given a draft or heard on one: a draft is the agent's unpublished work.
function preview_route(
  request: Request,
  url: URL,
  registry: BoardRegistry,
  id: string,
  local: boolean,
): Response | Promise<Response> {
  const origin = request.headers.get('origin')
  if (!local || (origin !== null && origin !== url.origin)) return denied(request)
  if (url.pathname === path_preview_json) {
    if (request.method !== 'GET') return text(405, 'Use GET to ask for a draft.')
    const have = url.searchParams.get('have')
    if (have !== null && !preview_id_pattern.test(have)) return text(400, 'Malformed draft id.')
    return board_with(registry, id, (board) => json_no_store(board.preview_job(have)))
  }
  assert(url.pathname === path_preview_png, 'a preview route is one of two')
  if (request.method !== 'PUT') return text(405, 'Use PUT to send a rendered draft.')
  return preview_put(request, url, registry, id)
}

async function preview_put(
  request: Request,
  url: URL,
  registry: BoardRegistry,
  id: string,
): Promise<Response> {
  const preview = url.searchParams.get('id') ?? ''
  if (!preview_id_pattern.test(preview)) return text(400, 'Malformed draft id.')
  const size_declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (!Number.isInteger(size_declared)) return text(411, 'Content-Length is required.')
  if (size_declared > image_size_bytes_max) return text(413, 'Image is too large.')

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > image_size_bytes_max) return text(413, 'Image is too large.')
  if (!png_signed(bytes)) return text(415, 'Image is not a PNG.')
  assert(bytes.byteLength <= image_size_bytes_max, 'image is bounded')
  assert(bytes.byteLength > 0, 'a signed PNG is not empty')

  // Looked up after the body has arrived: the board may have been set aside meanwhile.
  return board_with(registry, id, (board) => {
    if (!board.preview_put(preview, bytes)) return text(409, 'That draft was replaced.')
    return new Response(null, { status: 204 })
  })
}

function loopback_request(url: URL, server: Server<SocketData>, request: Request): boolean {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false
  const address = server.requestIP(request)?.address ?? ''
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
}

// Runs a route on the named board, opened if need be, or says why it cannot be served.
function board_with(
  registry: BoardRegistry,
  id: string,
  run: (board: Board) => Response | Promise<Response>,
): Response | Promise<Response> {
  const lookup = registry.board(id)
  if (lookup.kind !== 'board') return lookup_error(lookup)
  assert(lookup.board.session === id, 'the route runs on the board it named')
  return run(lookup.board)
}

function sync_upgrade(
  request: Request,
  url: URL,
  board: string,
  server: Server<SocketData>,
  registry: BoardRegistry,
): Response | undefined {
  assert(board_id_pattern.test(board), 'a sync connection names a valid board')
  const role = roles.find((candidate) => candidate === url.searchParams.get('role'))
  const session_id = url.searchParams.get('sessionId') ?? ''
  if (role === undefined) return text(400, 'Unknown role.')
  if (!session_id_pattern.test(session_id)) return text(400, 'Malformed session id.')
  if (registry.find(board) === null) return text(404, 'No board has that session id.')

  assert(session_id.length > 0, 'a session id that matched is not empty')
  assert(roles.includes(role), 'role is known')
  const upgraded = server.upgrade(request, { data: { session_id, role, board } })
  return upgraded ? undefined : text(400, 'Expected a WebSocket connection.')
}

function status_read(options: ServerOptions, board: Board, port: number | undefined): BoardStatus {
  assert(port !== undefined, 'a listening server has a port')
  assert(port > 0, 'the port is known once listening')
  const id = board.session
  const state = board.document_state()
  const cleaned = board.cleaned_status()
  const stage_path = board_stage_path(id)
  return {
    app: 'tldraw-sync',
    pid: process.pid,
    port,
    session: id,
    session_name: options.registry.find(id)?.name ?? null,
    draw_url: pairing_board(options.pairing, board_draw_path(id)).url,
    // The default board's address is the bare origin, as it always was.
    stage_url: `http://localhost:${port}${stage_path === '/' ? '' : stage_path}`,
    pen_connected: board.sessions_count('draw') > 0,
    stage_connected: board.sessions_count('stage') > 0,
    shapes_count: state.shapes_count,
    document_hash: state.hash,
    linked: options.registry.owner(id) !== null,
    protocol: whiteboard_protocol,
    agent_revision: cleaned.revision,
    cleaned_revision: cleaned.revision,
    cleaned_stale: cleaned.stale,
  }
}

async function image_get(board: Board): Promise<Response> {
  assert(document_hash_pattern.test(board.document_state().hash), 'a board has a hash')
  return image_response(await board.image_get())
}

function image_response(result: ImageResult): Response {
  if (result.kind === 'image') {
    assert(result.bytes.byteLength > 0, 'an image is never empty')
    assert(document_hash_pattern.test(result.document_hash), 'an image names its document')
    return new Response(result.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        [header_document_hash]: result.document_hash,
      },
    })
  }
  if (result.kind === 'empty') return text(404, 'The board is empty. Nothing has been drawn.')
  if (result.reason === 'stage_absent') {
    return text(503, 'The drawing has changed and the presentation page is not open to '
      + 'render it. Open the board address in a browser on the Mac, then fetch again.')
  }
  return text(503, 'The drawing is still being rendered. Fetch again in a moment.')
}

async function image_put(
  request: Request,
  url: URL,
  registry: BoardRegistry,
  id: string,
): Promise<Response> {
  const hash = url.searchParams.get('document_hash') ?? ''
  if (!document_hash_pattern.test(hash)) return text(400, 'Malformed document hash.')

  const size_declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (!Number.isInteger(size_declared)) return text(411, 'Content-Length is required.')
  if (size_declared > image_size_bytes_max) return text(413, 'Image is too large.')

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > image_size_bytes_max) return text(413, 'Image is too large.')
  if (!png_signed(bytes)) return text(415, 'Image is not a PNG.')
  const bounds = bounds_parse(url.searchParams.get('bounds'))
  if (bounds === 'malformed') return text(400, 'Malformed bounds.')
  assert(bytes.byteLength >= 8, 'a PNG is at least its signature')
  assert(bytes.byteLength <= image_size_bytes_max, 'image is bounded')

  // Looked up after the body has arrived: the board may have been set aside meanwhile.
  return board_with(registry, id, (board) => {
    board.image_put(hash, bytes, bounds)
    return new Response(null, { status: 204 })
  })
}

// Optional: `x,y,w,h` of the page area the stage rendered. Older stages send none.
function bounds_parse(value: string | null): SketchBounds | null | 'malformed' {
  if (value === null) return null
  const numbers = value.length <= 128 ? value.split(',').map(Number) : []
  const [x, y, w, h] = numbers
  const bounds = { x, y, w, h }
  if (numbers.length !== 4 || !bounds_valid(bounds)) return 'malformed'
  assert(Number.isFinite(bounds.x) && Number.isFinite(bounds.y), 'bounds have a position')
  assert(bounds.w >= 0 && bounds.h >= 0, 'bounds have a size')
  return bounds
}

function static_response(static_files: StaticFiles, pathname: string): Response {
  const file = static_files.get(pathname)
  if (file === undefined) return text(404, 'Not found.')
  // Built assets carry a content hash in their name, so they can be cached forever. The page
  // itself is revalidated, which is what lets a new build reach the iPad.
  assert(pathname.startsWith('/'), 'a served path is absolute')
  assert(path.isAbsolute(file), 'a served file is an absolute path')
  const immutable = pathname.startsWith('/assets/')
  return new Response(Bun.file(file), {
    headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
  })
}

// Every plain-text response is an error, and says what to do about it.
function text(status: number, message: string): Response {
  assert(status >= 400, 'text responses are errors')
  assert(status < 600, 'status is an HTTP status')
  assert(message.endsWith('.'), 'a message is a full sentence')
  return new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// The set of files that may be served is fixed at startup. A request can only name a key of
// this map, so there is no path to traverse.
export function static_files_load(directory: string): StaticFiles {
  assert(path.isAbsolute(directory), 'static directory is an absolute path')
  const static_files = new Map<string, string>()
  const pending = [directory]

  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(file)
      } else {
        static_files.set(`/${path.relative(directory, file).split(path.sep).join('/')}`, file)
      }
      assert(static_files.size <= static_files_count_max, 'static files are bounded')
      assert(pending.length <= static_files_count_max, 'static directories are bounded')
    }
  }
  assert(static_files.size > 0, 'the static directory is not empty')
  return static_files
}
