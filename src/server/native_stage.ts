// A native stage: every board of a copy of a stopped data directory, made native in one new data
// directory, offline. It is the first step towards serving native boards only, and it activates
// nothing: the stage is served only if someone points a board at it.
//
// A preflight reads the whole source through a disk that refuses writes, and lists every reason
// it cannot be staged: a retired format, an open chat request or native revision, an entry no
// board format accounts for, an unfinished deletion, a damaged file or a key that is not
// private. Each is named by its kind, board and file, never by what the file holds. With any
// reason, nothing is written. Otherwise every listed board is staged under the same id:
//
// - a legacy board, the original one included, linked or not, by the native rehearsal's own plan
//   (`native_rehearsal_plan.ts`): every room record kept, the Agent canvas as shown now joined
//   under the sketch, and its file kept byte for byte as `agent_canvas.archive`. Its earlier
//   revisions are archived there, not restorable on the native board, and reported so.
// - a native board byte for byte, its journal included.
// - a listed board with no files yet as a new native board.
//
// The registry with every name, owner and allocation, the private key, the chat journals and the
// drawing images are copied byte for byte. The stage is written into a private folder beside
// the output, reopened as the server opens it, checked board by board against the preflight,
// and renamed into place in one step; any failure removes it. The source is digested before and
// after, and never written.

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assert, AssertionError } from '../shared/assert'
import { board_default_id, board_id_pattern, type BoardSession } from '../shared/board_session'
import { board_sessions_count_max } from '../shared/constants'
import { time_real } from '../shared/time'
import { BoardEvents } from './board_events'
import { BoardRegistry, registry_read } from './board_registry'
import {
  board_read,
  directory_sync,
  disk_read_only,
  entry_exists,
  error_code,
  paths_check,
  room_read,
  source_running,
  SourceWriteRefused,
} from './native_rehearsal'
import { room_plan, type RoomSaved } from './native_rehearsal_plan'
import { journal_read, NativeScene } from './native_scene'
import {
  record_hash,
  record_hash_pattern,
  room_records_max,
  type SceneRecord,
} from './native_scene_ledger'
import {
  board_file_names,
  disk_open,
  envelope_encode,
  session_storage,
  StorageError,
  type Disk,
  type FileName,
} from './storage'

export type StageOptions = {
  readonly source_directory: string
  readonly output_directory: string

  // The data directory in daily use. It is never a source, and never holds the output.
  readonly live_directory: string

  // A new random id of sixteen hex digits: each new journal's room epoch.
  readonly id_create: () => string
}

export type StageRefusalKind =
  | 'source_missing'
  | 'source_live'
  | 'source_active'
  | 'source_changed'
  | 'output_exists'
  | 'output_alias'
  | 'output_failed'

export type BlockerKind =
  | 'root_unsupported'
  | 'registry_damaged'
  | 'registry_pending'
  | 'key_unsafe'
  | 'board_unlisted'
  | 'board_outstanding'
  | 'board_unsupported'
  | 'board_ambiguous'
  | 'board_damaged'

// One reason the source cannot be staged. `file` is a name, never a file's contents.
export type Blocker = {
  readonly kind: BlockerKind
  readonly session: string | null
  readonly file: string | null
  readonly message: string
}

export type StagedKind = 'converted' | 'native' | 'empty'

export type StagedBoard = {
  readonly session: string
  readonly linked: boolean
  readonly kind: StagedKind

  // Every record of the room as staged, sketch and Agent canvas together; 0 for a new room.
  readonly records_count: number
  readonly agent_records_count: number
  readonly agent_revision: number

  // Earlier Agent canvas revisions, kept only in `agent_canvas.archive`: never restorable.
  readonly agent_history_count: number
  readonly agent_archived: boolean
  readonly chat_events_count: number
  readonly view_controls_count: number

  // A native board's next revision sequence, carried with its journal; null for a new journal.
  readonly native_sequence_next: number | null
}

