// A native stage of a whole data directory on real folders: every kind of board, made by the
// board's own code (`tests/fixtures/native-stage/mixed_root.ts`), then staged. The verdicts
// are the folders themselves, byte for byte, and the stage as the server opens it. Every
// refusal and every reason to stop leaves the source exactly as it was and no output behind.
// Faults injected while the stage is written prove its own check catches lost content.

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { board_default_id } from '../shared/board_session'
import { time_real } from '../shared/time'
import { sketch_strokes } from '../../tests/fixtures/native-rehearsal/legacy_board'
import { canvas_publish, sketch_write } from '../../tests/fixtures/native-rehearsal/legacy_board'
import { mixed_root_write, type MixedRoot } from '../../tests/fixtures/native-stage/mixed_root'
import { BoardRegistry } from './board_registry'
import { native_stage, tree_digest, type StageOptions, type StageResult } from './native_stage'
import { disk_open, session_storage } from './storage'
import { machine_key } from './whiteboard_keys'

type Json = Record<string, any>

const folders: string[] = []
const entries_count_max = 256

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.chmodSync(folder, 0o700)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

type At = {
  readonly parent: string
  readonly source: string
  readonly out: string
  readonly live: string
  readonly boards: MixedRoot
}

function folder_create(): string {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-stage-')))
  folders.push(folder)
  return folder
}

async function fixture(): Promise<At> {
  const parent = folder_create()
  const source = path.join(parent, 'source')
  const live = path.join(parent, 'live')
  fs.mkdirSync(live)
  const boards = await mixed_root_write(source)
  return { parent, source, out: path.join(parent, 'native'), live, boards }
}

function stage(at: At, changes: Partial<StageOptions> = {}): StageResult {
  let next = 0

  return native_stage({
    source_directory: at.source,
    output_directory: at.out,
    live_directory: at.live,
    id_create: () => (++next).toString(16).padStart(16, 'a'),
    ...changes,
  })
}

// Every entry under `root`, with its mode and, for a file, a digest of its bytes.
function tree(root: string): Record<string, string> {
  const found: Record<string, string> = {}
  const pending = ['']

  while (pending.length > 0) {
    const relative = pending.pop() as string
    const stat = fs.lstatSync(path.join(root, relative))
    const mode = (stat.mode & 0o7777).toString(8)

    if (Object.keys(found).length > entries_count_max) throw new Error('the tree is bounded')

    if (stat.isSymbolicLink()) {
      found[relative] = `link ${fs.readlinkSync(path.join(root, relative))}`
    } else if (stat.isDirectory()) {
      found[`${relative}/`] = mode

      for (const name of fs.readdirSync(path.join(root, relative))) {
        pending.push(path.join(relative, name))
      }
    } else {
      const bytes = fs.readFileSync(path.join(root, relative))
      found[relative] = `${mode} ${createHash('sha256').update(bytes).digest('hex')}`
    }
  }

  return found
}

function registry_open(root: string): BoardRegistry {
  return BoardRegistry.open({
    time: time_real,
    disk: disk_open(root),
    ...session_storage(root),
    id_create: () => '0123456789abcdef',
  })
}

function board_of(registry: BoardRegistry, session: string) {
  const lookup = registry.board(session)

  if (lookup.kind !== 'board') throw new Error(`the board did not open: ${lookup.kind}`)

  return lookup.board
}

function board_file(root: string, session: string, name: string): string {
  return session === board_default_id
    ? path.join(root, name)
    : path.join(root, 'sessions', session, name)
}

