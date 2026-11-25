// Board sessions at the network edge, on a real server and port with a real sync client: the
// routes that list, create and rename boards, the addresses that open a board, and the board
// routes kept apart by `?session=`. Every input here is untrusted and bounded.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { board_default_id } from '../shared/board_session'
import { time_real } from '../shared/time'
import { registry_environment_simulated } from '../simulation/simulated_registry'
import { test_pen_draw } from '../simulation/test_pen'
import { proposal_example } from '../simulation/test_sketch'
import { BoardRegistry } from './board_registry'
import { server_start, static_files_load } from './http'
import { pairing_create } from './pairing'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-sessions-static-'))
let registry: BoardRegistry
let server: ReturnType<typeof server_start>
let origin: string

beforeAll(() => {
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Board</title>')
})

afterAll(() => {
  fs.rmSync(directory, { recursive: true })
})

beforeEach(() => {
  registry = BoardRegistry.open(registry_environment_simulated(time_real))
  server = server_start({
    registry,
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

afterEach(() => {
  server.stop(true)
  registry.destroy()
})

const post = (pathname: string, body: unknown) =>
  fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const json = async (response: Response) => (await response.json()) as Record<string, unknown>
const get = async (pathname: string) => json(await fetch(`${origin}${pathname}`))

async function board_new(name: string | null = null): Promise<string> {
  const created = await json(await post('/api/sessions', { name }))
  return String((created.session as { id: string }).id)
}

test('boards are listed, made and renamed; names are plain text and bounded', async () => {
  expect((await get('/api/sessions')).sessions).toEqual([
    { id: board_default_id, name: null, named_by: null, created_at_ms: 0 },
  ])
  const id = await board_new()
  expect(id).toMatch(/^[0-9a-f]{16}$/)
  const named = await json(await post('/api/sessions', { name: '  Payments   map ' }))
  expect(named.session).toMatchObject({ name: 'Payments map', named_by: 'person' })

  const renamed = await post('/api/sessions/rename', { session: id, name: '<b>Ops</b>' })
  expect(await json(renamed)).toMatchObject({ session: { id, name: '<b>Ops</b>' } })

  for (const name of ['', '   ', 'two\nlines', 'x'.repeat(81), 7]) {
    const refused = await post('/api/sessions/rename', { session: id, name })
    expect(refused.status, String(name)).toBe(400)
    expect(await json(refused)).toMatchObject({ code: 'invalid_name' })
  }

  const unknown = await post('/api/sessions/rename', { session: 'ffffffffffffffff', name: 'X' })
  expect(unknown.status).toBe(404)
  expect((await post('/api/sessions/rename', { session: '../x', name: 'X' })).status).toBe(400)
  expect((await post('/api/sessions', ' '.repeat(2048))).status).toBe(413)
  const listed = (await get('/api/sessions')).sessions as Array<{ id: string }>
  expect(listed.map((session) => session.id)).toEqual([
    board_default_id,
    id,
    String((named.session as { id: string }).id),
  ])
})

test('every board has its own address, and old addresses are the default board', async () => {
  const id = await board_new()

  for (const page of ['/', '/draw', `/s/${id}`, `/s/${id}/draw`, '/s/default']) {
    const response = await fetch(`${origin}${page}`)
    expect(response.status, page).toBe(200)
    expect(await response.text()).toContain('<title>Board</title>')
  }

  for (const page of ['/s/NOT-AN-ID', '/s/0123', `/s/${id}/stage`, `/s/${id}/draw/x`]) {
    expect((await fetch(`${origin}${page}`)).status, page).toBe(404)
  }

  // Each board's QR code leads to its own draw page; the default one is unchanged.
  expect((await get('/api/pairing')).url).toBe('http://test.local:5173/draw')
  expect((await get(`/api/pairing?session=${id}`)).url).toBe(`http://test.local:5173/s/${id}/draw`)
  expect((await fetch(`${origin}/api/pairing?session=ffffffffffffffff`)).status).toBe(404)
  expect((await fetch(`${origin}/api/status?session=nope`)).status).toBe(400)
  expect(
    (await fetch(`${origin}/sync?role=draw&sessionId=a&session=ffffffffffffffff`)).status,
  ).toBe(404)
})

test('ink, images and cleanups stay on their own board', async () => {
  const id = await board_new()
  const port = server.port as number
  const status = (session: string) => get(`/api/status?session=${session}`)
  await test_pen_draw(port, 'shape:one', async () => (await status(id)).shapes_count === 1, id)
  expect(await status(board_default_id)).toMatchObject({ shapes_count: 0, session: 'default' })
  expect(await status(id)).toMatchObject({
    session: id,
    session_name: null,
    stage_url: `http://localhost:${port}/s/${id}`,
  })

  // An image put for one board is never served for another.
  const hash = String((await status(id)).document_hash)
  const put = await fetch(`${origin}/api/drawing.png?document_hash=${hash}&session=${id}`, {
    method: 'PUT',
    body: png as Uint8Array<ArrayBuffer>,
  })
  expect(put.status).toBe(204)
  expect((await fetch(`${origin}/api/drawing.png?session=${id}`)).status).toBe(200)
  expect((await fetch(`${origin}/api/drawing.png`)).status).toBe(404)

  const sketch = await get(`/api/sketch.json?document_hash=${hash}&session=${id}`)
  expect(sketch).toMatchObject({ session: id, title_wanted: true, document_hash: hash })

  // The same proposal to the wrong board is refused, then accepted by its own, and titles it.
  const proposal = { ...proposal_example(hash, 0), session: id, title: 'Order flow' }
  const wrong = await post('/api/cleaned.json', proposal)
  expect(wrong.status).toBe(409)
  expect(await json(wrong)).toMatchObject({ code: 'session_mismatch', session: 'default' })
  const right = await post(`/api/cleaned.json?session=${id}`, proposal)
  expect(await json(right)).toMatchObject({ kind: 'published', revision: 1, title_applied: true })
  expect(await status(id)).toMatchObject({ session_name: 'Order flow', cleaned_revision: 1 })
  expect(await status(board_default_id)).toMatchObject({ cleaned_revision: 0 })
  const restored = await post(`/api/cleaned/restore?session=${id}`, { base_revision: 1 })
  expect(restored.status).toBe(404)
})
