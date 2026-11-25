// The command line as an agent uses it: separate processes, JSON out, exit codes. Each test
// works on a data directory of its own, so the board in daily use is never touched.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import diagram_fixture from '../../tests/fixtures/nested_groups.diagram.json'
import { diagram_format } from '../shared/cleanup_types'
import { proposal_size_bytes_max } from '../shared/constants'
import { test_pen_draw } from '../simulation/test_pen'
import { proposal_example } from '../simulation/test_sketch'
import { port_any, port_free } from './board_process'
import { port_pick } from './commands'

const entry = path.join(import.meta.dir, 'main.ts')
const directories: string[] = []
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])

type Run = { exit_code: number; json: Record<string, unknown>; stdout: string }

async function cli(directory: string, ...args: string[]): Promise<Run> {
  return cli_input(directory, null, ...args)
}

async function cli_input(directory: string, input: string | null, ...args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, BOARD_DATA_DIR: directory },
    stdin: input === null ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const exit_code = await child.exited
  const json = args.includes('--json') ? JSON.parse(stdout) as Record<string, unknown> : {}
  return { exit_code, json, stdout }
}

function directory_create(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cli-'))
  directories.push(directory)
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
  const fetch_help = await cli(directory, 'fetch', '--help')
  expect(fetch_help.stdout).toContain('document_hash')
  expect((await cli(directory, 'help', 'start')).stdout).toContain('--port <n>')
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
    method: 'PUT', body: png as Uint8Array<ArrayBuffer>,
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

// A PNG header that names its size, which is all the cleanup snapshot reads from it.
function png_sized(width_px: number, height_px: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width_px)
  view.setUint32(20, height_px)
  return bytes
}

// Stands in for the Mac page: renders the current document, with the bounds it covered.
async function stage_upload(directory: string, port: number): Promise<string> {
  const { document_hash } = await status_json(directory)
  const query = `document_hash=${document_hash}&bounds=0,0,10,10`
  const response = await fetch(`http://127.0.0.1:${port}/api/drawing.png?${query}`, {
    method: 'PUT', body: png_sized(148, 74) as Uint8Array<ArrayBuffer>,
  })
  expect(response.status).toBe(204)
  return String(document_hash)
}

test('cleanup as an agent runs it: snapshot, publish, conflicts, restore, restart', async () => {
  const directory = directory_create()
  const port = port_any()
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  const shapes_count = (count: number) => async () => {
    return (await status_json(directory)).shapes_count === count
  }
  await test_pen_draw(port, 'shape:one', shapes_count(1))
  const hash_one = await stage_upload(directory, port)
  const out = path.join(directory, 'cleanup')
  const proposal_path = await cleanup_first(directory, out, hash_one)

  // The sketch moves on: the old snapshot can no longer publish, and the cleanup is stale.
  await test_pen_draw(port, 'shape:two', shapes_count(2))
  fs.writeFileSync(proposal_path, JSON.stringify(proposal_example(hash_one, 1)))
  const changed = await cli(directory, 'cleanup-publish', '--file', proposal_path, '--json')
  expect(changed.exit_code).toBe(5)
  expect(changed.json).toMatchObject({ code: 'sketch_changed' })
  expect(await status_json(directory)).toMatchObject({ cleaned_revision: 1, cleaned_stale: true })
  const nothing = await cli(directory, 'cleanup-restore', '--base-revision', '1', '--json')
  expect(nothing.json).toMatchObject({ code: 'nothing_to_restore' })

  const hash_two = await stage_upload(directory, port)
  const fresh = await cli(directory, 'cleanup-snapshot', '--no-open', '--json', '--out', out)
  expect(fresh.json).toMatchObject({ snapshot: hash_two, base_revision: 1, shapes_count: 2 })
  fs.writeFileSync(proposal_path, JSON.stringify(proposal_example(hash_two, 1, 'Two')))
  const second = await cli(directory, 'cleanup-publish', '--file', proposal_path, '--json')
  expect(second.json).toMatchObject({ code: 'published', revision: 2 })

  const stale_base = await cli(directory, 'cleanup-restore', '--base-revision', '1', '--json')
  expect(stale_base.exit_code).toBe(5)
  const restored = await cli(directory, 'cleanup-restore', '--base-revision', '2', '--json')
  expect(restored.json).toMatchObject({ code: 'restored', revision: 3, restored_from: 1 })
  const malformed = await cli(directory, 'cleanup-restore', '--base-revision', 'x', '--json')
  expect(malformed.json).toMatchObject({ code: 'usage_error' })

  // Both canvases outlive the process.
  await cli(directory, 'stop', '--json')
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  expect(await status_json(directory)).toMatchObject({
    shapes_count: 2, document_hash: hash_two, cleaned_revision: 3, cleaned_stale: true,
  })
  const help = await cli(directory, 'cleanup-publish', '--help')
  expect(help.stdout).toContain('tldraw-sync.cleanup.v1')
  expect((await cli(directory, '--help')).stdout).toContain('cleanup-snapshot')
}, 60_000)

