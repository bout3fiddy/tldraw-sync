// A board's chat at the routes a pad, the Mac stage and a host use: words alone or with the
// sketch, the host's view of each request, the agent's answer, and who may read any of it.
// Method: drive `whiteboard_route` on a simulated registry, as the network edge would.

import { expect, test } from 'bun:test'
import { SimulatedDisk } from '../simulation/simulated_disk'
import { registry_environment_simulated } from '../simulation/simulated_registry'
import { VirtualTime } from '../simulation/virtual_time'
import { header_board_stage, retired_message, whiteboard_protocol } from '../shared/whiteboard'
import { BoardEvents } from './board_events'
import { BoardRegistry } from './board_registry'
import { whiteboard_route } from './http_whiteboard'
import { envelope_encode } from './storage'
import { scoped_key } from './whiteboard_keys'

const key = '2'.repeat(64)
const protocol = whiteboard_protocol
const request_id = (n: number) =>
  `00000000-${n.toString(16).padStart(4, '0')}-7aaa-8000-00000000000${n % 10}`

type Headers = Record<string, string>

function request(action: string, token: string | null, data?: object, headers: Headers = {}) {
  const body = data ? JSON.stringify(data) : undefined
  return new Request(`http://127.0.0.1/api/whiteboard/${action}`, {
    method: data ? 'POST' : 'GET',
    body,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body
        ? { 'content-type': 'application/json', 'content-length': `${Buffer.byteLength(body)}` }
        : {}),
      ...headers,
    },
  })
}

async function linked(owner = 'chat-owner') {
  const env = registry_environment_simulated(new VirtualTime())
  const registry = BoardRegistry.open(env)
  const link = request('link', key, { owner, protocol })
  const binding = await (await whiteboard_route(link, registry, 'default', key, true)).json()
  const session = binding.session as string
  const owner_header = { 'x-board-owner': owner }
  const host = (action: string, data?: object) =>
    whiteboard_route(
      request(action, binding.token, data, owner_header),
      registry,
      session,
      key,
      true,
    )
  const pad_key = scoped_key(key, 'event', session, owner)
  const pad = (action: string, data?: object, token: string | null = pad_key) =>
    whiteboard_route(request(action, token, data), registry, session, key, false)
  const poll = async () => (await (await host(`poll?protocol=${protocol}`)).json()) as any
  const lookup = registry.board(session)

  if (lookup.kind !== 'board') throw Error('the linked board did not open')

  const board = lookup.board
  return { env, registry, session, host, pad, pad_key, poll, board, token: binding.token }
}

test('words alone queue without naming a sketch, and need words', async () => {
  const { pad, poll, board, registry } = await linked()
  const words = { kind: 'sketch_notify', request_id: request_id(1), include_sketch: false }
  const text = 'Say the gateway times out instead'

  // Refused without mutation: no words, blank words, a sketch named, a flag that is no flag.
  for (const body of [
    words,
    { ...words, text: '  \n ' },
    { ...words, text, sketch_hash: board.document_state().hash },
    { ...words, text, include_sketch: 'no' },
  ]) {
    expect((await pad('event/v2', body)).status).toBe(400)
  }

  expect(await (await pad('event/v2', words)).json()).toMatchObject({ code: 'text_required' })
  expect((await poll()).events).toEqual([])
  const receipt = await (await pad('event/v2', { ...words, text })).json()
  expect(receipt).toMatchObject({ ...words, text, state: 'queued' })
  expect(receipt.sketch_hash).toBe(board.document_state().hash)

  // The host is handed exactly what it has always had, and whether the sketch went.
  const [polled] = (await poll()).events
  expect(polled).toEqual(receipt)
  expect(Object.keys(polled).sort()).toEqual([
    'created_at_ms',
    'id',
    'include_sketch',
    'kind',
    'request_id',
    'sketch_hash',
    'state',
    'text',
  ])
  expect(board.events.latest()).not.toHaveProperty('shapes_count')
  registry.close()
})

