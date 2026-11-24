// The command line as an agent uses it: separate processes, JSON out, exit codes. Each test
// works on a data directory of its own, so the board in daily use is never touched.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test_pen_draw } from '../simulation/test_pen'
import { port_any, port_free } from './board_process'
import { port_pick } from './commands'

const entry = path.join(import.meta.dir, 'main.ts')
const directories: string[] = []
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])

type Run = { exit_code: number; json: Record<string, unknown>; stdout: string }

async function cli(directory: string, ...args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, BOARD_DATA_DIR: directory },
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

async function status_json(directory: string): Promise<Record<string, unknown>> {
  return (await cli(directory, 'status', '--json')).json
}