// The first snapshot and publish, a conflicting second publish, and refused proposals.
// Returns where the agent writes its proposal.
async function cleanup_first(directory: string, out: string, hash_one: string) {
  const snapshot = await cli(directory, 'cleanup-snapshot', '--no-open', '--json', '--out', out)
  expect(snapshot.exit_code).toBe(0)
  expect(snapshot.json).toMatchObject({
    code: 'snapshot_saved', snapshot: hash_one, base_revision: 0, shapes_count: 1,
    bounds: { x: 0, y: 0, w: 10, h: 10 }, image: { width_px: 148, height_px: 74 },
    mapping: { x0: -32, y0: -32, ppu: 2 },
  })
  expect(fs.readFileSync(String(snapshot.json.path)).byteLength).toBe(33)
  const records = JSON.parse(fs.readFileSync(String(snapshot.json.records_path), 'utf8'))
  expect(records).toMatchObject({ snapshot: hash_one, records: [{ id: 'shape:one' }] })
  expect(String(snapshot.json.prompt)).toContain('Invent no items or connections.')
  expect(String(snapshot.json.prompt)).toContain(`"snapshot": "${hash_one}"`)

  const proposal_path = String(snapshot.json.proposal_path)
  fs.writeFileSync(proposal_path, JSON.stringify(proposal_example(hash_one, 0)))
  const published = await cli(directory, 'cleanup-publish', '--file', proposal_path, '--json')
  expect(published.json).toMatchObject({ code: 'published', revision: 1, shapes_count: 4 })
  const again = await cli(directory, 'cleanup-publish', '--file', proposal_path, '--json')
  expect(again.exit_code).toBe(5)
  expect(again.json).toMatchObject({ code: 'revision_conflict',
    next_action: { action: 'run', command: 'tldraw-sync cleanup-snapshot --json' } })

  const bad = JSON.stringify({ ...proposal_example(hash_one, 1), shapes: [{ kind: 'image' }] })
  const invalid = await cli_input(directory, bad, 'cleanup-publish', '--file', '-', '--json')
  expect(invalid.exit_code).toBe(1)
  expect(invalid.json).toMatchObject({ code: 'invalid_proposal',
    next_action: { action: 'fix_usage' } })
  expect(String(invalid.json.message)).toContain('shapes[0].kind')
  expect((await cli(directory, 'cleanup-publish', '--json')).json.code).toBe('usage_error')
  expect(await status_json(directory)).toMatchObject({ cleaned_revision: 1, cleaned_stale: false })
  return proposal_path
}

// A write to a child that has already answered and exited may fail; that is the point here.
function settle(value: unknown): void {
  Promise.resolve(value).catch(() => undefined)
}

