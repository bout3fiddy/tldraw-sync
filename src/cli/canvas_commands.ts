// What an agent's host runs against the Agent canvas of a linked board: read a coherent
// snapshot of the sketch and the canvas, have a draft scene rendered without publishing it,
// publish a scene, and bring back an earlier revision. None of them calls a model or changes
// the sketch, and nothing is laid out here: the scene goes to the board as it was written.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern, board_query } from '../shared/board_session'
import type { SketchSnapshot } from '../shared/canvas_types'
import {
  path_cleaned_restore,
  preview_attempts_count_max,
  preview_wait_ms_max,
  proposal_size_bytes_max,
  snapshot_attempts_count_max,
  status_timeout_ms,
} from '../shared/constants'
import { png_blank, png_signed, png_size } from '../shared/png'
import { scene_format } from '../shared/scene_types'
import { whiteboard_path } from '../shared/whiteboard'
import { api_request, type ApiAnswer } from './board_client'
import {
  command_session_list,
  image_current,
  not_running,
  output_directory,
  session_find,
  stage_open,
  type ImageCurrent,
  type Options,
  type SessionFound,
} from './commands'
import { exit_codes, failure, success, type Outcome } from './output'
import { file_read_bounded } from './proposal_reader'
import {
  scene_capabilities,
  scene_controls_from_json,
  scene_states_count,
  view_state_flag_read,
  type ViewStateFlag,
} from './scene_capabilities'
import { canvas_prompt, scene_schema_text } from './scene_prompt'
import { strokes_summarize } from './stroke_summary'
import { binding_headers, machine_headers, type Scope } from './whiteboard_scope'

type Answer = Extract<ApiAnswer, { kind: 'answer' }>

const command_publish_help = 'tldraw-sync whiteboard-publish --help'

function quote(pathname: string): string {
  return "'" + pathname.replaceAll("'", "'\\''") + "'"
}

function command_bound(
  action: string,
  scope: Scope,
  file: string | null,
  state: string | null = null,
): string {
  assert(action.length > 0, 'a command is named')
  assert(state === null || action === 'preview', 'only a preview names a view')
  const proposal = file === null ? '' : ` --file ${quote(file)}`
  const view = state === null ? '' : ` --state ${quote(state)}`
  return `tldraw-sync whiteboard-${action} --binding ${quote(scope.file)}${proposal}${view} --json`
}

// The image and the records come from two requests. The records are served only for the
// document the image showed, so a sketch that moves on in between is caught and read again.
export async function canvas_snapshot(options: Options, scope: Scope): Promise<Outcome> {
  for (let attempt = 0; attempt < snapshot_attempts_count_max; attempt += 1) {
    const image = await sketch_image(options)

    if ('kind' in image) return image

    const query = `?document_hash=${image.document_hash}&${board_query(image.session)}`
    const route = `${whiteboard_path}snapshot${query}`
    const answer = await api_request(image.port, route, null, binding_headers(scope.binding))

    if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

    if (answer.status === 409) continue

    if (answer.status !== 200) return answer_failure(answer, scope)

    const snapshot = answer.body as unknown as SketchSnapshot
    assert(snapshot.document_hash === image.document_hash, 'records match their image')
    assert(snapshot.session === image.session, 'records are of the board asked for')

    // A board from before controls sends none; one that sends a list it cannot have is wrong.
    const controls = scene_controls_from_json(snapshot.scene_controls)

    if (controls === null) return reply_unexpected('snapshot')

    const states_count = scene_states_count(controls)
    return snapshot_save(image.bytes, snapshot, options.out, scope, states_count)
  }

  return failure(
    'sketch_busy',
    'The sketch kept changing while the snapshot was taken.',
    { action: 'retry', command: command_bound('snapshot', scope, null) },
    exit_codes.not_ready,
  )
}

// The image of the sketch as it is now. A board with nothing drawn on it still has a
// snapshot: an agent can draw on its canvas whatever the sketch holds. Its image is a blank
// page.
async function sketch_image(options: Options): Promise<ImageCurrent | Outcome> {
  const image = await image_current(options)

  if (!('kind' in image)) return image

  if (image.kind !== 'failure' || image.code !== 'board_empty') return image

  const found = await session_find(options.session)

  if ('kind' in found) return found

  // Drawn on in the meantime: there is an image to wait for after all.
  if (found.status.shapes_count !== 0) return image_current(options)

  const { session, document_hash } = found.status
  return { bytes: png_blank(), document_hash, port: found.port, session }
}