test('a retry is the same request, never a second one, and never a different one', async () => {
  const { pad, poll, board, registry } = await linked()
  const sketch_hash = board.document_state().hash
  const words = {
    kind: 'sketch_notify',
    request_id: request_id(2),
    include_sketch: false,
    text: 'Hi',
  }
  const first = await (await pad('event/v2', words)).json()
  expect(await (await pad('event/v2', words)).json()).toEqual(first)

  // The same key with the sketch added, or other words, is a conflict and changes nothing.
  const with_sketch = { ...words, include_sketch: true, sketch_hash }
  expect((await pad('event/v2', with_sketch)).status).toBe(409)
  expect((await pad('event/v2', { ...words, text: 'Hello' })).status).toBe(409)

  // With the sketch, a retry must name the same sketch; absent means the sketch, as before.
  const sketch = {
    kind: 'sketch_notify',
    request_id: request_id(3),
    sketch_hash,
    include_sketch: true,
  }
  const sent = await (await pad('event/v2', sketch)).json()
  const legacy = { kind: 'sketch_notify', request_id: request_id(3), sketch_hash }
  expect(await (await pad('event/v2', legacy)).json()).toEqual(sent)
  const alone = { kind: 'sketch_notify', request_id: request_id(3), include_sketch: false }
  expect((await pad('event/v2', { ...alone, text: 'x' })).status).toBe(409)
  expect((await poll()).events).toHaveLength(2)
  expect(board.events.latest()).toMatchObject({ shapes_count: 0, revision_sent: 0 })

  // Words alone are the same words whatever the sketch has become since.
  const journal = BoardEvents.open(new SimulatedDisk())
  const request = { request_id: request_id(4), text: 'Again', include_sketch: false }
  const queued = journal.queue('sketch_notify', '1'.repeat(16), 1, '0'.repeat(36), request)
  expect(journal.replay('sketch_notify', '2'.repeat(16), request)).toEqual(queued)
  registry.close()
})

test('a status line is short; the answer is the final acknowledgement and is kept', async () => {
  const { pad, host, poll, board, registry } = await linked()
  const words = { kind: 'sketch_notify', request_id: request_id(5), include_sketch: false }
  const { id } = await (await pad('event/v2', { ...words, text: 'Which path?' })).json()
  const ack = (state: string, message?: string) => host('ack', { event: id, state, message })
  expect((await ack('received')).status).toBe(200)
  expect((await ack('working', 'x'.repeat(281))).status).toBe(400)
  expect((await ack('working', 'Reading the sketch')).status).toBe(200)

  // Refused answers change nothing: too long, controls, nothing but blanks.
  for (const message of ['🌱'.repeat(4001), 'a\x00b', '   ']) {
    expect((await ack('updated', message)).status).toBe(400)
  }

  expect(board.events.latest()).toMatchObject({ state: 'working', message: 'Reading the sketch' })
  const answer = '🌱'.repeat(3990) + '\nThe lower'
  expect(await (await ack('updated', answer)).json()).toMatchObject({ state: 'updated' })
  expect(board.events.latest()).toMatchObject({ message: answer, answer_seq: 1 })

  // Repeating the end changes nothing, and the host never sees the answer again.
  expect((await ack('updated', 'Something else')).status).toBe(200)
  expect(board.events.latest()).toMatchObject({ message: answer, answer_seq: 1 })
  expect((await poll()).events).toEqual([])
  registry.close()
})