test('an oversized proposal on stdin is refused while its writer holds stdin open', async () => {
  const directory = directory_create()
  const child = Bun.spawn([process.execPath, entry, 'cleanup-publish', '--file', '-', '--json'], {
    env: { ...process.env, BOARD_DATA_DIR: directory },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Six times the limit, and no end of input: a reader that waits for the end never answers.
  settle(child.stdin.write(new Uint8Array(6 * proposal_size_bytes_max).fill(0x20)))
  settle(child.stdin.flush())

  const wait_ms_max = 15_000
  let timer: ReturnType<typeof setTimeout> | null = null
  const timed_out = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), wait_ms_max)
  })
  const exit_code = await Promise.race([child.exited, timed_out])
  if (timer !== null) clearTimeout(timer)
  if (exit_code === 'timed_out') child.kill()
  expect(exit_code).toBe(1)

  const json = JSON.parse(await new Response(child.stdout).text()) as Record<string, unknown>
  expect(json).toMatchObject({ status: 'failure', code: 'proposal_too_large', exit_code: 1,
    next_action: { action: 'fix_usage', command: 'tldraw-sync cleanup-publish --help' } })
  expect(String(json.message)).toContain(String(proposal_size_bytes_max))
  try {
    settle(child.stdin.end())
  } catch {
    // The pipe is already closed.
  }
}, 30_000)

test('a proposal file that is too large, or not a regular file, is refused unread', async () => {
  const directory = directory_create()
  const over = path.join(directory, 'over.json')
  fs.writeFileSync(over, new Uint8Array(proposal_size_bytes_max + 1).fill(0x20))
  const too_large = await cli(directory, 'cleanup-publish', '--file', over, '--json')
  expect(too_large.exit_code).toBe(1)
  expect(too_large.json).toMatchObject({ code: 'proposal_too_large' })

  const folder = await cli(directory, 'cleanup-publish', '--file', directory, '--json')
  expect(folder.exit_code).toBe(1)
  expect(folder.json).toMatchObject({ code: 'proposal_unreadable',
    next_action: { action: 'fix_usage' } })
  const missing = path.join(directory, 'missing.json')
  const absent = await cli(directory, 'cleanup-publish', '--file', missing, '--json')
  expect(absent.json).toMatchObject({ code: 'proposal_unreadable' })

  // An endless device is refused at once rather than read until memory runs out.
  if (fs.existsSync('/dev/zero')) {
    const device = await cli(directory, 'cleanup-publish', '--file', '/dev/zero', '--json')
    expect(device.json).toMatchObject({ code: 'proposal_unreadable', exit_code: 1 })
  }

  // A proposal within the limit gets past the reader: with no board, that is the next failure.
  const within = path.join(directory, 'within.json')
  fs.writeFileSync(within, JSON.stringify(proposal_example('0123456789abcdef', 0)))
  const read = await cli(directory, 'cleanup-publish', '--file', within, '--json')
  expect(read.exit_code).toBe(2)
  const piped = await cli_input(directory, '{}', 'cleanup-publish', '--file', '-', '--json')
  expect(piped.exit_code).toBe(2)
}, 30_000)

async function status_json(directory: string): Promise<Record<string, unknown>> {
  return (await cli(directory, 'status', '--json')).json
}

function diagram_write(file: string, snapshot: string, base_revision: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...diagram_fixture, snapshot, base_revision }))
}