type SnapshotFiles = {
  image_path: string
  records_path: string
  strokes_path: string
  scene_path: string
  capabilities_path: string
  strokes_truncated: boolean
}

// Everything an agent reads, written aside and renamed, in one new private directory. The
// scene file is a proposal ready to edit: what the canvas holds, tied to this snapshot.
function snapshot_files_write(
  directory: string,
  png: Uint8Array,
  snapshot: SketchSnapshot,
): SnapshotFiles {
  assert(path.isAbsolute(directory), 'a snapshot directory is absolute')
  const image_path = path.join(directory, 'sketch.png')
  const records_path = path.join(directory, 'sketch.json')
  const strokes_path = path.join(directory, 'strokes.json')
  const scene_path = path.join(directory, 'scene.json')
  const capabilities_path = path.join(directory, 'capabilities.json')
  const records = snapshot.records as unknown as Array<Record<string, unknown>>
  const summaries = strokes_summarize(records)
  const { document_hash, session, bounds, agent_revision, scene } = snapshot
  file_write_atomic(image_path, png)
  json_write(records_path, { snapshot: document_hash, bounds, records: snapshot.records })
  json_write(strokes_path, { snapshot: document_hash, ...summaries })
  json_write(capabilities_path, scene_capabilities)

  // The scene is handed back whole: its controls go with the elements that name them, so the
  // file publishes again as it is. A scene without controls is written as it always was.
  const controls = scene === null ? [] : (snapshot.scene_controls ?? [])
  const proposal = {
    format: scene_format,
    session,
    snapshot: document_hash,
    base_revision: agent_revision,
    basis: 'sketch',
    ...(controls.length === 0 ? {} : { controls }),
    elements: scene ?? [],
  }
  file_write_atomic(scene_path, new TextEncoder().encode(`${JSON.stringify(proposal, null, 2)}\n`))
  assert(fs.statSync(scene_path).size > 0, 'the scene file was written')
  assert(scene !== null || controls.length === 0, 'controls belong to a scene')
  const strokes_truncated = summaries.truncated
  const paths = { image_path, records_path, strokes_path, scene_path, capabilities_path }
  return { ...paths, strokes_truncated }
}

function snapshot_directory(session: string, out: string | null): string {
  assert(board_id_pattern.test(session), 'a snapshot is of a board')
  const root = path.resolve(out ?? path.join(output_directory(session), 'canvas'))
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = fs.mkdtempSync(path.join(root, 'canvas-'))
  assert(path.isAbsolute(directory), 'a snapshot directory is absolute')
  return directory
}

function snapshot_save(
  png: Uint8Array,
  snapshot: SketchSnapshot,
  out: string | null,
  scope: Scope,
  states_count: number,
): Outcome {
  assert(states_count >= 1, 'a canvas has at least one view')
  const directory = snapshot_directory(snapshot.session, out)
  const files = snapshot_files_write(directory, png, snapshot)
  const image = png_size(png)
  const { bounds, image_padding, session, title_wanted, canvas_legacy } = snapshot
  const mapping =
    bounds === null || image === null
      ? null
      : {
          x0: bounds.x - image_padding,
          y0: bounds.y - image_padding,
          ppu: image.width_px / (bounds.w + image_padding * 2),
        }
  const preview_command = command_bound('preview', scope, files.scene_path)
  const publish_command = command_bound('publish', scope, files.scene_path)
  const base_revision = snapshot.agent_revision
  const prompt = canvas_prompt({
    ...files,
    mapping,
    snapshot: snapshot.document_hash,
    base_revision,
    session,
    title_wanted,
    scene_held: snapshot.scene !== null,
    canvas_legacy,
    preview_command,
    publish_command,
  })
  return success('snapshot_saved', `${prompt}\n`, files.image_path, {
    session,
    title_wanted,
    path: files.image_path,
    ...files,
    snapshot: snapshot.document_hash,
    document_hash: snapshot.document_hash,
    base_revision,
    agent_revision: base_revision,
    agent_history: snapshot.agent_history,
    agent_source_hash: snapshot.agent_source_hash,
    canvas: { revision: base_revision, editable: snapshot.scene !== null, legacy: canvas_legacy },
    shapes_count: snapshot.records.filter((record) => record.typeName === 'shape').length,
    bounds,
    image,
    mapping,
    scene_controls: snapshot.scene_controls ?? [],
    states_count,
    schema: scene_schema_text,
    capabilities: scene_capabilities,
    prompt,
    preview_command,
    publish_command,
  })
}

