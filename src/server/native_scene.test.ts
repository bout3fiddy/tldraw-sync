// A native board through the routes a host and a paired iPad use: one shared scene, edited by
// the agent with its binding and taken back by the iPad's Undo through its pairing. Boards run
// on simulated disks in virtual time, so every crash point below is replayed exactly.

import { afterEach, expect, test } from 'bun:test'
import { createTLSchema, PageRecordType, TLDOCUMENT_ID } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { native_marker_read } from '../shared/native_scene'
import { whiteboard_protocol } from '../shared/whiteboard'
import {
  registry_environment_simulated,
  type SimulatedRegistryEnvironment,
} from '../simulation/simulated_registry'
import { VirtualTime } from '../simulation/virtual_time'
import type { Board } from './board'
import { BoardRegistry } from './board_registry'
import { whiteboard_route } from './http_whiteboard'
import { record_canonical, type SceneRecord } from './native_scene_ledger'
import { revisions_retained_max } from './native_edit_revision'
import { scoped_key } from './whiteboard_keys'

const key = '2'.repeat(64)
const owner = 'native-owner'
const page_id = PageRecordType.createId('page')
const schema = createTLSchema()
const sync_protocol_version = 8

type Point = { x: number; y: number; z: number }
type Json = Record<string, any>

const rough_points: Point[] = [
  { x: 0, y: 0, z: 0.31 },
  { x: 98, y: 3, z: 0.47 },
  { x: 101, y: 77, z: 0.52 },
  { x: 2, y: 80, z: 0.29 },
  { x: 1, y: 2, z: 0.44 },
]
const tidy_points: Point[] = [
  { x: 0, y: 0, z: 0.5 },
  { x: 100, y: 0, z: 0.5 },
  { x: 100, y: 80, z: 0.5 },
  { x: 0, y: 80, z: 0.5 },
  { x: 0, y: 0, z: 0.5 },
]

function stroke(id: string, points: Point[], x = 100): SceneRecord {
  return {
    id,
    typeName: 'shape',
    type: 'draw',
    x,
    y: 100,
    rotation: 0,
    index: 'a1',
    parentId: page_id,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      segments: [{ type: 'free', points }],
      isComplete: true,
      isClosed: false,
      isPen: true,
      scale: 1,
    },
  }
}

function request(
  action: string,
  token: string,
  data?: object,
  origin?: string,
  speaker = owner,
): Request {
  const body = data ? JSON.stringify(data) : undefined
  return new Request(`http://127.0.0.1/api/whiteboard/${action}`, {
    method: data ? 'POST' : 'GET',
    body,
    headers: {
      authorization: `Bearer ${token}`,
      'x-board-owner': speaker,
      ...(body
        ? { 'content-type': 'application/json', 'content-length': `${Buffer.byteLength(body)}` }
        : {}),
      ...(origin ? { origin } : {}),
    },
  })
}

type Native = {
  readonly env: SimulatedRegistryEnvironment
  registry: BoardRegistry
  session: string
  host: string
  pad: string
  run: (request: Request) => Promise<Response>
}

const registries: BoardRegistry[] = []

afterEach(() => {
  for (const registry of registries.splice(0)) registry.destroy()
})

async function native_linked(is_native = true, name = owner): Promise<Native> {
  const env = registry_environment_simulated(new VirtualTime())
  const registry = BoardRegistry.open(env)
  registries.push(registry)
  const fields = { owner: name, protocol: whiteboard_protocol, native: is_native }
  const response = await whiteboard_route(
    request('link', key, fields),
    registry,
    'default',
    key,
    true,
  )
  const binding = (await response.json()) as Json
  expect(binding.native).toBe(is_native)
  const session = String(binding.session)
  const pad = scoped_key(key, 'event', session, name)
  const native: Native = { env, registry, session, host: String(binding.token), pad, run: null! }
  native.run = (request: Request) => whiteboard_route(request, native.registry, session, key, true)
  return native
}

function board_of(native: Native): Board {
  const lookup = native.registry.board(native.session)
  assert(lookup.kind === 'board', 'the native board opens')
  return lookup.board
}

// An orderly stop saves everything; a crash keeps only what was on disk.
function restart(native: Native, orderly: boolean): void {
  const index = registries.indexOf(native.registry)
  assert(index >= 0, 'the registry is open')
  registries.splice(index, 1)

  if (orderly) native.registry.close()
  else native.registry.destroy()

  native.registry = BoardRegistry.open(native.env)
  registries.push(native.registry)
}

// Runs the board's timers, such as its debounced save, until none is due.
function timers_settle(native: Native): void {
  const time = native.env.time as VirtualTime
  let ran = 0

  while (ran < 100 && time.run_next(time.now_ms() + 60_000)) ran += 1

  assert(ran < 100, 'the timers settle')
}

