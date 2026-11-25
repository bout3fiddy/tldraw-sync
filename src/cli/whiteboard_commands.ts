import fs from 'node:fs'
import { AssertionError } from '../shared/assert'
import { board_query } from '../shared/board_session'
import {
  event_states,
  layers,
  message_length_max,
  owner_pattern,
  whiteboard_path,
  type Binding,
} from '../shared/whiteboard'
import { api_request, type ApiAnswer } from './board_client'
import { browser_open } from './board_process'
import { cleanup_publish, cleanup_snapshot } from './cleanup_commands'
import { session_find, start, type Options } from './commands'
import { failure, success, type Outcome } from './output'
import { binding_directory, binding_install, binding_read } from './whiteboard_file'
import { binding_headers, machine_headers } from './whiteboard_scope'

export type BoardFlags = Partial<
  Record<'owner' | 'event' | 'message' | 'state' | 'binding' | 'layer', string>
>
const usage = (command: string, message: string) =>
  failure('usage_error', message, { action: 'fix_usage', command: `tldraw-sync ${command} --help` })

export async function whiteboard(command: string, options: Options): Promise<Outcome> {
  try {
    if (command === 'whiteboard-link') return await link(options)

    if (!options.binding) return usage(command, 'Supply --binding with the private file path.')

    const binding = binding_read(options.binding)

    if (command === 'whiteboard-publish' || command === 'whiteboard-snapshot') {
      const layer = layers.find((item) => item === options.layer)

      if (!layer) return usage(command, 'Choose interpretation or ideas with --layer.')

      if (command === 'whiteboard-publish' && (!options.file || options.file === '-')) {
        return usage(command, 'Name the semantic diagram with --file.')
      }

      // A bad binding must not launch a stage or run layout, even for an empty board.
      const access = await delivery('whiteboard-poll', binding, options)

      if (access.kind === 'failure') return access

      const scope = { binding, layer, file: options.binding }
      const bound = { ...options, session: binding.session }
      return command === 'whiteboard-snapshot'
        ? await cleanup_snapshot(bound, scope)
        : await cleanup_publish(bound, scope)
    }

    return await delivery(command, binding, options)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    return failure('whiteboard_io', 'Cannot read or save the private whiteboard files.', {
      action: 'ask_human',
      message: 'Check the binding path, owner and daemon version.',
    })
  }
}

async function link(options: Options): Promise<Outcome> {
  const { out, owner } = options

  if (!out || !owner || !owner_pattern.test(owner)) {
    return usage('whiteboard-link', 'Supply a bounded owner id and absolute binding path.')
  }

  binding_directory(out, true)

  const existing = fs.lstatSync(out, { throwIfNoEntry: false }) ? binding_read(out) : null

  if (existing && existing.owner !== owner) {
    return usage('whiteboard-link', 'This binding file belongs to another session.')
  }

  const running = await start({ ...options, terminal: false, no_open: true })

  if (running.kind === 'failure') return running

  const port = Number(running.data.port)
  const bound = await link_binding(port, existing, out, owner)

  if ('kind' in bound) return bound

  const { session } = bound
  const found = await session_find(session)

  if ('kind' in found) return found

  const { draw_url, stage_url, stage_connected } = found.status

  if (!stage_connected && !browser_open(stage_url)) {
    return failure(
      'stage_closed',
      'The bound stage could not be opened.',
      { action: 'ask_human', message: `Open ${stage_url} on the Mac and link again.` },
      4,
    )
  }

  return success('linked', `Scan the stage QR code to pair your iPad.\n${draw_url}`, draw_url, {
    session,
    owner,
    draw_url,
    stage_url,
    binding_file: out,
  })
}

async function link_binding(
  port: number,
  existing: Binding | null,
  out: string,
  owner: string,
): Promise<Binding | Outcome> {
  if (existing) {
    const route = `${whiteboard_path}poll?${board_query(existing.session)}`
    const poll = await api_request(port, route, null, binding_headers(existing))

    if (poll.kind !== 'answer' || poll.status !== 200) return refusal(poll)

    return existing
  }

  const response = await api_request(
    port,
    `${whiteboard_path}link`,
    JSON.stringify({ owner }),
    machine_headers(),
  )

  if (response.kind !== 'answer' || response.status !== 200) return refusal(response)

  const { session, token } = response.body

  if (typeof session !== 'string' || typeof token !== 'string' || response.body.owner !== owner) {
    return refusal({ kind: 'unreachable' })
  }

  const binding = { owner, session, token }
  binding_install(out, binding)
  return binding
}

async function delivery(command: string, binding: Binding, options: Options): Promise<Outcome> {
  const found = await session_find(null)

  if ('kind' in found) return found

  const ack = command === 'whiteboard-ack'

  if (
    ack &&
    (!options.event ||
      options.event.length > 128 ||
      !event_states.some((s) => s !== 'queued' && s === options.state) ||
      (options.message?.length ?? 0) > message_length_max)
  ) {
    return usage(command, 'Supply an event, acknowledgement state and optional short message.')
  }

  const route = `${whiteboard_path}${ack ? 'ack' : 'poll'}?${board_query(binding.session)}`
  const body = ack
    ? JSON.stringify({ event: options.event, state: options.state, message: options.message })
    : null
  const answer = await api_request(found.port, route, body, binding_headers(binding))

  if (answer.kind !== 'answer' || answer.status !== 200) return refusal(answer)

  return success(
    ack ? 'acknowledged' : 'polled',
    JSON.stringify(answer.body),
    binding.session,
    answer.body,
  )
}

function refusal(answer: ApiAnswer): Outcome {
  if (answer.kind === 'unreachable')
    return failure(
      'not_running',
      'The board is not answering.',
      { action: 'ask_human', message: 'Check the board daemon on the Mac.' },
      2,
    )

  const { code, message } = answer.body
  return failure(
    typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'request_failed',
    typeof message === 'string' && message.endsWith('.') ? message : 'Board request failed.',
    { action: 'ask_human', message: 'Check the session binding and the board status.' },
  )
}
