// The board sessions: which boards exist, what each is called, and which are open in memory.
// Every board is a whole `Board` of its own, with its own sync room, image and Agent canvas,
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
import type { SketchSnapshot } from '../shared/canvas_types'
import {
  board_name_length_max,
  board_sessions_count_max,
  board_title_length_max,
  boards_open_count_max,
} from '../shared/constants'
import { owner_pattern } from '../shared/whiteboard'
import type { Time } from '../shared/time'
import { Board, type PreviewResult } from './board'
import type { PublishResult } from './cleaned'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

export type RegistryEnvironment = {
  readonly time: Time

  // The data directory: the registry and the default board's files.
  readonly disk: Disk

  // The directory of a board other than the default one. Called only when it is opened.
  disk_board(id: string): Disk

  disk_remove(id: string): void
  disk_exists(id: string): boolean

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

// A draft handed to a board to be rendered. Nothing is published and no board is named.
export type RegistryPreview = PreviewResult | BoardLookupFailure

const file_name = 'sessions.registry'
const registry_format = 'tldraw-sync.sessions.v3'
const permanent_home_format = 'tldraw-sync.sessions.v2'
const legacy_format = 'tldraw-sync.sessions.v1'
const label = '-'

// Ten random hex digits plus a non-repeating allocation number. Addresses are public;
// host and event credentials remain separate secrets. Never wrap the allocation number.
const allocation_max = 0xffffff
type Allocation = { serial: number; legacy: readonly string[] }
const allocation_initial = (): Allocation => ({ serial: 0, legacy: [] })

export class BoardRegistry {

  // Open boards, least recently used first: a lookup moves its board to the end.
  private readonly boards = new Map<string, Board>()

  private constructor(
    private readonly environment: RegistryEnvironment,
    private sessions: readonly BoardSession[],
    private owners: ReadonlyMap<string, string>,
    private allocation: Allocation,
    private pending: string | null,
    private saved: Uint8Array | null,
  ) {}

  // Reads the registry and opens the default board. Damage to either is a StorageError: the
  // caller refuses to start, as it does for a damaged board.
  static open(environment: RegistryEnvironment): BoardRegistry {
    const bytes = environment.disk.read(file_name)
    const state =
      bytes === null
        ? {
            sessions: [session_default()],
            owners: new Map(),
            allocation: allocation_initial(),
            pending: null,
          }
        : registry_read(bytes)
    const registry = new BoardRegistry(
      environment,
      state.sessions,
      state.owners,
      state.allocation,
      state.pending,
      bytes,
    )
    registry.cleanup()

    if (registry.find(board_default_id) !== null) {
      const board = Board.open({ time: environment.time, disk: environment.disk })
      registry.boards.set(board_default_id, board)
    }

    assert(registry.pending === null, 'retired files are cleaned before serving')
    assert(registry.boards.size <= 1, 'only the legacy root board opens at start')
    return registry
  }

  list(): readonly BoardSession[] {
    assert(this.sessions.length <= board_sessions_count_max, 'sessions are bounded')
    assert(this.owners.size <= this.sessions.length, 'only listed boards can be owned')
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

    const next = this.id_unused()

    if (next === null) throw new StorageError('No unused board address could be allocated.')

    const { id, serial } = next
    const session: BoardSession = {
      id,
      name,
      named_by: name === null ? null : 'person',
      created_at_ms: this.environment.time.now_ms(),
    }
    const owners = owner === undefined ? this.owners : new Map(this.owners).set(id, owner)
    this.commit([...this.sessions, session], owners, this.pending, { ...this.allocation, serial })
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

  remove(id: string): 'removed' | 'not_found' {

    // Retry the previous cleanup before recording another. One durable slot bounds recovery.
    const retry = this.pending === id

    if (!retry && this.find(id) === null) return 'not_found'

    this.cleanup()

    if (retry) return 'removed'

    const owners = new Map(this.owners)
    owners.delete(id)
    this.commit(
      this.sessions.filter((session) => session.id !== id),
      owners,
      id,
    )
    const board = this.boards.get(id)
    this.boards.delete(id)
    board?.destroy()
    this.cleanup()
    assert(this.find(id) === null, 'a deleted board cannot reopen')
    assert(this.owner(id) === null, 'a deleted link no longer authorizes anything')
    return 'removed'
  }

  private cleanup(): void {
    if (this.pending === null) return

    assert(this.find(this.pending) === null, 'cleanup only touches a retired board')
    assert(!this.owners.has(this.pending), 'cleanup cannot affect a live binding')
    assert(!this.boards.has(this.pending), 'no socket or timer can write during cleanup')
    this.environment.disk_remove(this.pending)
    this.commit(this.sessions, this.owners, null)
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
    assert(this.boards.size <= this.sessions.length, 'only listed rooms are open')
    return this.boards.size
  }

  // The records of a board's sketch, and whether the agent is asked for a title.
  sketch_snapshot(id: string, hash: string): SketchSnapshot | null | BoardLookupFailure {
    const lookup = this.board(id)

    if (lookup.kind !== 'board') return lookup

    const snapshot = lookup.board.sketch_snapshot(hash)

    if (snapshot === null) return null

    const session = this.find(id)
    assert(session !== null, 'an open board is listed')
    assert(snapshot.session === id, 'the snapshot is of the board asked for')
    return { ...snapshot, title_wanted: session.name === null }
  }

  // Publishes, then names the board with the proposal's title if, at that moment, the board is
  // still unnamed. Both happen in one synchronous step, so no rename can come between them. A
  // refused publish names nothing.
  publish(id: string, input: unknown): RegistryPublish {
    const lookup = this.board(id)

    if (lookup.kind !== 'board') return lookup

    const result = lookup.board.cleaned_publish(input)

    if (result.kind !== 'published') return { ...result, title_applied: false }

    const title_applied = result.title !== null && this.title_apply(id, result.title)
    assert(!title_applied || this.find(id)?.named_by === 'agent', 'an applied title is listed')
    return { ...result, title_applied }
  }

  // Hands a draft to a board to be rendered. A draft names no board: its title is not read.
  preview(id: string, input: unknown): RegistryPreview {
    const lookup = this.board(id)

    if (lookup.kind !== 'board') return lookup

    const named = this.find(id)?.name ?? null
    const result = lookup.board.preview_create(input)
    assert(this.find(id)?.name === named, 'a draft names no board')
    assert(result.kind !== 'preview' || result.preview.length > 0, 'a draft is named')
    return result
  }

  // An orderly stop: every open board is saved.
  close(): void {
    assert(this.boards.size <= this.sessions.length, 'only listed rooms need closing')

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

      // The canvas is published already; a title that cannot be saved is left off, and the
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

  private id_unused(): { id: string; serial: number } | null {

    // Even a repeated random value after restart cannot revive a bookmark or credential.
    // Pre-upgrade random ids (at most one registry full) remain reserved independently.
    for (let step = 1; step <= board_sessions_count_max; step += 1) {
      const serial = this.allocation.serial + step

      if (serial > allocation_max) break

      const prefix = this.environment.id_create().slice(0, 10)
      const id = prefix + serial.toString(16).padStart(6, '0')
      assert(board_id_pattern.test(id), 'a generated id is sixteen hex digits')

      if (this.allocation.legacy.includes(id) || this.environment.disk_exists(id)) continue

      assert(this.find(id) === null, 'a new allocation has never been listed')
      return { id, serial }
    }

    return null
  }

  // Write first, then swap. Only a provably uncommitted write is recoverable in-process.
  private commit(
    sessions: readonly BoardSession[],
    owners = this.owners,
    pending = this.pending,
    allocation = this.allocation,
  ): void {
    assert(sessions.length <= board_sessions_count_max, 'sessions are bounded')
    assert(sessions.findIndex((s) => s.id === board_default_id) <= 0, 'legacy ink stays first')
    assert(allocation.serial >= this.allocation.serial, 'issued board identities never roll back')

    if (pending !== null) {
      assert(!owners.has(pending), 'a retired board has no owner')
      assert(!sessions.some((board) => board.id === pending), 'a retired board is not listed')
    }

    const state = {
      format: registry_format,
      sessions,
      owners: Object.fromEntries(owners),
      allocation,
      pending,
    }
    const payload = new TextEncoder().encode(JSON.stringify(state))
    const next = envelope_encode({ kind: 'registry', label, payload })

    try {
      this.environment.disk.write_atomic(file_name, next)
    } catch (error) {
      if (error instanceof AssertionError) throw error

      // An I/O failure after rename is ambiguous. Never let a later commit overwrite a
      // deletion using pre-deletion memory. Restart from the actual durable state instead.
      assert(this.saved_matches(this.saved), 'failed registry commit left the old file intact')
      throw error
    }

    assert(this.saved_matches(next), 'the complete new registry is durable before it is served')
    this.saved = next
    this.sessions = sessions
    this.owners = owners
    this.allocation = allocation
    this.pending = pending
  }

  private saved_matches(expected: Uint8Array | null): boolean {
    try {
      const actual = this.environment.disk.read(file_name)

      if (actual === null || expected === null) return actual === expected

      return Buffer.compare(actual, expected) === 0
    } catch (error) {
      if (error instanceof AssertionError) throw error

      return false
    }
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

  const json = parsed as Record<string, unknown> | null
  const known =
    json?.format === registry_format ||
    json?.format === permanent_home_format ||
    json?.format === legacy_format
  const list = known ? json.sessions : null

  if (!Array.isArray(list) || list.length > board_sessions_count_max) {
    throw new StorageError(`${file_name} is damaged: unknown format or session count`)
  }

  const sessions = list.map(session_read)
  const ids = new Set(sessions.map((session) => session.id))

  const needs_original = json?.format !== registry_format || ids.has(board_default_id)

  if (ids.size !== sessions.length || (needs_original && sessions[0]?.id !== board_default_id)) {
    throw new StorageError(`${file_name} is damaged: inconsistent board identities`)
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

  assert(owners.size <= sessions.length, 'only listed boards have owners')
  assert(used.size === owners.size, 'each owner links to one board')
  const { pending, allocation } = lifecycle_read(json!, ids)
  return { sessions, owners, pending, allocation }
}

function lifecycle_read(json: Record<string, unknown>, ids: Set<string>) {

  // v1 files predate deletion; their ids are the whole legacy set at migration.
  if (json.format === legacy_format) {
    const legacy = [...ids].filter((id) => id !== board_default_id)
    return { allocation: { serial: 0, legacy }, pending: null }
  }

  const pending = json.pending
  const valid_id = (id: unknown): id is string =>
    typeof id === 'string' && id !== board_default_id && board_id_pattern.test(id)

  const retiring_original = json.format === registry_format && pending === board_default_id

  if (pending !== null && ((!valid_id(pending) && !retiring_original) || ids.has(pending))) {
    throw new StorageError('Invalid pending board cleanup.')
  }

  const { serial, legacy } = (json.allocation ?? {}) as Partial<Allocation>

  if (
    typeof serial !== 'number' ||
    !Number.isInteger(serial) ||
    serial < 0 ||
    serial > allocation_max ||
    !Array.isArray(legacy) ||
    legacy.length >= board_sessions_count_max ||
    !legacy.every(valid_id)
  ) {
    throw new StorageError('Invalid board allocation history.')
  }

  for (const id of [...ids, pending]) {
    if (!id || id === board_default_id || legacy.includes(id)) continue

    const issued = parseInt(id.slice(-6), 16)

    if (issued < 1 || issued > serial) throw new StorageError('Unissued board id.')
  }

  return { allocation: { serial, legacy }, pending }
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
