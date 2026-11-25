// The commands. Each one returns a single outcome; printing it is the caller's job.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern, board_query } from '../shared/board_session'
import {
  fetch_attempts_count_max,
  path_status,
  poll_interval_ms,
  port_default,
  stage_open_wait_ms_max,
  start_wait_ms_max,
  stop_wait_ms_max,
} from '../shared/constants'
import type { BoardStatus } from '../server/http'
import { pairing_terminal } from '../server/pairing'
import { server_run } from '../server/server_run'
import { process_alive } from '../server/server_state'
import {
  api_request, board_find, image_fetch, pairing_get, type Found,
} from './board_client'
import {
  browser_open, build, build_stale, data_directory, installed, log_file, log_tail, port_any,
  port_free, repo_root, server_spawn, static_directory,
} from './board_process'
import { exit_codes, failure, success, type Outcome } from './output'

import type { BoardFlags } from './whiteboard_commands'

export type Options = BoardFlags & {
  readonly port: number | null
  readonly no_open: boolean
  readonly out: string | null
  // The cleanup commands: a proposal file, and revisions for compare-and-swap and restore.
  readonly file: string | null
  readonly base_revision: number | null
  readonly revision: number | null
  // The board session a command is about: null for the default board. A name for a board.
  readonly session: string | null
  readonly name: string | null
  // Whether a person is reading: only then is the QR code worth printing.
  readonly terminal: boolean
}

// A running board, and the status of the one board session a command is about.
export type SessionFound = { port: number; status: BoardStatus }

const command_start = 'tldraw-sync start'
const command_fetch = 'tldraw-sync fetch'
const command_stop = 'tldraw-sync stop'
export const command_session_list = 'tldraw-sync session-list --json'
const output_directory_root = path.join(os.tmpdir(), 'tldraw-sync')

// What to add to a suggested command so it stays on the same board: nothing for the default.
export function session_flag(session: string): string {
  assert(board_id_pattern.test(session), 'a board id is well formed')
  return session === board_default_id ? '' : ` --session ${session}`
}

// Where a command writes for a board when it is not told: the default board keeps the paths it
// always had, and every other board has a folder of its own, so two boards never overwrite each
// other's image or snapshot.
export function output_directory(session: string): string {
  assert(board_id_pattern.test(session), 'a board id is well formed')
  const directory = session === board_default_id
    ? output_directory_root
    : path.join(output_directory_root, 'sessions', session)
  assert(path.isAbsolute(directory), 'an output directory is absolute')
  return directory
}

// Finds the running board and the status of the named session, or the outcome that says why
// there is none. The default board's status is the one the board reports anyway.
export async function session_find(session: string | null): Promise<SessionFound | Outcome> {
  const found = await board_find(data_directory())
  if (found.kind !== 'running') return not_running(found)

  const port = found.status.port
  if (session === null || session === board_default_id) return { port, status: found.status }

  const answer = await api_request(port, `${path_status}?${board_query(session)}`, null)
  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })
  if (answer.status === 404) return session_unknown(session)
  if (answer.status !== 200) {
    return failure('board_unavailable', `The board ${session} cannot be opened right now.`,
      { action: 'retry', command: `tldraw-sync status --session ${session} --json` },
      exit_codes.not_ready)
  }

  const status = answer.body as unknown as BoardStatus
  assert(status.session === session, 'the status is of the board asked for')
  return { port, status }
}

export function session_unknown(session: string): Outcome {
  assert(session.length > 0, 'an unknown session is named')
  return failure('unknown_session', `No board has the session id ${session}.`,
    { action: 'run', command: command_session_list })
}