function reply_unexpected(command: string): Outcome {
  assert(command.length > 0, 'a command is named')
  return failure('invalid_response', 'Unexpected response from the board.', {
    action: 'ask_human',
    message: `Upgrade the Mac board, then run whiteboard-${command} again.`,
  })
}

function json_write(file: string, value: object): void {
  assert(path.isAbsolute(file), 'files are written by absolute path')
  file_write_atomic(file, new TextEncoder().encode(JSON.stringify(value)))
}

// The scene in `--file`, as text, once it is known to be JSON that names this board. The
// board checks everything else, whole, before anything changes.
function scene_read(options: Options, scope: Scope, command: string): string | Outcome {
  const help = `tldraw-sync ${command} --help`

  if (options.file === null || options.file === '-') {
    return failure('usage_error', 'Name the scene file with --file <path>.', {
      action: 'fix_usage',
      command: help,
    })
  }

  // Reading stops at the first byte past the limit, so a large or endless file costs no more
  // than the limit in memory or time.
  const read = file_read_bounded(options.file, proposal_size_bytes_max)

  if (read.kind !== 'read') {
    const large = read.kind === 'too_large'
    const message = large
      ? `The scene is larger than ${proposal_size_bytes_max} bytes.`
      : `The scene file ${options.file} cannot be read. It must be a regular file.`
    const fix = { action: 'fix_usage', command: help } as const
    return failure(large ? 'scene_too_large' : 'scene_unreadable', message, fix)
  }

  const text = new TextDecoder().decode(read.bytes)
  const session = session_peek(text)

  if (session === undefined) {
    return failure('invalid_scene', 'The scene is not a JSON object.', {
      action: 'fix_usage',
      command: help,
    })
  }

  if (session !== scope.binding.session) {
    return failure(
      'session_mismatch',
      'The scene does not name this bound board.',
      { action: 'run', command: command_bound('snapshot', scope, null) },
      exit_codes.conflict,
    )
  }

  assert(text.length <= proposal_size_bytes_max, 'a read scene is bounded')
  return text
}

// The board a scene says it was made for: null when it names none, undefined when the text
// is not a JSON object at all.
function session_peek(text: string): string | null | undefined {
  let json: unknown = null

  try {
    json = JSON.parse(text) as unknown
  } catch {
    return undefined
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined

  const session = (json as Record<string, unknown>).session
  return typeof session === 'string' && board_id_pattern.test(session) ? session : null
}

// Publishes the scene as the whole Agent canvas of the bound board, in one step.
export async function canvas_publish(options: Options, scope: Scope): Promise<Outcome> {
  const text = scene_read(options, scope, 'whiteboard-publish')

  if (typeof text !== 'string') return text

  const found = await session_find(scope.binding.session)

  if ('kind' in found) return found

  const session = found.status.session
  const route = `${whiteboard_path}publish?${board_query(session)}`
  const answer = await api_request(found.port, route, text, binding_headers(scope.binding))

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer, scope)

  const revision = Number(answer.body.revision)
  assert(Number.isInteger(revision) && revision > 0, 'a publish names its revision')
  return success('published', `Published Agent canvas revision ${revision}.`, String(revision), {
    session,
    revision,
    shapes_count: answer.body.shapes_count,
    records_hash: answer.body.records_hash,
    title_applied: answer.body.title_applied === true,
  })
}

