// The command line as an agent uses it: separate processes, JSON out, exit codes. Each test
// works on a data directory of its own, so the board in daily use is never touched.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proposal_size_bytes_max } from '../shared/constants'
import { scene_format } from '../shared/scene_types'
import { whiteboard_protocol } from '../shared/whiteboard'
import { test_pen_draw, test_stage_open } from '../simulation/test_pen'
import { sketch_stroke } from '../simulation/test_sketch'
import { port_any, port_free } from './board_process'
import { port_pick } from './commands'

const entry = path.join(import.meta.dir, 'main.ts')
const directories: string[] = []
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
const protocol = String(whiteboard_protocol)

type Json = Record<string, any>
type Run = { exit_code: number; json: Json; stdout: string }

// The data directory comes first on the PATH, so a test can put a harmless `open` there:
// no command here ever opens a real browser.
async function cli(directory: string, ...args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: {
      ...process.env,
      BOARD_DATA_DIR: directory,
      TMPDIR: directory,
      PATH: `${directory}:${process.env.PATH}`,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const exit_code = await child.exited
  const json = args.includes('--json') ? (JSON.parse(stdout) as Json) : {}
  return { exit_code, json, stdout }
}

function directory_create(): string {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cli-'))
  const directory = fs.realpathSync(made)
  directories.push(directory)

  // Stands in for the system's way of opening a browser, and opens nothing.
  for (const opener of ['open', 'xdg-open']) {
    fs.writeFileSync(path.join(directory, opener), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }

  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await cli(directory, 'stop', '--json')
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('help is layered: the top level orients an agent, each command has detail', async () => {
  const directory = directory_create()
  const top = await cli(directory, '--help')
  expect(top.exit_code).toBe(0)
  expect(top.stdout).toContain('tldraw-sync fetch --json')
  expect(top.stdout).toContain('next_action')
  expect(top.stdout).toContain('whiteboard-preview')
  const fetch_help = await cli(directory, 'fetch', '--help')
  expect(fetch_help.stdout).toContain('document_hash')
  expect((await cli(directory, 'help', 'start')).stdout).toContain('--port <n>')

  // The scene format is documented where an agent is sent for it, and nowhere is the retired
  // way of drawing offered.
  const snapshot_help = (await cli(directory, 'whiteboard-snapshot', '--help')).stdout
  expect(snapshot_help).toContain(`"format": "${scene_format}"`)
  expect(snapshot_help).toContain('"basis": "sketch" | "canvas"')
  expect((await cli(directory, 'whiteboard-link', '--help')).stdout).toContain(
    `--protocol ${protocol}`,
  )

  for (const word of ['cleanup-snapshot', 'cleanup-compose', 'cleanup-publish', 'Interpret']) {
    expect(top.stdout).not.toContain(word)
    expect(snapshot_help).not.toContain(word)
  }
})

test('usage errors are failures with a way out, in JSON too', async () => {
  const directory = directory_create()
  const unknown = await cli(directory, 'draw', '--json')
  expect(unknown.exit_code).toBe(1)
  expect(unknown.json).toMatchObject({ status: 'failure', code: 'usage_error' })
  expect(unknown.json.next_action).toEqual({ action: 'fix_usage', command: 'tldraw-sync --help' })

  const port = await cli(directory, 'start', '--port', 'abc', '--json')
  expect(port.json).toMatchObject({ code: 'usage_error', exit_code: 1 })
  const option = await cli(directory, 'fetch', '--colour', '--json')
  expect(option.json).toMatchObject({ code: 'usage_error' })

  // The retired authoring commands are not commands any more.
  for (const retired of ['cleanup-snapshot', 'cleanup-compose', 'cleanup-publish']) {
    const answer = await cli(directory, retired, '--json')
    expect(answer.json).toMatchObject({ status: 'failure', code: 'usage_error' })
    expect(String(answer.json.message)).toContain('Unknown command')
  }
})

test('start, fetch and stop, as an agent runs them', async () => {
  const directory = directory_create()
  const port = port_any()
  const not_running = await cli(directory, 'status', '--json')
  expect(not_running.exit_code).toBe(2)
  expect(not_running.json.next_action).toEqual({ action: 'run', command: 'tldraw-sync start' })

  const started = await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  expect(started.exit_code).toBe(0)
  expect(started.json).toMatchObject({ code: 'started', port, stage_opened: false })
  expect(String(started.json.draw_url)).toEndWith(`:${port}/draw`)
  const again = await cli(directory, 'start', '--no-open', '--json')
  expect(again.json).toMatchObject({ code: 'already_running', pid: started.json.pid })

  const empty = await cli(directory, 'fetch', '--no-open', '--json')
  expect(empty.exit_code).toBe(3)
  expect(empty.json).toMatchObject({ code: 'board_empty' })

  const drawn = async () => (await status_json(directory)).shapes_count === 1
  await test_pen_draw(port, 'shape:one', drawn)

  // Nothing has rendered the new shape, and the Mac page may not be opened: say so.
  const closed = await cli(directory, 'fetch', '--no-open', '--json')
  expect(closed.exit_code).toBe(4)
  expect(closed.json).toMatchObject({ code: 'stage_closed' })

  // Stand in for the Mac page: upload an image of the current document.
  const { document_hash } = await status_json(directory)
  await fetch(`http://127.0.0.1:${port}/api/drawing.png?document_hash=${document_hash}`, {
    method: 'PUT',
    body: png as Uint8Array<ArrayBuffer>,
  })
  const out = path.join(directory, 'out', 'drawing.png')
  const fetched = await cli(directory, 'fetch', '--no-open', '--json', '--out', out)
  expect(fetched.json).toMatchObject({ code: 'image_saved', path: out, document_hash })
  expect([...fs.readFileSync(out)]).toEqual([...png])
  const quiet = await cli(directory, 'fetch', '--no-open', '--quiet', '--out', out)
  expect(quiet.stdout).toBe(`${out}\n`)

  const stopped = await cli(directory, 'stop', '--json')
  expect(stopped.json).toMatchObject({ status: 'success', code: 'stopped' })
  expect(fs.existsSync(path.join(directory, 'server.json'))).toBe(false)
  expect((await cli(directory, 'stop', '--json')).json).toMatchObject({ code: 'already_stopped' })

  // The drawing and its image outlive the process.
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  const restored = await cli(directory, 'fetch', '--no-open', '--json', '--out', out)
  expect(restored.json).toMatchObject({ code: 'image_saved', document_hash })
}, 30_000)

test('a board that crashed leaves a stale file, and the next start takes over', async () => {
  const directory = directory_create()
  const port = port_any()
  fs.writeFileSync(path.join(directory, 'server.json'), JSON.stringify({ pid: 999_999, port }))
  expect((await cli(directory, 'status', '--json')).exit_code).toBe(2)
  const started = await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  expect(started.json).toMatchObject({ code: 'started', port })
}, 30_000)

test('a taken port is never used: a requested one fails, the default falls back', async () => {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })

  try {
    expect(await port_free(listener.port)).toBe(false)
    const picked = await port_pick(listener.port)
    expect(typeof picked === 'number' ? picked : picked.code).toBe('port_busy')
    expect(await port_pick(null)).toBeGreaterThan(0)
  } finally {
    listener.stop(true)
  }

  expect(await port_free(listener.port)).toBe(true)
})

// A PNG header that names its size, which is all a snapshot reads from it.
function png_sized(width_px: number, height_px: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width_px)
  view.setUint32(20, height_px)
  return bytes
}

