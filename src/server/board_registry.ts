// The board sessions: which boards exist, what each is called, and which are open in memory.
// Every board is a whole `Board` of its own, with its own sync room, image and cleaned diagram,
// so nothing one page or agent does to a board can reach another. There is no active board on
// the server: every request names the board it is about.
//
// The registry is a small file in the data directory, written whole and atomically, before the
// change it records is served. A data directory from before sessions has no registry, and holds
// exactly one board: the default one, whose files stay where they always were.
//
// Boards are opened on first use. At most `boards_open_count_max` are in memory; to open another,
// the least recently used idle board is saved and closed. The default board stays open, as it
// always did. When every open board is in use, the request is refused, never queued.

import { assert, AssertionError } from '../shared/assert'
import {
  board_default_id,
  board_id_pattern,
  board_name_clean,
  board_namers,
  type BoardSession,
} from '../shared/board_session'
import type { SketchSnapshot } from '../shared/cleanup_types'
import {
  board_name_length_max,
  board_sessions_count_max,
  board_title_length_max,
  boards_open_count_max,
} from '../shared/constants'
import { owner_pattern, type Layer } from '../shared/whiteboard'
import type { Time } from '../shared/time'
import { Board } from './board'
import type { PublishResult } from './cleaned'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

export type RegistryEnvironment = {
  readonly time: Time

  // The data directory: the registry and the default board's files.
  readonly disk: Disk

  // The directory of a board other than the default one. Called only when it is opened.
  disk_board(id: string): Disk

  // A new random id of sixteen hex digits. Replaceable, so a simulation can be replayed.
  id_create(): string
}

export type BoardLookup = { kind: 'board'; board: Board } | BoardLookupFailure
export type BoardLookupFailure =
  { kind: 'not_found' } | { kind: 'busy' } | { kind: 'damaged'; message: string }

export type CreateResult = { kind: 'created'; session: BoardSession } | { kind: 'full' }
export type RenameResult = { kind: 'renamed'; session: BoardSession } | { kind: 'not_found' }

// A publish to a board, and whether its title named that board.
export type RegistryPublish = (PublishResult & { title_applied: boolean }) | BoardLookupFailure

const file_name = 'sessions.registry'
const registry_format = 'tldraw-sync.sessions.v1'
const label = '-'
const id_attempts_count_max = 4

export class BoardRegistry {

  // Open boards, least recently used first: a lookup moves its board to the end.
  private readonly boards = new Map<string, Board>()

  private constructor(
    private readonly environment: RegistryEnvironment,
    private sessions: readonly BoardSession[],
    private owners: ReadonlyMap<string, string>,
  ) {}

  // Reads the registry and opens the default board. Damage to either is a StorageError: the
  // caller refuses to start, as it does for a damaged board.
  static open(environment: RegistryEnvironment): BoardRegistry {
    const bytes = environment.disk.read(file_name)
    const state =
      bytes === null
        ? { sessions: [session_default()], owners: new Map<string, string>() }
        : registry_read(bytes)
    const registry = new BoardRegistry(environment, state.sessions, state.owners)
    const board = Board.open({ time: environment.time, disk: environment.disk })
    registry.boards.set(board_default_id, board)

    assert(registry.sessions[0]?.id === board_default_id, 'the default board is listed first')
    assert(registry.boards.size === 1, 'only the default board opens at start')
    return registry
  }

  list(): readonly BoardSession[] {
    assert(this.sessions.length <= board_sessions_count_max, 'sessions are bounded')
    assert(this.sessions.length > 0, 'the default board is always listed')
    return this.sessions
  }

  find(id: string): BoardSession | null {
    assert(id.length > 0, 'an id is not empty')
    const session = this.sessions.find((candidate) => candidate.id === id) ?? null
    assert(session === null || board_id_pattern.test(session.id), 'a listed id is well formed')
    return session
  }

  owner(id: string): string | null {
    const owner = this.owners.get(id) ?? null
    assert(owner === null || this.find(id) !== null, 'only listed boards have owners')
    assert(owner === null || id !== board_default_id, 'personal default ink is never claimed')
    return owner
  }

  link(owner: string): CreateResult {
    assert(owner_pattern.test(owner), 'a link has a validated owner')

    for (const [id, bound] of this.owners) {
      if (bound !== owner) continue

      const session = this.find(id)
      assert(session !== null, 'a bound board is listed')
      return { kind: 'created', session }
    }

    return this.create(null, owner)
  }

  create(name: string | null, owner?: string): CreateResult {
    assert(name === null || board_name_clean(name, board_name_length_max) === name, 'clean name')

    if (this.sessions.length === board_sessions_count_max) return { kind: 'full' }

    const id = this.id_unused()
    const session: BoardSession = {
      id,
      name,
      named_by: name === null ? null : 'person',
      created_at_ms: this.environment.time.now_ms(),
    }
    const owners = owner === undefined ? this.owners : new Map(this.owners).set(id, owner)
    this.commit([...this.sessions, session], owners)
    assert(this.find(id) === session, 'a created board is listed')
    assert(this.sessions.length <= board_sessions_count_max, 'sessions are bounded')
    return { kind: 'created', session }
  }

