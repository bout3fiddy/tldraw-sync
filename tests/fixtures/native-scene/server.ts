// A disposable native-scene room for the browser journey in `tests/native_scene.e2e.ts`. It is
// not the product server: one pinned `TLSocketRoom` in memory, the stock editor page bundled
// from `client.tsx`, an agent endpoint that writes through the room's authoritative
// `updateStore`, and a read endpoint that reports the room's own per-record clocks.
//
// Run: bun tests/fixtures/native-scene/server.ts <port>

import { TLSocketRoom, type WebSocketMinimal } from '@tldraw/sync-core'
import {
  createTLSchema,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLPage,
  type TLRecord,
} from '@tldraw/tlschema'
import path from 'node:path'

type Role = 'ipad' | 'mac'
type SocketData = { session_id: string; role: Role }
type AgentRequest = { put?: TLRecord[]; delete?: string[] }

// Two pages and a reload of each is all the journey opens; an agent request is a handful of
// records. Anything larger is a broken test, refused rather than served.
const sessions_count_max = 8
const request_size_bytes_max = 64 * 1024
const agent_records_count_max = 32
const page_id = PageRecordType.createId('native')
const fixture_directory = import.meta.dir

const port = Number(process.argv[2])

if (!Number.isSafeInteger(port) || port <= 0) throw new Error('usage: server.ts <port>')

const build = await Bun.build({
  entrypoints: [path.join(fixture_directory, 'client.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
})

if (!build.success) throw new Error(`the fixture page did not build: ${build.logs.join('\n')}`)

const bundle = new Map<string, Blob>()

for (const output of build.outputs) bundle.set(`/${path.basename(output.path)}`, output)

if (!bundle.has('/client.js') || !bundle.has('/client.css')) {
  throw new Error('the fixture bundle lacks its script or stylesheet')
}

const schema = createTLSchema()
const seeded: TLRecord[] = [
  DocumentRecordType.create({ id: TLDOCUMENT_ID }),
  PageRecordType.create({ id: page_id, name: 'Scene', index: 'a1' as TLPage['index'] }),
]
const room = new TLSocketRoom<TLRecord>({
  schema,
  initialSnapshot: {
    clock: 1,
    documentClock: 1,
    documents: seeded.map((state) => ({ state, lastChangedClock: 1 })),
    schema: schema.serialize(),
    tombstones: {},
  },
})
const sessions = new Set<string>()

// Server writes are serialized: `updateStore` snapshots the room when it starts, so two
// overlapping calls would each overwrite the other's records.
let agent_tail: Promise<unknown> = Promise.resolve()

function agent_write(request: AgentRequest): Promise<number> {
  const write = agent_tail.then(() =>
    room.updateStore((store) => {
      for (const record of request.put ?? []) store.put(record)

      for (const id of request.delete ?? []) store.delete(id)
    }),
  )
  agent_tail = write.catch(() => undefined)
  return write.then(() => room.getCurrentDocumentClock())
}

function agent_request_parse(text: string): AgentRequest | null {
  const value = JSON.parse(text) as unknown

  if (typeof value !== 'object' || value === null) return null

  const request = value as AgentRequest
  const count = (request.put?.length ?? 0) + (request.delete?.length ?? 0)

  if (count === 0 || count > agent_records_count_max) return null

  return request
}

async function agent_handle(request: Request): Promise<Response> {
  const text = await request.text()

  if (text.length > request_size_bytes_max) return new Response('too large', { status: 413 })

  const parsed = agent_request_parse(text)

  if (parsed === null) return new Response('bad agent request', { status: 400 })

  try {
    return Response.json({ document_clock: await agent_write(parsed) })
  } catch (error) {
    return new Response(String(error), { status: 409 })
  }
}

function records_read(): Response {
  const snapshot = room.getCurrentSnapshot()
  const documents = snapshot.documents
    .filter((document) => document.state.typeName !== 'document')
    .map((document) => ({ state: document.state, changed_clock: document.lastChangedClock }))
  return Response.json({ document_clock: room.getCurrentDocumentClock(), documents })
}

const page_html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/client.css"></head>
<body><div id="root"></div><script type="module" src="/client.js"></script></body></html>`

const server = Bun.serve<SocketData, never>({
  port,
  hostname: '127.0.0.1',
  maxRequestBodySize: request_size_bytes_max,
  fetch: (request, server) => {
    const url = new URL(request.url)
    const role_match = /^\/sync\/(ipad|mac)$/.exec(url.pathname)

    if (role_match !== null) {
      const session_id = url.searchParams.get('sessionId') ?? ''

      if (session_id.length === 0) return new Response('no session', { status: 400 })

      if (sessions.size >= sessions_count_max) return new Response('full', { status: 503 })

      const data: SocketData = { session_id, role: role_match[1] as Role }
      return server.upgrade(request, { data }) ? undefined : new Response('no', { status: 400 })
    }

    if (url.pathname === '/agent' && request.method === 'POST') return agent_handle(request)

    if (url.pathname === '/records') return records_read()

    if (url.pathname === '/')
      return new Response(page_html, { headers: { 'content-type': 'text/html' } })

    const asset = bundle.get(url.pathname)
    return asset === undefined ? new Response('not found', { status: 404 }) : new Response(asset)
  },
  websocket: {
    open: (socket) => {
      sessions.add(socket.data.session_id)
      room.handleSocketConnect({
        sessionId: socket.data.session_id,
        socket: socket as unknown as WebSocketMinimal,

        // The Mac stage is refused at the server, not merely hidden behind a read-only UI.
        isReadonly: socket.data.role === 'mac',
      })
    },
    message: (socket, message) => {
      const text = typeof message === 'string' ? message : message.toString('utf8')
      room.handleSocketMessage(socket.data.session_id, text)
    },
    close: (socket) => {
      sessions.delete(socket.data.session_id)
      room.handleSocketClose(socket.data.session_id)
    },
  },
})

console.log(`native scene fixture listening on ${server.port}`)
