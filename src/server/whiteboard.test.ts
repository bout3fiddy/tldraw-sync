import { expect, test } from 'bun:test'
import { png_blank, png_signed } from '../shared/png'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import { registry_environment_simulated } from '../simulation/simulated_registry'
import { scene_example } from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Prng } from '../simulation/prng'
import { events_count_max, retired_message, whiteboard_protocol } from '../shared/whiteboard'
import { BoardEvents } from './board_events'
import { BoardRegistry } from './board_registry'
import { header_preview_id, whiteboard_route } from './http_whiteboard'
import { scoped_key } from './whiteboard_keys'

const key = '1'.repeat(64)
const hash = '1'.repeat(16)
const protocol = whiteboard_protocol
const id = (i: number) => i.toString(16).padStart(36, '0')

function request(action: string, token: string, owner: string, data?: object, origin?: string) {
  const body = data ? JSON.stringify(data) : undefined
  return new Request(`http://127.0.0.1/api/whiteboard/${action}`, {
    method: data ? 'POST' : 'GET',
    body,
    headers: {
      authorization: `Bearer ${token}`,
      'x-board-owner': owner,
      ...(body
        ? { 'content-type': 'application/json', 'content-length': `${Buffer.byteLength(body)}` }
        : {}),
      ...(origin ? { origin } : {}),
    },
  })
}

// A board linked to one owner, and the two credentials that speak for it.
async function linked(owner: string, time = new VirtualTime()) {
  const env = registry_environment_simulated(time)
  const registry = BoardRegistry.open(env)
  const link = request('link', key, owner, { owner, protocol })
  const binding = await (await whiteboard_route(link, registry, 'default', key, true)).json()
  const session = binding.session as string
  const host = binding.token as string
  const event_key = scoped_key(key, 'event', session, owner)
  const run = (req: Request, local = true) => whiteboard_route(req, registry, session, key, local)
  return { env, registry, session, host, event_key, run, time }
}

test('only the local machine links, and an older host is told to upgrade', async () => {
  const env = registry_environment_simulated(new VirtualTime())
  const registry = BoardRegistry.open(env)
  const owner = 'session-one'
  const link = (token: string, local: boolean, version: number = protocol) =>
    whiteboard_route(
      request('link', token, owner, { owner, protocol: version }),
      registry,
      'default',
      key,
      local,
    )
  expect((await link(hash, true)).status).toBe(403)
  expect((await link(key, false)).status).toBe(403)

  // A host that speaks the protocol before this one is told to upgrade, and links nothing.
  expect(await (await link(key, true, protocol - 1)).json()).toMatchObject({
    code: 'upgrade_required',
  })
  expect(registry.list()).toHaveLength(1)
  env.disk.write_fault_armed = true
  await expect(link(key, true)).rejects.toThrow(SimulatedCrash)
  expect(registry.list()).toHaveLength(1)
  const binding = await (await link(key, true)).json()
  expect((await (await link(key, true)).json()).session).toBe(binding.session)
  expect(binding.protocol).toBe(protocol)
  expect(registry.owner(binding.session)).toBe(owner)
  registry.close()
})

test('event authority cannot poll, ack, preview or publish; a request survives', async () => {
  const owner = 'session-one'
  const { env, registry, session, host, event_key, run } = await linked(owner)
  const binding = { token: host }
  expect((await run(request('poll', binding.token, 'session-two'))).status).toBe(403)

  for (const action of ['poll', 'ack', 'snapshot', 'preview', 'preview-image', 'publish']) {
    expect((await run(request(action, event_key, owner))).status).toBe(403)
    expect((await run(request(action, event_key, owner, {}))).status).toBe(403)
  }

  expect(await (await run(request('poll', binding.token, owner))).json()).toMatchObject({
    code: 'upgrade_required',
  })
  const stale = request(`poll?protocol=${protocol - 1}`, binding.token, owner)
  expect(await (await run(stale)).json()).toMatchObject({ code: 'upgrade_required' })
  const poll = request(`poll?protocol=${protocol}`, binding.token, owner)
  expect((await run(poll, false)).status).toBe(403)
  const { sketch_hash } = await (await run(poll)).json()
  const data = {
    kind: 'sketch_notify',
    sketch_hash,
    text: '筆\n 📝\t ',
    request_id: '00000000-0000-7aaa-8000-000000000001',
  }
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
  expect(recovered.events).toMatchObject([{ state: 'queued', ...data }])
  const retry = await whiteboard_route(
    request('event', event_key, owner, data),
    reopened,
    session,
    key,
    false,
  )
  expect(await retry.json()).toEqual(recovered.events[0])
  const conflict = request('event', event_key, owner, { ...data, text: 'different' })
  expect((await whiteboard_route(conflict, reopened, session, key, false)).status).toBe(409)
  const again = await whiteboard_route(poll, reopened, session, key, true)
  expect((await again.json()).events).toEqual(recovered.events)
  reopened.close()
})

