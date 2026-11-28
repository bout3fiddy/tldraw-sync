// A native stage as a person runs it, in separate processes: a data directory holding every
// kind of board is served and linked by the real command line, stopped and copied; the copy is
// staged; then the stage is served. Every board is listed and native, and the binding file of
// the source reads the linked board's shared scene. A copy with a stray file is blocked.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { whiteboard_protocol } from '../shared/whiteboard'
import { rehearsal_owner } from '../../tests/fixtures/native-rehearsal/legacy_board'
import { mixed_root_write } from '../../tests/fixtures/native-stage/mixed_root'
import { port_any } from './board_process'

const entry = path.join(import.meta.dir, 'main.ts')
const folders: string[] = []
const served: string[] = []

type Json = Record<string, any>
type Run = { exit_code: number; json: Json; stdout: string }

async function cli(data: string, ...args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, BOARD_DATA_DIR: data, TMPDIR: os.tmpdir() },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const exit_code = await child.exited
  const json = args.includes('--json') ? (JSON.parse(stdout) as Json) : {}
  return { exit_code, json, stdout }
}

function stage(data: string, source: string, out: string): Promise<Run> {
  return cli(data, 'native-stage', '--source', source, '--out', out, '--json')
}

async function serve(data: string): Promise<void> {
  const port = String(port_any())
  served.push(data)
  const started = await cli(data, 'start', '--no-open', '--port', port, '--json')
  expect(started.json).toMatchObject({ status: 'success', code: 'started' })
}

afterEach(async () => {
  for (const data of served.splice(0)) await cli(data, 'stop', '--json')

  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true })
})

test('a staged root serves every board natively; a stray file blocks the stage', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-stage-cli-')))
  folders.push(parent)
  const [source, copy, stray, native, live] = ['source', 'copy', 'stray', 'native', 'live'].map(
    (name) => path.join(parent, name),
  ) as [string, string, string, string, string]
  fs.mkdirSync(live)
  const boards = await mixed_root_write(source)

  // The host links the board it already owns, then the board is stopped and copied.
  await serve(source)
  const binding = path.join(parent, 'private', 'binding.json')
  const link = await cli(
    source,
    'whiteboard-link',
    '--protocol',
    String(whiteboard_protocol),
    '--owner',
    rehearsal_owner,
    '--out',
    binding,
    '--json',
  )
  expect(link.json).toMatchObject({ code: 'linked', session: boards.linked })
  const token = JSON.parse(fs.readFileSync(binding, 'utf8')).token as string
  expect((await cli(source, 'stop', '--json')).json.code).toBe('stopped')
  served.splice(0)
  fs.cpSync(source, copy, { recursive: true })
  fs.cpSync(source, stray, { recursive: true })
  fs.writeFileSync(path.join(stray, 'notes.txt'), 'private words', { mode: 0o600 })

  const blocked = await stage(live, stray, native)
  expect(blocked.json).toMatchObject({
    status: 'failure',
    code: 'blocked',
    exit_code: 1,
    boards_count: 5,
    blockers: [{ kind: 'root_unsupported', session: null, file: 'notes.txt' }],
  })
  expect(blocked.stdout).not.toContain('private words')
  expect(fs.existsSync(native)).toBe(false)
  expect((await stage(copy, copy, native)).json).toMatchObject({ code: 'source_live' })

  const staged = await stage(live, copy, native)
  expect(staged.exit_code).toBe(0)
  expect(staged.json).toMatchObject({
    status: 'success',
    code: 'staged',
    output_directory: native,
    boards_count: 5,
    native: true,
    activated: false,
  })
  expect(staged.stdout).not.toContain(token)
  expect((await stage(live, copy, native)).json).toMatchObject({ code: 'output_exists' })
  await staged_serve_check(native, binding, staged.json, boards.linked)
}, 90_000)

async function staged_serve_check(native: string, binding: string, report: Json, linked: string) {
  await serve(native)
  const listed = await cli(native, 'session-list', '--json')
  const ids = (report.boards as Json[]).map((board) => board.session)
  expect((listed.json.sessions as Json[]).map((session) => session.id)).toEqual(ids)

  // The source's binding reads the linked board's shared scene: sketch and Agent canvas.
  const scene_file = path.join(path.dirname(binding), 'scene.json')
  const read = await cli(
    native,
    'whiteboard-scene',
    '--binding',
    binding,
    '--out',
    scene_file,
    '--json',
  )
  expect(read.json).toMatchObject({ code: 'scene_read', session: linked, base_sequence: 1 })
  const scene = JSON.parse(fs.readFileSync(scene_file, 'utf8')) as Json
  const records = scene.records as Json[]
  expect(records.find((record) => record.id === 'shape:hill')!.props.color).toBe('blue')
  expect(records.find((record) => record.id === 'shape:scene-api')!.props.color).toBe('green')
}