export async function start(options: Options): Promise<Outcome> {
  const directory = data_directory()
  let found = await board_find(directory)
  // Another start may be bringing the board up right now: give it the time a start gets.
  if (found.kind === 'not_responding') found = await running_wait(directory, null)
  if (found.kind === 'not_responding') return not_running(found)
  if (found.kind === 'running') {
    if (options.port !== null && options.port !== found.status.port) {
      return failure('running_on_other_port',
        `The board is already running on port ${found.status.port}.`,
        { action: 'run', command: `${command_stop} && ${command_start} --port ${options.port}` })
    }
    return board_ready(found.status, 'already_running', options)
  }

  const prepared = prepare()
  if (prepared !== null) return prepared
  const port = await port_pick(options.port)
  if (typeof port !== 'number') return port

  const spawned = server_spawn(port, directory)
  const started = await running_wait(directory, spawned)
  if (started.kind !== 'running') {
    const last_line = log_tail(directory).split('\n').at(-1) ?? ''
    return failure('start_failed',
      `The board did not start${last_line === '' ? '' : ` ("${last_line}")`}. `
        + `Its log is ${log_file(directory)}.`,
      { action: 'ask_human', message: `Read ${log_file(directory)} to see why.` })
  }
  assert(started.status.pid === spawned.pid, 'the board that answers is the one started')
  return board_ready(started.status, 'started', options)
}

// Waits for the board to answer: any board, or the one just spawned.
async function running_wait(
  directory: string,
  spawned: { pid: number; exited: () => boolean } | null,
): Promise<Found> {
  let found: Found = { kind: 'not_running' }
  for (let waited_ms = 0; waited_ms < start_wait_ms_max; waited_ms += poll_interval_ms) {
    found = await board_find(directory)
    if (found.kind === 'running' && (spawned === null || found.status.pid === spawned.pid)) {
      return found
    }
    if (spawned !== null && spawned.exited()) return { kind: 'not_running' }
    if (spawned === null && found.kind === 'not_running') return found
    await Bun.sleep(poll_interval_ms)
  }
  return found
}

async function board_ready(status: BoardStatus, code: string, options: Options): Promise<Outcome> {
  assert(code === 'started' || code === 'already_running', 'a board is ready one of two ways')
  const stage_opened = !status.stage_connected && !options.no_open && browser_open(status.stage_url)
  const pairing = options.terminal ? await pairing_get(status.port) : null
  const lines = [
    code === 'started' ? 'The board is running.' : 'The board was already running.',
    '',
    ...(pairing === null ? []
      : ['Scan with the iPad camera to draw:', '', pairing_terminal(pairing), '']),
    `  Draw      ${status.draw_url}`,
    `  Present   ${status.stage_url}${stage_opened ? '  (opened in your browser)' : ''}`,
    `  Fetch     ${command_fetch}`,
    '',
    `It runs in the background. Stop it with: ${command_stop}`,
  ]
  return success(code, lines.join('\n'), status.draw_url, {
    pid: status.pid,
    port: status.port,
    draw_url: status.draw_url,
    stage_url: status.stage_url,
    stage_opened,
    log_file: log_file(data_directory()),
  })
}

// Dependencies installed and the client built from the current sources.
export function prepare(): Outcome | null {
  if (!installed()) {
    return failure('not_installed', 'Dependencies are not installed.',
      { action: 'run', command: `cd ${repo_root} && bun install` })
  }
  if (build_stale() && !build().ok) {
    return failure('build_failed', 'The client did not build.',
      { action: 'ask_human', message: `Run \`bun run build\` in ${repo_root} to see why.` })
  }
  return null
}

export async function port_pick(requested: number | null): Promise<number | Outcome> {
  if (requested !== null) {
    if (await port_free(requested)) return requested
    return failure('port_busy', `Port ${requested} is taken by another program.`,
      { action: 'run', command: command_start })
  }
  if (await port_free(port_default)) return port_default
  return port_any()
}

