// The cleanup commands an external agent runs. They read a coherent snapshot of the sketch,
// compose the agent's semantic diagram into a styled one, publish it, and restore an earlier
// cleanup. They never call a model and never change the sketch: the agent running them reads
// the sketch, and the composer lays out what the agent said it means.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'
import {
  path_cleaned_json,
  path_cleaned_restore,
  path_sketch_json,
  proposal_size_bytes_max,
  snapshot_attempts_count_max,
} from '../shared/constants'
import { board_default_id, board_id_pattern, board_query } from '../shared/board_session'
import { diagram_format, type SketchSnapshot } from '../shared/cleanup_types'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { api_request, type ApiAnswer } from './board_client'
import { whiteboard_path } from '../shared/whiteboard'
import { binding_headers, machine_headers, type Scope } from './whiteboard_scope'
import { canvas_prompt, cleanup_prompt } from './cleanup_prompt'
import {
  command_session_list,
  image_current,
  not_running,
  output_directory,
  session_find,
  session_flag,
  type ImageCurrent,
  type Options,
} from './commands'
import { diagram_compose, type Composed } from './diagram_compose'
import {
  canvas_previous,
  drawing_sizes,
  sketch_file_beside,
  sketch_file_name,
} from './diagram_ink'
import { exit_codes, failure, success, type Outcome } from './output'
import { file_read_bounded, stream_read_bounded } from './proposal_reader'
import { strokes_summarize } from './stroke_summary'

const command_publish_help = 'tldraw-sync cleanup-publish --help'
const command_compose_help = 'tldraw-sync cleanup-compose --help'

// The snapshot command for a board, as a next action names it.
function command_snapshot(session: string): string {
  return `tldraw-sync cleanup-snapshot${session_flag(session)} --json`
}

function cleanup_directory(session: string): string {
  return path.join(output_directory(session), 'cleanup')
}

// The image and the records come from two requests. The records are served only for the
// document the image showed, so a sketch that moves on in between is caught and read again.
export async function cleanup_snapshot(options: Options, scope?: Scope): Promise<Outcome> {
  const session = options.session ?? board_default_id

  for (let attempt = 0; attempt < snapshot_attempts_count_max; attempt += 1) {
    const image = await sketch_image(options, scope)

    if ('kind' in image) return image

    const query = `?document_hash=${image.document_hash}&${board_query(image.session)}`
    const route = scope
      ? `${whiteboard_path}snapshot${query}&layer=${scope.layer}`
      : `${path_sketch_json}${query}`
    const headers = scope ? binding_headers(scope.binding) : undefined
    const answer = await api_request(image.port, route, null, headers)

    if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

    if (answer.status === 409) continue

    if (answer.status !== 200) return answer_failure(answer, image.session, scope)

    const snapshot = answer.body as SketchSnapshot
    assert(snapshot.document_hash === image.document_hash, 'records match their image')
    assert(snapshot.session === image.session, 'records are of the board asked for')
    return snapshot_save(image.bytes, snapshot, options.out, scope)
  }

  const retry = scope ? scoped_snapshot_command(scope) : command_snapshot(session)
  return failure(
    'sketch_busy',
    'The sketch kept changing while the snapshot was taken.',
    { action: 'retry', command: retry },
    exit_codes.not_ready,
  )
}

// A blank page: what a sketch with nothing on it looks like. 64 by 64 white pixels.
const png_blank_base64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAAKUlEQVR42u3MQREAAAwCIPuX1hD77SAA6VEEAoFA' +
  'IBAIBAKBQCAQfA8Gpwvw4qrwDDIAAAAASUVORK5CYII='

// The image of the sketch as it is now. A bound board with nothing drawn on it still has a
// snapshot: the faithful copy of an empty sketch is an empty canvas, and an agent can publish
// one only from a snapshot. Its image is a blank page. Without a binding an empty board is
// still an error, since there is nothing to clean up and the person is asked to draw.
async function sketch_image(options: Options, scope?: Scope): Promise<ImageCurrent | Outcome> {
  const image = await image_current(options)

  if (!scope || !('kind' in image)) return image

  if (image.kind !== 'failure' || image.code !== 'board_empty') return image

  const found = await session_find(options.session)

  if ('kind' in found) return found

  // Drawn on in the meantime: there is an image to wait for after all.
  if (found.status.shapes_count !== 0) return image_current(options)

  const bytes = new Uint8Array(Buffer.from(png_blank_base64, 'base64'))
  assert(png_size(bytes) !== null, 'the blank page is a PNG')
  const { session, document_hash } = found.status
  return { bytes, document_hash, port: found.port, session }
}