export type Staged = {
  readonly kind: 'staged'
  readonly output_directory: string
  readonly boards: readonly StagedBoard[]
  readonly registry_carried: boolean
  readonly key_carried: boolean

  // Operational files of the source's root, not board data, left out of the stage by name.
  readonly operational_skipped: readonly string[]

  // `tree_digest` of the source, unchanged throughout, and of the stage as renamed into place.
  readonly source_digest: string
  readonly staged_digest: string
}

export type StageBlocked = {
  readonly kind: 'blocked'
  readonly boards_count: number
  readonly blockers: readonly Blocker[]
}

export type StageRefusal = { readonly kind: StageRefusalKind; readonly message: string }
export type StageResult = Staged | StageBlocked | StageRefusal

// What the stage of one board must hold, as hashes, so every board can be checked at the end
// without keeping any board's bytes in memory.
type Planned = {
  readonly report: StagedBoard

  // Every room record by id, and the scene's share of them; null for a room made on open.
  readonly documents: ReadonlyMap<string, string> | null
  readonly scene: ReadonlyMap<string, string> | null

  // Files kept byte for byte, by the name they have in the stage, with their sha-256.
  readonly files: ReadonlyMap<FileName, string>
}

type Prepared = {
  readonly planned: Planned
  readonly write: (target: Disk, id_create: () => string) => void
}

type Preflight = {
  readonly sessions: readonly BoardSession[]
  readonly owners: ReadonlyMap<string, string>
  readonly registry: Uint8Array | null
  readonly key: Uint8Array | null
  readonly operational: readonly string[]
  readonly planned: readonly Planned[]
  readonly blockers: readonly Blocker[]
}

type Paths = { readonly source: string; readonly output: string; readonly parent: string }

class SourceChanged extends Error {}

const blocker_messages: Readonly<Record<BlockerKind, string>> = {
  root_unsupported: 'The data directory holds an entry no board format accounts for.',
  registry_damaged: 'The board registry cannot be read.',
  registry_pending: 'A board deletion is unfinished. Start and stop the board, then copy again.',
  key_unsafe: 'The machine key is not a private regular file (mode 600).',
  board_unlisted: 'A board folder is not listed in the registry.',
  board_outstanding: 'A chat request or a native revision is still open.',
  board_unsupported: 'A board file is in a retired format, or needs an upgrade written first.',
  board_ambiguous: 'The Agent canvas cannot join the sketch without a guess.',
  board_damaged: 'A board file is damaged, missing or not a regular file.',
}

// What a board folder may hold. A legacy board's retired formats are refused by name, so
// nothing restorable is silently left behind.
const legacy_names: readonly string[] = [
  'board.snapshot',
  'cleaned.state',
  'events.state',
  'drawing.image',
  'drawing.frame',
]
const native_names: readonly string[] = [
  'board.snapshot',
  'events.state',
  'drawing.image',
  'drawing.frame',
  'native.journal',
  'agent_canvas.archive',
]
const legacy_carried: readonly FileName[] = ['events.state', 'drawing.image', 'drawing.frame']
const root_names_own = ['sessions.registry', 'whiteboard.key', 'sessions']

// A stopped board's claim file and the daemon's log are not board data. They stay with the
// source, and the stage names them; a live claim refuses the stage before it starts.
const root_lock_name = 'server.json'
const root_names_operational = [root_lock_name, 'server.log']
const scene_type_names = ['page', 'shape', 'binding']
const entries_count_max = 256
const board_entries_count_max = 64
const tree_depth_max = 3
const tree_entries_count_max = entries_count_max + board_sessions_count_max * 64
const room_label = '-'
const name_safe_pattern = /^[A-Za-z0-9._-]{1,64}$/
const board_names_all: readonly string[] = board_file_names

// A root from before sessions lists only the original board, as the registry reads it.
const session_original: BoardSession = {
  id: board_default_id,
  name: null,
  named_by: null,
  created_at_ms: 0,
}

assert(
  legacy_carried.every((name) => native_names.includes(name)),
  'carried files stay native',
)
assert(
  native_names.every((name) => board_names_all.includes(name)),
  'native files are known',
)