// Has the Mac stage render the scene exactly as a publish would save it, and saves the
// picture. Nothing is published: the canvas, its revision and the sketch stay as they are.
// With `--state`, the view of the draft that state names; without, the view a publish saves.
export async function canvas_preview(options: Options, scope: Scope): Promise<Outcome> {
  const help = { action: 'fix_usage', command: 'tldraw-sync whiteboard-preview --help' } as const
  const flag = view_state_flag_read(options.state)

  if (flag.kind === 'invalid') return failure('invalid_state', flag.message, help)

  const text = scene_read(options, scope, 'whiteboard-preview')

  if (typeof text !== 'string') return text

  const found = await session_find(scope.binding.session)

  if ('kind' in found) return found

  const session = found.status.session
  const view = flag.kind === 'selected' ? `&state=${encodeURIComponent(flag.text)}` : ''
  const route = `${whiteboard_path}preview?${board_query(session)}${view}`
  const answer = await api_request(found.port, route, text, binding_headers(scope.binding))

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer, scope)

  const { preview, records_hash, shapes_count, base_revision, snapshot } = answer.body
  const shown = preview_state(answer.body, flag)

  if (typeof preview !== 'string' || typeof records_hash !== 'string' || shown === null) {
    return reply_unexpected('preview')
  }

  const state_text = flag.kind === 'selected' ? flag.text : null
  const image = await preview_image(found, scope, preview, options, state_text)

  if ('kind' in image) return image

  const default_file = path.join(output_directory(session), 'preview', `${records_hash}.png`)
  const image_path = path.resolve(options.out ?? default_file)
  fs.mkdirSync(path.dirname(image_path), { recursive: true })
  file_write_atomic(image_path, image.bytes)
  const facts = { preview, records_hash, shapes_count, base_revision, snapshot }
  const named = flag.kind === 'selected' ? ` of view ${JSON.stringify(shown.state)}` : ''
  const human = `Saved the draft's rendering${named} to ${image_path}`
  return success('preview_saved', human, image_path, {
    session,
    image_path,
    path: image_path,
    ...facts,
    view: flag.kind,
    ...shown,
    image: png_size(image.bytes),
    published: false,
  })
}

type PreviewState = { state: Readonly<Record<string, unknown>> | null; states_count: number | null }

// What a board from before controls answers for the view a publish saves.
const preview_unnamed: PreviewState = { state: null, states_count: null }

// The view the board drew, as it names it. A board that drew some other view than the one
// asked for, or that cannot draw a chosen view at all, is not believed: nothing is saved.
function preview_state(
  body: Answer['body'],
  flag: Exclude<ViewStateFlag, { kind: 'invalid' }>,
): PreviewState | null {
  const state = body.state
  const states_count = body.states_count
  const named = state !== null && typeof state === 'object' && !Array.isArray(state)
  const counted = Number.isSafeInteger(states_count) && (states_count as number) >= 1

  if (flag.kind === 'rest') {
    if (!named || !counted) return preview_unnamed

    return { state: state as Record<string, unknown>, states_count: states_count as number }
  }

  if (!named || !counted) return null

  const drawn = state as Record<string, unknown>
  const same = Object.entries(flag.state).every(([control, value]) => drawn[control] === value)
  return same ? { state: drawn, states_count: states_count as number } : null
}

// The stage's rendering of one draft. The board waits on each request; the stage is opened
// when it is not connected, as it is for the sketch's own image.
async function preview_image(
  found: SessionFound,
  scope: Scope,
  preview: string,
  options: Options,
  state_text: string | null,
): Promise<{ bytes: Uint8Array } | Outcome> {
  const session = found.status.session
  const route = `${whiteboard_path}preview-image?id=${preview}&${board_query(session)}`
  const retry = command_bound('preview', scope, options.file, state_text)
  let stage_opened = false

  for (let attempt = 0; attempt < preview_attempts_count_max; attempt += 1) {
    const fetched = await image_request(found.port, route, binding_headers(scope.binding))

    if (fetched.kind === 'image') return { bytes: fetched.bytes }

    if (fetched.kind === 'unreachable') return not_running({ kind: 'not_running' })

    if (fetched.kind === 'answer' && fetched.status !== 503) return answer_failure(fetched, scope)

    // Not rendered yet. Without the board's Mac page, nothing will render it.
    const board = await session_find(session)

    if ('kind' in board) return board

    if (!board.status.stage_connected) {
      const opened = await stage_open(board.status, options.no_open, stage_opened)

      if (opened !== null) return opened

      stage_opened = true
    }
  }

  return failure(
    'preview_not_ready',
    'The Mac stage did not render the draft in time.',
    { action: 'retry', command: retry },
    exit_codes.not_ready,
  )
}

type ImageAnswer = { kind: 'image'; bytes: Uint8Array } | ApiAnswer

