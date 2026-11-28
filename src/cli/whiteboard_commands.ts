import fs from 'node:fs'
import { AssertionError } from '../shared/assert'
import { document_hash_pattern } from '../shared/constants'
import { board_query } from '../shared/board_session'
import {
  event_message_valid,
  event_request_complete,
  event_state_terminal,
  event_states,
  event_kinds,
  events_count_max,
  text_code_points_max,
  request_id_pattern,
  request_text_valid,
  type BoardEvent,
  message_length_max,
  owner_pattern,
  whiteboard_path,
  whiteboard_protocol,
  type Binding,
} from '../shared/whiteboard'
import { api_request, type ApiAnswer } from './board_client'
import { browser_open } from './board_process'
import { canvas_preview, canvas_publish, canvas_snapshot } from './canvas_commands'
import { native_edit, native_scene } from './native_commands'
import { board_port } from './session_commands'
import { session_find, start, type Options } from './commands'
import { failure, success, type Outcome } from './output'
import { binding_directory, binding_install, binding_read } from './whiteboard_file'
import { binding_headers, machine_headers } from './whiteboard_scope'
import { native_route_scene } from '../shared/native_scene'

export type BoardFlags = Partial<
  Record<
    'protocol' | 'owner' | 'event' | 'message' | 'state' | 'binding' | 'layer' | 'source',
    string
  >
>
const usage = (command: string, message: string) =>
  failure('usage_error', message, { action: 'fix_usage', command: `tldraw-sync ${command} --help` })

const invalid_reply = () =>
  failure('invalid_response', 'Unexpected response from the board.', {
    action: 'ask_human',
    message: 'Check the bound session and upgrade the Mac board.',
  })
const protocol_text = String(whiteboard_protocol)
const upgrade = () =>
  failure('upgrade_required', `Whiteboard protocol ${protocol_text} is required.`, {
    action: 'ask_human',
    message: `Upgrade the CLI and daemon, restart safely and use --protocol ${protocol_text}.`,
  })

// The commands that work on the Agent canvas of a bound board.
const canvas_commands = ['whiteboard-snapshot', 'whiteboard-preview', 'whiteboard-publish']

export async function whiteboard(command: string, options: Options): Promise<Outcome> {
  try {
    const versioned = ['whiteboard-link', 'whiteboard-poll'].includes(command)

    if (versioned && options.protocol !== protocol_text) return upgrade()

    if (command === 'whiteboard-link') return await link(options)

    if (!options.binding) return usage(command, 'Supply --binding with the private file path.')

    const binding = binding_read(options.binding)

    if (command === 'whiteboard-scene' || command === 'whiteboard-edit') {
      const port = await board_port()

      if (typeof port !== 'number') return port

      return command === 'whiteboard-scene'
        ? await native_scene(port, binding, options)
        : await native_edit(port, binding, options)
    }

    if (canvas_commands.includes(command)) {
      const layer = options.layer ?? 'canvas'

      // There is one Agent canvas. The name is accepted where an earlier host still gives it.
      if (layer !== 'canvas') {
        return usage(command, 'There is one Agent canvas: leave --layer out.')
      }

      if (command !== 'whiteboard-snapshot' && (!options.file || options.file === '-')) {
        return usage(command, 'Name the scene file with --file <path>.')
      }

      // A bad binding must not launch a stage or read a file, even for an empty board.
      const access = await delivery('whiteboard-poll', binding, options)

      if (access.kind === 'failure') return access

      const scope = { binding, file: options.binding }
      const bound = { ...options, session: binding.session }

      if (command === 'whiteboard-snapshot') return await canvas_snapshot(bound, scope)

      return command === 'whiteboard-preview'
        ? await canvas_preview(bound, scope)
        : await canvas_publish(bound, scope)
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
  const status = await api_request(port, '/api/status?server=1', null)

  if (status.kind !== 'answer' || status.status !== 200) return refusal(status)

  if (status.body.protocol !== whiteboard_protocol) return upgrade()

  const native = options.native === true
  const bound = await link_binding(port, existing, out, owner, native)

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
    protocol: whiteboard_protocol,
    native,
  })
}

