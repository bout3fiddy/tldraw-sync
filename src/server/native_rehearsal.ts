// A native rehearsal: one linked board with an Agent canvas, from a copy of a stopped data
// directory, made into a separate native working copy under the same session id. It is a dry
// run of a migration, explicit and offline, and reversible by deleting the copy.
//
// The source is only read. Every read goes through a disk that refuses writes, so a board that
// would need an upgrade written on open is refused rather than changed, and the files read are
// fingerprinted before and after to prove it. The copy holds a registry listing only this
// board, under the same owner, the same private machine key, the room with the Agent canvas
// merged in (`native_rehearsal_plan.ts`), a new native journal, the chat journal byte for byte,
// and the Agent canvas file byte for byte as `agent_canvas.archive`, so its revisions survive.
//
// An Agent canvas whose current revision has views is carried with every view: each device of
// the copy chooses its own, as it did on the print (`native_rehearsal_plan.ts`).
//
// Everything is refused before anything is written: a running daemon, the data directory in
// daily use, the original board, an unlinked, native or damaged board, an open chat request,
// an unsafe key, and an output that exists or overlaps either directory. The copy
// is written into a private staging folder beside the output, reopened as a native board and
// compared record by record, then renamed into place in one step. A failure removes the
// staging folder, so the output path holds a complete verified copy or nothing.

import type { TLRecord } from '@tldraw/tlschema'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assert, AssertionError } from '../shared/assert'
import { board_default_id, board_id_pattern, type BoardSession } from '../shared/board_session'
import { view_controls_key } from '../shared/native_views'
import type { SceneControl } from '../shared/scene_controls'
import { time_real } from '../shared/time'
import { BoardEvents } from './board_events'
import { BoardRegistry, registry_encode, registry_read, type RegistryState } from './board_registry'
import type { Json } from './canvas_state'
import { Cleaned } from './cleaned'
import { NativeScene } from './native_scene'
import { record_hash, room_view_create, type SceneRecord } from './native_scene_ledger'
import { canvas_views_records, room_plan, type RoomSaved } from './native_rehearsal_plan'
import { process_alive, server_state_read } from './server_state'
import {
  disk_open,
  envelope_decode,
  envelope_encode,
  session_storage,
  StorageError,
  type Disk,
  type FileName,
} from './storage'

export type RehearsalOptions = {
  readonly source_directory: string
  readonly session: string
  readonly output_directory: string

  // The data directory in daily use. It is never a source, and never holds the output.
  readonly live_directory: string

  // A new random room epoch for the copy's native journal.
  readonly id_create: () => string
}

export type RehearsalRefusalKind =
  | 'source_missing'
  | 'source_live'
  | 'source_active'
  | 'source_changed'
  | 'board_default'
  | 'board_not_found'
  | 'board_not_linked'
  | 'board_native'
  | 'board_damaged'
  | 'board_unsupported'
  | 'board_ambiguous'
  | 'board_outstanding'
  | 'key_unsafe'
  | 'output_exists'
  | 'output_alias'
  | 'output_failed'

export type RehearsalRefusal = {
  readonly kind: RehearsalRefusalKind
  readonly message: string
}

export type Rehearsed = {
  readonly kind: 'rehearsed'
  readonly session: string
  readonly output_directory: string
  readonly sketch_records_count: number
  readonly agent_records_count: number
  readonly agent_revision: number
  readonly agent_history_count: number
  readonly chat_events_count: number

  // Controls of the views carried; 0 for a canvas of one view.
  readonly view_controls_count: number
}

export type RehearsalResult = Rehearsed | RehearsalRefusal

type Paths = { readonly source: string; readonly output: string; readonly parent: string }

// What was read from the source, all of it before anything is written.
type SourceRead = {
  readonly session: BoardSession
  readonly owner: string
  readonly allocation: RegistryState['allocation']
  readonly key: Uint8Array
  readonly room: RoomSaved
  readonly canvas_records: readonly { id: string; typeName: string }[]
  readonly controls: readonly SceneControl[]
  readonly canvas_bytes: Uint8Array | null
  readonly carried: ReadonlyMap<FileName, Uint8Array>
  readonly agent_revision: number
  readonly agent_history_count: number
  readonly chat_events_count: number
  readonly files: readonly string[]

  // The fingerprint of `files` before any of them was read.
  readonly before: string
}

class SourceWriteRefused extends Error {}

