// The routes of a native board's shared scene. The host, with its binding, reads the scene with
// the hash of every record and edits it; a paired pad reverts one revision, which is how the
// iPad's Undo and Redo reach the agent's work. Bodies are untrusted, bounded and fully checked
// before the board sees them; the board decides every write against the room as it is.

import { assert } from '../shared/assert'
import {
  native_edit_bytes_max,
  native_request_id_pattern,
  native_revert_bytes_max,
  sequence_valid,
} from '../shared/native_scene'
import { whiteboard_protocol } from '../shared/whiteboard'
import type { Board } from './board'
import type { BoardRegistry } from './board_registry'
import { body_read, json_error, lookup_error } from './http_canvas'
import { json_no_store } from './http_sessions'
import { scene_request_parse } from './native_scene_plan'
import type { NativeOutcome } from './native_scene'

const edit_fields = ['request_id', 'base_sequence', 'adds', 'updates', 'deletes']

export const native_only = () =>
  json_error(409, 'native_board', 'This board is native: edit its scene instead of publishing.')

const not_native = () =>
  json_error(409, 'not_native', 'This board has an Agent canvas. Publish a scene to it instead.')

export function native_scene_route(board: Board): Response {
  if (board.native === null) return not_native()

  const scene = board.native.scene_read()
  assert(scene.base_sequence >= 1, 'a base sequence starts at one')
  return json_no_store({
    protocol: whiteboard_protocol,
    session: board.session,
    native: true,
    ...scene,
  })
}

export async function native_edit_route(request: Request, board: Board): Promise<Response> {
  const body = await body_read(request, native_edit_bytes_max)

  if (!body.ok) return body.response

  if (board.native === null) return not_native()

  const value = body.value as Record<string, unknown> | null

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return edit_invalid([])

  const unknown = Object.keys(value).filter((key) => !edit_fields.includes(key))
  const { request_id, base_sequence } = value

  if (unknown.length > 0) return edit_invalid([`unknown fields: ${unknown.join(', ')}`])

  if (typeof request_id !== 'string' || !native_request_id_pattern.test(request_id)) {
    return edit_invalid(['request_id must be 8 to 64 letters, digits, - or _'])
  }

  if (!sequence_valid(base_sequence)) {
    return edit_invalid(['base_sequence must be the base_sequence the scene was read at'])
  }

  const parsed = scene_request_parse({
    adds: value.adds,
    updates: value.updates,
    deletes: value.deletes,
  })

  if (!parsed.ok) return edit_invalid(parsed.errors)

  const edit = { request_id, base_sequence, request: parsed.request }
  return outcome_response(board.session, await board.native.edit(edit))
}

export async function native_revert_route(
  request: Request,
  registry: BoardRegistry,
  session: string,
): Promise<Response> {
  const body = await body_read(request, native_revert_bytes_max)

  if (!body.ok) return body.response

  const value = body.value as Record<string, unknown> | null
  const keys = typeof value === 'object' && value !== null ? Object.keys(value) : null

  if (keys === null || keys.length !== 1 || !sequence_valid(value?.sequence)) {
    return json_error(400, 'invalid_request', 'Send {"sequence": n} naming one revision.')
  }

  const lookup = registry.board(session)

  if (lookup.kind !== 'board') return lookup_error(lookup)

  if (lookup.board.native === null) return not_native()

  assert(lookup.board.session === session, 'a pad reverts on its own board only')
  return outcome_response(session, await lookup.board.native.revert(value.sequence as number))
}

function edit_invalid(errors: readonly string[]): Response {
  assert(errors.length <= 16, 'reported errors are bounded')
  return json_error(400, 'invalid_request', 'Check the edit against `whiteboard-edit --help`.', {
    errors,
  })
}

function outcome_response(session: string, outcome: NativeOutcome): Response {
  switch (outcome.kind) {
    case 'written':
    case 'replayed': {
      const { kind, sequence, reverts, minted } = outcome
      assert(sequence >= 1, 'a revision has a sequence')
      return json_no_store({ session, result: kind, sequence, reverts, minted })
    }
    case 'unchanged':
      return json_no_store({
        session,
        result: 'unchanged',
        sequence: null,
        reverts: null,
        minted: [],
      })
    case 'refused': {
      const { conflicts, conflicts_count } = outcome
      const message = 'Records changed since they were read. Nothing was written.'
      return json_error(409, 'conflict', message, { conflicts, conflicts_count })
    }
    case 'already_reverted':
      return json_error(409, 'already_reverted', 'That revision was already taken back.', {
        sequence: outcome.sequence,
      })
    case 'expired':
      return json_error(409, 'revision_expired', 'That revision is too old to take back.')
    case 'unknown':
      return json_error(404, 'unknown_revision', 'No revision has that sequence.')
    case 'replay_expired':
      return json_error(
        409,
        'replay_expired',
        'This request may have run already and is too old to check. Read the scene again.',
      )
    case 'base_unknown':
      return json_error(400, 'invalid_base', 'base_sequence is newer than the scene.')
    case 'request_id_reused':
      return json_error(409, 'request_id_reused', 'That request id was used for another edit.')
    case 'too_large':
      return json_error(413, 'revision_too_large', 'Split the edit into smaller ones.')
    case 'diverged':
      return json_error(409, 'diverged', 'The scene changed while writing. Nothing was written.')
    case 'rejected':
      return json_error(400, 'invalid_records', 'A record does not fit the tldraw schema.')
    case 'unavailable':
      return json_error(503, 'native_unavailable', 'The scene cannot be written right now.', {
        reason: outcome.reason,
      })
  }
}