export function native_stage(options: StageOptions): StageResult {
  assert(path.isAbsolute(options.source_directory), 'the source is an absolute path')
  assert(path.isAbsolute(options.output_directory), 'the output is an absolute path')
  const paths = paths_check(options)

  if ('kind' in paths) return refusal(paths.kind as StageRefusalKind, paths.message)

  if (source_running(paths.source)) {
    return refusal('source_active', 'A board is running on the source. Stop it and copy again.')
  }

  const before = tree_digest(paths.source)

  if (before === null) return blocked(0, [blocker('root_unsupported', null, null)])

  const read = preflight(paths.source)

  if (read.blockers.length > 0) return blocked(read.sessions.length, read.blockers)

  assert(read.planned.length === read.sessions.length, 'every listed board is planned')
  const result = staged(paths, read, before, options.id_create)
  assert(result.kind !== 'staged' || result.boards.length === read.sessions.length, 'all boards')
  return result
}

// A sha-256 over every entry under `root` to three levels, its name, type, mode and, for a file,
// its bytes, in name order. The stopped board's claim file is left out. Null past the bound.
export function tree_digest(root: string): string | null {
  assert(path.isAbsolute(root), 'a digested folder is named absolutely')
  const hash = createHash('sha256')
  const pending: string[] = ['']
  let count = 0

  while (pending.length > 0) {
    const relative = pending.pop() as string
    const stat = fs.lstatSync(path.join(root, relative))
    count += 1

    if (count > tree_entries_count_max) return null

    hash.update(`${relative}\0${stat.mode}\0`)

    if (stat.isFile()) hash.update(fs.readFileSync(path.join(root, relative)))

    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(path.join(root, relative)))

    const depth = relative === '' ? 0 : relative.split(path.sep).length

    if (!stat.isDirectory() || depth >= tree_depth_max) continue

    const names = fs.readdirSync(path.join(root, relative)).sort().reverse()

    for (const name of names) {
      if (depth === 0 && name === root_lock_name) continue

      pending.push(path.join(relative, name))
    }
  }

  assert(count >= 1 && count <= tree_entries_count_max, 'the walk is bounded')
  return hash.digest('hex')
}

function preflight(root: string): Preflight {
  assert(path.isAbsolute(root), 'the source is named absolutely')
  const disk = disk_read_only(disk_open(root))
  const listed = registry_listed(disk)

  if (listed === null) {
    const blockers = [blocker('registry_damaged', null, 'sessions.registry')]
    const none = { registry: null, key: null, operational: [], planned: [] }
    return { sessions: [], owners: new Map(), ...none, blockers }
  }

  const { sessions, owners, registry } = listed
  const blockers: Blocker[] = []

  if (listed.pending) blockers.push(blocker('registry_pending', null, 'sessions.registry'))

  const key = key_read(disk, blockers)
  blockers.push(...root_check(root, sessions))
  const planned: Planned[] = []

  for (const session of sessions) {
    const prepared = board_prepare(root, session, owners.has(session.id))

    if ('kind' in prepared) blockers.push(prepared)
    else planned.push(prepared.planned)
  }

  const names = fs.readdirSync(root)
  const operational = root_names_operational.filter((name) => names.includes(name))
  assert(planned.length + blockers.length >= sessions.length, 'every board is accounted for')
  return { sessions, owners, registry, key, operational, planned, blockers }
}

type Listed = Pick<Preflight, 'sessions' | 'owners' | 'registry'> & { readonly pending: boolean }

// The boards listed, or null for a registry that cannot be read. A root from before sessions
// has no registry and holds only the original board.
function registry_listed(disk: Disk): Listed | null {
  try {
    const registry = disk.read('sessions.registry')

    if (registry === null) {
      return { sessions: [session_original], owners: new Map(), registry, pending: false }
    }

    const state = registry_read(registry)
    assert(state.sessions.length <= board_sessions_count_max, 'a read registry is bounded')
    assert(state.owners.size <= state.sessions.length, 'only listed boards are owned')
    const { sessions, owners } = state
    return { sessions, owners, registry, pending: state.pending !== null }
  } catch (error) {
    if (!(error instanceof StorageError)) throw error

    return null
  }
}