test('cleanup-compose lays out a diagram the same way every time, without a board', async () => {
  const directory = directory_create()
  const input = path.join(directory, 'diagram.json')
  diagram_write(input, '0123456789abcdef', 0)
  const first_path = path.join(directory, 'first.json')
  const first = await cli(
    directory, 'cleanup-compose', '--file', input, '--out', first_path, '--json',
  )
  expect(first.exit_code).toBe(0)
  expect(first.json).toMatchObject({
    code: 'composed',
    path: first_path,
    snapshot: '0123456789abcdef',
    shapes_count: 20,
    route_conflicts_count: 0,
  })
  const second_path = path.join(directory, 'second.json')
  await cli(directory, 'cleanup-compose', '--file', input, '--out', second_path, '--json')
  expect(fs.readFileSync(second_path, 'utf8')).toBe(fs.readFileSync(first_path, 'utf8'))
  const composed = JSON.parse(fs.readFileSync(first_path, 'utf8'))
  expect(composed.format).toBe('tldraw-sync.cleanup.v2')
  expect(composed.diagram.nodes.map((node: { id: string }) => node.id)).toEqual(
    diagram_fixture.nodes.map((node) => node.id),
  )

  // Mistakes are named with their path, and nothing is written.
  const broken = { ...diagram_fixture, snapshot: '0123456789abcdef', base_revision: 0 }
  broken.nodes = [...broken.nodes, { id: 'lost', kind: 'box', label: 'Lost', parent: 'nowhere' }]
  const invalid = await cli_input(
    directory, JSON.stringify(broken), 'cleanup-compose', '--file', '-', '--json',
  )
  expect(invalid.exit_code).toBe(1)
  expect(invalid.json).toMatchObject({
    code: 'invalid_diagram', next_action: { action: 'fix_usage' },
  })
  expect(String(invalid.json.message)).toContain('diagram.nodes[10].parent')
  const garbage = await cli_input(directory, '{', 'cleanup-compose', '--file', '-', '--json')
  expect(garbage.json).toMatchObject({ code: 'invalid_diagram' })
  expect((await cli(directory, 'cleanup-compose', '--json')).json.code).toBe('usage_error')
  expect((await cli(directory, 'cleanup-compose', '--help')).stdout).toContain(diagram_format)
}, 30_000)

test('a semantic diagram publishes through the board and returns in a snapshot', async () => {
  const directory = directory_create()
  const port = port_any()
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  const shapes_count = (count: number) => async () => {
    return (await status_json(directory)).shapes_count === count
  }
  await test_pen_draw(port, 'shape:one', shapes_count(1))
  const hash_one = await stage_upload(directory, port)
  const out = path.join(directory, 'cleanup')
  const snapshot = await cli(directory, 'cleanup-snapshot', '--no-open', '--json', '--out', out)
  expect(snapshot.json).toMatchObject({ previous_diagram_path: null, strokes_truncated: false })
  const strokes = JSON.parse(fs.readFileSync(String(snapshot.json.strokes_path), 'utf8'))
  expect(strokes).toMatchObject({ snapshot: hash_one, strokes: [{ id: 'shape:one' }] })
  expect(Object.keys(strokes.strokes[0]).sort()).toEqual(
    ['h', 'id', 'points_count', 'type', 'w', 'x', 'y'],
  )

  const diagram_path = String(snapshot.json.diagram_path)
  diagram_write(diagram_path, hash_one, 0)
  expect(String(snapshot.json.publish_command)).toContain(diagram_path)
  const published = await cli(directory, 'cleanup-publish', '--file', diagram_path, '--json')
  expect(published.json).toMatchObject({ code: 'published', revision: 1, shapes_count: 20 })

  const again = await cli(directory, 'cleanup-snapshot', '--no-open', '--json', '--out', out)
  const previous = JSON.parse(fs.readFileSync(String(again.json.previous_diagram_path), 'utf8'))
  expect(previous.format).toBe(diagram_format)
  expect(previous.nodes.map((node: { label: string }) => node.label)).toEqual(
    diagram_fixture.nodes.map((node) => node.label),
  )
  expect(String(again.json.prompt)).toContain('previous interpretation')

  // The sketch moves on: a diagram of the old sketch is refused after composing, and the
  // published diagram stays.
  await test_pen_draw(port, 'shape:two', shapes_count(2))
  diagram_write(diagram_path, hash_one, 1)
  const stale = await cli(directory, 'cleanup-publish', '--file', diagram_path, '--json')
  expect(stale.exit_code).toBe(5)
  expect(stale.json).toMatchObject({ code: 'sketch_changed' })
  expect(await status_json(directory)).toMatchObject({ cleaned_revision: 1 })
}, 60_000)