async function status_json(directory: string, session = 'default'): Promise<Json> {
  return (await cli(directory, 'status', '--session', session, '--json')).json
}

// Stands in for the Mac page: renders the current document, with the bounds it covered.
async function stage_upload(directory: string, port: number, session: string): Promise<string> {
  const { document_hash } = await status_json(directory, session)
  const query = `document_hash=${document_hash}&bounds=0,0,10,10&session=${session}`
  const response = await fetch(`http://127.0.0.1:${port}/api/drawing.png?${query}`, {
    method: 'PUT',
    body: png_sized(148, 74) as Uint8Array<ArrayBuffer>,
  })
  expect(response.status).toBe(204)
  return String(document_hash)
}

// Stands in for the Mac page once more: waits for the draft the board wants drawn, and sends a
// picture for it. Bounded, like every wait here.
async function stage_draw(port: number, session: string, picture: Uint8Array): Promise<Json> {
  const base = `http://127.0.0.1:${port}/api/preview`

  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = (await (await fetch(`${base}.json?session=${session}`)).json()) as Json

    if (job.id !== null) {
      const put = await fetch(`${base}.png?session=${session}&id=${job.id}`, {
        method: 'PUT',
        body: picture as Uint8Array<ArrayBuffer>,
      })
      expect(put.status).toBe(204)
      return job
    }

    await Bun.sleep(25)
  }

  throw new Error('the board never asked for a draft to be drawn')
}

type Host = {
  directory: string
  port: number
  session: string
  binding: string
  bound: (action: string, ...args: string[]) => Promise<Run>
}