async function link_binding(
  port: number,
  existing: Binding | null,
  out: string,
  owner: string,
  native: boolean,
): Promise<Binding | Outcome> {
  if (existing) {
    const query = `protocol=${protocol_text}&${board_query(existing.session)}`
    const route = `${whiteboard_path}poll?${query}`
    const poll = await api_request(port, route, null, binding_headers(existing))

    if (poll.kind !== 'answer' || poll.status !== 200) return refusal(poll)

    if (poll.body.protocol !== whiteboard_protocol) return upgrade()

    if (!poll_checked(poll.body, existing)) return invalid_reply()

    if (!native) return existing

    // A native link never adopts a board with an Agent canvas.
    const scene = `${whiteboard_path}${native_route_scene}?${board_query(existing.session)}`
    const read = await api_request(port, scene, null, binding_headers(existing))
    return read.kind === 'answer' && read.status === 200 ? existing : refusal(read)
  }

  const response = await api_request(
    port,
    `${whiteboard_path}link`,
    JSON.stringify({ protocol: whiteboard_protocol, owner, ...(native ? { native } : {}) }),
    machine_headers(),
  )

  if (response.kind !== 'answer' || response.status !== 200) return refusal(response)

  if (response.body.protocol !== whiteboard_protocol) return upgrade()

  const { session, token } = response.body

  if (typeof session !== 'string' || typeof token !== 'string' || response.body.owner !== owner) {
    return refusal({ kind: 'unreachable' })
  }

  if (native && response.body.native !== true) return invalid_reply()

  const binding = { owner, session, token }
  binding_install(out, binding)
  return binding
}

async function delivery(command: string, binding: Binding, options: Options): Promise<Outcome> {
  const port = await board_port()

  if (typeof port !== 'number') return port

  const ack = command === 'whiteboard-ack'

  const state = event_states.find((s) => s !== 'queued' && s === options.state)

  if (ack && (!options.event || options.event.length > 128 || state === undefined)) {
    return usage(command, 'Supply an event and an acknowledgement state.')
  }

  // A status line while working; the answer for the pad when the request ends.
  if (ack && state !== undefined && !event_message_valid(state, options.message)) {
    return event_state_terminal(state)
      ? usage(command, `Give --message as an answer of 1 to ${text_code_points_max} characters.`)
      : usage(command, `Keep a --message for ${state} to ${message_length_max} characters.`)
  }

  const query = `?protocol=${protocol_text}&${board_query(binding.session)}`
  const route = `${whiteboard_path}${ack ? 'ack' : 'poll'}${query}`
  const body = ack
    ? JSON.stringify({ event: options.event, state: options.state, message: options.message })
    : null
  const answer = await api_request(port, route, body, binding_headers(binding))

  if (answer.kind !== 'answer' || answer.status !== 200) return refusal(answer)

  if (ack) {
    const { session, event, state } = answer.body

    if (session !== binding.session || event !== options.event || state !== options.state) {
      return invalid_reply()
    }

    const data = { session, event, state }
    return success('acknowledged', JSON.stringify(data), binding.session, data)
  }

  if (answer.body.protocol !== whiteboard_protocol) return upgrade()

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

    const event = value as BoardEvent
    const { id, kind, request_id, sketch_hash, created_at_ms, state, text, include_sketch } = event

    if (
      !event_kinds.some((known) => known === kind) ||
      typeof id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      typeof request_id !== 'string' ||
      !request_id_pattern.test(request_id) ||
      typeof sketch_hash !== 'string' ||
      !document_hash_pattern.test(sketch_hash) ||
      !Number.isSafeInteger(created_at_ms) ||
      created_at_ms < 0 ||
      !['queued', 'received', 'working'].includes(state) ||
      (text !== undefined && (!request_text_valid(text) || !text.length)) ||
      (include_sketch !== undefined && typeof include_sketch !== 'boolean') ||
      !event_request_complete({ text, include_sketch })
    )
      return null

    // Absent is the earlier meaning: the sketch goes with the words. False is words alone,
    // and there is no snapshot to take for it.
    const sketch = include_sketch === undefined ? {} : { include_sketch }
    pending.push({ id, kind, request_id, sketch_hash, created_at_ms, state, text, ...sketch })
  }

  const protocol = whiteboard_protocol
  return { protocol, session, owner, sketch_hash, agent_revision, events: pending }
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
