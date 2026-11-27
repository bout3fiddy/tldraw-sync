// The Agent canvas at the network edge, on a real server and port, with a real sync client
// drawing the ink: what pages read, the restore, the address the retired formats were sent to,
// and a linked board's draft going to the stage and coming back as a picture. The proposal
// rules themselves are covered in `scene_proposal.test.ts`.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { board_default_id } from '../shared/board_session'
import { restore_request_size_bytes_max } from '../shared/constants'
import { png_blank, png_signed } from '../shared/png'
import { time_real } from '../shared/time'
import { whiteboard_protocol } from '../shared/whiteboard'
import { registry_environment_simulated } from '../simulation/simulated_registry'
import { test_pen_draw } from '../simulation/test_pen'
import { scene_controlled, scene_example } from '../simulation/test_sketch'
import type { Board } from './board'
import { BoardRegistry } from './board_registry'
import { server_start, static_files_load } from './http'
import { cleaned_restore_route } from './http_canvas'
import { pairing_create } from './pairing'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-canvas-static-'))
const machine_key = 'a'.repeat(64)

// Enough refusals in a row that a connection left unusable by one would be reused by another.
const refusal_rounds_count = 8
let registry: BoardRegistry
let board: Board
let server: ReturnType<typeof server_start>
let origin: string

beforeAll(() => {
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Board</title>')
})

afterAll(() => {
  fs.rmSync(directory, { recursive: true })
})