// A board started and linked as a pih host links it, with the pen's first stroke on it.
async function host_link(): Promise<Host> {
  const directory = directory_create()
  const port = port_any()
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  const binding = path.join(directory, 'private', 'binding.json')
  const link = ['whiteboard-link', '--protocol', protocol, '--owner', 'cli-test', '--out', binding]
  const linked = await cli(directory, ...link, '--json')
  expect(linked.json).toMatchObject({
    status: 'success',
    code: 'linked',
    protocol: whiteboard_protocol,
  })
  const session = String(linked.json.session)
  const bound = (action: string, ...args: string[]) =>
    cli(directory, `whiteboard-${action}`, '--binding', binding, ...args, '--json')

  // The link reveals where the credentials are, never what they are.
  const { token } = JSON.parse(fs.readFileSync(binding, 'utf8')) as { token: string }
  expect(linked.stdout).not.toContain(token)
  expect(fs.statSync(binding).mode & 0o777).toBe(0o600)
  return { directory, port, session, binding, bound }
}

const hill = sketch_stroke('shape:hill', 0, 10, [
  [0, 0],
  [5, -8],
  [10, 0],
])

function scene_write(file: string, change: (scene: Json) => void): Json {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
  change(scene)
  fs.writeFileSync(file, JSON.stringify(scene))
  return scene
}

const drawn_elements = [
  { type: 'sketch', id: 'pic', strokes: ['shape:hill'] },
  { type: 'text', id: 'cap', x: 0, y: 40, text: 'A hill' },
  { type: 'geo', id: 'note', x: 120, y: 0, w: 140, h: 60, text: 'Why so steep?' },
  { type: 'arrow', id: 'asks', from: 'note', to: 'cap' },
]

test('a linked board as a host drives it: snapshot, draft, publish, restore', async () => {
  const host = await host_link()
  const { directory, port, session, bound } = host
  const drawn = async () => (await status_json(directory, session)).shapes_count === 1
  await test_pen_draw(port, 'shape:hill', drawn, session, hill)
  const hash = await stage_upload(directory, port, session)
  const out = path.join(directory, 'snapshots')
  const scene_path = await host_snapshot(host, out, hash)
  scene_write(scene_path, (scene) => (scene.elements = drawn_elements))

  // The draft is drawn by the stage and saved as a picture. Nothing is published by it.
  const stage_close = await test_stage_open(port, session)
  const picture = png_sized(400, 240)
  const preview = bound('preview', '--file', scene_path, '--no-open')
  const job = await stage_draw(port, session, picture)
  const drafted = (await preview).json
  expect(drafted).toMatchObject({
    status: 'success',
    code: 'preview_saved',
    session,
    published: false,
    shapes_count: 4,
    base_revision: 0,
    snapshot: hash,
    image: { width_px: 400, height_px: 240 },
  })
  expect([...fs.readFileSync(String(drafted.image_path))]).toEqual([...picture])
  expect(job.records.map((record: Json) => record.id)).toContain('shape:scene-pic.0')
  expect(await status_json(directory, session)).toMatchObject({ agent_revision: 0, linked: true })
  stage_close()

  // Publishing the same file saves the records the draft was drawn from.
  const published = await bound('publish', '--file', scene_path)
  expect(published.json).toMatchObject({
    code: 'published',
    session,
    revision: 1,
    shapes_count: 4,
    title_applied: false,
  })
  expect(published.json.records_hash).toBe(drafted.records_hash)
  const again = await bound('publish', '--file', scene_path)
  expect(again.exit_code).toBe(5)
  expect(again.json).toMatchObject({ code: 'revision_conflict', next_action: { action: 'run' } })
  expect(String(again.json.next_action.command)).toContain('whiteboard-snapshot --binding')

  await host_conflicts_and_refusals(host, scene_path, hash)
  await host_restore_and_restart(host, out)
}, 90_000)