type SnapshotFiles = {
  image_path: string
  records_path: string
  strokes_path: string
  previous_path: string | null
  strokes_truncated: boolean
}

// Everything an agent reads, written aside and renamed, in one directory.
function snapshot_files_write(
  directory: string,
  png: Uint8Array,
  snapshot: SketchSnapshot,
): SnapshotFiles {
  assert(path.isAbsolute(directory), 'a snapshot directory is absolute')
  fs.mkdirSync(directory, { recursive: true })
  const image_path = path.join(directory, 'sketch.png')
  const records_path = path.join(directory, sketch_file_name)
  const strokes_path = path.join(directory, 'strokes.json')
  const previous_path = path.join(directory, 'diagram_previous.json')
  const records = snapshot.records as unknown as Array<Record<string, unknown>>
  const summaries = strokes_summarize(records)
  file_write_atomic(image_path, png)

  // `canvas_previous` is what the canvas holds now: the command line sizes a drawing that is
  // carried over with it once its strokes are gone from the sketch (see `diagram_ink.ts`).
  json_write(records_path, {
    snapshot: snapshot.document_hash,
    bounds: snapshot.bounds,
    records: snapshot.records,
    canvas_previous: canvas_previous(snapshot.diagram_previous, snapshot.drawings_previous ?? []),
  })
  json_write(strokes_path, { snapshot: snapshot.document_hash, ...summaries })

  // A previous interpretation from an older snapshot must not be mistaken for this one's. An
  // empty canvas has nothing to edit, so it is not offered either.
  const previous = snapshot.diagram_previous?.nodes.length ? snapshot.diagram_previous : null

  if (previous === null) fs.rmSync(previous_path, { force: true })
  else json_write(previous_path, { format: diagram_format, ...previous })

  return {
    image_path,
    records_path,
    strokes_path,
    previous_path: previous === null ? null : previous_path,
    strokes_truncated: summaries.truncated,
  }
}

function snapshot_directory(session: string, out: string | null, scope?: Scope): string {
  const root = path.resolve(out ?? cleanup_directory(session))

  if (!scope) return root

  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return fs.mkdtempSync(path.join(root, `${scope.layer}-`))
}

function snapshot_save(
  png: Uint8Array,
  snapshot: SketchSnapshot,
  out: string | null,
  scope?: Scope,
): Outcome {
  const directory = snapshot_directory(snapshot.session, out, scope)
  const base_revision = snapshot.cleaned_revision
  const { image_path, records_path, strokes_path, previous_path, strokes_truncated } =
    snapshot_files_write(directory, png, snapshot)
  const proposal_path = path.join(directory, 'proposal.json')
  const diagram_path = path.join(directory, 'diagram.json')
  const image = png_size(png)
  const mapping =
    snapshot.bounds === null || image === null
      ? null
      : {
          x0: snapshot.bounds.x - snapshot.image_padding,
          y0: snapshot.bounds.y - snapshot.image_padding,
          ppu: image.width_px / (snapshot.bounds.w + snapshot.image_padding * 2),
        }
  const facts = {
    image_path,
    records_path,
    strokes_path,
    diagram_path,
    previous_path,
    mapping,
    snapshot: snapshot.document_hash,
    base_revision,
    session: snapshot.session,
    title_wanted: snapshot.title_wanted,
  }
  const publish_flags = `${session_flag(snapshot.session)} --file ${diagram_path} --json`
  const publish_command = scope
    ? `tldraw-sync whiteboard-publish --binding ${quote(scope.file)} ` +
      `--layer ${scope.layer} --file ${quote(diagram_path)} --json`
    : `tldraw-sync cleanup-publish${publish_flags}`
  const shapes_count = snapshot.records.filter((r) => r.typeName === 'shape').length
  assert(scope !== undefined || shapes_count > 0, 'only a bound board snapshots an empty sketch')
  const prompt = scope
    ? canvas_prompt(facts, publish_command, shapes_count === 0)
    : cleanup_prompt(facts)
  return success('snapshot_saved', `${prompt}\n`, image_path, {
    session: snapshot.session,
    ...(scope ? { layer: 'canvas' } : {}),
    title_wanted: snapshot.title_wanted,
    path: image_path,
    records_path,
    strokes_path,
    strokes_truncated,
    diagram_path,
    previous_diagram_path: previous_path,
    proposal_path,
    snapshot: snapshot.document_hash,
    document_hash: snapshot.document_hash,
    base_revision,
    interpretation_revision: snapshot.cleaned_revision,
    agent_revision: base_revision,
    agent_history: snapshot.agent_history,
    agent_source_hash: snapshot.agent_source_hash,
    archived_diagrams_path: archives_write(directory, snapshot),
    shapes_count,
    bounds: snapshot.bounds,
    image,
    mapping,
    prompt,
    publish_command,
  })
}

