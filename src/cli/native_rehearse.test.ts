// The native rehearsal as a person runs it, in separate processes: a linked legacy board is
// served and linked by the real command line, stopped and copied; the copy is rehearsed; then
// the native copy and the untouched source are each served again. The same binding file edits
// the native copy with whiteboard-edit, and still finds the source a board with an Agent canvas.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { whiteboard_protocol } from '../shared/whiteboard'
import {
  legacy_board_write,
  rehearsal_owner,
} from '../../tests/fixtures/native-rehearsal/legacy_board'
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

function rehearse(data: string, source: string, session: string, out: string): Promise<Run> {
  const args = ['--source', source, '--session', session, '--out', out, '--json']
  return cli(data, 'native-rehearse', ...args)
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

test('a rehearsed copy serves natively, same binding; the source still serves', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-rehearse-cli-')))
  folders.push(parent)
  const [source, copy, native, live] = ['source', 'copy', 'native', 'live'].map((name) =>
    path.join(parent, name),
  ) as [string, string, string, string]
  fs.mkdirSync(live)
  const { session } = legacy_board_write(source)

  // The host links the board it already owns: the same board, with an Agent canvas.
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
  expect(link.json).toMatchObject({ code: 'linked', session })
  const token = JSON.parse(fs.readFileSync(binding, 'utf8')).token as string
  expect((await cli(source, 'stop', '--json')).json.code).toBe('stopped')
  fs.cpSync(source, copy, { recursive: true })
  expect(fs.statSync(path.join(copy, 'whiteboard.key')).mode & 0o777).toBe(0o600)

  // Run from the data directory in use, the copy is refused; a relative path is a usage error.
  const refused = await rehearse(copy, copy, session, native)
  expect(refused.json).toMatchObject({ status: 'failure', code: 'source_live', exit_code: 1 })
  const usage = await rehearse(live, 'copy', session, native)
  expect(usage.json).toMatchObject({ code: 'usage_error' })

  const rehearsed = await rehearse(live, copy, session, native)
  expect(rehearsed.exit_code).toBe(0)
  expect(rehearsed.json).toMatchObject({
    status: 'success',
    code: 'rehearsed',
    session,
    output_directory: native,
    agent_records_count: 9,
    native: true,
  })
  expect(rehearsed.stdout).not.toContain(token)
  const again = await rehearse(live, copy, session, native)
  expect(again.json).toMatchObject({ code: 'output_exists', exit_code: 1 })

  await native_edit_check(native, binding, parent)
  await source_check(copy, binding)
}, 90_000)

// The copy is served as a native board, read and edited through the binding of the source.
async function native_edit_check(native: string, binding: string, parent: string) {
  await serve(native)
  const scene_file = path.join(parent, 'private', 'scene.json')
  const read = await cli(
    native,
    'whiteboard-scene',
    '--binding',
    binding,
    '--out',
    scene_file,
    '--json',
  )
  expect(read.json).toMatchObject({ code: 'scene_read', base_sequence: 1, records_count: 12 })
  const scene = JSON.parse(fs.readFileSync(scene_file, 'utf8')) as Json
  const record = (id: string) => (scene.records as Json[]).find((candidate) => candidate.id === id)!
  const hill = record('shape:hill')
  const api = record('shape:scene-api')
  expect(hill.props.color).toBe('blue')
  expect(api.props.color).toBe('green')

  // One edit moves the agent's box and recolours the person's stroke: both are native now.
  const edit = {
    base_sequence: scene.base_sequence,
    adds: [],
    deletes: [],
    updates: [
      { record: { ...api, x: api.x + 50 }, base_hash: scene.hashes[api.id] },
      {
        record: { ...hill, props: { ...hill.props, color: 'orange' } },
        base_hash: scene.hashes[hill.id],
      },
    ],
  }
  const edit_file = path.join(parent, 'private', 'edit.json')
  fs.writeFileSync(edit_file, JSON.stringify(edit), { mode: 0o600 })
  const written = await cli(
    native,
    'whiteboard-edit',
    '--binding',
    binding,
    '--file',
    edit_file,
    '--json',
  )
  expect(written.json).toMatchObject({ code: 'edit_written', sequence: 1 })

  const after = await cli(
    native,
    'whiteboard-scene',
    '--binding',
    binding,
    '--out',
    scene_file,
    '--json',
  )
  expect(after.json).toMatchObject({ base_sequence: 2 })
  const changed = JSON.parse(fs.readFileSync(scene_file, 'utf8')) as Json
  const moved = (changed.records as Json[]).find((candidate) => candidate.id === api.id)!
  expect(moved.x).toBe(api.x + 50)
  const recoloured = (changed.records as Json[]).find((candidate) => candidate.id === hill.id)!
  expect(recoloured.props.color).toBe('orange')
}

// The source copy is still the board it was: an Agent canvas at its revision, the same owner.
async function source_check(copy: string, binding: string) {
  await serve(copy)
  const scene = await cli(copy, 'whiteboard-scene', '--binding', binding, '--json')
  expect(scene.json).toMatchObject({ status: 'failure', code: 'not_native' })
  const session = JSON.parse(fs.readFileSync(binding, 'utf8')).session as string
  const status = await cli(copy, 'status', '--session', session, '--json')
  expect(status.json).toMatchObject({ code: 'running', agent_revision: 2, shapes_count: 2 })
}