// The iPad's sync connection, as the room sees one: a connect, then whole-record pushes.
function human(board: Board) {
  const socket = { readyState: 1, send: (_data: string) => {}, close: () => {} }
  let clock = 0
  const send = (message: object) =>
    board.session_message('ipad-test', socket as never, JSON.stringify(message))
  assert(board.session_open('ipad-test', 'draw', socket as never), 'the iPad connects')
  send({
    type: 'connect',
    connectRequestId: 'connect',
    lastServerClock: 0,
    protocolVersion: sync_protocol_version,
    schema: schema.serialize(),
  })
  return (record: SceneRecord) => {
    clock += 1
    send({ type: 'push', clientClock: clock, diff: { [record.id]: ['put', record] } })
  }
}

function record(board: Board, id: string): SceneRecord | undefined {
  return board.shapes().find((shape) => shape.id === id) as SceneRecord | undefined
}

async function scene(native: Native): Promise<Json> {
  const response = await native.run(request(`native/scene`, native.host))
  expect(response.status).toBe(200)
  return (await response.json()) as Json
}

async function tidy_edit(native: Native, request_id = 'tidy-request-1'): Promise<Json> {
  const read = await scene(native)
  const rough = read.records.find((r: SceneRecord) => r.id === 'shape:rough') as SceneRecord
  const props = rough.props as Json
  const tidied = {
    ...rough,
    props: { ...props, segments: [{ type: 'free', points: tidy_points }] },
  }
  return {
    request_id,
    base_sequence: read.base_sequence,
    adds: [],
    updates: [{ record: tidied, base_hash: read.hashes['shape:rough'] }],
    deletes: [],
  }
}

test('a native link makes a new native board, never adopting an Agent canvas', async () => {
  const native = await native_linked(true)
  const again = request('link', key, { owner, protocol: whiteboard_protocol, native: true })
  const relinked = await whiteboard_route(again, native.registry, 'default', key, true)
  expect(((await relinked.json()) as Json).session).toBe(native.session)
  expect(board_of(native).native).not.toBe(null)

  // A native board has no Agent canvas to publish to.
  const publish = await native.run(request('publish', native.host, { elements: [] }))
  expect(((await publish.json()) as Json).code).toBe('native_board')

  // An owner whose board has an Agent canvas keeps it; a native link is refused, unchanged.
  const legacy = await native_linked(false, 'legacy-owner')
  const native_link = request('link', key, {
    owner: 'legacy-owner',
    protocol: whiteboard_protocol,
    native: true,
  })
  const refused = await whiteboard_route(native_link, legacy.registry, 'default', key, true)
  expect([refused.status, ((await refused.json()) as Json).code]).toEqual([409, 'not_native'])
  expect(board_of(legacy).native).toBe(null)
  const read = await legacy.run(
    request('native/scene', legacy.host, undefined, undefined, 'legacy-owner'),
  )
  expect(((await read.json()) as Json).code).toBe('not_native')
})

test('the iPad takes an agent tidy of its own stroke back exactly, and only it can', async () => {
  const native = await native_linked()
  const push = human(board_of(native))
  push(stroke('shape:rough', rough_points))
  const original = record_canonical(record(board_of(native), 'shape:rough')!)
  const edit = await tidy_edit(native)

  // Only the host's binding edits: not the pairing, nor a page of another origin.
  expect((await native.run(request('native/edit', native.pad, edit))).status).toBe(403)
  const crossing = request('native/edit', native.host, edit, 'http://elsewhere')
  expect((await native.run(crossing)).status).toBe(403)
  const written = (await (
    await native.run(request('native/edit', native.host, edit))
  ).json()) as Json
  expect([written.result, written.sequence, written.reverts]).toEqual(['written', 1, null])
  const tidied = record(board_of(native), 'shape:rough')!
  expect((tidied.props as Json).segments[0].points).toEqual(tidy_points)
  const document = board_of(native)['room'].getRecord(TLDOCUMENT_ID)
  expect(native_marker_read(document?.meta)).toEqual({ sequence: 1, reverts: null })

  // Only the pairing reverts: not the host, a stranger, or another board's pairing.
  const revert = (token: string, sequence: number) =>
    native.run(request('native/revert', token, { sequence }))
  expect((await revert(native.host, 1)).status).toBe(403)
  expect((await revert('3'.repeat(64), 1)).status).toBe(403)
  expect((await revert(scoped_key(key, 'event', 'abcdabcdabcdabcd', owner), 1)).status).toBe(403)
  expect(record(board_of(native), 'shape:rough')).toEqual(tidied)

  const undone = (await (await revert(native.pad, 1)).json()) as Json
  expect([undone.sequence, undone.reverts]).toEqual([2, 1])
  expect(record_canonical(record(board_of(native), 'shape:rough')!)).toBe(original)
  const redone = (await (await revert(native.pad, 2)).json()) as Json
  expect([redone.sequence, redone.reverts]).toEqual([3, 2])
  expect(record(board_of(native), 'shape:rough')).toEqual(tidied)
  expect(((await (await revert(native.pad, 1)).json()) as Json).code).toBe('already_reverted')

  // A stale read is refused whole: the person moved the stroke since the agent read it.
  const stale = await tidy_edit(native, 'tidy-request-2')
  push({ ...record(board_of(native), 'shape:rough')!, x: 140 })
  const conflict = (await (
    await native.run(request('native/edit', native.host, stale))
  ).json()) as Json
  expect(conflict.code).toBe('conflict')
  expect(conflict.conflicts).toEqual([
    { id: 'shape:rough', reason: 'stale_base', related_id: null },
  ])
  expect(record(board_of(native), 'shape:rough')!.x).toBe(140)
})