function key_read(disk: Disk, blockers: Blocker[]): Uint8Array | null {
  try {
    const key = disk.read('whiteboard.key')
    assert(key === null || key.byteLength === 64, 'a read key is complete')
    return key
  } catch (error) {
    if (!(error instanceof StorageError)) throw error

    assert(!blockers.some((found) => found.kind === 'key_unsafe'), 'the key is judged once')
    blockers.push(blocker('key_unsafe', null, 'whiteboard.key'))
    return null
  }
}

// The entries of the root and of `sessions/` that belong to no listed board.
function root_check(root: string, sessions: readonly BoardSession[]): Blocker[] {
  assert(path.isAbsolute(root), 'the source is named absolutely')
  const ids = new Set(sessions.map((session) => session.id))
  const original = ids.has(board_default_id)
  const blockers: Blocker[] = []
  const names = fs.readdirSync(root).sort()

  if (names.length > entries_count_max) return [blocker('root_unsupported', null, null)]

  for (const name of names) {
    const own = root_names_own.includes(name) || root_names_operational.includes(name)
    const board = board_names_all.includes(name)

    if ((own && name !== 'sessions') || (board && original)) continue

    const folder = fs.lstatSync(path.join(root, name)).isDirectory()

    if (name !== 'sessions' || !folder) blockers.push(blocker('root_unsupported', null, name))
  }

  const parent = path.join(root, 'sessions')

  if (!fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) return blockers

  const folders = fs.readdirSync(parent).sort()

  if (folders.length > entries_count_max) {
    return [...blockers, blocker('board_unlisted', null, null)]
  }

  for (const name of folders) {
    if (!ids.has(name) || name === board_default_id) {
      blockers.push(blocker('board_unlisted', null, name))
    }
  }

  assert(blockers.length <= names.length + folders.length, 'one blocker per entry at most')
  return blockers
}

// What one board becomes, read through a disk that refuses writes, or why it cannot be staged.
function board_prepare(root: string, session: BoardSession, linked: boolean): Prepared | Blocker {
  const id = session.id
  const original = id === board_default_id
  const directory = original ? root : path.join(root, 'sessions', id)
  assert(path.isAbsolute(directory), 'a board folder is named absolutely')
  assert(original || path.dirname(directory) === path.join(root, 'sessions'), 'in sessions/')
  const names = board_names(directory, original)

  if (!Array.isArray(names)) return { ...names, session: id }

  const base = { session: id, linked, records_count: 0, agent_records_count: 0, agent_revision: 0 }
  const report = {
    ...base,
    agent_history_count: 0,
    agent_archived: false,
    chat_events_count: 0,
    view_controls_count: 0,
    native_sequence_next: null,
  }

  if (names.length === 0) return board_empty({ ...report, kind: 'empty' }, original)

  try {
    const disk = disk_read_only(disk_open(directory))

    if (names.includes('native.journal')) return board_native(disk, names, report)

    if (!names.includes('board.snapshot')) return blocker('board_damaged', id, 'board.snapshot')

    return board_legacy(disk, report, original)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    if (error instanceof SourceWriteRefused) return blocker('board_unsupported', id, null)

    if (error instanceof StorageError) return blocker('board_damaged', id, null)

    throw error
  }
}

// The board files in a board's folder, each a regular file of a format staged; the original
// board's are the board files in the root. A listed board without a folder has none yet.
function board_names(directory: string, original: boolean): string[] | Blocker {
  assert(path.isAbsolute(directory), 'a board folder is named absolutely')
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false })

  if (stat === undefined) return []

  if (!stat.isDirectory()) return blocker('board_damaged', null, null)

  const all = fs.readdirSync(directory).sort()

  if (all.length > (original ? entries_count_max : board_entries_count_max)) {
    return blocker('board_unsupported', null, null)
  }

  const names = original ? all.filter((name) => board_names_all.includes(name)) : all
  const allowed = names.includes('native.journal') ? native_names : legacy_names

  for (const name of names) {
    if (!allowed.includes(name)) return blocker('board_unsupported', null, name)

    if (!fs.lstatSync(path.join(directory, name)).isFile()) {
      return blocker('board_damaged', null, name)
    }
  }

  assert(names.length <= board_entries_count_max, 'the names are bounded')
  return names
}