function archives_write(directory: string, snapshot: SketchSnapshot): string | null {
  const archives = snapshot.legacy_diagrams

  if (!archives || !Object.keys(archives).length) return null

  const file = path.join(directory, 'archived_diagrams.json')
  json_write(file, archives)
  return file
}

function quote(pathname: string): string {
  return "'" + pathname.replaceAll("'", "'\\''") + "'"
}

function json_write(file: string, value: object): void {
  assert(path.isAbsolute(file), 'files are written by absolute path')
  file_write_atomic(file, new TextEncoder().encode(JSON.stringify(value)))
}

// Lays out a semantic diagram locally and saves the styled proposal, without a board. The
// result is exactly what cleanup-publish would send for the same diagram.
export async function cleanup_compose(options: Options): Promise<Outcome> {
  if (options.file === null) {
    return failure('usage_error', 'Name the diagram with --file <path>, or --file - for stdin.', {
      action: 'fix_usage',
      command: command_compose_help,
    })
  }

  const text = await input_read(options.file, 'diagram', command_compose_help)

  if (typeof text !== 'string') return text

  // A trial layout may keep a drawing the canvas already holds, as a bound publish would.
  const composed = await diagram_compose_text(text, command_compose_help, options.file, true)

  if ('kind' in composed) return composed

  // The composed proposal is filed with the board its diagram names.
  const named = composed.proposal.session
  const session =
    typeof named === 'string' && board_id_pattern.test(named) ? named : board_default_id
  const out = path.resolve(options.out ?? path.join(cleanup_directory(session), 'composed.json'))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  file_write_atomic(out, new TextEncoder().encode(composed.text))
  const { proposal } = composed
  return success('composed', `Composed the diagram into ${out}.`, out, {
    path: out,
    session,
    snapshot: proposal.snapshot,
    base_revision: proposal.base_revision,
    shapes_count: composed.shapes.length,
    width_units: composed.width_units,
    height_units: composed.height_units,
    route_conflicts_count: composed.route_conflicts_count,
  })
}

// The sketch records a diagram's drawings are sized from: the snapshot's file beside the
// diagram file, or, for a diagram on stdin, the one in its board's default snapshot folder.
function sketch_file_for(file: string, session: string | null): string {
  assert(file.length > 0, 'an input is named')

  if (file !== '-') return sketch_file_beside(file)

  const named = session !== null && board_id_pattern.test(session) ? session : board_default_id
  return path.join(cleanup_directory(named), sketch_file_name)
}