test('every board of a mixed root is staged native; the source stays as it was', async () => {
  const at = await fixture()
  const before = tree(at.source)
  const result = stage(at)

  if (result.kind !== 'staged') throw new Error(JSON.stringify(result))

  expect(tree(at.source)).toEqual(before)
  expect(fs.readdirSync(at.parent).sort()).toEqual(['live', 'native', 'source'])
  expect(result.boards.map((board) => [board.session, board.kind, board.linked])).toEqual([
    [board_default_id, 'converted', false],
    [at.boards.linked, 'converted', true],
    [at.boards.unlinked, 'converted', false],
    [at.boards.native, 'native', true],
    [at.boards.empty, 'empty', false],
  ])
  const [original, linked, unlinked, native, empty] = result.boards
  const archived = { agent_records_count: 9, agent_revision: 2, agent_history_count: 1 }
  expect(original).toMatchObject({ ...archived, agent_archived: true, chat_events_count: 1 })
  expect(linked).toMatchObject({ ...archived, agent_archived: true, chat_events_count: 1 })
  expect(unlinked).toMatchObject({ agent_revision: 1, view_controls_count: 3 })
  expect(native).toMatchObject({ native_sequence_next: 2, agent_archived: false })
  expect(empty).toMatchObject({ records_count: 0, native_sequence_next: null })
  expect(result).toMatchObject({ registry_carried: true, key_carried: true })
  expect(result.operational_skipped).toEqual(['server.log'])
  expect(fs.existsSync(path.join(at.out, 'server.log'))).toBe(false)
  expect(result.source_digest).toBe(tree_digest(at.source)!)
  expect(result.staged_digest).toBe(tree_digest(at.out)!)

  // Private all the way down; the key, chats, images and archives are the source's bytes.
  const copied = tree(at.out)

  for (const [entry, value] of Object.entries(copied)) {
    expect([entry, value.split(' ')[0]]).toEqual([entry, entry.endsWith('/') ? '700' : '600'])
  }

  expect(copied['whiteboard.key']).toBe(before['whiteboard.key']!)
  expect(copied['sessions.registry']).toBe(before['sessions.registry']!)

  for (const session of [board_default_id, at.boards.linked, at.boards.unlinked]) {
    const of = (name: string) => path.relative(at.source, board_file(at.source, session, name))
    expect(copied[of('events.state')]).toBe(before[of('events.state')])
    expect(copied[of('agent_canvas.archive')]).toBe(before[of('cleaned.state')]!)
    expect(copied[of('cleaned.state')]).toBeUndefined()
  }

  const journal = path.join('sessions', at.boards.native, 'native.journal')
  expect(copied[journal]).toBe(before[journal]!)
  expect(copied[path.join('sessions', at.boards.empty, 'native.journal')]).toBeDefined()
  reopen_check(at)
})

// The stage as the server opens it, against the source as the server opens it.
function reopen_check(at: At): void {
  const source = registry_open(at.source)
  const staged = registry_open(at.out)

  try {
    expect(staged.list()).toEqual(source.list())

    for (const { id } of source.list()) {
      expect([id, staged.owner(id)]).toEqual([id, source.owner(id)])
    }

    for (const session of [board_default_id, at.boards.linked, at.boards.unlinked]) {
      converted_check(board_of(source, session), board_of(staged, session))
    }

    const native = board_of(staged, at.boards.native).native!
    const native_source = board_of(source, at.boards.native).native!
    expect(native.scene_read()).toEqual(native_source.scene_read())
    expect(native.scene_read().records.some((record) => record.id === 'shape:sun')).toBe(true)

    const empty = board_of(staged, at.boards.empty)
    expect(empty.native!.scene_read().records.map((record) => record.typeName)).toEqual(['page'])
  } finally {
    source.close()
    staged.close()
  }
}

// Every sketch stroke exact; every record of the Agent canvas as shown now, hidden views
// included, in the scene; shapes on the page keep their order under the sketch; the chat whole.
function converted_check(
  original: ReturnType<typeof board_of>,
  native: ReturnType<typeof board_of>,
): void {
  expect(original.native).toBeNull()
  const records = native.native!.scene_read().records as unknown as Json[]
  const by_id = new Map(records.map((record) => [record.id, record]))

  for (const stroke of sketch_strokes) expect(by_id.get(stroke.id)).toEqual(stroke as Json)

  const rest = original.cleaned_view(null)

  if (rest.kind !== 'view') throw new Error('the legacy view at rest was refused')

  expect(native.events.chat()).toEqual(original.events.chat())
  expect(native.cleaned_status()).toMatchObject({ revision: 0, current: null, history: [] })

  // Each view's shapes are checked view by view in `native_rehearsal.test.ts`; here, that
  // what the rest view hides came too, with the view it belongs to.
  if (rest.view.controls.length > 0) {
    for (const record of rest.view.records) expect(by_id.has(record.id)).toBe(true)

    expect(by_id.get('shape:scene-snow')!.meta.view).toBeDefined()
    return
  }

  const page = (rest.view.records as Json[]).filter((record) => record.parentId === 'page:page')
  const ordered = [...page].sort((a, b) => (a.index < b.index ? -1 : 1))
  const indices = ordered.map((record) => by_id.get(record.id)!.index as string)
  expect(indices.length).toBeGreaterThan(0)
  expect([...indices].sort()).toEqual(indices)
  expect(indices.every((index) => index < 'a1')).toBe(true)

  for (const record of rest.view.records as Json[]) {
    const placed = by_id.get(record.id)
    expect(placed).toBeDefined()
    const { index: _placed, meta: _meta, ...kept } = placed!
    const { index: _index, meta: _rest, ...shown } = record
    expect(kept).toEqual(shown)
  }
}