// A Send is a conversation until the agent decides otherwise: it is queued, handed to the
// host, acknowledged to its end, and through all of it the Agent canvas is not written.
test('a Send with a note is delivered and answered without anything being published', async () => {
  const owner = 'talker'
  const { registry, session, host, event_key, run } = await linked(owner)
  const poll = () => run(request(`poll?protocol=${protocol}`, host, owner))
  const { sketch_hash, agent_revision } = await (await poll()).json()
  expect(agent_revision).toBe(0)
  const data = {
    kind: 'sketch_notify',
    sketch_hash,
    text: 'What do you make of the left column?',
    request_id: '00000000-0000-7aaa-8000-000000000002',
  }
  const board = registry.board_open(session)!
  const ink = board.document_state()
  const receipt = await (await run(request('event/v2', event_key, owner, data), false)).json()
  expect(receipt).toMatchObject({ ...data, state: 'queued' })
  const waiting = await (await poll()).json()
  expect(waiting.events).toMatchObject([{ id: receipt.id, kind: 'sketch_notify', text: data.text }])

  for (const state of ['received', 'working', 'updated']) {
    const ack = { event: receipt.id, state, message: state === 'updated' ? 'Answered.' : undefined }
    expect((await run(request('ack', host, owner, ack))).status).toBe(200)
  }

  const settled = await (await poll()).json()
  expect(settled).toMatchObject({ events: [], agent_revision: 0, sketch_hash })
  expect(board.cleaned_document()).toMatchObject({ revision: 0, current: null, records: [] })
  expect(board.document_state()).toEqual(ink)
  expect(board.events.latest()).toMatchObject({ state: 'updated', message: 'Answered.' })
  registry.close()
})

test('a request for the retired Interpret is refused at the door and queues nothing', async () => {
  const owner = 'old-page'
  const { registry, session, host, event_key, run } = await linked(owner)
  const poll = () => run(request(`poll?protocol=${protocol}`, host, owner))
  const { sketch_hash } = await (await poll()).json()
  const data = {
    kind: 'interpret_request',
    sketch_hash,
    request_id: '00000000-0000-7aaa-8000-000000000003',
  }
  const answer = await run(request('event/v2', event_key, owner, data), false)
  expect(answer.status).toBe(409)
  expect(await answer.json()).toEqual({ code: 'retired', message: retired_message })
  expect((await run(request('event/v2', event_key, owner, { ...data, kind: 'run' }))).status).toBe(
    400,
  )
  expect((await (await poll()).json()).events).toEqual([])
  expect(registry.board_open(session)!.events.latest()).toBeUndefined()
  registry.close()
})