// Parses and composes a semantic diagram, or explains why it cannot be. `file` is where the
// diagram was read from. `carry` lets a drawing already on the canvas keep its box when the
// diagram reads the sketch as the canvas does, which is what a bound publish does.
async function diagram_compose_text(
  text: string,
  help: string,
  file: string,
  carry: boolean,
): Promise<Composed | Outcome> {
  assert(text.length <= proposal_size_bytes_max, 'a read diagram is bounded')
  let json: unknown

  try {
    json = JSON.parse(text)
  } catch {
    return failure('invalid_diagram', 'The diagram is not valid JSON.', {
      action: 'fix_usage',
      command: help,
    })
  }

  const parsed = diagram_proposal_parse(json)

  if (!parsed.ok) {
    return failure('invalid_diagram', `${parsed.path}: ${parsed.message}`, {
      action: 'fix_usage',
      command: help,
    })
  }

  // A drawing keeps the person's own strokes, so it is as large as they are in the sketch.
  const sketch_file = sketch_file_for(file, parsed.proposal.session)
  const drawings = drawing_sizes(parsed.proposal, sketch_file, carry)

  if (!drawings.ok) {
    return failure('invalid_diagram', `${drawings.path}: ${drawings.message}`, {
      action: 'fix_usage',
      command: help,
    })
  }

  const result = await diagram_compose(parsed.proposal, drawings.sizes)

  if (!result.ok) {
    return failure('composition_failed', `The diagram could not be laid out: ${result.message}`, {
      action: 'ask_human',
      message: 'The composer could not lay out this diagram; report the diagram file.',
    })
  }

  const { nodes, edges } = parsed.proposal.diagram
  assert(result.composed.shapes.length === nodes.length + edges.length, 'a shape for each item')
  return result.composed
}

// What the command line reads from an input before the board checks it whole: whether it is a
// semantic diagram, which is laid out here first, and which board it says it was made from.
function input_peek(text: string): { diagram: boolean; session: string | null } {
  let json: unknown = null

  try {
    json = JSON.parse(text) as unknown
  } catch {
    return { diagram: false, session: null }
  }

  const object =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {}
  const session =
    typeof object.session === 'string' && board_id_pattern.test(object.session)
      ? object.session
      : null
  assert(session === null || session.length > 0, 'a peeked session is not empty')
  return { diagram: object.format === diagram_format, session }
}

export async function cleanup_publish(options: Options, scope?: Scope): Promise<Outcome> {
  if (options.file === null) {
    return failure('usage_error', 'Name the proposal with --file <path>, or --file - for stdin.', {
      action: 'fix_usage',
      command: command_publish_help,
    })
  }

  const text = await input_read(options.file, 'proposal', command_publish_help)

  if (typeof text !== 'string') return text

  // Layout happens here, before the board is asked anything: the board's publish stays one
  // synchronous check-and-swap against the snapshot and revision named in the diagram.
  const peeked = input_peek(text)

  if (scope && !peeked.diagram) {
    return failure('invalid_diagram', 'Send a semantic diagram for the bound board.', {
      action: 'fix_usage',
      command: 'tldraw-sync whiteboard-publish --help',
    })
  }

  if (scope && peeked.session !== scope.binding.session) {
    return failure(
      'session_mismatch',
      'The diagram does not name this bound board.',
      { action: 'run', command: scoped_snapshot_command(scope) },
      exit_codes.conflict,
    )
  }

  // Only a bound board's canvas carries a drawing over from one publish to the next.
  const composed = peeked.diagram
    ? await diagram_compose_text(text, command_publish_help, options.file, scope !== undefined)
    : null

  if (composed !== null && 'kind' in composed) return composed

  const body = composed === null ? text : composed.text
  return proposal_publish(options.session ?? peeked.session, body, scope)
}

// Send to the named board, or the one in the proposal. The board also checks the source session.
async function proposal_publish(
  target: string | null,
  body: string,
  scope?: Scope,
): Promise<Outcome> {
  const found = await session_find(target)

  if ('kind' in found) return found

  const session = found.status.session
  const query = `?${board_query(session)}`
  const pathname = scope
    ? `${whiteboard_path}publish${query}&layer=${scope.layer}`
    : `${path_cleaned_json}${query}`
  const headers = scope
    ? binding_headers(scope.binding)
    : found.status.linked
      ? machine_headers()
      : undefined
  const answer = await api_request(found.port, pathname, body, headers)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer, session, scope)

  const revision = Number(answer.body.revision)
  assert(Number.isInteger(revision) && revision > 0, 'a publish names its revision')

  if (scope)
    return success(
      'published',
      `Published ${scope.layer} revision ${revision}.`,
      String(revision),
      { session, layer: 'canvas', revision },
    )

  return success(
    'published',
    `Published cleaned revision ${revision}. See it on the Cleaned tab.`,
    String(revision),
    {
      session,
      revision,
      shapes_count: answer.body.shapes_count,
      title_applied: answer.body.title_applied === true,
      stage_url: found.status.stage_url,
    },
  )
}