export function not_running(found: Found): Outcome {
  assert(found.kind !== 'running', 'only a board that is not running is reported so')
  if (found.kind === 'not_responding') {
    const { pid, port } = found.state
    return failure('not_responding',
      `A board process (pid ${pid}) holds port ${port} but does not answer.`,
      { action: 'ask_human', message: `Stop process ${pid}, then run ${command_start}.` })
  }
  return failure('not_running', 'The board is not running.',
    { action: 'run', command: command_start }, exit_codes.not_running)
}

export async function status(options: Options): Promise<Outcome> {
  const found = await session_find(options.session)
  if ('kind' in found) return found
  const board = found.status
  const name = board.session_name === null ? 'untitled' : `“${board.session_name}”`
  const human = [
    `The board is running on port ${board.port} (pid ${board.pid}).`,
    `  Board     ${board.session} (${name})`,
    `  Draw      ${board.draw_url}  ${board.pen_connected ? 'iPad connected' : 'no iPad'}`,
    `  Present   ${board.stage_url}  ${board.stage_connected ? 'open' : 'not open'}`,
    `  Drawing   ${board.shapes_count} ${board.shapes_count === 1 ? 'shape' : 'shapes'}`,
    `  Cleaned   ${cleaned_text(board)}`,
  ].join('\n')
  const { app: _, ...data } = board
  return success('running', human, board.draw_url, data)
}

function cleaned_text(board: BoardStatus): string {
  if (board.cleaned_revision === 0) return 'none'
  const stale = board.cleaned_stale ? ', the sketch changed since' : ''
  return `revision ${board.cleaned_revision}${stale}`
}

export async function stop(): Promise<Outcome> {
  const found = await board_find(data_directory())
  if (found.kind === 'not_running') {
    return success('already_stopped', 'The board was not running.', '', {})
  }
  if (found.kind === 'not_responding') return not_running(found)

  const { pid } = found.status
  process.kill(pid, 'SIGTERM')
  for (let waited_ms = 0; waited_ms < stop_wait_ms_max; waited_ms += poll_interval_ms) {
    if (!process_alive(pid)) return success('stopped', 'The board is saved and stopped.', '', {})
    await Bun.sleep(poll_interval_ms)
  }
  return failure('stop_timeout', `The board (pid ${pid}) did not stop in time.`,
    { action: 'ask_human', message: `Stop process ${pid}.` })
}

export async function fetch_drawing(options: Options): Promise<Outcome> {
  const image = await image_current(options)
  if ('kind' in image) return image
  assert(image.bytes.byteLength > 0, 'a fetch ends in an image or an outcome')
  const out = options.out ?? path.join(output_directory(image.session), 'drawing.png')
  return image_save(image.bytes, image.document_hash, image.session, out)
}

export type ImageCurrent = {
  bytes: Uint8Array
  document_hash: string
  port: number
  session: string
}

// The image of the drawing as it is now, opening the Mac page to render it if needed.
export async function image_current(options: Options): Promise<ImageCurrent | Outcome> {
  const found = await session_find(options.session)
  if ('kind' in found) return found
  const { port } = found
  const session = found.status.session
  const retry = `${command_fetch}${session_flag(session)} --json`
  let stage_opened = false

  for (let attempt = 0; attempt < fetch_attempts_count_max; attempt += 1) {
    const image = await image_fetch(port, session)
    if (image.kind === 'image') {
      return { bytes: image.bytes, document_hash: image.document_hash, port, session }
    }
    if (image.kind === 'unreachable') return not_running({ kind: 'not_running' })
    if (image.kind === 'empty') {
      return failure('board_empty', 'The board is empty.',
        { action: 'ask_human', message: 'Draw something on the iPad, then ask again.' },
        exit_codes.board_empty)
    }
    // The image is behind the drawing. Without the board's Mac page, nothing will render it.
    const board = await session_find(session)
    if ('kind' in board) return board
    if (!board.status.stage_connected) {
      const opened = await stage_open(board.status, options.no_open, stage_opened)
      if (opened !== null) return opened
      stage_opened = true
    }
  }
  return failure('image_not_ready', 'The Mac page did not render the drawing in time.',
    { action: 'retry', command: retry }, exit_codes.not_ready)
}

