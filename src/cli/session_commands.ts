// The board session commands: list the boards, make a new one, rename one. Each board is a
// whole board of its own; every board command takes --session <id> to work on one of them,
// and works on the default board without it.

import { assert } from '../shared/assert'
import { board_default_id, board_label, type BoardSession } from '../shared/board_session'
import {
  board_sessions_count_max as sessions_count_max,
  path_sessions,
  path_sessions_rename,
} from '../shared/constants'
import { api_request, board_find, type ApiAnswer } from './board_client'
import { data_directory } from './board_process'
import { command_session_list, not_running, session_unknown, type Options } from './commands'
import { failure, success, type Outcome } from './output'

export async function session_list(): Promise<Outcome> {
  const port = await board_port()

  if (typeof port !== 'number') return port

  const answer = await api_request(port, path_sessions, null)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200 || !Array.isArray(answer.body.sessions)) return answer_failure(answer)

  const sessions = (answer.body.sessions as BoardSession[]).slice(0, sessions_count_max)
  const listed = sessions.map((session) => ({ ...session, stage_url: stage_url(port, session) }))
  const lines = listed.map((session) => {
    const named = session.named_by === null ? '' : `  (named by ${session.named_by})`
    return `  ${session.id.padEnd(16)}  ${board_label(session)}${named}`
  })
  const human = [`${sessions.length} ${sessions.length === 1 ? 'board' : 'boards'}:`, ...lines]
  assert(listed.length <= sessions_count_max, 'a listing is bounded')
  return success('sessions', human.join('\n'), sessions.map((session) => session.id).join('\n'), {
    sessions: listed,
  })
}

export async function session_create(options: Options): Promise<Outcome> {
  const port = await board_port()

  if (typeof port !== 'number') return port

  const body = JSON.stringify({ name: options.name })
  const answer = await api_request(port, path_sessions, body)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status !== 200) return answer_failure(answer)

  const session = answer.body.session as BoardSession
  assert(typeof session.id === 'string', 'a created board has an id')
  const url = stage_url(port, session)
  return success(
    'session_created',
    `Created ${board_label(session)} (${session.id}): ${url}`,
    session.id,
    { session, stage_url: url },
  )
}

export async function session_rename(options: Options): Promise<Outcome> {
  if (options.session === null || options.name === null) {
    return failure('usage_error', 'Name the board with --session <id> and its name with --name.', {
      action: 'fix_usage',
      command: 'tldraw-sync session-rename --help',
    })
  }

  const port = await board_port()

  if (typeof port !== 'number') return port

  const body = JSON.stringify({ session: options.session, name: options.name })
  const answer = await api_request(port, path_sessions_rename, body)

  if (answer.kind === 'unreachable') return not_running({ kind: 'not_running' })

  if (answer.status === 404) return session_unknown(options.session)

  if (answer.status !== 200) return answer_failure(answer)

  const session = answer.body.session as BoardSession
  assert(session.id === options.session, 'the renamed board is the one named')
  return success(
    'session_renamed',
    `Renamed ${session.id} to “${board_label(session)}”.`,
    session.id,
    { session },
  )
}

async function board_port(): Promise<number | Outcome> {
  const found = await board_find(data_directory())

  if (found.kind !== 'running') return not_running(found)

  assert(found.status.port > 0, 'a running board has a port')
  return found.status.port
}

function stage_url(port: number, session: BoardSession): string {
  assert(port > 0, 'a running board has a port')
  const suffix = session.id === board_default_id ? '' : `/s/${session.id}`
  return `http://localhost:${port}${suffix}`
}

function answer_failure(answer: Extract<ApiAnswer, { kind: 'answer' }>): Outcome {
  const code =
    typeof answer.body.code === 'string' && /^[a-z_]+$/.test(answer.body.code)
      ? answer.body.code
      : 'request_failed'
  const message_raw =
    typeof answer.body.message === 'string'
      ? answer.body.message
      : `The board answered ${answer.status}.`
  const message = message_raw.endsWith('.') ? message_raw : `${message_raw}.`

  if (code === 'sessions_full') {
    return failure(code, message, {
      action: 'ask_human',
      message: 'Every board slot is taken; reuse an existing board.',
    })
  }

  if (code === 'invalid_name') {
    return failure(code, message, {
      action: 'fix_usage',
      command: 'tldraw-sync session-create --help',
    })
  }

  return failure(code, message, { action: 'retry', command: command_session_list })
}
