import { expect, test } from 'bun:test'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import { registry_environment_simulated } from '../simulation/simulated_registry'
import { VirtualTime } from '../simulation/virtual_time'
import { Prng } from '../simulation/prng'
import { events_count_max } from '../shared/whiteboard'
import { BoardEvents } from './board_events'
import { BoardRegistry } from './board_registry'
import { whiteboard_route } from './http_whiteboard'
import { scoped_key } from './whiteboard_keys'

const key = '1'.repeat(64)
const hash = '1'.repeat(16)
const id = (i: number) => i.toString(16).padStart(36, '0')

function request(action: string, token: string, owner: string, data?: object, origin?: string) {
  const body = data ? JSON.stringify(data) : undefined
  return new Request(`http://127.0.0.1/api/whiteboard/${action}`, {
    method: data ? 'POST' : 'GET',
    body,
    headers: {
      authorization: `Bearer ${token}`,
      'x-board-owner': owner,
      ...(body ? { 'content-type': 'application/json', 'content-length': `${body.length}` } : {}),
      ...(origin ? { origin } : {}),
    },
  })
}

test('only the local machine links; event authority cannot poll, ack or publish', async () => {
  const env = registry_environment_simulated(new VirtualTime())
  const registry = BoardRegistry.open(env)
  const owner = 'session-one'
  const link = (token: string, local: boolean) =>
    whiteboard_route(request('link', token, owner, { owner }), registry, 'default', key, local)
  expect((await link(hash, true)).status).toBe(403)
  expect((await link(key, false)).status).toBe(403)
  env.disk.write_fault_armed = true
  await expect(link(key, true)).rejects.toThrow(SimulatedCrash)
  expect(registry.list()).toHaveLength(1)
  const binding = await (await link(key, true)).json()
  expect((await (await link(key, true)).json()).session).toBe(binding.session)
  const session: string = binding.session
  const event_key = scoped_key(key, 'event', session, owner)
  const run = (req: Request, local = true) => whiteboard_route(req, registry, session, key, local)
  expect((await run(request('poll', binding.token, 'session-two'))).status).toBe(403)

  for (const action of ['poll', 'ack', 'publish?layer=ideas']) {
    expect((await run(request(action, event_key, owner))).status).toBe(403)
  }

  const poll = request('poll', binding.token, owner)
  expect((await run(poll, false)).status).toBe(403)
  const { sketch_hash } = await (await run(poll)).json()
  const data = { kind: 'interpret_request', sketch_hash }
  expect((await run(request('event', event_key, owner, data, 'http://other'))).status).toBe(403)
  const refused = request('event', binding.token, owner, data)
  expect((await run(refused)).status).toBe(403)
  expect(refused.bodyUsed).toBe(true)
  const other = scoped_key(key, 'event', 'abcdabcdabcdabcd', 'session-two')
  expect((await run(request('event', other, owner, data))).status).toBe(403)
  expect(
    (await run(request('event', event_key, owner, { ...data, sketch_hash: hash }))).status,
  ).toBe(409)
  expect((await (await run(poll)).json()).events).toEqual([])
  expect((await run(request('event', event_key, owner, data), false)).status).toBe(200)
  registry.close()
  const reopened = BoardRegistry.open(env)
  expect(reopened.owner(session)).toBe(owner)
  const recovered = await (await whiteboard_route(poll, reopened, session, key, true)).json()
  expect(recovered.events).toMatchObject([{ state: 'queued', kind: data.kind, sketch_hash }])
  reopened.close()
})

test('full queues refuse without losing either kind; only completed slots can be reused', () => {
  const journal = BoardEvents.open(new SimulatedDisk())

  for (let n = 0; n < events_count_max; n++) {
    journal.queue(n % 2 ? 'interpret_request' : 'sketch_notify', hash, n, id(n))
  }

  const before = journal.outstanding()
  expect(journal.queue('interpret_request', hash, 65, id(65))).toBe('full')
  expect(journal.outstanding()).toEqual(before)
  expect(journal.ack(id(0), 'updated')).toBe('transition')
  expect(journal.ack(id(0), 'received')).toMatchObject({ state: 'received' })
  expect(journal.ack(id(0), 'updated')).toMatchObject({ state: 'updated' })
  expect(journal.ack(id(0), 'updated')).toMatchObject({ state: 'updated' })
  expect(journal.ack(id(0), 'working')).toBe('transition')
  expect(journal.queue('interpret_request', hash, 65, id(65))).toMatchObject({ id: id(65) })
  expect(journal.outstanding().slice(0, -1)).toEqual(before.slice(1))
})

test('journal recovery never exposes an uncommitted transition (replay SEED=n)', () => {
  const first = Number(process.env.SEED ?? 0)

  for (let seed = first; seed < first + (process.env.SEED ? 1 : 12); seed++) {
    const rng = new Prng(seed)
    const disk = new SimulatedDisk()
    let events = BoardEvents.open(disk)
    const event_id = id(seed)

    for (const state of ['queued', 'received', 'working', 'updated'] as const) {
      const transition = () =>
        state === 'queued'
          ? events.queue('interpret_request', hash, seed, event_id)
          : events.ack(event_id, state)
      const before = events.outstanding()
      disk.write_fault_armed = true
      expect(transition, `seed ${seed}, ${state}`).toThrow(SimulatedCrash)
      expect(events.outstanding()).toEqual(before)

      if (rng.chance(0.5)) events = BoardEvents.open(disk)

      expect(events.outstanding()).toEqual(before)
      expect(transition()).toMatchObject({ state })

      if (rng.chance(0.5)) events = BoardEvents.open(disk)

      expect(events.latest()).toMatchObject({ state })
    }

    expect(BoardEvents.open(disk).outstanding()).toEqual([])
  }
})
