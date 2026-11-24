// The real server on a real port, with a real sync client. This covers what the simulator
// cannot: the HTTP edge, where every input is untrusted.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TLSyncClient } from '@tldraw/sync-core'
import { atom, createTLSchema, createTLStore, type TLRecord, type TLStore } from 'tldraw'
import { image_size_bytes_max } from '../shared/constants'
import { time_real } from '../shared/time'
import { ClientSocket } from '../simulation/simulated_client'
import { SimulatedDisk } from '../simulation/simulated_disk'
import { Board } from './board'
import { server_start, static_files_load } from './http'
import { pairing_create } from './pairing'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-static-'))
let board: Board
let server: ReturnType<typeof server_start>
let origin: string

beforeAll(() => {
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Board</title>')
  fs.mkdirSync(path.join(directory, 'assets'))
  fs.writeFileSync(path.join(directory, 'assets', 'app.js'), 'export {}')
  fs.writeFileSync(path.join(os.tmpdir(), 'board-secret.txt'), 'secret')

  board = Board.open({ time: time_real, disk: new SimulatedDisk() })
  server = server_start({
    board,
    port: 0,
    hostname: '127.0.0.1',
    static_files: static_files_load(directory),
    pairing: pairing_create('test.local', 5173),
    on_fatal: (error) => {
      throw error
    },
  })
  origin = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
  board.destroy()
  fs.rmSync(directory, { recursive: true })
})

const image_url = (hash: string) => `${origin}/api/drawing.png?document_hash=${hash}`
const put = (hash: string, body: Uint8Array) =>
  fetch(image_url(hash), { method: 'PUT', body: body as Uint8Array<ArrayBuffer> })

async function draw_a_shape(): Promise<void> {
  const store = createTLStore({ schema: createTLSchema() })
  // The sync library's own socket adapter needs a browser, so this bridges a plain WebSocket.
  const sync_url = `ws://127.0.0.1:${server.port}/sync?role=draw&sessionId=test-pen`
  const web_socket = new WebSocket(sync_url)
  const socket = new ClientSocket((message) => web_socket.send(JSON.stringify(message)), () => {})
  web_socket.onmessage = (event) => socket.message_deliver(JSON.parse(String(event.data)) as object)
  web_socket.onopen = () => socket.status_set('online')
  const loaded = Promise.withResolvers<void>()
  const client = new TLSyncClient<TLRecord, TLStore>({
    store,
    socket,
    presence: atom('presence', null),
    didCancel: () => false,
    onLoad: () => loaded.resolve(),
    onSyncError: (reason) => loaded.reject(new Error(reason)),
  })
  await loaded.promise

  store.put([{
    id: 'shape:test', typeName: 'shape', type: 'geo', x: 0, y: 0, rotation: 0, index: 'a1',
    parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
    props: {
      w: 10, h: 10, geo: 'rectangle', color: 'black', labelColor: 'black', fill: 'none',
      dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle',
      growY: 0, url: '', scale: 1, richText: { type: 'doc', content: [] },
    },
  } as unknown as TLRecord])
  for (let attempt = 0; attempt < 200 && board.shapes().length === 0; attempt += 1) {
    await Bun.sleep(10)
  }
  client.close()
  web_socket.close()
}

test('an empty board has no image, and says so', async () => {
  const response = await fetch(`${origin}/api/drawing.png`)
  expect(response.status).toBe(404)
  expect(await response.text()).toContain('The board is empty')
  expect(await (await fetch(`${origin}/api/drawing.json`)).json()).toEqual([])
})

test('a drawn shape reaches the board, and the image follows the document', async () => {
  await draw_a_shape()
  expect(board.shapes().map((shape) => shape.id)).toEqual(['shape:test'])
  const shapes = await (await fetch(`${origin}/api/drawing.json`)).json() as Array<{ id: string }>
  expect(shapes.map((shape) => shape.id)).toEqual(['shape:test'])

  // No stage is connected, so nothing can render the new shape: the fetch fails at once.
  const stale = await fetch(`${origin}/api/drawing.png`)
  expect(stale.status).toBe(503)
  expect(await stale.text()).toContain('presentation page is not open')

  // An image of some other document is stored but never served.
  expect((await put('0000000000000000', png)).status).toBe(204)
  expect((await fetch(`${origin}/api/drawing.png`)).status).toBe(503)

  // An image of this document is served byte for byte.
  expect((await put(board.document_state().hash, png)).status).toBe(204)
  const fresh = await fetch(`${origin}/api/drawing.png`)
  expect(fresh.status).toBe(200)
  expect(fresh.headers.get('content-type')).toBe('image/png')
  expect([...new Uint8Array(await fresh.arrayBuffer())]).toEqual([...png])
})

test('malformed uploads are refused', async () => {
  expect((await put('not-a-hash', png)).status).toBe(400)
  expect((await put('0123456789ABCDEF', png)).status).toBe(400)
  expect((await put('0123456789abcdef', new TextEncoder().encode('not a png'))).status).toBe(415)
  expect((await put('0123456789abcdef', new Uint8Array(0))).status).toBe(415)
  const oversized = new Uint8Array(image_size_bytes_max + 1)
  oversized.set(png)
  expect((await put('0123456789abcdef', oversized)).status).toBe(413)
  expect((await fetch(image_url('0123456789abcdef'), { method: 'DELETE' })).status).toBe(405)
})

test('a sync connection must name a known role and a well-formed session', async () => {
  expect((await fetch(`${origin}/sync?role=admin&sessionId=a`)).status).toBe(400)
  expect((await fetch(`${origin}/sync?role=draw&sessionId=`)).status).toBe(400)
  expect((await fetch(`${origin}/sync?role=draw&sessionId=${'a'.repeat(65)}`)).status).toBe(400)
  expect((await fetch(`${origin}/sync?role=draw&sessionId=ok`)).status).toBe(400)
})

test('both pages are the built client, and only built files are served', async () => {
  for (const page of ['/', '/draw']) {
    const response = await fetch(`${origin}${page}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toContain('<title>Board</title>')
  }
  const asset = await fetch(`${origin}/assets/app.js`)
  expect(asset.headers.get('cache-control')).toContain('immutable')

  expect((await fetch(`${origin}/missing.js`)).status).toBe(404)
  expect((await fetch(`${origin}/../board-secret.txt`)).status).toBe(404)
  expect((await fetch(`${origin}/%2e%2e/board-secret.txt`)).status).toBe(404)
  expect((await fetch(`${origin}/assets/../../board-secret.txt`)).status).toBe(404)
  expect((await fetch(`${origin}/`, { method: 'POST' })).status).toBe(405)
})

test('the pairing endpoint describes the draw page', async () => {
  const pairing = await (await fetch(`${origin}/api/pairing`)).json() as { url: string }
  expect(pairing.url).toBe('http://test.local:5173/draw')
  expect(await (await fetch(`${origin}/api/health`)).json()).toEqual({ status: 'ok' })
})