test('every reason to stop is listed by name, with nothing written or disclosed', async () => {
  const at = await fixture()
  const registry = registry_open(at.source)

  try {
    const board = board_of(registry, at.boards.linked)
    const stamp = Date.now().toString(16).padStart(12, '0')
    const request = {
      request_id: `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7aaa-8000-000000000009`,
      text: 'secret chat words',
      include_sketch: false,
    }
    expect(typeof board.queue_event(null, request)).not.toBe('string')
  } finally {
    registry.close()
  }

  const secret = { mode: 0o600 }
  fs.writeFileSync(board_file(at.source, at.boards.unlinked, 'ideas.state'), 'secret idea', secret)
  fs.writeFileSync(path.join(at.source, 'notes.txt'), 'secret note', secret)
  fs.mkdirSync(path.join(at.source, 'sessions', 'ffffffffffffffff'))
  const before = tree(at.source)
  const result = stage(at)

  if (result.kind !== 'blocked') throw new Error(JSON.stringify(result))

  expect(result.boards_count).toBe(5)
  const found = result.blockers.map(({ kind, session, file }) => [kind, session, file])
  expect(found).toEqual([
    ['root_unsupported', null, 'notes.txt'],
    ['board_unlisted', null, 'ffffffffffffffff'],
    ['board_outstanding', at.boards.linked, 'events.state'],
    ['board_unsupported', at.boards.unlinked, 'ideas.state'],
  ])
  expect(JSON.stringify(result)).not.toContain('secret')
  untouched_check(at, before)
})

type Stop = readonly [name: string, kind: string, prepare: (at: At) => Partial<StageOptions>]

// Each unsafe folder is refused, and each unsafe source blocked, before anything is written.
const stops: readonly Stop[] = [
  ['the data directory in use', 'source_live', (at) => ({ live_directory: at.source })],
  ['an output inside the source', 'output_alias', (at) => out(path.join(at.source, 'n'))],
  ['an output in the live folder', 'output_alias', (at) => out(path.join(at.live, 'n'))],
  ['an output through a link', 'output_alias', (at) => output_linked(at)],
  ['an existing output', 'output_exists', (at) => folder_make(at.out)],
  ['a missing source', 'source_missing', (at) => ({ source_directory: path.join(at.parent, 'x') })],
  ['a running board', 'source_active', (at) => server_claim(at)],
  [
    'a public key',
    'blocked key_unsafe',
    (at) => chmod(path.join(at.source, 'whiteboard.key'), 0o644),
  ],
  [
    'a damaged registry',
    'blocked registry_damaged',
    (at) => byte_flip(path.join(at.source, 'sessions.registry')),
  ],
  [
    'a damaged sketch',
    'blocked board_damaged',
    (at) => byte_flip(board_file(at.source, 'default', 'board.snapshot')),
  ],
  ['a leftover partial', 'blocked board_unsupported', (at) => file_make(at, 'board.snapshot.tmp')],
  ['a linked board folder', 'blocked board_damaged', (at) => board_folder_linked(at)],
]

for (const [name, kind, prepare] of stops) {
  test(`stopped before writing: ${name}`, async () => {
    const at = await fixture()
    const changes = prepare(at)
    const before = tree(at.source)
    const outputs = fs.readdirSync(at.parent).sort()
    const result = stage(at, changes)
    const found =
      result.kind === 'blocked'
        ? `blocked ${result.blockers.map((reason) => reason.kind).join(' ')}`
        : result.kind
    expect(found).toBe(kind)
    untouched_check(at, before, outputs)
  })
}

// Faults injected into the stage while it is written, after the preflight passed. Each must be
// caught by the stage's own check and leave no output, not even a partial one.
type Fault = readonly [name: string, kind: string, message: RegExp, fault: (at: At) => void]

const faults: readonly Fault[] = [
  [
    'a changed archive',
    'output_failed',
    /agent_canvas\.archive of board default differs/,
    (at) => byte_flip(path.join(staging_of(at), 'agent_canvas.archive')),
  ],
  [
    'a lost Agent canvas',
    'output_failed',
    /scene of board default differs/,
    (at) =>
      fs.copyFileSync(
        path.join(at.source, 'board.snapshot'),
        path.join(staging_of(at), 'board.snapshot'),
      ),
  ],
  [
    'a stray file',
    'output_failed',
    /an entry no board planned/,
    (at) => fs.writeFileSync(path.join(staging_of(at), 'stray'), 'x', { mode: 0o600 }),
  ],
  [
    'a public file',
    'output_failed',
    /events\.state is not private/,
    (at) => fs.chmodSync(path.join(staging_of(at), 'events.state'), 0o644),
  ],
  [
    'a source change',
    'source_changed',
    /changed during the stage/,
    (at) => fs.writeFileSync(board_file(at.source, at.boards.linked, 'drawing.image'), 'x'),
  ],
  [
    'a failed write',
    'output_failed',
    /ENOSPC/,
    () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    },
  ],
]