test('a retried edit is answered from the journal across a restart, never twice', async () => {
  const native = await native_linked()
  const read = await scene(native)
  const box = { ...stroke('shape:new-box', tidy_points, 400) }
  const edit = {
    request_id: 'add-box-0001',
    base_sequence: read.base_sequence,
    adds: [box],
    updates: [],
    deletes: [],
  }
  const first = (await (await native.run(request('native/edit', native.host, edit))).json()) as Json
  expect(first.result).toBe('written')
  const minted = first.minted

  // An orderly restart: the same request is a replay, naming the same box.
  restart(native, true)
  const replay = (await (
    await native.run(request('native/edit', native.host, edit))
  ).json()) as Json
  expect([replay.result, replay.sequence, replay.minted]).toEqual(['replayed', 1, minted])
  expect(board_of(native).shapes()).toHaveLength(1)
  const reused = { ...edit, adds: [{ ...box, x: 9 }] }
  const reuse = (await (
    await native.run(request('native/edit', native.host, reused))
  ).json()) as Json
  expect(reuse.code).toBe('request_id_reused')

  // Once the revision has expired, the board cannot tell whether the request ran: it refuses.
  for (let index = 0; index < revisions_retained_max; index += 1) {
    const base = (await scene(native)).base_sequence
    const other = {
      ...edit,
      request_id: `other-${index}-0000`,
      base_sequence: base,
      adds: [{ ...box, x: index * 10 }],
    }
    expect((await native.run(request('native/edit', native.host, other))).status).toBe(200)
  }

  const shapes_count = board_of(native).shapes().length
  const late = (await (await native.run(request('native/edit', native.host, edit))).json()) as Json
  expect(late.code).toBe('replay_expired')
  expect(board_of(native).shapes()).toHaveLength(shapes_count)
})

// Every save an edit makes, crashed in turn: the intent, the room, the settled journal, and
// last a crash just after the acknowledgement. After the restart the edit is either applied and
// remembered, or absent and unacknowledged; a retry lands it exactly once.
test('a crash at any save leaves the edit acknowledged or absent; a retry lands once', async () => {
  for (let crash_at = 0; crash_at <= 3; crash_at += 1) {
    const native = await native_linked()
    const push = human(board_of(native))
    push(stroke('shape:rough', rough_points))
    timers_settle(native)
    const edit = await tidy_edit(native)
    const disk = native.env.disks.get(native.session)!
    let writes = 0
    disk.on_write = () => {
      writes += 1
      disk.write_fault_armed = writes === crash_at
    }
    disk.write_fault_armed = crash_at === 0
    const answer = await native.run(request('native/edit', native.host, edit))
    expect(answer.status).toBe(crash_at === 3 ? 200 : 503)
    disk.on_write = () => undefined
    disk.write_fault_armed = false

    // The process dies; everything in memory is lost, the disk is what is left.
    restart(native, false)
    const points = (record(board_of(native), 'shape:rough')!.props as Json).segments[0].points
    const landed = crash_at >= 2
    expect(points).toEqual(landed ? tidy_points : rough_points)
    const retry = (await (
      await native.run(request('native/edit', native.host, edit))
    ).json()) as Json
    expect([retry.result, retry.sequence]).toEqual([landed ? 'replayed' : 'written', 1])
    expect((record(board_of(native), 'shape:rough')!.props as Json).segments[0].points).toEqual(
      tidy_points,
    )
    expect(board_of(native).shapes()).toHaveLength(1)
  }
})

test('two edits read from the same bytes: one lands, the other is refused whole', async () => {
  const native = await native_linked()
  const push = human(board_of(native))
  push(stroke('shape:rough', rough_points))
  const first = await tidy_edit(native, 'concurrent-a')
  const second = await tidy_edit(native, 'concurrent-b')
  const moved = { ...second.updates[0].record, x: 600 }
  second.updates = [{ ...second.updates[0], record: moved }]
  const [a, b] = await Promise.all([
    native.run(request('native/edit', native.host, first)),
    native.run(request('native/edit', native.host, second)),
  ])
  expect([a.status, b.status]).toEqual([200, 409])
  expect(((await b.json()) as Json).conflicts[0].reason).toBe('stale_base')
  expect(record(board_of(native), 'shape:rough')!.x).toBe(100)
})