// The host reads a snapshot, has a draft drawn, and publishes it. The draft and the publish
// are the same records; the draft itself changes nothing.
test('a draft is rendered from the records its publish saves, and publishes nothing', async () => {
  const owner = 'drafter'
  const { registry, session, host, run } = await linked(owner)
  const poll = async () => (await run(request(`poll?protocol=${protocol}`, host, owner))).json()
  const { sketch_hash } = await poll()
  const snapshot = await run(request(`snapshot?document_hash=${sketch_hash}`, host, owner))
  expect(await snapshot.json()).toMatchObject({
    session,
    document_hash: sketch_hash,
    agent_revision: 0,
    agent_source_hash: null,
    scene: null,
    canvas_legacy: false,
    title_wanted: true,
  })
  const scene = scene_example(sketch_hash, 0, 'Checkout', session)
  const drafted = await (await run(request('preview', host, owner, scene))).json()
  expect(drafted).toMatchObject({
    session,
    base_revision: 0,
    snapshot: sketch_hash,
    shapes_count: 4,
  })
  expect(drafted.preview).toMatch(/^[0-9a-f-]{36}$/)
  expect(await poll()).toMatchObject({ agent_revision: 0, events: [] })
  const board = registry.board_open(session)!
  expect(board.cleaned_document()).toMatchObject({ revision: 0, records: [] })
  expect(registry.find(session)?.name).toBeNull()

  // With no stage open nobody can draw it, and the request says so at once.
  const image_request = () => run(request(`preview-image?id=${drafted.preview}`, host, owner))
  const absent = await image_request()
  expect(absent.status).toBe(503)
  expect(await absent.json()).toMatchObject({ code: 'preview_not_ready', reason: 'stage_absent' })

  // The stage is handed exactly the records, draws them, and sends its picture back.
  const job = board.preview_job(null)
  expect(job.id).toBe(drafted.preview)
  expect(job.records!.map((record) => record.id)).toContain('shape:scene-title')
  expect(board.preview_job(drafted.preview)).toEqual({ id: drafted.preview })
  expect(board.preview_put(id(1), png_blank())).toBe(false)
  expect(board.preview_put(drafted.preview, png_blank())).toBe(true)
  expect(board.preview_job(null)).toEqual({ id: null })
  const image = await image_request()
  expect(image.status).toBe(200)
  expect(image.headers.get(header_preview_id)).toBe(drafted.preview)
  expect(png_signed(new Uint8Array(await image.arrayBuffer()))).toBe(true)

  // Publishing the same proposal saves the records the draft was drawn from.
  const published = await (await run(request('publish', host, owner, scene))).json()
  expect(published).toMatchObject({ kind: 'published', revision: 1, shapes_count: 4 })
  expect(published.records_hash).toBe(drafted.records_hash)
  expect(board.cleaned_document().records).toEqual(job.records!)
  expect(await poll()).toMatchObject({ agent_revision: 1 })
  registry.close()
})

test('a draft that would be refused is refused as a draft, for the same reason', async () => {
  const owner = 'careless'
  const { registry, session, host, run } = await linked(owner)
  const { sketch_hash } = await (
    await run(request(`poll?protocol=${protocol}`, host, owner))
  ).json()
  const scene = scene_example(sketch_hash, 0, 'Checkout', session)
  const board = registry.board_open(session)!
  const cases: Array<[object, number, string]> = [
    [{ ...scene, base_revision: 3 }, 409, 'revision_conflict'],
    [{ ...scene, snapshot: hash }, 409, 'sketch_changed'],
    [{ ...scene, session: 'default' }, 409, 'session_mismatch'],
    [
      { ...scene, elements: [{ type: 'image', id: 'a', src: 'http://example.com/a.png' }] },
      400,
      'invalid_scene',
    ],
    [{ ...scene, format: 'tldraw-sync.diagram.v1', nodes: [], edges: [] }, 400, 'invalid_scene'],
    [{ ...scene, format: 'tldraw-sync.cleanup.v1', shapes: [] }, 400, 'invalid_scene'],
  ]

  for (const action of ['preview', 'publish']) {
    for (const [body, status, code] of cases) {
      const answer = await run(request(action, host, owner, body))
      expect([action, answer.status, (await answer.json()).code]).toEqual([action, status, code])
    }

    const layered = await run(request(`${action}?layer=ideas`, host, owner, scene))
    expect(await layered.json()).toMatchObject({ code: 'invalid_layer' })
  }

  expect(board.preview_job(null)).toEqual({ id: null })
  expect(board.cleaned_document()).toMatchObject({ revision: 0, records: [] })

  // Nobody but the host, on this machine, is given a draft's picture or may ask for one.
  const drafted = await (await run(request('preview', host, owner, scene))).json()
  const image = `preview-image?id=${drafted.preview}`
  expect((await run(request(image, host, owner), false)).status).toBe(403)
  expect((await run(request(image, host, 'someone-else'))).status).toBe(403)
  expect((await run(request(image, key, owner))).status).toBe(403)
  expect((await run(request('preview', host, owner, scene, 'http://evil.example'))).status).toBe(
    403,
  )
  expect((await run(request('preview-image?id=nope', host, owner))).status).toBe(400)
  const unknown = await run(request(`preview-image?id=${id(7)}`, host, owner))
  expect(await unknown.json()).toMatchObject({ code: 'unknown_preview' })
  registry.close()
})