// The first snapshot of a linked board: what it saves, and what it tells the agent.
async function host_snapshot(host: Host, out: string, hash: string): Promise<string> {
  const snapshot = await host.bound('snapshot', '--no-open', '--out', out)
  expect(snapshot.exit_code).toBe(0)
  expect(snapshot.json).toMatchObject({
    code: 'snapshot_saved',
    session: host.session,
    snapshot: hash,
    base_revision: 0,
    shapes_count: 1,
    title_wanted: true,
    agent_source_hash: null,
    canvas: { revision: 0, editable: false, legacy: false },
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    image: { width_px: 148, height_px: 74 },
    mapping: { x0: -32, y0: -32, ppu: 2 },
  })
  const { scene_path, records_path, strokes_path, prompt, schema } = snapshot.json
  expect(path.dirname(String(scene_path)).startsWith(out)).toBe(true)
  expect(fs.readFileSync(String(snapshot.json.image_path)).byteLength).toBe(33)
  const records = JSON.parse(fs.readFileSync(String(records_path), 'utf8'))
  expect(records).toMatchObject({ snapshot: hash, records: [{ id: 'shape:hill' }] })
  const strokes = JSON.parse(fs.readFileSync(String(strokes_path), 'utf8'))
  expect(strokes.strokes).toMatchObject([{ id: 'shape:hill', type: 'draw' }])

  // The scene file is a proposal ready to edit, already tied to this snapshot.
  expect(JSON.parse(fs.readFileSync(String(scene_path), 'utf8'))).toEqual({
    format: scene_format,
    session: host.session,
    snapshot: hash,
    base_revision: 0,
    basis: 'sketch',
    elements: [],
  })
  expect(String(schema)).toContain(`"format": "${scene_format}"`)
  expect(String(prompt)).toContain('answer in the')
  expect(String(prompt)).toContain('Publish nothing')
  expect(String(prompt)).toContain(String(snapshot.json.preview_command))
  expect(String(snapshot.json.preview_command)).toContain('whiteboard-preview --binding')
  expect(String(snapshot.json.publish_command)).toContain(`--file '${scene_path}'`)
  expect(String(prompt)).toContain('no name yet')
  expect(snapshot.stdout).not.toContain(JSON.parse(fs.readFileSync(host.binding, 'utf8')).token)
  return String(scene_path)
}

// The sketch moves on, scenes are refused for what is wrong with them, and nothing changes.
async function host_conflicts_and_refusals(host: Host, scene_path: string, hash: string) {
  const { directory, port, session, bound } = host
  const square_drawn = async () => (await status_json(directory, session)).shapes_count === 2
  await test_pen_draw(port, 'shape:two', square_drawn, session)
  scene_write(scene_path, (scene) => (scene.base_revision = 1))
  const changed = await bound('publish', '--file', scene_path)
  expect(changed.exit_code).toBe(5)
  expect(changed.json).toMatchObject({ code: 'sketch_changed' })
  expect((await bound('preview', '--file', scene_path, '--no-open')).json).toMatchObject({
    code: 'sketch_changed',
    exit_code: 5,
  })
  expect(await status_json(directory, session)).toMatchObject({
    agent_revision: 1,
    cleaned_stale: true,
  })

  // A change to the canvas alone is accepted, and keeps the strokes copied from the sketch.
  scene_write(scene_path, (scene) => {
    scene.basis = 'canvas'
    scene.elements[2].text = 'Still steep.'
  })
  const own = await bound('publish', '--file', scene_path)
  expect(own.json).toMatchObject({ code: 'published', revision: 2, shapes_count: 4 })

  const bad = path.join(directory, 'bad.json')
  fs.writeFileSync(
    bad,
    JSON.stringify({
      format: scene_format,
      session,
      snapshot: hash,
      base_revision: 2,
      elements: [{ type: 'image', id: 'a', src: 'http://example.com/a.png' }],
    }),
  )

  for (const action of ['publish', 'preview']) {
    const invalid = await bound(action, '--file', bad)
    expect(invalid.exit_code).toBe(1)
    expect(invalid.json).toMatchObject({
      code: 'invalid_scene',
      next_action: { action: 'fix_usage' },
    })
    expect(String(invalid.json.message)).toContain('elements[0].type')
  }

  fs.writeFileSync(bad, JSON.stringify({ format: scene_format, session: 'default', elements: [] }))
  const elsewhere = await bound('publish', '--file', bad)
  expect(elsewhere.json).toMatchObject({ code: 'session_mismatch', exit_code: 5 })
  fs.writeFileSync(bad, new Uint8Array(proposal_size_bytes_max + 1).fill(0x20))
  expect((await bound('publish', '--file', bad)).json).toMatchObject({ code: 'scene_too_large' })
  expect((await bound('preview', '--file', directory)).json).toMatchObject({
    code: 'scene_unreadable',
  })
  fs.writeFileSync(bad, '{"format":')
  expect((await bound('publish', '--file', bad)).json).toMatchObject({ code: 'invalid_scene' })
  expect((await bound('publish', '--file', '-')).json).toMatchObject({ code: 'usage_error' })
  expect((await bound('publish')).json).toMatchObject({ code: 'usage_error' })
  expect((await bound('snapshot', '--layer', 'ideas')).json).toMatchObject({ code: 'usage_error' })
  expect(await status_json(directory, session)).toMatchObject({ agent_revision: 2 })
}

