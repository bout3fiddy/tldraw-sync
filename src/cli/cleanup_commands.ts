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
import { cleanup_prompt } from './cleanup_prompt'
import {
  command_session_list,
  image_current,
  not_running,
  output_directory,
  session_find,
  session_flag,
  type Options,
} from './commands'
import { diagram_compose, type Composed } from './diagram_compose'
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
export async function cleanup_snapshot(options: Options): Promise<Outcome> {
  const session = options.session ?? board_default_id

  for (let attempt = 0; attempt < snapshot_attempts_count_max; attempt += 1) {
    const image = await image_current(options)

    if ('kind' in image) return image

    const query = `?document_hash=${image.document_hash}&${board_query(image.session)}`
    const answer = await api_request(image.port, `${path_sketch_json}${query}`, null)

    if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

    if (answer.status === 409) continue

    if (answer.status !== 200) return answer_failure(answer, image.session)

    const snapshot = answer.body as SketchSnapshot
    assert(snapshot.document_hash === image.document_hash, 'records match their image')
    assert(snapshot.session === image.session, 'records are of the board asked for')
    return snapshot_save(image.bytes, snapshot, options.out)
  }

  return failure(
    'sketch_busy',
    'The sketch kept changing while the snapshot was taken.',
    { action: 'retry', command: command_snapshot(session) },
    exit_codes.not_ready,
  )
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
  const records_path = path.join(directory, 'sketch.json')
  const strokes_path = path.join(directory, 'strokes.json')
  const previous_path = path.join(directory, 'diagram_previous.json')
  const records = snapshot.records as unknown as Array<Record<string, unknown>>
  const summaries = strokes_summarize(records)
  file_write_atomic(image_path, png)
  json_write(records_path, {
    snapshot: snapshot.document_hash,
    bounds: snapshot.bounds,
    records: snapshot.records,
  })
  json_write(strokes_path, { snapshot: snapshot.document_hash, ...summaries })

  // A previous interpretation from an older snapshot must not be mistaken for this one's.
  const previous = snapshot.diagram_previous

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

function snapshot_save(png: Uint8Array, snapshot: SketchSnapshot, out: string | null): Outcome {
  const directory = path.resolve(out ?? cleanup_directory(snapshot.session))
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
  const prompt = cleanup_prompt({
    image_path,
    records_path,
    strokes_path,
    diagram_path,
    previous_path,
    mapping,
    snapshot: snapshot.document_hash,
    base_revision: snapshot.cleaned_revision,
    session: snapshot.session,
    title_wanted: snapshot.title_wanted,
  })
  const publish_flags = `${session_flag(snapshot.session)} --file ${diagram_path} --json`
  const publish_command = `tldraw-sync cleanup-publish${publish_flags}`
  return success('snapshot_saved', `${prompt}\n`, image_path, {
    session: snapshot.session,
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
    base_revision: snapshot.cleaned_revision,
    shapes_count: snapshot.records.length,
    bounds: snapshot.bounds,
    image,
    mapping,
    prompt,
    publish_command,
  })
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

  const composed = await diagram_compose_text(text, command_compose_help)

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

// Parses and composes a semantic diagram, or explains why it cannot be.
async function diagram_compose_text(text: string, help: string): Promise<Composed | Outcome> {
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

  const result = await diagram_compose(parsed.proposal)

  if (!result.ok) {
    return failure('composition_failed', `The diagram could not be laid out: ${result.message}`, {
      action: 'ask_human',
      message: 'The composer could not lay out this diagram; report the diagram file.',
    })
  }

  assert(result.composed.shapes.length > 0, 'a composition has shapes')
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

export async function cleanup_publish(options: Options): Promise<Outcome> {
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
  const composed = peeked.diagram ? await diagram_compose_text(text, command_publish_help) : null

  if (composed !== null && 'kind' in composed) return composed

  // Sent to the board named, or else the board the proposal says it came from. The board
  // refuses a proposal made from another board's snapshot either way.
  const body = composed === null ? text : composed.text
  const found = await session_find(options.session ?? peeked.session)

  if ('kind' in found) return found

  const session = found.status.session
  const pathname = `${path_cleaned_json}?${board_query(session)}`
  const answer = await api_request(found.port, pathname, body)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer, session)

  const revision = Number(answer.body.revision)
  assert(Number.isInteger(revision) && revision > 0, 'a publish names its revision')
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
  const answer = await api_request(found.port, pathname, body)

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
function answer_failure(answer: Extract<ApiAnswer, { kind: 'answer' }>, session: string): Outcome {
  const code = typeof answer.body.code === 'string' ? answer.body.code : 'request_failed'
  const message_raw =
    typeof answer.body.message === 'string'
      ? answer.body.message
      : `The board answered ${answer.status}.`
  const message = message_raw.endsWith('.') ? message_raw : `${message_raw}.`

  // A proposal for another board is a conflict like a stale one: snapshot this board afresh.
  if (code === 'sketch_changed' || code === 'revision_conflict' || code === 'session_mismatch') {
    const command = command_snapshot(session)
    return failure(code, message, { action: 'run', command }, exit_codes.conflict)
  }

  if (code === 'unknown_session') {
    return failure(code, message, { action: 'run', command: command_session_list })
  }

  if (code === 'boards_busy') {
    const command = command_snapshot(session)
    return failure(code, message, { action: 'retry', command }, exit_codes.not_ready)
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
    command: command_snapshot(session),
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