// What a board folder may hold to be rehearsed. Anything else is refused by name, so nothing a
// later version adds is silently left behind. The image and frame are derived and carried as is.
const board_files_carried = ['events.state', 'drawing.image', 'drawing.frame'] as const
const board_files_known = ['board.snapshot', 'cleaned.state', ...board_files_carried]
const board_entries_count_max = 64
const board_label = '-'
const room_epoch_check = 'rehearsal'

export function native_rehearse(options: RehearsalOptions): RehearsalResult {
  assert(path.isAbsolute(options.source_directory), 'the source is an absolute path')
  assert(path.isAbsolute(options.output_directory), 'the output is an absolute path')

  if (options.session === board_default_id) {
    return refusal('board_default', 'The original board shares its folder: it is not rehearsed.')
  }

  assert(board_id_pattern.test(options.session), 'the session was validated')
  const paths = paths_check(options)

  if ('kind' in paths) return paths

  if (source_running(paths.source)) {
    return refusal('source_active', 'A board is running on the source. Stop it and copy again.')
  }

  const source = source_read(paths.source, options.session)

  if ('kind' in source) return source

  const plan = room_plan(source.room, source.canvas_records, source.controls)

  if (!plan.ok) return refusal(plan.kind, plan.message)

  const result = staged({ paths, source, snapshot: plan.snapshot, agent: plan.agent, options })
  assert(result.kind !== 'rehearsed' || result.session === options.session, 'same identity')
  return result
}

function paths_check(options: RehearsalOptions): Paths | RehearsalRefusal {
  const source = directory_real(options.source_directory)

  if (source === null) return refusal('source_missing', 'The source data directory is missing.')

  const live = directory_real(options.live_directory)

  if (live === source) {
    const message = 'Rehearse on a copy of a stopped data directory, never the one in use.'
    return refusal('source_live', message)
  }

  const parent = directory_real(path.dirname(options.output_directory))

  if (parent === null) return refusal('output_alias', 'The output must be in an existing folder.')

  const output = path.join(parent, path.basename(options.output_directory))

  if (entry_exists(options.output_directory) || entry_exists(output)) {
    return refusal('output_exists', 'The output already exists. Name a new folder.')
  }

  for (const other of [source, live]) {
    if (other !== null && paths_overlap(output, other)) {
      const message = 'The output must be outside the source and the data directory in use.'
      return refusal('output_alias', message)
    }
  }

  assert(path.isAbsolute(output) && path.dirname(output) === parent, 'the output is resolved')
  assert(output !== source, 'the output is never the source')
  return { source, output, parent }
}

function source_read(root: string, session: string): SourceRead | RehearsalRefusal {
  assert(path.isAbsolute(root), 'the source is named absolutely')

  try {
    const disk = disk_read_only(disk_open(root))
    const listed = registry_find(disk, session)

    if ('kind' in listed) return listed

    const directory = path.join(root, 'sessions', session)
    const names = board_names(directory)

    if (!Array.isArray(names)) return names

    // Taken before the board is read: a change from here on is caught before the rename.
    const files = [
      path.join(root, 'sessions.registry'),
      path.join(root, 'whiteboard.key'),
      ...names.map((name) => path.join(directory, name)),
    ]
    const before = fingerprint(files)
    const key = key_read(disk)

    if (key === null) {
      return refusal('key_unsafe', 'The machine key must be private to you (mode 600).')
    }

    const board = board_read(disk_read_only(session_storage(root).disk_board(session)))

    if ('kind' in board) return board

    assert(names.includes('board.snapshot'), 'a rehearsed board has its room')
    return { ...listed, ...board, key, files, before }
  } catch (error) {
    if (error instanceof AssertionError) throw error

    if (error instanceof SourceWriteRefused) {
      const message = 'The board needs an upgrade written first. Open it once, stop, copy again.'
      return refusal('board_unsupported', message)
    }

    if (error instanceof StorageError) return refusal('board_damaged', sentence(error.message))

    throw error
  }
}

type Listed = Pick<SourceRead, 'session' | 'owner' | 'allocation'>