// An earlier revision comes back as a new one, and everything outlives the process.
async function host_restore_and_restart(host: Host, out: string) {
  const { directory, port, session, bound } = host
  const restore = (base: string) =>
    cli(directory, 'cleanup-restore', '--session', session, '--base-revision', base, '--json')
  const stale_base = await restore('1')
  expect(stale_base.exit_code).toBe(5)
  expect((await restore('2')).json).toMatchObject({
    code: 'restored',
    revision: 3,
    restored_from: 1,
  })
  expect((await restore('x')).json).toMatchObject({ code: 'usage_error' })

  await cli(directory, 'stop', '--json')
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  expect(await status_json(directory, session)).toMatchObject({
    shapes_count: 2,
    agent_revision: 3,
    cleaned_revision: 3,
    cleaned_stale: true,
    linked: true,
  })
  expect((await bound('poll', '--protocol', protocol)).json).toMatchObject({
    code: 'polled',
    agent_revision: 3,
    events: [],
  })

  // The next snapshot hands back the scene that is on the canvas, with what the board filled
  // in: where the copied strokes are and which sketch they came from.
  await stage_upload(directory, port, session)
  const snapshot = await bound('snapshot', '--no-open', '--out', out)
  expect(snapshot.json).toMatchObject({
    base_revision: 3,
    shapes_count: 2,
    canvas: { revision: 3, editable: true, legacy: false },
  })
  const scene = JSON.parse(fs.readFileSync(String(snapshot.json.scene_path), 'utf8')) as Json
  expect(scene.base_revision).toBe(3)
  expect(scene.elements.map((element: Json) => element.id)).toEqual(['pic', 'cap', 'note', 'asks'])
  expect(scene.elements[0]).toMatchObject({
    type: 'sketch',
    strokes: ['shape:hill'],
    source_hash: snapshot.json.agent_source_hash,
  })
  expect(scene.elements[0]).not.toHaveProperty('ink')
  expect(scene.elements[2].text).toBe('Why so steep?')
}

test('the canvas commands need a binding, and a wrong one reads and opens nothing', async () => {
  const host = await host_link()
  const { directory, session } = host
  const scene = path.join(directory, 'scene.json')
  fs.writeFileSync(scene, JSON.stringify({ format: scene_format, session, elements: [] }))

  for (const command of ['whiteboard-snapshot', 'whiteboard-preview', 'whiteboard-publish']) {
    const bare = await cli(directory, command, '--file', scene, '--json')
    expect(bare.json).toMatchObject({ code: 'usage_error' })
  }

  // A binding for this board with someone else's token: refused before any file is read.
  const forged = path.join(directory, 'private', 'forged.json')
  const real = JSON.parse(fs.readFileSync(host.binding, 'utf8')) as Json
  const stolen = { session: real.session, owner: real.owner, token: 'f'.repeat(64) }
  fs.writeFileSync(forged, JSON.stringify(stolen), { mode: 0o600 })
  const missing = path.join(directory, 'missing.json')

  // A snapshot takes no scene. The other two name one that is not there: had it been read,
  // the answer would say so.
  for (const action of ['snapshot', 'preview', 'publish']) {
    const scene_named = action === 'snapshot' ? [] : ['--file', missing]
    const command = [`whiteboard-${action}`, '--binding', forged, ...scene_named, '--json']
    const refused = await cli(directory, ...command)
    expect(refused.json, action).toMatchObject({ status: 'failure', code: 'not_authorized' })
  }

  // The scene file is not a snapshot's to take, with or without a sound binding.
  const scene_given = await host.bound('snapshot', '--file', scene)
  expect(scene_given.json).toMatchObject({ code: 'usage_error', exit_code: 1 })

  // A host that speaks an earlier protocol is told to upgrade, here and when it links.
  const old = String(whiteboard_protocol - 1)
  const polled = await host.bound('poll', '--protocol', old)
  expect(polled.json).toMatchObject({ code: 'upgrade_required' })
  const relink = await cli(
    directory,
    'whiteboard-link',
    '--protocol',
    old,
    '--owner',
    'cli-test',
    '--out',
    host.binding,
    '--json',
  )
  expect(relink.json).toMatchObject({ code: 'upgrade_required' })
  expect(await status_json(directory, session)).toMatchObject({ agent_revision: 0 })
}, 60_000)