type Report = Omit<StagedBoard, 'kind'>

function board_empty(report: StagedBoard, original: boolean): Prepared {
  assert(report.kind === 'empty' && report.records_count === 0, 'an empty board has no room')
  assert(report.native_sequence_next === null, 'an empty board gets a new journal')
  const planned = { report, documents: null, scene: null, files: new Map() }
  const write = (target: Disk, id_create: () => string) => {
    journal_create(target, report.session, original, id_create)
  }
  return { planned, write }
}

function board_legacy(disk: Disk, report: Report, original: boolean): Prepared | Blocker {
  const read = board_read(disk)

  if ('kind' in read) {
    assert(read.kind === 'board_outstanding', 'a read board is refused only for an open request')
    return blocker('board_outstanding', report.session, 'events.state')
  }

  const plan = room_plan(read.room, read.canvas_records, read.controls)

  if (!plan.ok) return blocker(plan.kind, report.session, null)

  const files = new Map<FileName, Uint8Array>()

  for (const name of legacy_carried) {
    const bytes = read.carried.get(name)

    if (bytes !== undefined) files.set(name, bytes)
  }

  if (read.canvas_bytes !== null) files.set('agent_canvas.archive', read.canvas_bytes)

  const room = room_encode(plan.snapshot)
  const planned: Planned = {
    report: {
      ...report,
      kind: 'converted',
      records_count: plan.snapshot.documents.length,
      agent_records_count: plan.agent.length,
      agent_revision: read.agent_revision,
      agent_history_count: read.agent_history_count,
      agent_archived: read.canvas_bytes !== null,
      chat_events_count: read.chat_events_count,
      view_controls_count: read.controls.length,
    },
    ...room_hashes(plan.snapshot),
    files: digests(files),
  }
  const write = (target: Disk, id_create: () => string) => {
    target.write_atomic('board.snapshot', room)

    for (const [name, bytes] of files) target.write_atomic(name, bytes)

    journal_create(target, report.session, original, id_create)
  }
  assert(planned.report.records_count >= read.room.documents.length, 'the room only grows')
  return { planned, write }
}

function board_native(disk: Disk, names: readonly string[], report: Report): Prepared | Blocker {
  const journal = journal_read(disk)
  assert(journal !== null, 'a native board has its journal')

  if (journal.pending !== null)
    return blocker('board_outstanding', report.session, 'native.journal')

  const events = BoardEvents.open(disk)

  if (events.outstanding().length > 0) {
    return blocker('board_outstanding', report.session, 'events.state')
  }

  const room = names.includes('board.snapshot') ? room_read(disk) : null
  const files = new Map<FileName, Uint8Array>()

  for (const name of names) {
    const bytes = disk.read(name as FileName)
    assert(bytes !== null, 'a listed board file is read')
    files.set(name as FileName, bytes)
  }

  // The room is checked record by record: opening a board saves it again under a later clock.
  const kept = new Map([...files].filter(([name]) => name !== 'board.snapshot'))
  const planned: Planned = {
    report: {
      ...report,
      kind: 'native',
      records_count: room?.documents.length ?? 0,
      agent_archived: files.has('agent_canvas.archive'),
      chat_events_count: events.chat().events.length,
      native_sequence_next: journal.sequence_next,
    },
    ...(room === null ? { documents: null, scene: null } : room_hashes(room)),
    files: digests(kept),
  }
  const write = (target: Disk) => {
    for (const [name, bytes] of files) target.write_atomic(name, bytes)
  }
  assert(files.size === names.length, 'every file of a native board is carried')
  return { planned, write }
}