function registry_find(disk: Disk, session: string): Listed | RehearsalRefusal {
  const bytes = disk.read('sessions.registry')

  if (bytes === null) return refusal('board_not_found', 'This data directory lists no boards.')

  const registry = registry_read(bytes)

  if (registry.pending !== null) {
    const message = 'A board deletion is unfinished here. Start and stop it, then copy again.'
    return refusal('board_ambiguous', message)
  }

  const listed = registry.sessions.find((candidate) => candidate.id === session)

  if (listed === undefined) return refusal('board_not_found', 'No board has that id here.')

  const owner = registry.owners.get(session)

  if (owner === undefined) {
    return refusal('board_not_linked', 'Only a board linked to a host is rehearsed.')
  }

  assert(listed.id === session, 'the listed board is the one asked for')
  assert(owner.length > 0, 'a read owner is not empty')
  return { session: listed, owner, allocation: registry.allocation }
}

// The machine key, read only if it is private: null for a missing or unsafe one.
function key_read(disk: Disk): Uint8Array | null {
  try {
    const key = disk.read('whiteboard.key')
    assert(key === null || key.byteLength === 64, 'a read key is complete')
    return key
  } catch (error) {
    if (error instanceof StorageError) return null

    throw error
  }
}

// The names in a board folder, each a regular file this rehearsal knows how to carry.
function board_names(directory: string): string[] | RehearsalRefusal {
  assert(path.isAbsolute(directory), 'a board folder is named absolutely')
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false })

  if (stat === undefined || !stat.isDirectory()) {
    return refusal('board_damaged', 'The board folder is missing or not a real folder.')
  }

  const names = fs.readdirSync(directory).sort()

  if (names.includes('native.journal')) {
    return refusal('board_native', 'This board is native already.')
  }

  if (names.length > board_entries_count_max) {
    return refusal('board_unsupported', 'The board folder holds too many entries.')
  }

  for (const name of names) {
    if (!board_files_known.includes(name)) {
      return refusal('board_unsupported', `The board folder holds ${name}, which is not carried.`)
    }

    if (!fs.lstatSync(path.join(directory, name)).isFile()) {
      return refusal('board_damaged', `The board file ${name} is not a regular file.`)
    }
  }

  if (!names.includes('board.snapshot')) {
    return refusal('board_damaged', 'The board has no saved sketch.')
  }

  assert(names.length <= board_entries_count_max, 'the names are bounded')
  return names
}

type BoardRead = Omit<SourceRead, keyof Listed | 'key' | 'files' | 'before'>

function board_read(disk: Disk): BoardRead | RehearsalRefusal {
  const room = room_read(disk)
  const canvas_bytes = disk.read('cleaned.state')
  const canvas = Cleaned.open(disk)
  const view = canvas.view(null)
  assert(view.kind === 'view', 'the view at rest is always valid')

  // Earlier revisions, with any views they had, stay in the archive byte for byte.
  const views = canvas.views_current()
  const canvas_records = views === null ? view.view.records : canvas_views_records(views)
  assert(views === null || canvas_records.length >= view.view.records.length, 'views only add')
  const status = canvas.status('0'.repeat(16))
  const events = BoardEvents.open(disk)

  if (events.outstanding().length > 0) {
    const message = 'A chat request is still open. End it on the board, stop, and copy again.'
    return refusal('board_outstanding', message)
  }

  const carried = new Map<FileName, Uint8Array>()

  for (const name of board_files_carried) {
    const bytes = disk.read(name)

    if (bytes !== null) carried.set(name, bytes)
  }

  return {
    room,
    canvas_records,
    controls: views?.controls ?? [],
    canvas_bytes,
    carried,
    agent_revision: status.revision,
    agent_history_count: status.history.length,
    chat_events_count: events.chat().events.length,
  }
}

function room_read(disk: Disk): RoomSaved {
  const bytes = disk.read('board.snapshot')
  assert(bytes !== null, 'the board folder was checked for its room')
  const decoded = envelope_decode(bytes, 'board')

  if (!decoded.ok) throw new StorageError(`board.snapshot is damaged: ${decoded.reason}`)

  let room: RoomSaved

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded.envelope.payload)
    room = JSON.parse(text) as RoomSaved
  } catch {
    throw new StorageError('board.snapshot is damaged: it is not JSON')
  }

  if (typeof room !== 'object' || room === null || !Array.isArray(room.documents)) {
    throw new StorageError('board.snapshot is damaged: it holds no documents')
  }

  const view = room_view_create(room, room_epoch_check)

  if (!view.ok) throw new StorageError(`board.snapshot is damaged: ${view.reason}`)

  assert(view.view.documents.size === room.documents.length, 'every record was read')
  return room
}