// One request for a PNG. Any other answer is the board's JSON error.
async function image_request(
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<ImageAnswer> {
  assert(pathname.startsWith('/api/'), 'only the board API is asked')
  let response: Response

  try {
    response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers,
      redirect: 'error',

      // The board itself waits up to `preview_wait_ms_max` for the stage.
      signal: AbortSignal.timeout(preview_wait_ms_max + status_timeout_ms * 2),
    })
  } catch {
    return { kind: 'unreachable' }
  }

  if (response.status === 200) {
    const bytes = new Uint8Array(await response.arrayBuffer())

    if (png_signed(bytes)) return { kind: 'image', bytes }

    return { kind: 'answer', status: 502, body: { code: 'invalid_response' } }
  }

  let body: unknown = null

  try {
    body = await response.json()
  } catch {
    body = null
  }

  const object = body !== null && typeof body === 'object' && !Array.isArray(body)
  return { kind: 'answer', status: response.status, body: object ? (body as Answer['body']) : {} }
}

// Brings back an earlier revision as a new one. It works on any board, linked or not: a board
// keeps its history whatever format its revisions were published in.
export async function canvas_restore(options: Options): Promise<Outcome> {
  if (options.base_revision === null) {
    return failure('usage_error', 'Name the current canvas revision with --base-revision <n>.', {
      action: 'fix_usage',
      command: 'tldraw-sync cleanup-restore --help',
    })
  }

  const found = await session_find(options.session)

  if ('kind' in found) return found

  const session = found.status.session
  const body = JSON.stringify({ base_revision: options.base_revision, revision: options.revision })
  const pathname = `${path_cleaned_restore}?${board_query(session)}`
  const headers = found.status.linked ? machine_headers() : undefined
  const answer = await api_request(found.port, pathname, body, headers)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer, null, session)

  const revision = Number(answer.body.revision)
  const restored_from = Number(answer.body.restored_from)
  assert(revision > restored_from, 'a restore makes a newer revision')
  return success(
    'restored',
    `Restored revision ${restored_from} as revision ${revision}.`,
    String(revision),
    { session, revision, restored_from },
  )
}

// The board's own error codes are passed on, each with what to do about it.
function answer_failure(answer: Answer, scope: Scope | null, session = board_default_id): Outcome {
  const status_flag = ` --session ${session}`
  const again =
    scope === null
      ? `tldraw-sync status${status_flag} --json`
      : command_bound('snapshot', scope, null)
  const code = typeof answer.body.code === 'string' ? answer.body.code : 'request_failed'
  const message_raw =
    typeof answer.body.message === 'string'
      ? answer.body.message
      : `The board answered ${answer.status}.`
  const message = message_raw.endsWith('.') ? message_raw : `${message_raw}.`

  // A scene for another board is a conflict like a stale one: snapshot this board afresh.
  if (code === 'sketch_changed' || code === 'revision_conflict' || code === 'session_mismatch') {
    return failure(code, message, { action: 'run', command: again }, exit_codes.conflict)
  }

  if (code === 'unknown_session') {
    return failure(code, message, { action: 'run', command: command_session_list })
  }

  if (code === 'boards_busy' || code === 'unknown_preview') {
    return failure(code, message, { action: 'retry', command: again }, exit_codes.not_ready)
  }

  // A view the draft does not have: the message names the control or value.
  if (code === 'invalid_state') {
    return failure(code, message, {
      action: 'fix_usage',
      command: 'tldraw-sync whiteboard-preview --help',
    })
  }

  if (code === 'invalid_scene' || code === 'invalid_json' || code === 'too_large') {
    return failure(code === 'too_large' ? 'scene_too_large' : 'invalid_scene', message, {
      action: 'fix_usage',
      command: command_publish_help,
    })
  }

  if (code === 'nothing_to_restore') {
    return failure(code, message, {
      action: 'ask_human',
      message: 'There is no earlier revision of the canvas to restore.',
    })
  }

  return failure(/^[a-z_]+$/.test(code) ? code : 'request_failed', message, {
    action: 'retry',
    command: again,
  })
}

// Written aside and renamed, so a reader never sees half a file.
function file_write_atomic(file: string, bytes: Uint8Array): void {
  assert(path.isAbsolute(file), 'files are written by absolute path')
  const partial = `${file}.${process.pid}.partial`
  fs.writeFileSync(partial, bytes)
  fs.renameSync(partial, file)
  assert(fs.statSync(file).size === bytes.byteLength, 'the written file is complete')
}