function journal_create(
  target: Disk,
  session: string,
  original: boolean,
  id_create: () => string,
): void {

  // The original board's id is not a namespace; minted ids need only be unique on one board.
  const id_namespace = original ? id_create() : session
  assert(original === (session === board_default_id), 'only the original has no namespace')
  NativeScene.create_file(target, { room_epoch: id_create(), id_namespace })
  assert(target.read('native.journal') !== null, 'the board is native')
}

function staged(
  paths: Paths,
  read: Preflight,
  before: string,
  id_create: () => string,
): StageResult {
  const name = `.${path.basename(paths.output)}.stage-${randomUUID()}`
  const directory = path.join(paths.parent, name)
  assert(path.dirname(directory) === paths.parent, 'the staging folder is beside the output')

  try {
    fs.mkdirSync(directory, { mode: 0o700 })
    assert((fs.statSync(directory).mode & 0o077) === 0, 'the staging folder is private')
    stage_write(directory, paths.source, read, id_create)
    const problem = stage_verify(directory, read)

    if (problem !== null) return refusal('output_failed', `The stage failed its check: ${problem}.`)

    if (tree_digest(paths.source) !== before || source_running(paths.source)) {
      throw new SourceChanged()
    }

    if (entry_exists(paths.output)) {
      return refusal('output_exists', 'The output appeared during the stage. Name a new one.')
    }

    const staged_digest = tree_digest(directory)
    assert(staged_digest !== null, 'a stage is within the walk bound')
    fs.renameSync(directory, paths.output)
    directory_sync(paths.parent)
    return stage_report(paths, read, before, staged_digest)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    if (error instanceof SourceChanged) {
      return refusal('source_changed', 'The source changed during the stage. Copy it again.')
    }

    const reason = error instanceof StorageError ? error.message : error_code(error)
    return refusal('output_failed', `The stage could not be written: ${reason}.`)
  } finally {

    // After the rename there is nothing here; before it, a partial stage is never left behind.
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// Each board is read again and must plan exactly as it did in the preflight. The registry is
// written last: until then no board is listed.
function stage_write(
  directory: string,
  source: string,
  read: Preflight,
  id_create: () => string,
): void {
  const root = disk_open(directory)

  if (read.key !== null) root.write_atomic('whiteboard.key', read.key)

  for (const [place, session] of read.sessions.entries()) {
    const prepared = board_prepare(source, session, read.owners.has(session.id))
    const expected = read.planned[place]
    assert(expected !== undefined && expected.report.session === session.id, 'boards in order')

    if ('kind' in prepared || planned_text(prepared.planned) !== planned_text(expected)) {
      throw new SourceChanged()
    }

    prepared.write(board_disk(directory, session.id), id_create)
  }

  if (read.registry !== null) root.write_atomic('sessions.registry', read.registry)

  assert(read.key === null || root.read('whiteboard.key') !== null, 'the stage has its key')
}

function board_disk(directory: string, id: string): Disk {
  assert(path.isAbsolute(directory) && board_id_pattern.test(id), 'a board of the stage')

  if (id === board_default_id) return disk_open(directory)

  for (const folder of [path.join(directory, 'sessions'), path.join(directory, 'sessions', id)]) {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 })

    assert((fs.statSync(folder).mode & 0o077) === 0, 'a folder of the stage is private')
  }

  return session_storage(directory).disk_board(id)
}

// Opens the stage as the server would and checks each board against its plan; then, closed,
// each room record by record, each kept file byte for byte, and the stage's entries.
function stage_verify(directory: string, read: Preflight): string | null {
  assert(path.isAbsolute(directory), 'the stage is named absolutely')
  assert(read.planned.length === read.sessions.length, 'every listed board was staged')
  const registry = BoardRegistry.open({
    time: time_real,
    disk: disk_open(directory),
    ...session_storage(directory),
    id_create: () => {
      throw new Error('a verification creates no board')
    },
  })

  try {
    if (JSON.stringify(registry.list()) !== JSON.stringify(read.sessions)) {
      return 'the boards listed differ'
    }

    for (const planned of read.planned) {
      const id = planned.report.session

      if (registry.owner(id) !== (read.owners.get(id) ?? null)) return `board ${id} changed owner`

      const problem = board_open_problem(registry, planned)

      if (problem !== null) return problem
    }
  } finally {
    registry.close()
  }

  for (const planned of read.planned) {
    const problem = board_files_problem(directory, planned)

    if (problem !== null) return problem
  }

  return tree_problem(directory, read)
}