// The protocol as a pih host speaks it, through the public command line only, with a pad
// paired the way the Mac stage pairs one: words alone and the sketch, the poll, a status line,
// and the answer the board's chat then shows under the words it answers.
test('a scripted host answers the board chat through the command line', async () => {
  const host = await host_link()
  const { port, session, bound } = host
  const base = `http://127.0.0.1:${port}/api/whiteboard`
  const stage = await fetch(`${base}/stage?session=${session}`, {
    headers: { 'x-board-stage': 'chat' },
  })
  const { token } = (await stage.json()) as Json
  const pad = (action: string, body?: Json) =>
    fetch(`${base}/${action}?session=${session}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const text = 'Say the gateway times out instead'
  const words = {
    kind: 'sketch_notify',
    request_id: '00000000-0001-7aaa-8000-000000000001',
    include_sketch: false,
    text,
  }
  expect((await pad('event/v2', words)).status).toBe(200)
  const { document_hash } = await status_json(host.directory, session)
  const request_id = '00000000-0002-7aaa-8000-000000000002'
  const sketch = {
    kind: 'sketch_notify',
    request_id,
    include_sketch: true,
    sketch_hash: document_hash,
  }
  expect((await pad('event/v2', sketch)).status).toBe(200)

  const polled = await bound('poll', '--protocol', protocol)
  expect(polled.json.events).toMatchObject([
    { include_sketch: false, text, state: 'queued' },
    { include_sketch: true, sketch_hash: document_hash, state: 'queued' },
  ])
  const [alone, drawn] = polled.json.events as Json[]
  const ack = (state: string, ...message: string[]) =>
    bound('ack', '--event', String(alone!.id), '--state', state, ...message)
  expect((await ack('received')).json).toMatchObject({ code: 'acknowledged' })
  expect((await ack('working', '--message', 'Reading')).json).toMatchObject({ state: 'working' })

  // A status line that is too long, or an answer that is, is refused before it is sent.
  expect((await ack('working', '--message', 'x'.repeat(281))).json).toMatchObject({
    code: 'usage_error',
  })
  expect((await ack('updated', '--message', '🌱'.repeat(4001))).json).toMatchObject({
    code: 'usage_error',
  })

  const answer = 'The lower path loses fewer orders.\nI drew nothing.'
  expect((await ack('updated', '--message', answer)).json).toMatchObject({ state: 'updated' })
  const next = await bound('poll', '--protocol', protocol)
  expect((next.json.events as Json[]).map((event) => event.id)).toEqual([drawn!.id])
  expect(next.stdout).not.toContain('lower path')

  const chat = (await (await pad('chat')).json()) as Json
  expect(chat.items).toMatchObject([
    { id: alone!.id, text, reply: answer, answer_seq: 1, state: 'updated' },
    { id: drawn!.id, include_sketch: true, state: 'queued', reply: null },
  ])
}, 60_000)

test('implicit capture follows home but an explicit retired target never does', async () => {
  const directory = directory_create()
  const port = port_any()
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  const remove = async (session: string) => {
    const answer = await fetch(`http://127.0.0.1:${port}/api/sessions/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    expect(answer.status).toBe(200)
  }
  const created = await cli(directory, 'session-create', '--json')
  const id = String((created.json.session as { id: string }).id)
  const drawn = async () => (await status_json(directory, id)).shapes_count === 1
  await test_pen_draw(port, 'shape:survivor', drawn, id)
  const hash = await stage_upload(directory, port, id)
  await remove('default')
  const captured = await cli(directory, 'fetch', '--no-open', '--json')
  expect(captured.json).toMatchObject({ code: 'image_saved', session: id, document_hash: hash })
  expect(String(captured.json.path)).toContain(path.join('sessions', id))
  const out = path.join(directory, 'must-not-exist.png')
  const stale = await cli(directory, 'fetch', '--session', 'default', '--out', out, '--json')
  expect(stale.json).toMatchObject({ code: 'unknown_session' })
  expect(fs.existsSync(out)).toBe(false)
  await remove(id)
  expect((await cli(directory, 'stop', '--json')).json.code).toBe('stopped')
  expect((await cli(directory, 'start', '--no-open', '--json')).json.code).toBe('started')
  expect((await cli(directory, 'session-list', '--json')).json.sessions).toEqual([])
  expect((await cli(directory, 'status', '--json')).json.code).toBe('no_boards')
  expect((await cli(directory, 'status', '--session', 'default', '--json')).json.code).toBe(
    'unknown_session',
  )
  const next = await cli(directory, 'session-create', '--json')
  const next_id = String((next.json.session as { id: string }).id)
  expect(next_id).not.toBe(id)
  expect((await cli(directory, 'status', '--json')).json.session).toBe(next_id)
}, 60_000)

