// The cleanup commands an external agent runs. They read a coherent snapshot of the sketch,
// publish a finished cleanup as a structured proposal, and restore an earlier cleanup. They
// never call a model and never change the sketch: the agent running them does the tidying.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert } from '../shared/assert'
import {
  path_cleaned_json,
  path_cleaned_restore,
  path_sketch_json,
  proposal_size_bytes_max,
  snapshot_attempts_count_max,
} from '../shared/constants'
import type { SketchSnapshot } from '../shared/cleanup_types'
import { api_request, board_find, type ApiAnswer } from './board_client'
import { data_directory } from './board_process'
import { cleanup_prompt } from './cleanup_prompt'
import { image_current, not_running, type Options } from './commands'
import { exit_codes, failure, success, type Outcome } from './output'
import { file_read_bounded, stream_read_bounded } from './proposal_reader'

const command_snapshot = 'tldraw-sync cleanup-snapshot --json'
const command_publish_help = 'tldraw-sync cleanup-publish --help'

// The image and the records come from two requests. The records are served only for the
// document the image showed, so a sketch that moves on in between is caught and read again.
export async function cleanup_snapshot(options: Options): Promise<Outcome> {
  for (let attempt = 0; attempt < snapshot_attempts_count_max; attempt += 1) {
    const image = await image_current(options)

    if ('kind' in image) return image

    const query = `?document_hash=${image.document_hash}`
    const answer = await api_request(image.port, `${path_sketch_json}${query}`, null)

    if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

    if (answer.status === 409) continue

    if (answer.status !== 200) return answer_failure(answer)

    const snapshot = answer.body as SketchSnapshot
    assert(snapshot.document_hash === image.document_hash, 'records match their image')
    return snapshot_save(image.bytes, snapshot, options.out)
  }

  return failure(
    'sketch_busy',
    'The sketch kept changing while the snapshot was taken.',
    { action: 'retry', command: command_snapshot },
    exit_codes.not_ready,
  )
}

function snapshot_save(png: Uint8Array, snapshot: SketchSnapshot, out: string | null): Outcome {
  const directory = path.resolve(out ?? path.join(os.tmpdir(), 'tldraw-sync', 'cleanup'))
  fs.mkdirSync(directory, { recursive: true })
  const image_path = path.join(directory, 'sketch.png')
  const records_path = path.join(directory, 'sketch.json')
  const proposal_path = path.join(directory, 'proposal.json')
  const image = png_size(png)
  const mapping =
    snapshot.bounds === null || image === null
      ? null
      : {
          x0: snapshot.bounds.x - snapshot.image_padding,
          y0: snapshot.bounds.y - snapshot.image_padding,
          ppu: image.width_px / (snapshot.bounds.w + snapshot.image_padding * 2),
        }
  file_write_atomic(image_path, png)
  file_write_atomic(
    records_path,
    new TextEncoder().encode(
      JSON.stringify({
        snapshot: snapshot.document_hash,
        bounds: snapshot.bounds,
        records: snapshot.records,
      }),
    ),
  )

  const prompt = cleanup_prompt({
    image_path,
    records_path,
    proposal_path,
    mapping,
    snapshot: snapshot.document_hash,
    base_revision: snapshot.cleaned_revision,
  })
  return success('snapshot_saved', `${prompt}\n`, image_path, {
    path: image_path,
    records_path,
    proposal_path,
    snapshot: snapshot.document_hash,
    document_hash: snapshot.document_hash,
    base_revision: snapshot.cleaned_revision,
    shapes_count: snapshot.records.length,
    bounds: snapshot.bounds,
    image,
    mapping,
    prompt,
    publish_command: `tldraw-sync cleanup-publish --file ${proposal_path} --json`,
  })
}

export async function cleanup_publish(options: Options): Promise<Outcome> {
  if (options.file === null) {
    return failure('usage_error', 'Name the proposal with --file <path>, or --file - for stdin.', {
      action: 'fix_usage',
      command: command_publish_help,
    })
  }

  const body = await proposal_read(options.file)

  if (typeof body !== 'string') return body

  const found = await board_find(data_directory())

  if (found.kind !== 'running') return not_running(found)

  const answer = await api_request(found.status.port, path_cleaned_json, body)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer)

  const revision = Number(answer.body.revision)
  assert(Number.isInteger(revision) && revision > 0, 'a publish names its revision')
  return success(
    'published',
    `Published cleaned revision ${revision}. See it on the Cleaned tab.`,
    String(revision),
    {
      revision,
      shapes_count: answer.body.shapes_count,
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

  const found = await board_find(data_directory())

  if (found.kind !== 'running') return not_running(found)

  const body = JSON.stringify({ base_revision: options.base_revision, revision: options.revision })
  const answer = await api_request(found.status.port, path_cleaned_restore, body)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer)

  const revision = Number(answer.body.revision)
  const restored_from = Number(answer.body.restored_from)
  assert(revision > restored_from, 'a restore makes a newer revision')
  return success(
    'restored',
    `Restored revision ${restored_from} as revision ${revision}.`,
    String(revision),
    { revision, restored_from },
  )
}

async function proposal_read(file: string): Promise<string | Outcome> {
  assert(file.length > 0, 'a proposal is named')

  // Reading stops at the first byte past the limit, so a large or endless input costs no more
  // than the limit in memory or time.
  const read =
    file === '-'
      ? await stream_read_bounded(Bun.stdin.stream(), proposal_size_bytes_max)
      : file_read_bounded(file, proposal_size_bytes_max)

  if (read.kind === 'too_large') {
    return failure(
      'proposal_too_large',
      `The proposal is larger than ${proposal_size_bytes_max} bytes.`,
      { action: 'fix_usage', command: command_publish_help },
    )
  }

  if (read.kind === 'unreadable') {
    const source = file === '-' ? 'on stdin' : `file ${file}`
    return failure(
      'proposal_unreadable',
      `The proposal ${source} cannot be read. It must be a regular file, or - for stdin.`,
      { action: 'fix_usage', command: command_publish_help },
    )
  }

  assert(read.bytes.byteLength <= proposal_size_bytes_max, 'a read proposal is within the limit')
  return new TextDecoder().decode(read.bytes)
}

// The board's own error codes are passed on, each with what to do about it.
function answer_failure(answer: Extract<ApiAnswer, { kind: 'answer' }>): Outcome {
  const code = typeof answer.body.code === 'string' ? answer.body.code : 'request_failed'
  const message_raw =
    typeof answer.body.message === 'string'
      ? answer.body.message
      : `The board answered ${answer.status}.`
  const message = message_raw.endsWith('.') ? message_raw : `${message_raw}.`

  if (code === 'sketch_changed' || code === 'revision_conflict') {
    return failure(code, message, { action: 'run', command: command_snapshot }, exit_codes.conflict)
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
    command: command_snapshot,
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