for (const [name, kind, message, fault] of faults) {
  test(`caught by the stage's check: ${name}`, async () => {
    const at = await fixture()
    const before = tree(at.source)
    const outputs = fs.readdirSync(at.parent).sort()
    let calls = 0
    const result = stage(at, {
      id_create: () => {
        calls += 1

        if (calls === 1) fault(at)

        return calls.toString(16).padStart(16, 'b')
      },
    })
    expect([result.kind, (result as { message?: string }).message]).toEqual([
      kind as StageResult['kind'],
      expect.stringMatching(message),
    ])
    expect(fs.readdirSync(at.parent).sort()).toEqual(outputs)

    if (kind !== 'source_changed') expect(tree(at.source)).toEqual(before)
  })
}

// The same source stages cleanly after each fault: nothing was left to trip over.
test('a stage after a failed one succeeds, and the output is never overwritten', async () => {
  const at = await fixture()
  const failed = stage(at, {
    id_create: () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    },
  })
  expect(failed.kind).not.toBe('staged')
  expect(stage(at).kind).toBe('staged')
  const digest = tree_digest(at.out)
  expect(stage(at).kind).toBe('output_exists')
  expect(tree_digest(at.out)).toBe(digest)
})

// A data directory from before sessions holds only the original board and no registry.
test('a root from before sessions stages its one board, and still lists no registry', () => {
  const parent = folder_create()
  const source = path.join(parent, 'source')
  const disk = disk_open(source)
  machine_key(disk)
  sketch_write(disk)
  const registry = registry_open(source)
  canvas_publish(registry, board_default_id, 'hidden')
  registry.close()
  fs.mkdirSync(path.join(parent, 'live'))
  expect(fs.existsSync(path.join(source, 'sessions.registry'))).toBe(false)
  const at = { parent, source, out: path.join(parent, 'native'), live: path.join(parent, 'live') }
  const result = stage({ ...at, boards: {} as MixedRoot })

  if (result.kind !== 'staged') throw new Error(JSON.stringify(result))

  expect(result.boards).toEqual([
    expect.objectContaining({ session: board_default_id, kind: 'converted', agent_revision: 2 }),
  ])
  expect(result.registry_carried).toBe(false)
  expect(fs.existsSync(path.join(at.out, 'sessions.registry'))).toBe(false)
  const staged = registry_open(at.out)

  try {
    expect(staged.list().map((session) => session.id)).toEqual([board_default_id])
    expect(board_of(staged, board_default_id).native).not.toBeNull()
  } finally {
    staged.close()
  }
})

function untouched_check(at: At, before: Record<string, string>, outputs?: string[]): void {
  expect(tree(at.source)).toEqual(before)
  const listed = fs.readdirSync(at.parent).sort()
  expect(listed).toEqual(outputs ?? ['live', 'source'])
}

function staging_of(at: At): string {
  const name = fs.readdirSync(at.parent).find((entry) => entry.startsWith('.native.stage-'))

  if (name === undefined) throw new Error('no staging folder is being written')

  return path.join(at.parent, name)
}

function out(output_directory: string): Partial<StageOptions> {
  return { output_directory }
}

function output_linked(at: At): Partial<StageOptions> {
  fs.symlinkSync(at.source, path.join(at.parent, 'into'))
  return out(path.join(at.parent, 'into', 'n'))
}

function folder_make(folder: string): Partial<StageOptions> {
  fs.mkdirSync(folder)
  return {}
}

function server_claim(at: At): Partial<StageOptions> {
  const state = JSON.stringify({ pid: process.pid, port: 4321 })
  fs.writeFileSync(path.join(at.source, 'server.json'), `${state}\n`)
  return {}
}

function chmod(file: string, mode: number): Partial<StageOptions> {
  fs.chmodSync(file, mode)
  return {}
}

function byte_flip(file: string): Partial<StageOptions> {
  const bytes = fs.readFileSync(file)
  bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01
  fs.writeFileSync(file, bytes)
  return {}
}

function file_make(at: At, name: string): Partial<StageOptions> {
  fs.writeFileSync(board_file(at.source, at.boards.linked, name), 'left over', { mode: 0o600 })
  return {}
}

function board_folder_linked(at: At): Partial<StageOptions> {
  const folder = path.join(at.source, 'sessions', at.boards.unlinked)
  const moved = path.join(at.parent, 'moved')
  fs.renameSync(folder, moved)
  fs.symlinkSync(moved, folder)
  return {}
}