beforeEach(async () => {
  registry = BoardRegistry.open(registry_environment_simulated(time_real))
  board = registry.board_open(board_default_id) as Board
  server = server_start({
    registry,
    machine_key,
    port: 0,
    hostname: '127.0.0.1',
    static_files: static_files_load(directory),
    pairing: pairing_create('test.local', 5173),
    on_fatal: (error) => {
      throw error
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  await test_pen_draw(server.port as number, 'shape:ink', () => board.shapes().length === 1)
})

afterEach(() => {
  server.stop(true)
  registry.destroy()
})

type Headers = Record<string, string>

const post = (pathname: string, body: unknown, headers: Headers = {}) =>
  fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const json = async (response: Response) => (await response.json()) as Record<string, any>

// Reads the body to its end before reporting the status, so no test leaves a response half
// read on a connection that the next request may be given.
const status_of = async (response: Response) => {
  await response.arrayBuffer()
  return response.status
}
const revision_read = async () => (await json(await fetch(`${origin}/api/cleaned/status`))).revision

function publish(title = 'Checkout') {
  const status = board.cleaned_status()
  const scene = scene_example(board.document_state().hash, status.revision, title)
  return registry.publish(board_default_id, scene)
}

test('the address the retired formats were sent to takes nothing from anyone', async () => {
  const hash = board.document_state().hash
  const retired = [
    scene_example(hash, 0),
    { format: 'tldraw-sync.cleanup.v1', snapshot: hash, base_revision: 0, shapes: [] },
    { format: 'tldraw-sync.diagram.v1', snapshot: hash, base_revision: 0, nodes: [], edges: [] },
    '{"format":',
  ]

  for (const body of retired) {
    const answer = await post('/api/cleaned.json', body)
    expect(answer.status).toBe(410)
    expect(await json(answer)).toMatchObject({ code: 'retired' })
  }

  expect(await revision_read()).toBe(0)
  expect(await status_of(await fetch(`${origin}/api/sketch.json?document_hash=${hash}`))).toBe(404)
  expect(board.shapes().map((shape) => shape.id)).toEqual(['shape:ink'])
})

// The regression for a refusal sent while its body was still arriving: the connection was
// left with unread bytes, and the request after it could stall until the test timed out.
test('a refused body is received before its refusal, so the next request is answered', async () => {
  const oversized = ' '.repeat(restore_request_size_bytes_max + 1)
  const large = ' '.repeat(2 * 1024 * 1024)

  for (let round = 0; round < refusal_rounds_count; round += 1) {
    const too_large = await post('/api/cleaned/restore', oversized)
    expect(too_large.status, `round ${round}`).toBe(413)
    expect(await json(too_large)).toMatchObject({ code: 'too_large' })
    const not_json = await post('/api/cleaned/restore', large, { 'content-type': 'text/plain' })
    expect(not_json.status, `round ${round}`).toBe(415)
    expect(await json(not_json)).toMatchObject({ code: 'not_json' })
    const gone = await post('/api/cleaned.json', large)
    expect(gone.status, `round ${round}`).toBe(410)
    expect(await json(gone)).toMatchObject({ code: 'retired' })
    expect(await revision_read(), `round ${round}`).toBe(0)
  }

  // The same rule without a network between: a refusal has consumed the body it refuses.
  const request = new Request(`${origin}/api/cleaned/restore`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: oversized,
  })
  expect(request.bodyUsed).toBe(false)
  expect((await cleaned_restore_route(request, registry, board_default_id)).status).toBe(415)
  expect(request.bodyUsed).toBe(true)

  // And the board still publishes afterwards.
  expect(publish()).toMatchObject({ kind: 'published', revision: 1 })
  expect(await revision_read()).toBe(1)
})

// A page that shows controls asks for one view at a time; a page that does not reads the view
// at rest, as it always has. Asking for a view, even a bad one, changes nothing.
test('a page that shows controls reads one view at a time, and the canvas stays', async () => {
  const scene = scene_controlled(board.document_state().hash, 0)
  expect(registry.publish(board_default_id, scene)).toMatchObject({ kind: 'published' })
  const document = await json(await fetch(`${origin}/api/cleaned.json`))
  const view_get = (query: string) => fetch(`${origin}/api/cleaned/view.json${query}`)
  const rest = await json(await view_get(''))
  expect(rest).toMatchObject({
    revision: 1,
    state: { season: 'summer', stage: 'plan', labels: 'off' },
    states_count: 12,
  })
  expect(rest.records).toEqual(document.records)

  const state = encodeURIComponent(JSON.stringify({ season: 'winter', labels: 'on' }))
  const winter = await json(await view_get(`?state=${state}`))
  const winter_ids = (winter.records as Array<{ id: string }>).map((record) => record.id)
  expect(winter_ids).toContain('shape:scene-snow')
  expect(winter_ids).not.toContain('shape:scene-sun')
  expect(winter.taps).toEqual([
    { shape_id: 'shape:scene-snow', control: 'season', value: 'summer' },
  ])

  const refusals: Array<[string, number, string]> = [
    ['?state=%7B', 400, 'invalid_state'],
    [`?state=${encodeURIComponent('{"weather":"rain"}')}`, 400, 'invalid_state'],
    [`?state=${'7'.repeat(2000)}`, 413, 'too_large'],
  ]

  for (const [query, status, code] of refusals) {
    const answer = await view_get(query)
    expect([query, answer.status, (await json(answer)).code]).toEqual([query, status, code])
  }

  expect(await status_of(await post('/api/cleaned/view.json', {}))).toBe(405)
  expect(await revision_read()).toBe(1)
  expect(await json(await fetch(`${origin}/api/cleaned.json`))).toEqual(document)
})

test('pages read the canvas and see it go stale when the ink changes', async () => {
  expect(publish()).toMatchObject({ kind: 'published', revision: 1 })

  const document = await json(await fetch(`${origin}/api/cleaned.json`))
  expect(document).toMatchObject({ revision: 1, stale: false, current: { legacy: false } })
  expect((document.records as unknown[]).length).toBe(6)
  const status = await fetch(`${origin}/api/cleaned/status`)
  expect(status.headers.get('cache-control')).toBe('no-store')
  const polled = await json(status)
  expect(polled).not.toHaveProperty('records')
  expect(polled).toMatchObject({ linked: false, protocol: whiteboard_protocol, last_event: null })

  await test_pen_draw(server.port as number, 'shape:more', () => board.shapes().length === 2)
  expect(await json(await fetch(`${origin}/api/cleaned/status`))).toMatchObject({
    revision: 1,
    stale: true,
  })
  const board_status = await json(await fetch(`${origin}/api/status`))
  expect(board_status).toMatchObject({
    cleaned_revision: 1,
    agent_revision: 1,
    cleaned_stale: true,
    protocol: whiteboard_protocol,
  })

  // The original drawing.json still lists just the ink, as a plain array.
  const shapes = (await (await fetch(`${origin}/api/drawing.json`)).json()) as Array<{ id: string }>
  expect(shapes.map((shape) => shape.id).sort()).toEqual(['shape:ink', 'shape:more'])
})

test('a restore is a compare-and-swap on the current revision', async () => {
  expect(publish('First')).toMatchObject({ kind: 'published', revision: 1 })
  expect(publish('Second')).toMatchObject({ kind: 'published', revision: 2 })

  const malformed = await post('/api/cleaned/restore', { base_revision: 'two' })
  expect(await status_of(malformed)).toBe(400)
  const conflict = await post('/api/cleaned/restore', { base_revision: 1 })
  expect(conflict.status).toBe(409)
  expect(await json(conflict)).toMatchObject({ code: 'revision_conflict', revision: 2 })
  const missing = await post('/api/cleaned/restore', { base_revision: 2, revision: 99 })
  expect(await status_of(missing)).toBe(404)
  const restored = await post('/api/cleaned/restore', { base_revision: 2 })
  expect(await json(restored)).toEqual({ kind: 'restored', revision: 3, restored_from: 1 })
  expect(await status_of(await fetch(`${origin}/api/cleaned/restore`))).toBe(405)
  const put = await fetch(`${origin}/api/cleaned.json`, { method: 'PUT' })
  expect(await status_of(put)).toBe(405)
})

// A board linked over HTTP as a host links it, with the credentials the link returned.
async function linked(owner: string) {
  const link = await post(
    '/api/whiteboard/link',
    { owner, protocol: whiteboard_protocol },
    { authorization: `Bearer ${machine_key}` },
  )
  const binding = await json(link)
  const session = String(binding.session)
  const host = { authorization: `Bearer ${binding.token}`, 'x-board-owner': owner }
  const route = (action: string, query = '') =>
    `/api/whiteboard/${action}?session=${session}${query}`
  const get = (action: string, query = '') =>
    fetch(`${origin}${route(action, query)}`, { headers: host })
  const polled = await json(await get('poll', `&protocol=${whiteboard_protocol}`))
  return { session, host, route, get, sketch_hash: String(polled.sketch_hash) }
}

// The chat is read with the board's pairing and nothing else. Method: a real server, a pad's
// words and the agent's answer, then every public route read for either of them.
test('the chat is read only with its pairing; public routes never carry a word of it', async () => {
  const { session, host, route, get } = await linked('chat-public')
  const words = 'Private words about the gateway'
  const answer = 'Private answer: two minutes'
  const stage = await fetch(`${origin}${route('stage')}`, { headers: { 'x-board-stage': 'chat' } })
  const { token } = await json(stage)
  const pad = { authorization: `Bearer ${token}` }
  const sent = await post(
    route('event/v2'),
    {
      kind: 'sketch_notify',
      request_id: '00000000-0001-7aaa-8000-000000000001',
      include_sketch: false,
      text: words,
    },
    pad,
  )
  const { id } = await json(sent)

  for (const state of ['received', 'working']) {
    expect(await status_of(await post(route('ack'), { event: id, state }, host))).toBe(200)
  }

  const ended = await post(route('ack'), { event: id, state: 'updated', message: answer }, host)
  expect(await status_of(ended)).toBe(200)

  for (const pathname of [
    `/api/cleaned/status?session=${session}`,
    `/api/status?session=${session}`,
    '/api/sessions',
    `/api/drawing.json?session=${session}`,
    `/api/pairing?session=${session}`,
  ]) {
    const text = await (await fetch(`${origin}${pathname}`)).text()
    expect(text, pathname).not.toContain('Private')
  }

  const polled = await json(await get('poll', `&protocol=${whiteboard_protocol}`))
  expect(JSON.stringify(polled)).not.toContain('Private')
  const status = await json(await fetch(`${origin}/api/cleaned/status?session=${session}`))
  expect(status.last_event).toEqual({
    id,
    kind: 'sketch_notify',
    state: 'updated',
    created_at_ms: expect.any(Number),
  })

  // The pairing reads it all; nobody else reads any of it.
  expect(await status_of(await fetch(`${origin}${route('chat')}`))).toBe(403)
  expect(await status_of(await fetch(`${origin}${route('chat')}`, { headers: host }))).toBe(403)
  const chat = await json(await fetch(`${origin}${route('chat')}`, { headers: pad }))
  expect(chat.items).toMatchObject([{ id, text: words, reply: answer, answer_seq: 1 }])
  const elsewhere = { 'x-board-stage': 'chat', origin: 'http://elsewhere.example' }
  expect(await status_of(await fetch(`${origin}${route('stage')}`, { headers: elsewhere }))).toBe(
    403,
  )
})

test('a draft goes to the stage as records and comes back as a picture, unpublished', async () => {
  const { session, host, route, get, sketch_hash } = await linked('drafter')
  const scene = scene_example(sketch_hash, 0, 'Draft', session)
  const drafted = await json(await post(route('preview'), scene, host))
  expect(drafted).toMatchObject({ session, base_revision: 0, shapes_count: 4 })
  const stage = (pathname: string, query = '') => `${origin}${pathname}?session=${session}${query}`

  // No stage is connected: the host is told so at once.
  const absent = await get('preview-image', `&id=${drafted.preview}`)
  expect(absent.status).toBe(503)
  expect(await json(absent)).toMatchObject({ code: 'preview_not_ready', reason: 'stage_absent' })

  // What the stage is handed is what a publish would save.
  const job = await json(await fetch(stage('/api/preview.json')))
  expect(job.id).toBe(drafted.preview)
  expect(job.records.map((record: { id: string }) => record.id)).toContain('shape:scene-title')
  const held = await json(await fetch(stage('/api/preview.json', `&have=${drafted.preview}`)))
  expect(held).toEqual({ id: drafted.preview })

  // Another site cannot read a draft through a visitor's browser, or answer for the stage.
  const elsewhere = { origin: 'http://evil.example' }
  expect(await status_of(await fetch(stage('/api/preview.json'), { headers: elsewhere }))).toBe(403)
  const put = (id: string, body: Uint8Array, headers: Headers = {}) =>
    fetch(stage('/api/preview.png', `&id=${id}`), {
      method: 'PUT',
      headers,
      body: body as Uint8Array<ArrayBuffer>,
    })
  const picture = png_blank()
  expect(await status_of(await put(drafted.preview, picture, elsewhere))).toBe(403)
  expect(await status_of(await put('nope', picture))).toBe(400)
  expect(await status_of(await put(drafted.preview, new Uint8Array([1, 2, 3])))).toBe(415)
  expect(await status_of(await put('0'.repeat(36), picture))).toBe(409)
  expect(await status_of(await fetch(stage('/api/preview.png')))).toBe(405)
  expect(await status_of(await put(drafted.preview, picture))).toBe(204)
  expect(await json(await fetch(stage('/api/preview.json')))).toEqual({ id: null })

  const image = await get('preview-image', `&id=${drafted.preview}`)
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(png_signed(new Uint8Array(await image.arrayBuffer()))).toBe(true)

  // Nothing was published by any of it. Publishing saves the records that were drawn.
  const status = () => fetch(`${origin}/api/status?session=${session}`).then(json)
  expect(await status()).toMatchObject({ agent_revision: 0, linked: true })
  const published = await json(await post(route('publish'), scene, host))
  expect(published).toMatchObject({ kind: 'published', revision: 1 })
  expect(published.records_hash).toBe(drafted.records_hash)
  const shown = await json(await fetch(`${origin}/api/cleaned.json?session=${session}`))
  expect(shown.records).toEqual(job.records)
  expect(await status()).toMatchObject({ agent_revision: 1 })

  // A board that has no draft has nothing for a stage to draw.
  expect(await json(await fetch(`${origin}/api/preview.json`))).toEqual({ id: null })
})

test('a linked board is published and restored only with its credentials', async () => {
  const { session, host, route, sketch_hash } = await linked('owner-one')
  const scene = scene_example(sketch_hash, 0, 'Mine', session)
  const stranger = { authorization: `Bearer ${'b'.repeat(64)}`, 'x-board-owner': 'owner-one' }
  const other_owner = { ...host, 'x-board-owner': 'owner-two' }

  for (const headers of [{}, stranger, other_owner]) {
    for (const action of ['publish', 'preview']) {
      expect(await status_of(await post(route(action), scene, headers))).toBe(403)
    }

    const snapshot = route('snapshot', `&document_hash=${sketch_hash}`)
    expect(await status_of(await fetch(`${origin}${snapshot}`, { headers }))).toBe(403)
  }

  expect(await status_of(await post(route('publish'), scene, host))).toBe(200)
  const base = { base_revision: 1 }
  const restore = `/api/cleaned/restore?session=${session}`
  expect(await status_of(await post(restore, base))).toBe(403)
  expect(await status_of(await post(restore, base, host))).toBe(403)
  const keyed = await post(restore, base, { authorization: `Bearer ${machine_key}` })
  expect(keyed.status).toBe(404)
  expect(await json(keyed)).toMatchObject({ code: 'nothing_to_restore' })
  const status = await json(await fetch(`${origin}/api/status?session=${session}`))
  expect(status).toMatchObject({ agent_revision: 1 })
})
