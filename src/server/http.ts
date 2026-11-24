// The network edge. Everything arriving here is untrusted, so it is validated and bounded
// before it reaches the board, which only asserts.

import fs from 'node:fs'
import path from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import type { WebSocketMinimal } from '@tldraw/sync-core'
import { assert, AssertionError } from '../shared/assert'
import type { SketchBounds } from '../shared/cleanup_types'
import {
  document_hash_pattern,
  header_document_hash,
  image_size_bytes_max,
  path_cleaned_json,
  path_cleaned_restore,
  path_cleaned_status,
  path_draw,
  path_drawing_json,
  path_drawing_png,
  path_pairing,
  path_sketch_json,
  path_status,
  path_sync,
  roles,
  sync_message_size_bytes_max,
  type Role,
} from '../shared/constants'
import { bounds_valid, type Board, type ImageResult } from './board'
import { cleaned_publish_route, cleaned_restore_route, json_error } from './http_cleanup'
import type { Pairing } from './pairing'

export type ServerOptions = {
  readonly board: Board
  readonly port: number
  readonly hostname: string
  readonly static_files: StaticFiles
  readonly pairing: Pairing
  // A failed assertion must stop the process, not turn into a 500 that hides it.
  readonly on_fatal: (error: AssertionError) => void
}

export type StaticFiles = ReadonlyMap<string, string>

// What the command line reads to find the board and report on it.
export type BoardStatus = {
  readonly app: 'tldraw-sync'
  readonly pid: number
  readonly port: number
  readonly draw_url: string
  readonly stage_url: string
  readonly pen_connected: boolean
  readonly stage_connected: boolean
  readonly shapes_count: number
  readonly document_hash: string
  // The cleaned diagram: its revision (0 when none) and whether the sketch moved on since.
  readonly cleaned_revision: number
  readonly cleaned_stale: boolean
}

type SocketData = { session_id: string; role: Role }
type Socket = ServerWebSocket<SocketData>

const static_files_count_max = 4096
const session_id_pattern = /^[A-Za-z0-9_-]{1,64}$/
const png_signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function server_start(options: ServerOptions): Server<SocketData> {
  assert(options.static_files.has('/index.html'), 'the client has been built')
  const { board } = options
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
      open: (socket) => guard(() => {
        const accepted = board.session_open(
          socket.data.session_id, socket.data.role, socket_minimal(socket),
        )
        if (!accepted) socket.close(1013, 'The board has too many connections.')
      }, () => undefined),
      message: (socket, message) => guard(() => {
        const message_text = typeof message === 'string' ? message : message.toString('utf8')
        board.session_message(socket.data.session_id, socket_minimal(socket), message_text)
      }, () => undefined),
      close: (socket) => guard(() => {
        board.session_close(socket.data.session_id, socket_minimal(socket))
      }, () => undefined),
    },
  })
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

function route(
  request: Request,
  server: Server<SocketData>,
  options: ServerOptions,
): Response | Promise<Response> | undefined {
  const url = new URL(request.url)
  const method = request.method
  const pathname = url.pathname
  assert(pathname.startsWith('/'), 'a request path is absolute')

  if (pathname === path_sync) return sync_upgrade(request, url, server)
  if (pathname === path_drawing_png) {
    if (method === 'GET') return options.board.image_get().then(image_response)
    if (method === 'PUT') return image_put(request, url, options.board)
    return text(405, 'Use GET to fetch the drawing.')
  }
  if (pathname === path_cleaned_json && method === 'POST') {
    return cleaned_publish_route(request, options.board)
  }
  if (pathname === path_cleaned_restore) {
    if (method === 'POST') return cleaned_restore_route(request, options.board)
    return text(405, 'Use POST to restore a cleaned revision.')
  }
  if (method !== 'GET') return text(405, 'Method not allowed.')

  if (pathname === path_drawing_json) return Response.json(options.board.shapes())
  if (pathname === path_sketch_json) return sketch_response(url, options.board)
  if (pathname === path_cleaned_json) return json_no_store(options.board.cleaned_document())
  if (pathname === path_cleaned_status) return json_no_store(options.board.cleaned_status())
  if (pathname === path_pairing) return Response.json(options.pairing)
  if (pathname === path_status) return Response.json(status_read(options, server.port))
  if (pathname === '/' || pathname === path_draw) {
    return static_response(options.static_files, '/index.html')
  }
  return static_response(options.static_files, pathname)
}

function sync_upgrade(
  request: Request,
  url: URL,
  server: Server<SocketData>,
): Response | undefined {
  const role = roles.find((candidate) => candidate === url.searchParams.get('role'))
  const session_id = url.searchParams.get('sessionId') ?? ''
  if (role === undefined) return text(400, 'Unknown role.')
  if (!session_id_pattern.test(session_id)) return text(400, 'Malformed session id.')

  assert(session_id.length > 0, 'a session id that matched is not empty')
  assert(roles.includes(role), 'role is known')
  const upgraded = server.upgrade(request, { data: { session_id, role } })
  return upgraded ? undefined : text(400, 'Expected a WebSocket connection.')
}

function status_read(options: ServerOptions, port: number | undefined): BoardStatus {
  assert(port !== undefined, 'a listening server has a port')
  assert(port > 0, 'the port is known once listening')
  const { board } = options
  const state = board.document_state()
  const cleaned = board.cleaned_status()
  return {
    app: 'tldraw-sync',
    pid: process.pid,
    port,
    draw_url: options.pairing.url,
    stage_url: `http://localhost:${port}`,
    pen_connected: board.sessions_count('draw') > 0,
    stage_connected: board.sessions_count('stage') > 0,
    shapes_count: state.shapes_count,
    document_hash: state.hash,
    cleaned_revision: cleaned.revision,
    cleaned_stale: cleaned.stale,
  }
}

// The sketch's records, for exactly the document an image showed. A newer document is a
// conflict: the caller fetches the image again, so its image and records always agree.
function sketch_response(url: URL, board: Board): Response {
  const hash = url.searchParams.get('document_hash') ?? ''
  if (!document_hash_pattern.test(hash)) {
    return json_error(400, 'malformed_hash', 'Name the document_hash of the fetched image.')
  }
  const snapshot = board.sketch_snapshot(hash)
  if (snapshot === null) {
    return json_error(409, 'sketch_changed', 'The sketch changed after that image. Fetch again.')
  }
  assert(snapshot.document_hash === hash, 'the snapshot is of the named document')
  return json_no_store(snapshot)
}

function json_no_store(value: object): Response {
  assert(typeof value === 'object', 'a JSON response is an object')
  assert(value !== null, 'a JSON response is not null')
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
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

async function image_put(request: Request, url: URL, board: Board): Promise<Response> {
  const hash = url.searchParams.get('document_hash') ?? ''
  if (!document_hash_pattern.test(hash)) return text(400, 'Malformed document hash.')

  const size_declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (!Number.isInteger(size_declared)) return text(411, 'Content-Length is required.')
  if (size_declared > image_size_bytes_max) return text(413, 'Image is too large.')

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > image_size_bytes_max) return text(413, 'Image is too large.')
  if (!png_signature.every((byte, index) => bytes[index] === byte)) {
    return text(415, 'Image is not a PNG.')
  }
  const bounds = bounds_parse(url.searchParams.get('bounds'))
  if (bounds === 'malformed') return text(400, 'Malformed bounds.')
  assert(bytes.byteLength >= png_signature.length, 'a PNG is at least its signature')
  assert(bytes.byteLength <= image_size_bytes_max, 'image is bounded')
  board.image_put(hash, bytes, bounds)
  return new Response(null, { status: 204 })
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
