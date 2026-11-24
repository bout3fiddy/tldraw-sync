// The cleanup routes on a real server and port, with a real sync client drawing the ink. The
// original routes must answer exactly as before; the new ones validate every body.
//
// Every test gets its own board and server, holding one drawn shape and no cleaned diagram,
// so no test depends on what another published, and a failure in one cannot fail the next.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proposal_size_bytes_max } from '../shared/constants'
import { time_real } from '../shared/time'
import { SimulatedDisk } from '../simulation/simulated_disk'
import { test_pen_draw } from '../simulation/test_pen'
import { proposal_example } from '../simulation/test_sketch'
import { Board } from './board'
import { server_start, static_files_load } from './http'
import { cleaned_publish_route } from './http_cleanup'
import { pairing_create } from './pairing'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cleanup-static-'))

// Enough refusals in a row that a connection left unusable by one would be reused by another.
const refusal_rounds_count = 8
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
  await test_pen_draw(server.port as number, 'shape:ink', () => board.shapes().length === 1)
})

afterEach(() => {
  server.stop(true)
  board.destroy()
})

const post = (pathname: string, body: unknown, content_type = 'application/json') =>
  fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': content_type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const json = async (response: Response) => (await response.json()) as Record<string, unknown>

// Reads the body to its end before reporting the status, so no test leaves a response half
// read on a connection that the next request may be given.
const status_of = async (response: Response) => {
  await response.arrayBuffer()
  return response.status
}
const revision_read = async () => (await json(await fetch(`${origin}/api/cleaned/status`))).revision

test('the sketch records are served only for the document the image showed', async () => {
  const hash = board.document_state().hash
  const bounds = '-5,-5,20.5,20'
  const put = await fetch(`${origin}/api/drawing.png?document_hash=${hash}&bounds=${bounds}`, {
    method: 'PUT',
    body: png as Uint8Array<ArrayBuffer>,
  })
  expect(await status_of(put)).toBe(204)

  const sketch = await fetch(`${origin}/api/sketch.json?document_hash=${hash}`)
  expect(sketch.status).toBe(200)
  const snapshot = await json(sketch)
  expect(snapshot.document_hash).toBe(hash)
  expect(snapshot.bounds).toEqual({ x: -5, y: -5, w: 20.5, h: 20 })
  expect(snapshot.cleaned_revision).toBe(0)
  expect((snapshot.records as Array<{ id: string }>).map((record) => record.id)).toEqual([
    'shape:ink',
  ])

  const other = await fetch(`${origin}/api/sketch.json?document_hash=0000000000000000`)
  expect(other.status).toBe(409)
  expect(await json(other)).toMatchObject({ code: 'sketch_changed' })
  const malformed_hash = await fetch(`${origin}/api/sketch.json?document_hash=nope`)
  expect(await status_of(malformed_hash)).toBe(400)

  for (const malformed of ['1,2,3', 'a,b,c,d', '1,2,-3,4', '1,2,3,4,5', '1e99,0,1,1']) {
    const response = await fetch(
      `${origin}/api/drawing.png?document_hash=${hash}&bounds=${malformed}`,
      { method: 'PUT', body: png as Uint8Array<ArrayBuffer> },
    )
    expect(await status_of(response), malformed).toBe(400)
  }

  // The original fetch is unchanged by any of this.
  const image = await fetch(`${origin}/api/drawing.png`)
  expect(await status_of(image)).toBe(200)
  expect(image.headers.get('x-document-hash')).toBe(hash)
})