  // A person's rename always applies, whoever named the board before.
  rename(id: string, name: string): RenameResult {
    assert(board_name_clean(name, board_name_length_max) === name, 'a new name is clean')
    const previous = this.find(id)

    if (previous === null) return { kind: 'not_found' }

    const session: BoardSession = { ...previous, name, named_by: 'person' }
    this.commit(this.sessions.map((candidate) => (candidate.id === id ? session : candidate)))
    assert(this.find(id)?.name === name, 'the new name is listed')
    return { kind: 'renamed', session }
  }

  // The open board for this id, opening it if it is listed and there is room.
  board(id: string): BoardLookup {
    assert(id.length > 0, 'an id is not empty')
    const open = this.boards.get(id)

    if (open !== undefined) {
      this.boards.delete(id)
      this.boards.set(id, open)
      return { kind: 'board', board: open }
    }

    if (this.find(id) === null) return { kind: 'not_found' }

    if (this.boards.size === boards_open_count_max && !this.board_evict()) return { kind: 'busy' }

    assert(this.boards.size < boards_open_count_max, 'there is room for one more board')
    let board: Board

    try {
      const disk = this.environment.disk_board(id)
      board = Board.open({ time: this.environment.time, disk, session: id })
    } catch (error) {
      if (!(error instanceof StorageError)) throw error

      return { kind: 'damaged', message: error.message }
    }

    this.boards.set(id, board)
    assert(board.session === id, 'the opened board is the one asked for')
    return { kind: 'board', board }
  }

  // Only a board already in memory: a message for a closed board has nowhere to go.
  board_open(id: string): Board | null {
    assert(id.length > 0, 'an id is not empty')
    const board = this.boards.get(id) ?? null
    assert(board === null || board.session === id, 'an open board is filed under its own id')
    return board
  }

  open_count(): number {
    assert(this.boards.size <= boards_open_count_max, 'open boards are bounded')
    assert(this.boards.has(board_default_id), 'the default board stays open')
    return this.boards.size
  }

  // The records of a board's sketch, and whether the agent is asked for a title.
  sketch_snapshot(
    id: string,
    hash: string,
    layer: Layer = 'interpretation',
  ): SketchSnapshot | null | BoardLookupFailure {
    const lookup = this.board(id)

    if (lookup.kind !== 'board') return lookup

    const snapshot = lookup.board.sketch_snapshot(hash, layer)

    if (snapshot === null) return null

    const session = this.find(id)
    assert(session !== null, 'an open board is listed')
    assert(snapshot.session === id, 'the snapshot is of the board asked for')
    return { ...snapshot, title_wanted: session.name === null }
  }

  // Publishes, then names the board with the proposal's title if, at that moment, the board is
  // still unnamed. Both happen in one synchronous step, so no rename can come between them. A
  // refused publish names nothing.
  publish(id: string, input: unknown, layer: Layer = 'interpretation'): RegistryPublish {
    const lookup = this.board(id)

    if (lookup.kind !== 'board') return lookup

    const result = lookup.board.cleaned_publish(input, layer)

    if (result.kind !== 'published') return { ...result, title_applied: false }

    const title_applied =
      layer === 'interpretation' && result.title !== null && this.title_apply(id, result.title)
    assert(!title_applied || this.find(id)?.named_by === 'agent', 'an applied title is listed')
    return { ...result, title_applied }
  }

  // An orderly stop: every open board is saved.
  close(): void {
    assert(this.boards.size > 0, 'the default board is open until the end')

    for (const board of this.boards.values()) board.close()

    this.boards.clear()
    assert(this.boards.size === 0, 'every board was closed')
  }

  destroy(): void {
    for (const board of this.boards.values()) board.destroy()

    this.boards.clear()
    assert(this.boards.size === 0, 'every board was destroyed')
  }

  private title_apply(id: string, title: string): boolean {
    assert(board_name_clean(title, board_title_length_max) === title, 'a title is clean')
    const session = this.find(id)
    assert(session !== null, 'a published board is listed')

    if (session.name !== null) return false

    const named: BoardSession = { ...session, name: title, named_by: 'agent' }

    try {
      this.commit(this.sessions.map((candidate) => (candidate.id === id ? named : candidate)))
    } catch (error) {

      // The diagram is published already; a title that cannot be saved is left off, and the
      // board stays unnamed, in memory and on disk. A broken invariant still stops the server.
      if (error instanceof AssertionError) throw error

      return false
    }

    assert(this.find(id)?.name === title, 'the title is listed')
    return true
  }