// Opens the Mac page and waits for it to connect. Returns a failure, or null once connected.
async function stage_open(
  board: BoardStatus,
  no_open: boolean,
  opened_before: boolean,
): Promise<Outcome | null> {
  const ask = `Open ${board.stage_url} in a browser on the Mac, then ask again.`
  if (no_open) {
    return failure('stage_closed',
      'The drawing changed, and the Mac page that renders it is closed.',
      { action: 'ask_human', message: ask }, exit_codes.not_ready)
  }
  if (!opened_before && !browser_open(board.stage_url)) {
    return failure('stage_closed', 'The Mac page that renders the drawing could not be opened.',
      { action: 'ask_human', message: ask }, exit_codes.not_ready)
  }
  for (let waited_ms = 0; waited_ms < stage_open_wait_ms_max; waited_ms += poll_interval_ms) {
    const found = await session_find(board.session)
    if ('kind' in found) return found
    if (found.status.stage_connected) return null
    await Bun.sleep(poll_interval_ms)
  }
  return failure('image_not_ready', 'The Mac page was opened but did not connect in time.',
    { action: 'ask_human', message: ask }, exit_codes.not_ready)
}

function image_save(
  bytes: Uint8Array,
  document_hash: string,
  session: string,
  out: string,
): Outcome {
  assert(bytes.byteLength > 0, 'an image is never empty')
  assert(out.length > 0, 'an image is saved somewhere')
  const file = path.resolve(out)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Written aside and renamed, so a reader never sees half an image.
  const partial = `${file}.${process.pid}.partial`
  fs.writeFileSync(partial, bytes)
  fs.renameSync(partial, file)
  assert(fs.statSync(file).size === bytes.byteLength, 'the saved image is complete')
  return success('image_saved', `Saved the drawing to ${file}`, file, {
    path: file,
    session,
    document_hash,
    bytes_count: bytes.byteLength,
  })
}

// Runs the board in this process. The process stays alive for as long as the server listens.
export async function serve(options: Options): Promise<Outcome> {
  const directory = data_directory()
  const found = await board_find(directory)
  if (found.kind !== 'not_running') {
    return failure('already_running', 'A board is already running for this data directory.',
      { action: 'run', command: command_stop })
  }
  const prepared = prepare()
  if (prepared !== null) return prepared
  const port = await port_pick(options.port)
  if (typeof port !== 'number') return port

  const result = server_run({ port, data_directory: directory, static_directory })
  if (result.kind === 'held') {
    return failure('already_running', `A board (pid ${result.state.pid}) is already running.`,
      { action: 'run', command: command_stop })
  }
  if (result.kind === 'port_busy') {
    return failure('port_busy', `Port ${port} is taken by another program.`,
      { action: 'run', command: command_start })
  }
  if (result.kind === 'not_built') {
    return failure('build_failed', 'The client has not been built.',
      { action: 'ask_human', message: `Run \`bun run build\` in ${repo_root}.` })
  }
  if (result.kind === 'storage_damaged') {
    return failure('storage_damaged', `${result.message} Nothing was overwritten.`,
      { action: 'ask_human', message: `Move ${directory} aside to start an empty board.` })
  }

  assert(result.kind === 'serving', 'every other result was handled')
  const stage_url = `http://localhost:${result.port}`
  const lines = [
    ...(options.terminal ? ['Scan with the iPad camera to draw:', '',
      pairing_terminal(result.pairing), ''] : []),
    `  Draw      ${result.pairing.url}`,
    `  Present   ${stage_url}`,
    `  Fetch     ${command_fetch}`,
    '',
    'Serving until Ctrl-C.',
  ]
  return success('serving', lines.join('\n'), result.pairing.url, {
    pid: process.pid,
    port: result.port,
    draw_url: result.pairing.url,
    stage_url,
  })
}