test('a publish is checked whole, and refused bodies change nothing', async () => {
  const hash = board.document_state().hash
  const valid = proposal_example(hash, 0)
  expect(await status_of(await post('/api/cleaned.json', valid, 'text/plain'))).toBe(415)
  expect(await status_of(await post('/api/cleaned.json', '{"format":'))).toBe(400)
  const oversized = await post('/api/cleaned.json', ' '.repeat(proposal_size_bytes_max + 1))
  expect(oversized.status).toBe(413)
  expect(await json(oversized)).toMatchObject({ code: 'too_large' })

  const invalid = await post('/api/cleaned.json', { ...valid, shapes: [{ kind: 'image' }] })
  expect(invalid.status).toBe(400)
  expect(await json(invalid)).toMatchObject({ code: 'invalid_proposal', path: 'shapes[0].kind' })
  const stale = await post('/api/cleaned.json', { ...valid, snapshot: '0000000000000000' })
  expect(stale.status).toBe(409)
  expect(await json(stale)).toMatchObject({ code: 'sketch_changed', sketch_hash: hash })
  expect(await revision_read()).toBe(0)

  const published = await post('/api/cleaned.json', valid)
  expect(published.status).toBe(200)
  expect(await json(published)).toEqual({ kind: 'published', revision: 1, shapes_count: 4 })
  const conflict = await post('/api/cleaned.json', valid)
  expect(conflict.status).toBe(409)
  expect(await json(conflict)).toMatchObject({ code: 'revision_conflict', revision: 1 })
  expect(board.shapes().map((shape) => shape.id)).toEqual(['shape:ink'])
})

// The regression for a refusal sent while its body was still arriving: the connection was
// left with unread bytes, and the request after it could stall until the test timed out.
test('a refused body is received before its refusal, so the next request is answered', async () => {
  const oversized = ' '.repeat(proposal_size_bytes_max + 1)

  for (let round = 0; round < refusal_rounds_count; round += 1) {
    const too_large = await post('/api/cleaned.json', oversized)
    expect(too_large.status, `round ${round}`).toBe(413)
    expect(await json(too_large)).toMatchObject({ code: 'too_large' })
    const not_json = await post('/api/cleaned.json', oversized, 'text/plain')
    expect(not_json.status, `round ${round}`).toBe(415)
    expect(await json(not_json)).toMatchObject({ code: 'not_json' })
    expect(await revision_read(), `round ${round}`).toBe(0)
  }

  // The same rule without a network between: a refusal has consumed the body it refuses.
  const request = new Request(`${origin}/api/cleaned.json`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: oversized,
  })
  expect(request.bodyUsed).toBe(false)
  expect((await cleaned_publish_route(request, board)).status).toBe(415)
  expect(request.bodyUsed).toBe(true)

  // And the board still publishes afterwards, on whichever connection it is given.
  const published = await post(
    '/api/cleaned.json',
    proposal_example(board.document_state().hash, 0),
  )
  expect(await json(published)).toMatchObject({ kind: 'published', revision: 1 })
})

test('pages read the cleaned diagram and see it go stale when the ink changes', async () => {
  const published = await post(
    '/api/cleaned.json',
    proposal_example(board.document_state().hash, 0),
  )
  expect(await json(published)).toMatchObject({ kind: 'published', revision: 1 })

  const document = await json(await fetch(`${origin}/api/cleaned.json`))
  expect(document).toMatchObject({ revision: 1, stale: false })
  expect((document.records as unknown[]).length).toBe(6)
  const status = await fetch(`${origin}/api/cleaned/status`)
  expect(status.headers.get('cache-control')).toBe('no-store')
  expect(await json(status)).not.toHaveProperty('records')

  await test_pen_draw(server.port as number, 'shape:more', () => board.shapes().length === 2)
  expect(await json(await fetch(`${origin}/api/cleaned/status`))).toMatchObject({
    revision: 1,
    stale: true,
  })
  const board_status = await json(await fetch(`${origin}/api/status`))
  expect(board_status).toMatchObject({ cleaned_revision: 1, cleaned_stale: true })

  // The original drawing.json still lists just the ink, as a plain array.
  const shapes = (await (await fetch(`${origin}/api/drawing.json`)).json()) as Array<{ id: string }>
  expect(shapes.map((shape) => shape.id).sort()).toEqual(['shape:ink', 'shape:more'])
})

test('a restore is a compare-and-swap on the current revision', async () => {
  const hash = board.document_state().hash
  const first = await post('/api/cleaned.json', proposal_example(hash, 0))
  expect(await json(first)).toMatchObject({ kind: 'published', revision: 1 })
  const second = await post('/api/cleaned.json', proposal_example(hash, 1, 'Second'))
  expect(await json(second)).toMatchObject({ kind: 'published', revision: 2 })

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