// Boards as an agent addresses them: each command names its board with --session, writes where
// no other board writes, and a proposal reaches only the board its snapshot came from.
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
    'default', id,
  ])

  const board_status = async () => (await cli(directory, 'status', '--session', id, '--json')).json
  await test_pen_draw(port, 'shape:one', async () => (await board_status()).shapes_count === 1, id)
  expect(await status_json(directory)).toMatchObject({ session: 'default', shapes_count: 0 })
  const { document_hash } = await board_status()
  const query = `document_hash=${document_hash}&session=${id}&bounds=0,0,10,10`
  await fetch(`http://127.0.0.1:${port}/api/drawing.png?${query}`, {
    method: 'PUT', body: png_sized(148, 74) as Uint8Array<ArrayBuffer>,
  })
  await session_snapshot_and_publish(directory, id, String(document_hash))

  // A person's name wins over the agent's title, and outlives a restart with everything else.
  const renamed = await cli(
    directory, 'session-rename', '--session', id, '--name', 'Mine', '--json',
  )
  expect(renamed.json).toMatchObject({ code: 'session_renamed', session: { name: 'Mine' } })
  await cli(directory, 'stop', '--json')
  await cli(directory, 'start', '--no-open', '--json', '--port', String(port))
  expect(await board_status()).toMatchObject({
    session: id, session_name: 'Mine', shapes_count: 1, cleaned_revision: 1,
  })
  expect(await status_json(directory)).toMatchObject({ shapes_count: 0, cleaned_revision: 0 })

  const unknown = await cli(directory, 'status', '--session', 'ffffffffffffffff', '--json')
  expect(unknown.json).toMatchObject({ code: 'unknown_session',
    next_action: { action: 'run', command: 'tldraw-sync session-list --json' } })
  expect((await cli(directory, 'fetch', '--session', '../x', '--json')).json.code)
    .toBe('usage_error')
  const restore = await cli(
    directory, 'cleanup-restore', '--session', id, '--base-revision', '1', '--json',
  )
  expect(restore.json).toMatchObject({ code: 'nothing_to_restore' })
}, 60_000)

// A snapshot of one board, its output kept apart from the default board's, and its diagram
// refused by the default board but published, and titled, on its own.
async function session_snapshot_and_publish(directory: string, id: string, hash: string) {
  const fetched = await cli(directory, 'fetch', '--session', id, '--no-open', '--json')
  expect(fetched.json).toMatchObject({ code: 'image_saved', session: id, document_hash: hash })
  expect(String(fetched.json.path)).toContain(path.join('tldraw-sync', 'sessions', id))
  const snapshot = await cli(directory, 'cleanup-snapshot', '--session', id, '--no-open', '--json')
  expect(snapshot.json).toMatchObject({ session: id, title_wanted: true, snapshot: hash })
  expect(String(snapshot.json.path)).toContain(path.join('sessions', id, 'cleanup'))
  expect(String(snapshot.json.prompt)).toContain(`"session": "${id}"`)
  expect(String(snapshot.json.prompt)).toContain('no name yet')
  expect(String(snapshot.json.publish_command)).toContain(`--session ${id}`)

  const file = path.join(directory, 'board-proposal.json')
  fs.writeFileSync(file, JSON.stringify({
    ...proposal_example(hash, 0), session: id, title: 'Order flow',
  }))
  const wrong = await cli(directory, 'cleanup-publish', '--session', 'default', '--file', file,
    '--json')
  expect(wrong.exit_code).toBe(5)
  expect(wrong.json).toMatchObject({ code: 'session_mismatch',
    next_action: { action: 'run', command: 'tldraw-sync cleanup-snapshot --json' } })
  const published = await cli(directory, 'cleanup-publish', '--file', file, '--json')
  expect(published.json).toMatchObject({
    code: 'published', session: id, revision: 1, title_applied: true,
  })
  const listed = await cli(directory, 'session-list', '--json')
  expect(listed.json.sessions).toContainEqual(expect.objectContaining({
    id, name: 'Order flow', named_by: 'agent',
  }))
  fs.rmSync(path.dirname(String(fetched.json.path)), { recursive: true, force: true })
}
