// What a host runs against the shared scene of a native board: read every record with the
// hash of its bytes, and write one edit that the board applies whole or not at all. An edit may
// change any record, the person's own strokes included, from the bytes the host read. The
// person's Undo on the iPad takes an edit back as one step; the host has no undo of its own.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'
import { board_query } from '../shared/board_session'
import {
  native_edit_bytes_max,
  native_request_id_pattern,
  native_route_edit,
  native_route_scene,
  sequence_valid,
} from '../shared/native_scene'
import { whiteboard_path, type Binding } from '../shared/whiteboard'
import { api_request, type ApiAnswer } from './board_client'
import { output_directory, type Options } from './commands'
import { exit_codes, failure, success, type Outcome } from './output'
import { file_read_bounded } from './proposal_reader'
import { binding_headers } from './whiteboard_scope'

const scene_help = 'tldraw-sync whiteboard-scene --help'
const edit_help = 'tldraw-sync whiteboard-edit --help'

export async function native_scene(port: number, binding: Binding, options: Options) {
  const route = `${whiteboard_path}${native_route_scene}?${board_query(binding.session)}`
  const answer = await api_request(port, route, null, binding_headers(binding))

  if (answer.kind !== 'answer' || answer.status !== 200) return refusal(answer, scene_help)

  const { session, base_sequence, records, hashes } = answer.body

  if (
    session !== binding.session ||
    !sequence_valid(base_sequence) ||
    !Array.isArray(records) ||
    typeof hashes !== 'object' ||
    hashes === null
  ) {
    return failure('invalid_response', 'Unexpected response from the board.', {
      action: 'ask_human',
      message: 'Upgrade the Mac board and the CLI together.',
    })
  }

  const file = options.out ?? scene_path(binding.session, base_sequence)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  json_write_atomic(file, { session, base_sequence, records, hashes })
  const data = { session, base_sequence, records_count: records.length, scene_path: file }
  const human = `Scene at base ${base_sequence}: ${records.length} records.\n${file}`
  return success('scene_read', human, file, data)
}

export async function native_edit(port: number, binding: Binding, options: Options) {
  if (!options.file) return usage('Name the edit file with --file <path>.')

  const read = file_read_bounded(options.file, native_edit_bytes_max)

  if (read.kind === 'too_large')
    return usage(`Keep the edit file to ${native_edit_bytes_max} bytes.`)

  if (read.kind === 'unreadable') return usage('The edit file cannot be read.')

  let value: unknown

  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
  } catch {
    return usage('The edit file is not JSON.')
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return usage('The edit file is one JSON object.')
  }

  // Without a request id, the file's own bytes name the request: running the same file again
  // is a retry, answered from the board's journal and never applied twice.
  const fields = value as Record<string, unknown>
  const request_id = fields.request_id ?? `file-${digest(read.bytes)}`

  if (typeof request_id !== 'string' || !native_request_id_pattern.test(request_id)) {
    return usage('request_id is 8 to 64 letters, digits, - or _.')
  }

  const body = JSON.stringify({ ...fields, request_id })
  const route = `${whiteboard_path}${native_route_edit}?${board_query(binding.session)}`
  const answer = await api_request(port, route, body, binding_headers(binding))

  if (answer.kind !== 'answer' || answer.status !== 200) return refusal(answer, edit_help)

  const { session, result, sequence, minted } = answer.body

  if (
    session !== binding.session ||
    !['written', 'replayed', 'unchanged'].includes(String(result))
  ) {
    return failure('invalid_response', 'Unexpected response from the board.', {
      action: 'ask_human',
      message: 'Upgrade the Mac board and the CLI together.',
    })
  }

  const data = { session, result, sequence, minted, request_id }
  const human = result === 'unchanged' ? 'Nothing to change.' : `Revision ${String(sequence)}.`
  return success(`edit_${String(result)}`, human, String(sequence ?? ''), data)
}

function scene_path(session: string, base_sequence: number): string {
  assert(sequence_valid(base_sequence), 'a scene is read at a base')

  const directory = path.join(output_directory(session), 'native')
  const file = path.join(directory, `scene-${base_sequence}-${Date.now()}.json`)
  assert(path.isAbsolute(file), 'a scene path is absolute')
  return file
}

function json_write_atomic(file: string, value: object): void {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  assert(fs.statSync(file).size > 0, 'the scene file was written')
}

function digest(bytes: Uint8Array): string {
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 40)
  assert(hex.length === 40, 'a digest names a request')
  return hex
}

function usage(message: string): Outcome {
  return failure('usage_error', message, { action: 'fix_usage', command: edit_help })
}

// The board's own code and sentence, with the next step for the ones a host can act on.
function refusal(answer: ApiAnswer, help: string): Outcome {
  if (answer.kind === 'unreachable') {
    return failure(
      'not_running',
      'The board is not answering.',
      { action: 'ask_human', message: 'Check the board daemon on the Mac.' },
      exit_codes.not_running,
    )
  }

  const { code, message } = answer.body
  const known = typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'request_failed'
  const sentence = typeof message === 'string' && message.endsWith('.') ? message : 'Refused.'
  const stale = ['conflict', 'diverged', 'replay_expired', 'invalid_base'].includes(known)
  const errors = Array.isArray(answer.body.errors) ? answer.body.errors.slice(0, 8) : []
  const named = [...conflicts_named(answer.body.conflicts), ...errors.map(String)]
  const detail = named.length === 0 ? '' : ` ${named.join('; ').slice(0, 2000)}.`

  if (stale) {
    return failure(
      known,
      `${sentence}${detail}`,
      { action: 'run', command: 'tldraw-sync whiteboard-scene --binding <file> --json' },
      exit_codes.conflict,
    )
  }

  return failure(known, `${sentence}${detail}`, { action: 'fix_usage', command: help })
}

// The first few conflicts, each as the record and the reason: enough to read the scene again
// and know what moved.
function conflicts_named(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const named = value.slice(0, 8).map((conflict) => {
    const { id, reason, related_id } = (conflict ?? {}) as Record<string, unknown>
    const related = typeof related_id === 'string' ? ` (${related_id})` : ''
    return `${String(id)} ${String(reason)}${related}`
  })
  assert(named.length <= 8, 'named conflicts are bounded')
  return named
}