function board_open_problem(registry: BoardRegistry, planned: Planned): string | null {
  const id = planned.report.session
  const lookup = registry.board(id)

  if (lookup.kind !== 'board') return `board ${id} did not open (${lookup.kind})`

  assert(lookup.board.session === id, 'the board opened is the one planned')
  assert((planned.scene === null) === (planned.documents === null), 'a scene is of a room')
  const native = lookup.board.native

  if (native === null) return `board ${id} did not open as native`

  const scene = native.scene_read()

  if (planned.scene === null) {
    const drawn = scene.records.some((record) => record.typeName !== 'page')

    if (drawn) return `board ${id} gained records`
  } else if (hashes_problem(scene.records, planned.scene)) {
    return `the scene of board ${id} differs`
  }

  const sequence = planned.report.native_sequence_next

  if (sequence !== null && scene.base_sequence !== sequence) {
    return `the native journal of board ${id} differs`
  }

  if (lookup.board.events.chat().events.length !== planned.report.chat_events_count) {
    return `the chat of board ${id} differs`
  }

  if (lookup.board.cleaned_status().current !== null) return `board ${id} shows an Agent canvas`

  return null
}

function board_files_problem(directory: string, planned: Planned): string | null {
  const id = planned.report.session
  assert(path.isAbsolute(directory), 'the stage is named absolutely')
  assert(planned.files.size <= native_names.length, 'a board keeps a few known files')
  const disk = board_disk(directory, id)

  for (const [name, digest] of planned.files) {
    const bytes = disk.read(name)

    if (bytes === null || sha256(bytes) !== digest) return `${name} of board ${id} differs`
  }

  if (planned.documents === null) return null

  const room = room_read(disk)
  const states = room.documents.map((document) => document.state as unknown as SceneRecord)
  return hashes_problem(states, planned.documents) ? `the room of board ${id} differs` : null
}

// The stage holds exactly the planned entries, each private: nothing extra and nothing lost.
function tree_problem(directory: string, read: Preflight): string | null {
  const expected = new Set<string>()
  const root_files = [
    ...(read.registry === null ? [] : ['sessions.registry']),
    ...(read.key === null ? [] : ['whiteboard.key']),
  ]

  for (const name of root_files) expected.add(name)

  for (const planned of read.planned) {
    const id = planned.report.session
    const folder = id === board_default_id ? '' : path.join('sessions', id)

    if (folder !== '') for (const name of ['sessions', folder]) expected.add(name)

    for (const name of ['board.snapshot', 'native.journal', ...planned.files.keys()]) {
      expected.add(path.join(folder, name))
    }
  }

  assert(expected.size >= read.planned.length * 2, 'each board has its room and journal')
  assert(path.isAbsolute(directory), 'the stage is named absolutely')

  const found = tree_entries(directory)

  if (found === null) return 'the stage holds too many entries'

  for (const [relative, stat] of found) {
    const mode = stat.mode & 0o777

    if (!expected.has(relative)) return 'the stage holds an entry no board planned'

    if (mode !== (stat.isDirectory() ? 0o700 : 0o600)) return `${relative} is not private`
  }

  return found.size === expected.size ? null : 'the stage lacks a planned file'
}

function tree_entries(root: string): Map<string, fs.Stats> | null {
  assert(path.isAbsolute(root), 'a listed folder is named absolutely')
  const found = new Map<string, fs.Stats>()
  const pending = fs.readdirSync(root)

  while (pending.length > 0) {
    const relative = pending.pop() as string
    const stat = fs.lstatSync(path.join(root, relative))
    found.set(relative, stat)

    if (found.size > tree_entries_count_max) return null

    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(root, relative))) {
        pending.push(path.join(relative, name))
      }
    }
  }

  assert(found.size <= tree_entries_count_max, 'the entries are bounded')
  return found
}