// Boards as an agent addresses them: each command names its board with --session and writes
// where no other board writes.
test('boards: list, create, rename, and --session on every board command', async () => {
  const directory = directory_create()
  const port = port_any()
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  const created = await cli(directory, 'session-create', '--json')
  expect(created.json).toMatchObject({ code: 'session_created' })
  const id = String((created.json.session as { id: string }).id)
  expect(created.json.stage_url).toBe(`http://localhost:${port}/s/${id}`)
  const listed = await cli(directory, 'session-list', '--json')
  expect((listed.json.sessions as Array<{ id: string }>).map((session) => session.id)).toEqual([
    'default',
    id,
  ])

  const board_status = () => status_json(directory, id)
  await test_pen_draw(port, 'shape:one', async () => (await board_status()).shapes_count === 1, id)
  expect(await status_json(directory)).toMatchObject({ session: 'default', shapes_count: 0 })
  const hash = await stage_upload(directory, port, id)
  const fetched = await cli(directory, 'fetch', '--session', id, '--no-open', '--json')
  expect(fetched.json).toMatchObject({ code: 'image_saved', session: id, document_hash: hash })
  expect(String(fetched.json.path)).toContain(path.join('tldraw-sync', 'sessions', id))

  // A person's name outlives a restart with everything else.
  const renamed = await cli(
    directory,
    'session-rename',
    '--session',
    id,
    '--name',
    'Mine',
    '--json',
  )
  expect(renamed.json).toMatchObject({ code: 'session_renamed', session: { name: 'Mine' } })
  await cli(directory, 'stop', '--json')
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  expect(await board_status()).toMatchObject({
    session: id,
    session_name: 'Mine',
    shapes_count: 1,
    cleaned_revision: 0,
    linked: false,
  })
  expect(await status_json(directory)).toMatchObject({ shapes_count: 0, cleaned_revision: 0 })

  const unknown = await cli(directory, 'status', '--session', 'ffffffffffffffff', '--json')
  expect(unknown.json).toMatchObject({
    code: 'unknown_session',
    next_action: { action: 'run', command: 'tldraw-sync session-list --json' },
  })
  expect((await cli(directory, 'fetch', '--session', '../x', '--json')).json.code).toBe(
    'usage_error',
  )
  const restore = await cli(
    directory,
    'cleanup-restore',
    '--session',
    id,
    '--base-revision',
    '0',
    '--json',
  )
  expect(restore.json).toMatchObject({ code: 'nothing_to_restore' })
}, 60_000)

// A scene with controls, of neutral names: a choice of two values and a toggle, four views.
const views_controls = [
  {
    id: 'mode',
    kind: 'choice',
    label: 'Mode',
    options: [
      { value: 'first', label: 'First' },
      { value: 'second', label: 'Second' },
    ],
  },
  { id: 'more', kind: 'toggle', label: 'More' },
]
const views_elements = [
  { type: 'geo', id: 'base', x: 0, y: 0, w: 120, h: 60, text: 'Always' },
  {
    type: 'text',
    id: 'second_only',
    x: 0,
    y: 80,
    text: 'Second',
    visible_when: [{ control: 'mode', values: ['second'] }],
  },
  {
    type: 'geo',
    id: 'more_only',
    x: 160,
    y: 0,
    w: 80,
    h: 40,
    visible_when: [{ control: 'more', values: ['on'] }],
    on_tap: { control: 'mode', value: 'first' },
  },
]

// What a draft drew: the scene shapes among the records the stage was asked to render.
const job_shapes = (job: Json) =>
  (job.records as Json[])
    .map((record) => String(record.id))
    .filter((id) => id.startsWith('shape:scene-'))
    .sort()

// The escaped gap: a snapshot handed the elements back without the controls they name, so a
// scene re-authored from it was refused. The snapshot now keeps the scene whole, and a preview
// names and draws exactly the view --state asks for, or says precisely why it cannot.
test('a scene with controls round-trips a snapshot; --state previews one view', async () => {
  const host = await host_link()
  const { directory, port, session, bound } = host
  const drawn = async () => (await status_json(directory, session)).shapes_count === 1
  await test_pen_draw(port, 'shape:hill', drawn, session, hill)
  await stage_upload(directory, port, session)
  const out = path.join(directory, 'snapshots')
  const first = await bound('snapshot', '--no-open', '--out', out)
  expect(first.json).toMatchObject({ code: 'snapshot_saved', scene_controls: [], states_count: 1 })
  const scene_path = String(first.json.scene_path)
  scene_write(scene_path, (scene) => {
    scene.controls = views_controls
    scene.elements = views_elements
  })
  const published = await bound('publish', '--file', scene_path)

  // A publish saves the view at rest: the one shape shown in every view.
  expect(published.json).toMatchObject({ code: 'published', revision: 1, shapes_count: 1 })

  // The snapshot hands the scene back whole, with what the board accepts as data.
  const second = await bound('snapshot', '--no-open', '--out', out)
  expect(second.json).toMatchObject({
    code: 'snapshot_saved',
    base_revision: 1,
    scene_controls: views_controls,
    states_count: 4,
    capabilities: { format: 'tldraw-sync.scene-capabilities.v1', scene_format },
  })
  const capabilities_file = fs.readFileSync(String(second.json.capabilities_path), 'utf8')
  expect(JSON.parse(capabilities_file)).toEqual(second.json.capabilities)
  expect(second.json.capabilities.controls).toMatchObject({ count_max: 8, options_count_max: 12 })
  const again_path = String(second.json.scene_path)
  const again = JSON.parse(fs.readFileSync(again_path, 'utf8')) as Json
  expect(again).toMatchObject({ base_revision: 1, controls: views_controls })
  expect(again.elements).toMatchObject(views_elements)

  // Published again as it was handed back: the same records, as a new revision.
  const republished = await bound('publish', '--file', again_path)
  expect(republished.json).toMatchObject({
    code: 'published',
    revision: 2,
    records_hash: published.json.records_hash,
  })

  // A draft is checked against the current revision, so views are previewed from a fresh
  // snapshot: the scene file handed back before the republish is now stale.
  const stale = await bound('preview', '--file', again_path, '--no-open')
  expect(stale.json).toMatchObject({ code: 'revision_conflict' })
  const third = await bound('snapshot', '--no-open', '--out', out)
  expect(third.json).toMatchObject({ base_revision: 2, scene_controls: views_controls })
  const current_path = String(third.json.scene_path)
  await views_previewed(host, current_path, String(published.json.records_hash))
}, 90_000)