test('only the pairing reads the chat, and it reads every word and receipt', async () => {
  const { pad, host, pad_key, token, board, registry, session } = await linked()
  const text = 'Good. How long should the hold be?'
  const sketch_hash = board.document_state().hash
  await pad('event/v2', { kind: 'sketch_notify', request_id: request_id(6), sketch_hash })
  const words = { kind: 'sketch_notify', request_id: request_id(7), include_sketch: false, text }
  const { id } = await (await pad('event/v2', words)).json()

  for (const state of ['received', 'working']) await host('ack', { event: id, state })

  await host('ack', { event: id, state: 'updated', message: 'Two minutes.' })

  // Nobody else: no key, the host's key, another board's pairing, a page from elsewhere.
  const other = scoped_key(key, 'event', 'abcdabcdabcdabcd', 'chat-owner')
  expect((await pad('chat', undefined, null)).status).toBe(403)
  expect((await pad('chat', undefined, token)).status).toBe(403)
  expect((await pad('chat', undefined, other)).status).toBe(403)
  const foreign = request('chat', pad_key, undefined, { origin: 'http://elsewhere' })
  expect((await whiteboard_route(foreign, registry, session, key, false)).status).toBe(403)

  const chat = await (await pad('chat')).json()
  expect(chat).toMatchObject({ protocol, session, answers_count: 1 })
  expect(chat.items).toMatchObject([
    { include_sketch: true, text: null, sketch_hash, shapes_count: 0, state: 'queued' },
    {
      id,
      include_sketch: false,
      text,
      sketch_hash: null,
      state: 'updated',
      status: null,
      reply: 'Two minutes.',
      answer_seq: 1,
      canvas_revision: null,
    },
  ])
  expect(chat.items[1].answered_at_ms).toBeGreaterThanOrEqual(chat.items[1].created_at_ms)

  // Nothing changed since: the answer is the count alone.
  const quiet = await (await pad(`chat?since=${chat.changes_count}`)).json()
  expect(quiet).toEqual({ ...chat, items: null })
  expect((await pad('chat?since=x')).status).toBe(400)
  registry.close()
})

test('the Mac stage is handed the pairing only on this Mac, by a page of its own', async () => {
  const { registry, session, pad_key } = await linked()
  const stage = (headers: Headers, local = true) =>
    whiteboard_route(request('stage', null, undefined, headers), registry, session, key, local)
  const asked = { [header_board_stage]: 'chat' }
  expect(await (await stage(asked)).json()).toEqual({ session, token: pad_key })
  expect((await stage(asked, false)).status).toBe(403)
  expect((await stage({})).status).toBe(403)
  expect((await stage({ ...asked, origin: 'http://127.0.0.1' })).status).toBe(403)

  // An unlinked board has no pairing to hand out.
  const unlinked = request('stage', null, undefined, asked)
  expect((await whiteboard_route(unlinked, registry, 'default', key, true)).status).toBe(403)
  registry.close()
})

test('a protocol 3 journal opens unchanged, and answers after it are counted from one', () => {
  const disk = new SimulatedDisk()
  const hash = 'f'.repeat(16)
  const old = (n: number, state: string, message?: string) => ({
    id: n.toString(16).padStart(36, '0'),
    kind: 'sketch_notify',
    sketch_hash: hash,
    created_at_ms: n,
    state,
    request_id: request_id(n),
    text: 'Keep the left column.',
    ...(message === undefined ? {} : { message }),
  })

  // An earlier board kept any short line, even one a new answer could not be.
  const saved = [
    old(1, 'updated', ''),
    old(2, 'failed', retired_message),
    old(3, 'working', 'On it'),
  ]
  const payload = new TextEncoder().encode(
    JSON.stringify({ events: saved, retired_through_ms: -1 }),
  )
  disk.write_atomic('events.state', envelope_encode({ kind: 'events', label: '-', payload }))
  const events = BoardEvents.open(disk)
  expect(events.chat()).toMatchObject({ answers_count: 0, changes_count: 0 })
  expect(events.chat().events).toEqual(saved as never)
  expect(events.ack(saved[2]!.id, 'updated', 'Done.', { revision: 2, now_ms: 9 })).toMatchObject({
    answer_seq: 1,
    revision_answered: 2,
    answered_at_ms: 9,
  })

  const reopened = BoardEvents.open(disk)
  expect(reopened.chat()).toMatchObject({ answers_count: 1, changes_count: 1 })
  expect(reopened.chat().events.slice(0, 2)).toEqual(saved.slice(0, 2) as never)
})