export async function cleanup_restore(options: Options): Promise<Outcome> {
  if (options.base_revision === null) {
    return failure('usage_error', 'Name the current cleaned revision with --base-revision <n>.', {
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

  if (answer.status !== 200) return answer_failure(answer, session)

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

async function input_read(
  file: string,
  noun: 'proposal' | 'diagram',
  help: string,
): Promise<string | Outcome> {
  assert(file.length > 0, 'an input is named')

  // Reading stops at the first byte past the limit, so a large or endless input costs no more
  // than the limit in memory or time.
  const read =
    file === '-'
      ? await stream_read_bounded(Bun.stdin.stream(), proposal_size_bytes_max)
      : file_read_bounded(file, proposal_size_bytes_max)

  if (read.kind === 'too_large') {
    return failure(
      `${noun}_too_large`,
      `The ${noun} is larger than ${proposal_size_bytes_max} bytes.`,
      { action: 'fix_usage', command: help },
    )
  }

  if (read.kind === 'unreadable') {
    const source = file === '-' ? 'on stdin' : `file ${file}`
    return failure(
      `${noun}_unreadable`,
      `The ${noun} ${source} cannot be read. It must be a regular file, or - for stdin.`,
      { action: 'fix_usage', command: help },
    )
  }

  assert(read.bytes.byteLength <= proposal_size_bytes_max, 'a read input is within the limit')
  return new TextDecoder().decode(read.bytes)
}

// The board's own error codes are passed on, each with what to do about it.
function scoped_snapshot_command(scope: Scope): string {
  return (
    `tldraw-sync whiteboard-snapshot --binding ${quote(scope.file)} ` +
    `--layer ${scope.layer} --json`
  )
}

function answer_failure(
  answer: Extract<ApiAnswer, { kind: 'answer' }>,
  session: string,
  scope?: Scope,
): Outcome {
  const retry = scope ? scoped_snapshot_command(scope) : command_snapshot(session)
  const code = typeof answer.body.code === 'string' ? answer.body.code : 'request_failed'
  const message_raw =
    typeof answer.body.message === 'string'
      ? answer.body.message
      : `The board answered ${answer.status}.`
  const message = message_raw.endsWith('.') ? message_raw : `${message_raw}.`

  // A proposal for another board is a conflict like a stale one: snapshot this board afresh.
  if (code === 'sketch_changed' || code === 'revision_conflict' || code === 'session_mismatch') {
    return failure(code, message, { action: 'run', command: retry }, exit_codes.conflict)
  }

  if (code === 'unknown_session') {
    return failure(code, message, { action: 'run', command: command_session_list })
  }

  if (code === 'boards_busy') {
    return failure(code, message, { action: 'retry', command: retry }, exit_codes.not_ready)
  }

  if (code === 'invalid_proposal' || code === 'invalid_json' || code === 'too_large') {
    return failure(code === 'too_large' ? 'proposal_too_large' : 'invalid_proposal', message, {
      action: 'fix_usage',
      command: command_publish_help,
    })
  }

  if (code === 'nothing_to_restore') {
    return failure(code, message, {
      action: 'ask_human',
      message: 'There is no earlier cleaned revision to restore.',
    })
  }

  return failure(/^[a-z_]+$/.test(code) ? code : 'request_failed', message, {
    action: 'retry',
    command: retry,
  })
}

// Width and height from the PNG header, or null for anything that is not a full header.
function png_size(png: Uint8Array): { width_px: number; height_px: number } | null {
  if (png.byteLength < 24) return null

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunk = String.fromCharCode(...png.subarray(12, 16))

  if (chunk !== 'IHDR') return null

  const size = { width_px: view.getUint32(16), height_px: view.getUint32(20) }
  return size.width_px > 0 && size.height_px > 0 ? size : null
}

// Written aside and renamed, so a reader never sees half a file.
function file_write_atomic(file: string, bytes: Uint8Array): void {
  assert(path.isAbsolute(file), 'files are written by absolute path')
  const partial = `${file}.${process.pid}.partial`
  fs.writeFileSync(partial, bytes)
  fs.renameSync(partial, file)
  assert(fs.statSync(file).size === bytes.byteLength, 'the written file is complete')
}