type Staging = {
  readonly paths: Paths
  readonly source: SourceRead
  readonly snapshot: RoomSaved
  readonly agent: readonly TLRecord[]
  readonly options: RehearsalOptions
}

function staged(staging: Staging): RehearsalResult {
  const { paths, source } = staging
  const name = `.${path.basename(paths.output)}.rehearsal-${randomUUID()}`
  const directory = path.join(paths.parent, name)
  assert(path.dirname(directory) === paths.parent, 'the staging folder is beside the output')

  try {
    fs.mkdirSync(directory, { mode: 0o700 })
    assert((fs.statSync(directory).mode & 0o077) === 0, 'the staging folder is private')
    staging_write(directory, staging)
    const problem = staging_verify(directory, staging)

    if (problem !== null) return refusal('output_failed', `The copy failed its check: ${problem}.`)

    if (fingerprint(source.files) !== source.before || source_running(paths.source)) {
      return refusal('source_changed', 'The source changed during the rehearsal. Copy it again.')
    }

    if (entry_exists(paths.output)) {
      return refusal('output_exists', 'The output appeared during the rehearsal. Name a new one.')
    }

    fs.renameSync(directory, paths.output)
    directory_sync(paths.parent)
    return rehearsed(staging)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    const reason = error instanceof StorageError ? error.message : error_code(error)
    return refusal('output_failed', `The copy could not be written: ${reason}.`)
  } finally {

    // After the rename there is nothing here; before it, a partial copy is never left behind.
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// The data directory of the copy. The registry is written last: until then no board is listed.
function staging_write(directory: string, staging: Staging): void {
  const { source } = staging
  const id = source.session.id
  fs.mkdirSync(path.join(directory, 'sessions', id), { mode: 0o700, recursive: true })
  const root = disk_open(directory)
  root.write_atomic('whiteboard.key', source.key)

  const board = session_storage(directory).disk_board(id)
  const payload = new TextEncoder().encode(JSON.stringify(staging.snapshot))
  const room = envelope_encode({ kind: 'board', label: board_label, payload })
  board.write_atomic('board.snapshot', room)

  for (const [name, bytes] of source.carried) board.write_atomic(name, bytes)

  if (source.canvas_bytes !== null) board.write_atomic('agent_canvas.archive', source.canvas_bytes)

  NativeScene.create_file(board, { room_epoch: staging.options.id_create(), id_namespace: id })
  const registry: RegistryState = {
    sessions: [source.session],
    owners: new Map([[id, source.owner]]),
    allocation: source.allocation,
    pending: null,
  }
  root.write_atomic('sessions.registry', registry_encode(registry))
  assert(root.read('whiteboard.key') !== null, 'the copy has its private key')
  assert(board.read('native.journal') !== null, 'the copy is native')
}

// Opens the copy as the server would, and compares its scene with the plan record by record.
function staging_verify(directory: string, staging: Staging): string | null {
  const { source } = staging
  const id = source.session.id
  assert(path.isAbsolute(directory), 'the staging folder is named absolutely')
  assert(fs.existsSync(path.join(directory, 'sessions.registry')), 'the copy is complete')
  const registry = BoardRegistry.open({
    time: time_real,
    disk: disk_open(directory),
    ...session_storage(directory),
    id_create: () => {
      throw new Error('a verification creates no board')
    },
  })

  try {
    if (registry.owner(id) !== source.owner) return 'the copy is linked to another owner'

    const lookup = registry.board(id)

    if (lookup.kind !== 'board') return `the copy did not open (${lookup.kind})`

    if (lookup.board.native === null) return 'the copy did not open as native'

    const records = lookup.board.native.scene_read().records
    const problem = scene_problem(records, source.room, staging.agent)

    if (problem !== null) return problem
  } finally {
    registry.close()
  }

  return files_problem(directory, source) ?? controls_problem(directory, staging)
}

// The room as the closed board left it keeps the views' controls on its document, exactly.
function controls_problem(directory: string, staging: Staging): string | null {
  const board = session_storage(directory).disk_board(staging.source.session.id)
  const controls_of = (room: RoomSaved) => {
    const states = room.documents.map((document) => document.state as Json)
    const document = states.find((state) => state.typeName === 'document')
    const meta = (document?.meta ?? {}) as Json
    return JSON.stringify(meta[view_controls_key] ?? null)
  }
  const planned = controls_of(staging.snapshot)
  assert((planned === 'null') === (staging.source.controls.length === 0), 'controls are planned')
  return controls_of(room_read(board)) === planned ? null : 'the views changed'
}

function scene_problem(
  records: readonly SceneRecord[],
  room: RoomSaved,
  agent: readonly TLRecord[],
): string | null {
  const hashes = new Map(records.map((record) => [record.id, record_hash(record)]))
  const scene_types = ['page', 'shape', 'binding']
  const sketch = room.documents
    .map((document) => document.state as SceneRecord)
    .filter((record) => scene_types.includes(record.typeName))
  const expected = [...sketch, ...(agent as unknown as SceneRecord[])]

  if (records.length !== expected.length) return 'the scene has a different number of records'

  for (const record of expected) {
    if (hashes.get(record.id) !== record_hash(record)) return `record ${record.id} changed`
  }

  assert(hashes.size === records.length, 'scene ids are unique')
  assert(expected.length >= sketch.length, 'the canvas only adds records')
  return null
}

// The chat journal and the canvas archive are the source's bytes exactly.
function files_problem(directory: string, source: SourceRead): string | null {
  assert(path.isAbsolute(directory), 'the staging folder is named absolutely')
  const board = session_storage(directory).disk_board(source.session.id)

  for (const [name, bytes] of source.carried) {
    const copied = board.read(name)

    if (copied === null || !Buffer.from(copied).equals(bytes)) return `${name} differs`
  }

  const archive = board.read('agent_canvas.archive')
  const same =
    source.canvas_bytes === null
      ? archive === null
      : archive !== null && Buffer.from(archive).equals(source.canvas_bytes)
  assert(source.carried.size <= board_files_carried.length, 'only known files are carried')
  return same ? null : 'the Agent canvas archive differs'
}

function rehearsed(staging: Staging): Rehearsed {
  const { source, paths } = staging
  const sketch_records_count = source.room.documents.length
  assert(fs.statSync(paths.output).isDirectory(), 'the copy is in place')
  assert((fs.statSync(paths.output).mode & 0o077) === 0, 'the copy is private')
  return {
    kind: 'rehearsed',
    session: source.session.id,
    output_directory: paths.output,
    sketch_records_count,
    agent_records_count: staging.agent.length,
    agent_revision: source.agent_revision,
    agent_history_count: source.agent_history_count,
    chat_events_count: source.chat_events_count,
    view_controls_count: source.controls.length,
  }
}

function disk_read_only(disk: Disk): Disk {
  return {
    read: (name) => disk.read(name),
    write_atomic: () => {
      throw new SourceWriteRefused()
    },
  }
}

function source_running(directory: string): boolean {
  assert(path.isAbsolute(directory), 'a source is named absolutely')
  const held = server_state_read(directory)
  assert(held === null || held.pid > 0, 'a read claim names a process')
  return held !== null && process_alive(held.pid)
}

// A digest of the named files' bytes and modes, or of their absence.
function fingerprint(files: readonly string[]): string {
  assert(files.length <= board_entries_count_max + 2, 'the files read are bounded')
  assert(
    files.every((file) => path.isAbsolute(file)),
    'the files read are named absolutely',
  )
  const hash = createHash('sha256')

  for (const file of files) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    hash.update(`${file}\0${stat === undefined ? 'absent' : stat.mode}\0`)

    if (stat?.isFile()) hash.update(fs.readFileSync(file))
  }

  return hash.digest('hex')
}

function directory_real(directory: string): string | null {
  assert(path.isAbsolute(directory), 'folders are named absolutely')

  try {
    const real = fs.realpathSync(directory)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function entry_exists(file: string): boolean {
  assert(path.isAbsolute(file), 'an output is named absolutely')
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined
}

function paths_overlap(a: string, b: string): boolean {
  assert(path.isAbsolute(a) && path.isAbsolute(b), 'overlap compares resolved paths')
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}

function directory_sync(directory: string): void {
  assert(path.isAbsolute(directory), 'a synced folder is named absolutely')
  const descriptor = fs.openSync(directory, 'r')

  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function error_code(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'an unexpected error'
}

function sentence(text: string): string {
  assert(text.length > 0, 'a storage error says what is wrong')
  return text.endsWith('.') ? text : `${text}.`
}

function refusal(kind: RehearsalRefusalKind, message: string): RehearsalRefusal {
  assert(message.endsWith('.'), 'a refusal is a sentence')
  assert(message.length <= 200, 'a refusal is short')
  return { kind, message }
}