test('a newer draft replaces the one before it, and an empty canvas needs no stage', async () => {
  const owner = 'reviser'
  const { registry, session, host, run } = await linked(owner)
  const { sketch_hash } = await (
    await run(request(`poll?protocol=${protocol}`, host, owner))
  ).json()
  const scene = scene_example(sketch_hash, 0, 'First', session)
  const first = await (await run(request('preview', host, owner, scene))).json()
  const second = await (
    await run(request('preview', host, owner, { ...scene, elements: [scene.elements[0]] }))
  ).json()
  expect(second.preview).not.toBe(first.preview)
  expect(second.records_hash).not.toBe(first.records_hash)
  const board = registry.board_open(session)!
  expect(board.preview_put(first.preview, png_blank())).toBe(false)
  const replaced = await run(request(`preview-image?id=${first.preview}`, host, owner))
  expect(await replaced.json()).toMatchObject({ code: 'unknown_preview' })

  // Nothing to draw: the picture of an empty canvas is a blank page, ready at once.
  const empty = await (
    await run(request('preview', host, owner, { ...scene, elements: [] }))
  ).json()
  expect(empty).toMatchObject({ shapes_count: 0 })
  expect(board.preview_job(null)).toEqual({ id: null })
  const image = await run(request(`preview-image?id=${empty.preview}`, host, owner))
  expect(image.status).toBe(200)
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...png_blank()])
  expect(board.cleaned_status().revision).toBe(0)
  registry.close()
})

test('validates exact UTF-8 size, control marks and code points before queueing', async () => {
  const owner = 'boundary'
  const { registry, host, event_key, run } = await linked(owner)
  const poll = () => run(request(`poll?protocol=${protocol}`, host, owner))
  const { sketch_hash } = await (await poll()).json()
  const request_id = '00000000-0000-7aaa-8000-000000000001'
  const req = { kind: 'sketch_notify', sketch_hash, request_id }
  const send = (body: string) =>
    run(
      new Request('http://127.0.0.1/api/whiteboard/event/v2', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'content-length': `${Buffer.byteLength(body)}`,
          authorization: `Bearer ${event_key}`,
        },
      }),
    )

  for (const text of ['a'.repeat(4001), '\x00', '\ud800', '\x0b', null]) {
    expect((await send(JSON.stringify({ ...req, text }))).status).toBe(400)
  }

  const text = '🌱'.repeat(4000)
  const json = JSON.stringify({ ...req, text })
  const exact = json + ' '.repeat(16 * 1024 - Buffer.byteLength(json))
  expect((await send(exact + ' ')).status).toBe(413)
  expect((await (await poll()).json()).events).toEqual([])
  expect(await (await send(exact)).json()).toMatchObject({ ...req, text })
  expect((await (await poll()).json()).events).toHaveLength(1)
  registry.close()
})

test('a full queue refuses without losing a request; only completed slots can be reused', () => {
  const journal = BoardEvents.open(new SimulatedDisk())

  for (let n = 0; n < events_count_max; n++) journal.queue('sketch_notify', hash, n, id(n))

  const before = journal.outstanding()
  expect(journal.queue('sketch_notify', hash, 65, id(65))).toBe('full')
  expect(journal.outstanding()).toEqual(before)
  expect(journal.ack(id(0), 'updated')).toBe('transition')
  expect(journal.ack(id(0), 'received')).toMatchObject({ state: 'received' })
  expect(journal.ack(id(0), 'updated')).toMatchObject({ state: 'updated' })
  expect(journal.ack(id(0), 'updated')).toMatchObject({ state: 'updated' })
  expect(journal.ack(id(0), 'working')).toBe('transition')
  expect(journal.queue('sketch_notify', hash, 65, id(65))).toMatchObject({ id: id(65) })
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
          ? events.queue('sketch_notify', hash, seed, event_id)
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