function hashes_problem(
  records: readonly SceneRecord[],
  expected: ReadonlyMap<string, string>,
): boolean {
  assert(
    [...expected.values()].every((hash) => record_hash_pattern.test(hash)),
    'expected hashes are sha-256',
  )

  if (records.length !== expected.size) return true

  return records.some((record) => expected.get(record.id) !== record_hash(record))
}

function room_hashes(room: RoomSaved): Pick<Planned, 'documents' | 'scene'> {
  const documents = new Map<string, string>()
  const scene = new Map<string, string>()

  for (const document of room.documents) {
    const state = document.state as unknown as SceneRecord
    const hash = record_hash(state)
    documents.set(state.id, hash)

    if (scene_type_names.includes(state.typeName)) scene.set(state.id, hash)
  }

  assert(documents.size === room.documents.length, 'room ids are unique')
  assert(scene.size <= documents.size, 'the scene is part of the room')
  return { documents, scene }
}

function room_encode(room: RoomSaved): Uint8Array {
  assert(room.documents.length <= room_records_max, 'a planned room is bounded')
  const payload = new TextEncoder().encode(JSON.stringify(room))
  const bytes = envelope_encode({ kind: 'board', label: room_label, payload })
  assert(bytes.byteLength > payload.byteLength, 'the room has its envelope')
  return bytes
}

function digests(files: ReadonlyMap<FileName, Uint8Array>): Map<FileName, string> {
  assert(files.size <= native_names.length, 'a board keeps a few known files')
  const found = new Map([...files].map(([name, bytes]) => [name, sha256(bytes)] as const))
  assert(found.size === files.size, 'every file has a digest')
  return found
}

function sha256(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert(record_hash_pattern.test(digest), 'a digest is 64 lowercase hex characters')
  return digest
}

// A plan as text, to compare the preflight's with the stage's.
function planned_text(planned: Planned): string {
  const entries = (map: ReadonlyMap<string, string> | null) => (map === null ? null : [...map])
  const text = JSON.stringify([
    planned.report,
    entries(planned.documents),
    entries(planned.scene),
    entries(planned.files),
  ])
  assert(planned.report.session.length > 0, 'a plan names its board')
  assert(text.length > 0, 'a plan has text')
  return text
}

function stage_report(paths: Paths, read: Preflight, source: string, staged: string): Staged {
  assert(fs.statSync(paths.output).isDirectory(), 'the stage is in place')
  assert((fs.statSync(paths.output).mode & 0o077) === 0, 'the stage is private')
  return {
    kind: 'staged',
    output_directory: paths.output,
    boards: read.planned.map((planned) => planned.report),
    registry_carried: read.registry !== null,
    key_carried: read.key !== null,
    operational_skipped: read.operational,
    source_digest: source,
    staged_digest: staged,
  }
}

function blocker(kind: BlockerKind, session: string | null, file: string | null): Blocker {
  assert(Object.hasOwn(blocker_messages, kind), 'every reason has its message')
  assert(session === null || board_id_pattern.test(session), 'a reason names a listed board')
  const named = file !== null && name_safe_pattern.test(file) ? file : null
  return { kind, session, file: named, message: blocker_messages[kind] }
}

function blocked(boards_count: number, blockers: readonly Blocker[]): StageBlocked {
  assert(blockers.length > 0, 'a blocked stage says why')
  assert(
    blockers.every((found) => found.message.endsWith('.')),
    'each reason is a sentence',
  )
  return { kind: 'blocked', boards_count, blockers }
}

function refusal(kind: StageRefusalKind, message: string): StageRefusal {
  assert(message.endsWith('.'), 'a refusal is a sentence')
  assert(message.length <= 200, 'a refusal is short')
  return { kind, message }
}