async function views_previewed(host: Host, scene_path: string, rest_hash: string) {
  const { directory, port, session, bound } = host
  const stage_close = await test_stage_open(port, session)
  const picture = png_sized(320, 200)
  const preview = (...state: string[]) =>
    bound('preview', '--file', scene_path, '--no-open', ...state)

  // Without --state: the view at rest, which is exactly what the publish saved.
  const rest_run = preview()
  const rest_job = await stage_draw(port, session, picture)
  const rest = (await rest_run).json
  expect(rest).toMatchObject({
    code: 'preview_saved',
    view: 'rest',
    state: { mode: 'first', more: 'off' },
    states_count: 4,
    base_revision: 2,
    records_hash: rest_hash,
    shapes_count: 1,
    published: false,
  })
  expect(job_shapes(rest_job)).toEqual(['shape:scene-base'])

  // One chosen view; a control left out keeps its value at rest.
  const chosen_run = preview('--state', '{"mode":"second","more":"on"}')
  const chosen_job = await stage_draw(port, session, picture)
  const chosen = (await chosen_run).json
  expect(chosen).toMatchObject({
    code: 'preview_saved',
    view: 'selected',
    state: { mode: 'second', more: 'on' },
    states_count: 4,
    base_revision: 2,
    shapes_count: 3,
  })
  expect(chosen.records_hash).not.toBe(rest_hash)
  const shown = ['shape:scene-base', 'shape:scene-more_only', 'shape:scene-second_only']
  expect(job_shapes(chosen_job)).toEqual(shown)
  const partial_run = preview('--state', '{"more":"on"}')
  const partial_job = await stage_draw(port, session, picture)
  expect((await partial_run).json.state).toEqual({ mode: 'first', more: 'on' })
  expect(job_shapes(partial_job)).toEqual(['shape:scene-base', 'shape:scene-more_only'])
  stage_close()
  await views_refused(host, scene_path)
  expect(await status_json(directory, session)).toMatchObject({ agent_revision: 2 })
}

// A view the scene does not have, or a --state that is not one, is refused with a reason, and
// nothing is drawn or published. A publish takes no view at all.
async function views_refused(host: Host, scene_path: string) {
  const preview = (state: string) =>
    host.bound('preview', '--file', scene_path, '--no-open', '--state', state)
  const cases: Array<[state: string, message: string]> = [
    ['{"mode":"third"}', 'state.mode: Expected one of: first, second.'],
    ['{"absent":"on"}', 'state.absent: Unknown control.'],
    ['{"mode":', '--state is not JSON.'],
    ['["mode"]', '--state must be a JSON object of control values.'],
    ['{"mode":2}', '--state gives control "mode" a value that cannot exist.'],
    [JSON.stringify({ mode: 'x'.repeat(1100) }), '--state is over 1024 bytes.'],
  ]

  for (const [state, message] of cases) {
    const refused = await preview(state)
    expect(refused.exit_code, state).toBe(1)
    expect(refused.json, state).toMatchObject({
      status: 'failure',
      code: 'invalid_state',
      message,
      next_action: { action: 'fix_usage', command: 'tldraw-sync whiteboard-preview --help' },
    })
  }

  const publish = await host.bound('publish', '--file', scene_path, '--state', '{}')
  expect(publish.json).toMatchObject({ code: 'usage_error', exit_code: 1 })
}