  // The least recently used idle board, other than the default one, is saved and closed.
  private board_evict(): boolean {
    assert(this.boards.size === boards_open_count_max, 'eviction only makes room when full')

    for (const [id, board] of this.boards) {
      if (id === board_default_id || !board.idle()) continue

      board.close()
      this.boards.delete(id)
      assert(this.boards.size < boards_open_count_max, 'eviction made room')
      return true
    }

    return false
  }

  private id_unused(): string {
    for (let attempt = 0; attempt < id_attempts_count_max; attempt += 1) {
      const id = this.environment.id_create()
      assert(board_id_pattern.test(id) && id !== board_default_id, 'a new id is random hex')

      if (this.find(id) === null) return id
    }

    throw new AssertionError('sixty-four random bits collided again and again')
  }

  // Write first, then swap. A throwing disk leaves the registry, and its file, as they were.
  private commit(sessions: readonly BoardSession[], owners = this.owners): void {
    assert(sessions.length <= board_sessions_count_max, 'sessions are bounded')
    assert(sessions[0]?.id === board_default_id, 'the default board stays first')
    const state = { format: registry_format, sessions, owners: Object.fromEntries(owners) }
    const payload = new TextEncoder().encode(JSON.stringify(state))
    this.environment.disk.write_atomic(
      file_name,
      envelope_encode({
        kind: 'registry',
        label,
        payload,
      }),
    )

    // Pair assertion: the file now on disk reads back as the registry about to be served.
    const written = this.environment.disk.read(file_name)
    assert(written !== null, 'the registry was written')
    const read = registry_read(written)
    assert(read.sessions.length === sessions.length, 'the written registry reads back')
    assert(read.owners.size === owners.size, 'every link was saved')
    this.sessions = sessions
    this.owners = owners
  }
}

function session_default(): BoardSession {
  const session = { id: board_default_id, name: null, named_by: null, created_at_ms: 0 }
  assert(board_id_pattern.test(session.id), 'the default id is well formed')
  assert(session.name === null, 'the default board starts unnamed, as before sessions')
  return session
}

// The registry file is untrusted like any input. Damage stops the server, because starting
// without it would hide every board but the default one.
function registry_read(bytes: Uint8Array) {
  const decoded = envelope_decode(bytes, 'registry')

  if (!decoded.ok) throw new StorageError(`${file_name} is damaged: ${decoded.reason}`)

  let parsed: unknown

  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
  } catch {
    throw new StorageError(`${file_name} is damaged: it is not JSON`)
  }

  const json = parsed as { format?: unknown; sessions?: unknown; owners?: unknown } | null
  const list =
    typeof json === 'object' && json !== null && json.format === registry_format
      ? json.sessions
      : null

  if (!Array.isArray(list) || list.length === 0 || list.length > board_sessions_count_max) {
    throw new StorageError(`${file_name} is damaged: unknown format or session count`)
  }

  const sessions = list.map(session_read)
  const ids = new Set(sessions.map((session) => session.id))

  if (ids.size !== sessions.length || sessions[0]?.id !== board_default_id) {
    throw new StorageError(`${file_name} is damaged: ids repeat or the default board is missing`)
  }

  assert(sessions.length <= board_sessions_count_max, 'a read registry is bounded')
  assert(
    sessions.every((session) => board_id_pattern.test(session.id)),
    'read ids are valid',
  )
  const input = json?.owners === undefined ? {} : json.owners

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StorageError('Invalid whiteboard links.')
  }

  const owners = new Map<string, string>()
  const used = new Set<string>()

  for (const [id, owner] of Object.entries(input)) {
    if (
      !ids.has(id) ||
      id === board_default_id ||
      typeof owner !== 'string' ||
      !owner_pattern.test(owner) ||
      used.has(owner)
    ) {
      throw new StorageError('Invalid board owner.')
    }

    owners.set(id, owner)
    used.add(owner)
  }

  assert(owners.size < sessions.length, 'there is at least one unbound board')
  assert(used.size === owners.size, 'each owner links to one board')
  return { sessions, owners }
}

function session_read(value: unknown): BoardSession {
  const json = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const { id, name, named_by, created_at_ms } = json
  const name_valid =
    name === null
      ? named_by === null
      : board_name_clean(name, board_name_length_max) === name &&
        board_namers.some((namer) => namer === named_by)
  const valid =
    typeof id === 'string' &&
    board_id_pattern.test(id) &&
    name_valid &&
    typeof created_at_ms === 'number' &&
    Number.isFinite(created_at_ms) &&
    created_at_ms >= 0 &&
    Object.keys(json).length === 4

  if (!valid) throw new StorageError(`${file_name} is damaged: a session is malformed`)

  assert(typeof id === 'string', 'a valid session has an id')
  assert(name === null || typeof name === 'string', 'a valid session has a name or none')
  return {
    id,
    name: name as string | null,
    named_by: named_by as BoardSession['named_by'],
    created_at_ms: created_at_ms as number,
  }
}
