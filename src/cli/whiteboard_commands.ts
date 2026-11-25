import fs from 'node:fs'
import { AssertionError } from '../shared/assert'
import { document_hash_pattern } from '../shared/constants'
import { board_query } from '../shared/board_session'
import {
  event_states,
  event_kinds,
  events_count_max,
  request_id_pattern,
  request_text_valid,
  type BoardEvent,
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
  Record<'protocol' | 'owner' | 'event' | 'message' | 'state' | 'binding' | 'layer', string>
>
const usage = (command: string, message: string) =>
  failure('usage_error', message, { action: 'fix_usage', command: `tldraw-sync ${command} --help` })

const invalid_reply = () =>
  failure('invalid_response', 'Unexpected response from the board.', {
    action: 'ask_human',
    message: 'Check the bound session and upgrade the Mac board.',
  })
const upgrade = () =>
  failure('upgrade_required', 'Whiteboard protocol 2 is required.', {
    action: 'ask_human',
    message: 'Upgrade the CLI and daemon, restart safely and use --protocol 2.',
  })

export async function whiteboard(command: string, options: Options): Promise<Outcome> {
  try {
    if (['whiteboard-link', 'whiteboard-poll'].includes(command) && options.protocol !== '2') {
      return upgrade()
    }

    if (command === 'whiteboard-link') return await link(options)

    if (!options.binding) return usage(command, 'Supply --binding with the private file path.')

    const binding = binding_read(options.binding)

    if (command === 'whiteboard-publish' || command === 'whiteboard-snapshot') {
      const layer = layers.find((item) => item === (options.layer ?? 'canvas'))

      if (!layer || layer === 'ideas') {
        return usage(command, 'Take a fresh --layer canvas snapshot and edit the complete graph.')
      }

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
  const status = await api_request(port, '/api/status', null)

  if (status.kind !== 'answer' || status.status !== 200) return refusal(status)

  if (status.body.protocol !== 2) return upgrade()

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
    protocol: 2,
  })
}

async function link_binding(
  port: number,
  existing: Binding | null,
  out: string,
  owner: string,
): Promise<Binding | Outcome> {
  if (existing) {
    const route = `${whiteboard_path}poll?protocol=2&${board_query(existing.session)}`
    const poll = await api_request(port, route, null, binding_headers(existing))

    if (poll.kind !== 'answer' || poll.status !== 200) return refusal(poll)

    if (poll.body.protocol !== 2) return upgrade()

    if (!poll_checked(poll.body, existing)) return invalid_reply()

    return existing
  }

  const response = await api_request(
    port,
    `${whiteboard_path}link`,
    JSON.stringify({ protocol: 2, owner }),
    machine_headers(),
  )

  if (response.kind !== 'answer' || response.status !== 200) return refusal(response)

  if (response.body.protocol !== 2) return upgrade()

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

  const query = `?protocol=2&${board_query(binding.session)}`
  const route = `${whiteboard_path}${ack ? 'ack' : 'poll'}${query}`
  const body = ack
    ? JSON.stringify({ event: options.event, state: options.state, message: options.message })
    : null
  const answer = await api_request(found.port, route, body, binding_headers(binding))

  if (answer.kind !== 'answer' || answer.status !== 200) return refusal(answer)

  if (ack) {
    const { session, event, state } = answer.body

    if (session !== binding.session || event !== options.event || state !== options.state) {
      return invalid_reply()
    }

    const data = { session, event, state }
    return success('acknowledged', JSON.stringify(data), binding.session, data)
  }

  if (answer.body.protocol !== 2) return upgrade()

  const data = poll_checked(answer.body, binding)

  if (!data) return invalid_reply()

  return success('polled', JSON.stringify(data), binding.session, data)
}

// Select only public protocol fields. Text is an opaque value, not a bag of fields to redact.
function poll_checked(body: Record<string, unknown>, binding: Binding) {
  const { session, owner, sketch_hash, agent_revision, events } = body

  if (
    session !== binding.session ||
    owner !== binding.owner ||
    typeof sketch_hash !== 'string' ||
    !document_hash_pattern.test(sketch_hash) ||
    typeof agent_revision !== 'number' ||
    !Number.isSafeInteger(agent_revision) ||
    agent_revision < 0 ||
    !Array.isArray(events) ||
    events.length > events_count_max
  )
    return null

  const pending = []

  for (const value of events) {
    if (!value || typeof value !== 'object') return null

    const { id, kind, request_id, sketch_hash, created_at_ms, state, text } = value as BoardEvent

    if (
      !event_kinds.includes(kind) ||
      typeof id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      typeof request_id !== 'string' ||
      !request_id_pattern.test(request_id) ||
      typeof sketch_hash !== 'string' ||
      !document_hash_pattern.test(sketch_hash) ||
      !Number.isSafeInteger(created_at_ms) ||
      created_at_ms < 0 ||
      !['queued', 'received', 'working'].includes(state) ||
      (text !== undefined && (!request_text_valid(text) || !text.length))
    )
      return null

    pending.push({ id, kind, request_id, sketch_hash, created_at_ms, state, text })
  }

  return { protocol: 2, session, owner, sketch_hash, agent_revision, events: pending }
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
