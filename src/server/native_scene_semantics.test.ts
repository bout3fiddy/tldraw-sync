// Executable evidence for one native shared scene on the pinned tldraw sync 4.2.3 room: the
// iPad edits it, the Mac stage only reads it, and an agent writes native records through the
// room's own authoritative `updateStore` API. Nothing here is wired into the product yet; each
// test states which room semantics a later slice may rely on, and which ones it must not.
//
// Method: a real `TLSocketRoom`, real `TLSyncClient`s with real stores, and the editor's own
// `HistoryManager` (what `editor.undo()` runs) on the iPad store. The network is two in-memory
// queues per device, delivered in order by `network_settle`, so every interleaving below is an
// explicit, replayable schedule rather than a timing accident.

import { afterEach, expect, test } from 'bun:test'
import { TLSocketRoom, TLSyncClient, type RoomSnapshot } from '@tldraw/sync-core'
import {
  atom,
  createBindingId,
  createShapeId,
  createTLSchema,
  createTLStore,
  DocumentRecordType,
  HistoryManager,
  PageRecordType,
  TLDOCUMENT_ID,
  toRichText,
  type IndexKey,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGeoShape,
  type TLGroupShape,
  type TLRecord,
  type TLShape,
  type TLShapeId,
  type TLStore,
} from 'tldraw'
import { assert } from '../shared/assert'
import { Prng } from '../simulation/prng'
import { ClientSocket } from '../simulation/simulated_client'
import { globals_install, VirtualTime } from '../simulation/virtual_time'

const schema = createTLSchema()
const page_id = PageRecordType.createId('native')

// Every exchange here is a handful of messages; a schedule that has not settled after this
// many deliveries and timer runs is a livelock in the harness, not a slow network.
const network_steps_max = 1_000
const devices_count_max = 4

// The room batches data messages per session for one frame (`DATA_MESSAGE_DEBOUNCE_INTERVAL`,
// 1000 / 60 ms); a quiet network lets virtual time run this far to release such a batch.
const settle_window_ms = 20
const scene_seed = 4_203

// The wire protocol of the pinned sync 4.2.3. The raw-push test checks the room echoes it, so
// a dependency bump that changes the protocol fails loudly instead of testing nothing.
const sync_protocol_version = 8

// `RecordOpType.Put` on the wire; the enum itself is internal to sync-core.
const record_op_put = 'put'

type ServerSocket = { readyState: number; send(data: string): void; close(): void }
type Usable = { ensureStoreIsUsable(): void }

class Device {
  readonly store: TLStore
  readonly history: HistoryManager<TLRecord>
  readonly socket: ClientSocket
  readonly sync: TLSyncClient<TLRecord, TLStore>
  readonly to_server: string[] = []
  readonly to_client: string[] = []
  readonly server_socket: ServerSocket
  readonly sync_errors: string[] = []

  constructor(
    readonly name: string,
    readonly readonly_session: boolean,
  ) {
    this.store = createTLStore({ schema })
    this.history = new HistoryManager<TLRecord>({ store: this.store })
    this.server_socket = {
      readyState: 1,
      send: (data) => this.to_client.push(data),
      close: () => {
        this.server_socket.readyState = 3
      },
    }
    this.socket = new ClientSocket(
      (message) => this.to_server.push(JSON.stringify(message)),
      () => {},
    )
    this.sync = new TLSyncClient<TLRecord, TLStore>({
      store: this.store,
      socket: this.socket,
      presence: atom('presence', null),
      didCancel: () => false,
      onLoad: () => {},
      onSyncError: (reason) => {
        this.sync_errors.push(String(reason))
      },
      onAfterConnect: () => (this.store as unknown as Usable).ensureStoreIsUsable(),
    })
  }

  shape<T extends TLShape>(id: TLShapeId): T {
    const shape = this.store.get(id)
    assert(shape !== undefined, `${this.name} holds ${id}`)
    return shape as T
  }

  // A user gesture: one stopping point, then local writes with the store's default 'user'
  // source, which is what the editor's own tools produce and what its history records.
  gesture(name: string, change: () => void): void {

    // `editor.markHistoryStoppingPoint` is this call; `_mark` is internal to the typings.
    const history = this.history as unknown as { _mark(id: string): void }
    history._mark(name)
    change()
  }
}

class Scene {
  readonly time = new VirtualTime()
  readonly globals_uninstall: () => void
  readonly room: TLSocketRoom<TLRecord>
  readonly devices: Device[] = []
  data_changes_count = 0

  constructor() {

    // The room and clients call timers, `Date.now` and random ids directly; virtual time and a
    // fixed seed make every schedule below replay identically.
    this.globals_uninstall = globals_install(this.time, new Prng(scene_seed))
    this.room = new TLSocketRoom<TLRecord>({
      schema,
      initialSnapshot: snapshot_seeded(),
      onDataChange: () => {
        this.data_changes_count += 1
      },
    })
  }

  connect(name: string, readonly_session: boolean): Device {
    assert(this.devices.length < devices_count_max, 'devices are bounded')
    const device = new Device(name, readonly_session)
    this.devices.push(device)
    this.room.handleSocketConnect({
      sessionId: name,
      socket: device.server_socket,
      isReadonly: readonly_session,
    })
    device.socket.status_set('online')
    this.network_settle()
    assert(device.store.get(page_id) !== undefined, 'a connected device has the scene page')

    // The editor clears its history once mounted, so its setup writes are never undoable.
    device.history.clear()
    assert(device.history.getNumUndos() === 0, 'a mounted device starts with no history')
    return device
  }

  // Delivers queued messages in order, one per direction per device per round, and runs the
  // room's frame-batching timers when the wire is quiet, until neither has work left.
  network_settle(): number {
    let steps = 0

    while (steps < network_steps_max) {
      const steps_before = steps

      for (const device of this.devices) {
        const up = device.to_server.shift()

        if (up !== undefined) {
          this.room.handleSocketMessage(device.name, up)
          steps += 1
        }

        const down = device.to_client.shift()

        if (down !== undefined && device.server_socket.readyState === 1) {
          device.socket.message_deliver(JSON.parse(down) as object)
          steps += 1
        }
      }

      if (steps === steps_before) {
        if (!this.time.run_next(this.time.now_ms() + settle_window_ms)) return steps

        steps += 1
      }
    }

    throw new Error('the network did not settle within its step bound')
  }

  // The room's authoritative per-record history: the clock of each record's last change.
  changed_clock(id: string): number | null {
    const document = this.room
      .getCurrentSnapshot()
      .documents.find((candidate) => candidate.state.id === id)
    return document === undefined ? null : document.lastChangedClock
  }

  record<T extends TLRecord>(id: string): T | null {
    const record = this.room.getRecord(id)
    return record === undefined ? null : (record as T)
  }

  close(): void {
    for (const device of this.devices) device.sync.close()

    this.room.close()
    this.globals_uninstall()
  }
}

const scenes_open: Scene[] = []

afterEach(() => {
  for (const scene of scenes_open.splice(0)) scene.close()
})

function scene_open(): Scene {
  const scene = new Scene()
  scenes_open.push(scene)
  return scene
}

function snapshot_seeded(): RoomSnapshot {
  const records: TLRecord[] = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    PageRecordType.create({ id: page_id, name: 'Scene', index: 'a1' as IndexKey }),
  ]
  return {
    clock: 1,
    documentClock: 1,
    documents: records.map((state) => ({ state, lastChangedClock: 1 })),
    schema: schema.serialize(),
    tombstones: {},
  }
}

type GeoOptions = { x?: number; index?: string; color?: TLGeoShape['props']['color'] }

function geo(id: TLShapeId, options: GeoOptions = {}, meta: TLShape['meta'] = {}): TLGeoShape {
  return {
    id,
    typeName: 'shape',
    type: 'geo',
    x: options.x ?? 0,
    y: 0,
    rotation: 0,
    index: (options.index ?? 'a1') as IndexKey,
    parentId: page_id,
    isLocked: false,
    opacity: 1,
    meta,
    props: {
      w: 100,
      h: 100,
      geo: 'rectangle',
      dash: 'draw',
      growY: 0,
      url: '',
      scale: 1,
      color: options.color ?? 'black',
      labelColor: 'black',
      fill: 'none',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(''),
    },
  }
}

// The scene's paint order as the editor computes it: siblings sorted by fractional index.
function paint_order(store: TLStore): string[] {
  return store
    .allRecords()
    .filter((record): record is TLShape => record.typeName === 'shape')
    .filter((shape) => shape.parentId === page_id)
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
    .map((shape) => shape.id)
}

const agent_id = createShapeId('agent-box')
const user_id = createShapeId('user-box')

test('an agent record inserted through updateStore reaches both devices natively', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const mac = scene.connect('mac', true)
  const clock_before = scene.room.getCurrentDocumentClock()

  await scene.room.updateStore((store) => {
    store.put(geo(agent_id, { x: 10 }, { agent: 'claimed by meta only' }))
  })
  scene.network_settle()

  // One authoritative clock tick, one data change, and both stores hold the same record.
  const clock_after = scene.room.getCurrentDocumentClock()
  expect(clock_after).toBe(clock_before + 1)
  expect(scene.changed_clock(agent_id)).toBe(clock_after)
  expect(scene.data_changes_count).toBe(1)
  expect(ipad.shape<TLGeoShape>(agent_id)).toEqual(scene.record<TLGeoShape>(agent_id)!)
  expect(mac.shape<TLGeoShape>(agent_id)).toEqual(scene.record<TLGeoShape>(agent_id)!)

  // A remote insert is not part of the user's history: undo has nothing to take back.
  expect(ipad.history.getNumUndos()).toBe(0)
  ipad.history.undo()
  scene.network_settle()
  expect(scene.record(agent_id)).toEqual(ipad.shape(agent_id))
  expect(scene.room.getCurrentDocumentClock()).toBe(clock_after)
})

test('the iPad edits an agent shape in place, and the stage sees the same id move', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const mac = scene.connect('mac', true)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 })))
  scene.network_settle()
  const inserted_clock = scene.changed_clock(agent_id)!

  ipad.gesture('move', () => ipad.store.put([{ ...ipad.shape<TLGeoShape>(agent_id), x: 300 }]))
  scene.network_settle()

  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(300)
  expect(mac.shape<TLGeoShape>(agent_id).x).toBe(300)
  expect(
    scene.room.getCurrentSnapshot().documents.filter((d) => d.state.typeName === 'shape'),
  ).toHaveLength(1)
  expect(scene.changed_clock(agent_id)!).toBeGreaterThan(inserted_clock)
  expect(ipad.sync_errors).toEqual([])
})

test('per-object stacking holds in both orderings, whoever reorders', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const mac = scene.connect('mac', true)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { index: 'a2' })))
  scene.network_settle()

  // The user's shape below the agent's.
  ipad.gesture('draw', () => ipad.store.put([geo(user_id, { index: 'a1' })]))
  scene.network_settle()
  expect(paint_order(mac.store)).toEqual([user_id, agent_id])

  // The user brings theirs to the front: only the user record changes.
  const agent_clock = scene.changed_clock(agent_id)
  ipad.gesture('front', () => ipad.store.put([{ ...ipad.shape(user_id), index: 'a3' as IndexKey }]))
  scene.network_settle()
  expect(paint_order(mac.store)).toEqual([agent_id, user_id])
  expect(scene.changed_clock(agent_id)).toBe(agent_clock)

  // The agent brings its shape back to the front through the room.
  await scene.room.updateStore((store) => {
    store.put({ ...(store.get(agent_id) as TLGeoShape), index: 'a4' as IndexKey })
  })
  scene.network_settle()
  expect(paint_order(ipad.store)).toEqual([user_id, agent_id])
  expect(paint_order(mac.store)).toEqual([user_id, agent_id])
})

test('the stage session is refused at the server and its local edit is rolled back', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const mac = scene.connect('mac', true)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 })))
  scene.network_settle()
  const clock_before = scene.room.getCurrentDocumentClock()
  const changes_before = scene.data_changes_count

  mac.store.put([{ ...mac.shape<TLGeoShape>(agent_id), x: 999 }])
  mac.store.put([geo(user_id, { x: 50 })])
  expect(mac.shape<TLGeoShape>(agent_id).x).toBe(999)
  scene.network_settle()

  // The room discards the push: no clock tick, no data change, nothing broadcast.
  expect(scene.room.getCurrentDocumentClock()).toBe(clock_before)
  expect(scene.data_changes_count).toBe(changes_before)
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(10)
  expect(scene.record(user_id)).toBeNull()
  expect(ipad.store.get(user_id)).toBeUndefined()

  // The stage's speculative change is undone by the discard, not left as a divergent copy.
  expect(mac.shape<TLGeoShape>(agent_id).x).toBe(10)
  expect(mac.store.get(user_id)).toBeUndefined()
  expect(mac.sync_errors).toEqual([])
})

test('the iPad undoes and redoes its own move without touching the agent insert', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  scene.connect('mac', true)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 })))
  scene.network_settle()

  ipad.gesture('move', () => ipad.store.put([{ ...ipad.shape<TLGeoShape>(agent_id), x: 300 }]))
  scene.network_settle()
  expect(ipad.history.getNumUndos()).toBeGreaterThan(0)

  ipad.history.undo()
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(10)
  expect(ipad.history.getNumRedos()).toBeGreaterThan(0)

  ipad.history.redo()
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(300)

  // A second undo goes back past the move only; the agent's insert is not the user's step.
  ipad.history.undo()
  ipad.history.undo()
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)).not.toBeNull()
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(10)
})

type Color = TLGeoShape['props']['color']

function recolored(shape: TLGeoShape, color: Color): TLGeoShape {
  return { ...shape, props: { ...shape.props, color } }
}

// Risk, verified: undo restores whole records. An agent edit to another field of the same
// shape, landed between the user's gesture and their undo, is reverted by that undo, and redo
// does not bring it back. Edits to other records are untouched.
test('undo after an interleaved agent edit reverts that edit on the same record', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const mac = scene.connect('mac', true)
  await scene.room.updateStore((store) => {
    store.put(geo(agent_id, { x: 10 }))
    store.put(geo(user_id, { x: 600, index: 'a2' }))
  })
  scene.network_settle()

  ipad.gesture('move', () => ipad.store.put([{ ...ipad.shape<TLGeoShape>(agent_id), x: 300 }]))
  scene.network_settle()
  await scene.room.updateStore((store) => {
    store.put(recolored(store.get(agent_id) as TLGeoShape, 'red'))
    store.put(recolored(store.get(user_id) as TLGeoShape, 'blue'))
  })
  scene.network_settle()
  expect(ipad.shape<TLGeoShape>(agent_id).props.color).toBe('red')

  ipad.history.undo()
  scene.network_settle()
  const undone = scene.record<TLGeoShape>(agent_id)!
  expect(undone.x).toBe(10)
  expect(undone.props.color).toBe('black')
  expect(scene.record<TLGeoShape>(user_id)!.props.color).toBe('blue')
  expect(mac.shape<TLGeoShape>(agent_id)).toEqual(undone)

  ipad.history.redo()
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(300)
  expect(scene.record<TLGeoShape>(agent_id)!.props.color).toBe('black')
  expect(ipad.sync_errors).toEqual([])
})

// Overlap, verified: the room applies pushes in arrival order. Different fields of one record
// merge; the same field takes the last arrival, and the earlier writer is not told.
test('overlapping edits merge by field and the last arrival wins a field', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  scene.connect('mac', true)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 })))
  scene.network_settle()

  // The iPad's move is in flight while the agent recolours and moves the same shape.
  ipad.gesture('move', () => ipad.store.put([{ ...ipad.shape<TLGeoShape>(agent_id), x: 300 }]))
  expect(ipad.to_server.length).toBeGreaterThan(0)
  await scene.room.updateStore((store) => {
    store.put({ ...recolored(store.get(agent_id) as TLGeoShape, 'red'), x: 500 })
  })
  const agent_clock = scene.changed_clock(agent_id)!
  scene.network_settle()

  const merged = scene.record<TLGeoShape>(agent_id)!
  expect(merged.x).toBe(300)
  expect(merged.props.color).toBe('red')
  expect(ipad.shape<TLGeoShape>(agent_id)).toEqual(merged)
  expect(scene.changed_clock(agent_id)!).toBeGreaterThan(agent_clock)

  // The user's undo returns to what the user saw before, not to the agent's x of 500.
  ipad.history.undo()
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(10)
})

// Atomicity, verified: one synchronous `updateStore` is one push at one clock. A batch with an
// invalid record throws and leaves no trace: no clock tick, no data change, nothing broadcast.
test('an updateStore batch applies at one clock, or not at all', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const second_id = createShapeId('agent-second')

  await scene.room.updateStore((store) => {
    store.put(geo(agent_id, { x: 10 }))
    store.put(geo(second_id, { x: 20, index: 'a2' }))
  })
  scene.network_settle()
  expect(scene.changed_clock(agent_id)).toBe(scene.changed_clock(second_id))
  expect(scene.data_changes_count).toBe(1)

  const clock_before = scene.room.getCurrentDocumentClock()
  const invalid = { ...geo(user_id), props: { ...geo(user_id).props, color: 'plaid' } }
  const batch = scene.room.updateStore((store) => {
    store.put({ ...(store.get(agent_id) as TLGeoShape), x: 999 })
    store.put(invalid as unknown as TLGeoShape)
  })
  await expect(batch).rejects.toThrow('INVALID_RECORD')
  scene.network_settle()

  expect(scene.room.getCurrentDocumentClock()).toBe(clock_before)
  expect(scene.data_changes_count).toBe(1)
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(10)
  expect(scene.record(user_id)).toBeNull()
  expect(ipad.shape<TLGeoShape>(agent_id).x).toBe(10)
})

// Risk, verified: `updateStore` snapshots the room when it starts and writes whole records
// when it ends. Two overlapping calls, or one that awaits, silently undo writes that landed
// in between. Server writes must be serialized and their updaters synchronous.
test('overlapping or awaiting updateStore calls lose writes that land in between', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 })))
  scene.network_settle()

  await Promise.all([
    scene.room.updateStore((store) => {
      store.put({ ...(store.get(agent_id) as TLGeoShape), x: 500 })
    }),
    scene.room.updateStore((store) => {
      store.put(recolored(store.get(agent_id) as TLGeoShape, 'red'))
    }),
  ])
  expect(scene.record<TLGeoShape>(agent_id)!.props.color).toBe('red')
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(10)

  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writing = scene.room.updateStore(async (store) => {
    const read = store.get(agent_id) as TLGeoShape
    await gate
    store.put({ ...read, x: 700 })
  })
  scene.network_settle()
  ipad.gesture('recolor', () => ipad.store.put([recolored(ipad.shape(agent_id), 'green')]))
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.props.color).toBe('green')

  release()
  await writing
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(700)
  expect(scene.record<TLGeoShape>(agent_id)!.props.color).toBe('red')
  expect(ipad.shape<TLGeoShape>(agent_id).props.color).toBe('red')
})

type GuardOutcome = 'written' | 'conflict' | 'missing'

// Proposed rule, exercised here only: an agent write to an existing record names the room
// clock at which it read that record, and is refused when the room's own per-record history
// shows a later change. The check and the `updateStore` snapshot run in one synchronous turn,
// so no socket message can land between them; callers must still serialize server writes.
async function agent_update_guarded(
  scene: Scene,
  id: TLShapeId,
  read_clock: number,
  change: (shape: TLGeoShape) => TLGeoShape,
): Promise<GuardOutcome> {
  const changed_clock = scene.changed_clock(id)

  if (changed_clock === null) return 'missing'

  if (changed_clock > read_clock) return 'conflict'

  let outcome: GuardOutcome = 'missing'
  await scene.room.updateStore((store) => {
    const current = store.get(id) as TLGeoShape | null

    if (current === null) return

    store.put(change(current))
    outcome = 'written'
  })
  return outcome
}

// Metadata is client-writable, so it cannot carry authority: the iPad forges the marker an
// agent would check, and only the room's own history still sees the user's change.
test('client-writable meta is forgeable; the room clock still detects the change', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  const mac = scene.connect('mac', true)
  const agent_meta = { origin: 'agent', agent_revision: 7 }
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 }, agent_meta)))
  scene.network_settle()
  const read_clock = scene.room.getCurrentDocumentClock()

  // The user moves the agent's shape and keeps its marker; another shape claims to be agent's.
  ipad.gesture('move', () => ipad.store.put([{ ...ipad.shape<TLGeoShape>(agent_id), x: 300 }]))
  ipad.gesture('forge', () => ipad.store.put([geo(user_id, { index: 'a2' }, agent_meta)]))
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.meta).toEqual(agent_meta)
  expect(scene.record<TLGeoShape>(user_id)!.meta).toEqual(agent_meta)
  expect(mac.shape<TLGeoShape>(user_id).meta).toEqual(agent_meta)

  const outcome = await agent_update_guarded(scene, agent_id, read_clock, (shape) => ({
    ...shape,
    x: 50,
  }))
  expect(outcome).toBe('conflict')
  expect(scene.record<TLGeoShape>(agent_id)!.x).toBe(300)

  // Negative control: re-read at the current clock, the same guarded write goes through.
  const fresh_clock = scene.room.getCurrentDocumentClock()
  const absent_id = createShapeId('absent')
  expect(await agent_update_guarded(scene, absent_id, fresh_clock, (shape) => shape)).toBe(
    'missing',
  )
  const written = await agent_update_guarded(scene, agent_id, fresh_clock, (shape) => ({
    ...shape,
    x: 50,
  }))
  expect(written).toBe('written')
  scene.network_settle()
  expect(ipad.shape<TLGeoShape>(agent_id).x).toBe(50)
  expect(await agent_update_guarded(scene, user_id, 0, (shape) => shape)).toBe('conflict')
})

const arrow_id = createShapeId('user-arrow')
const binding_id = createBindingId('user-arrow-end')
const group_id = createShapeId('user-group')

function arrow(): TLArrowShape {
  return {
    ...geo(arrow_id, { x: 0, index: 'a3' }),
    type: 'arrow',
    props: {
      kind: 'arc',
      elbowMidPoint: 0.5,
      dash: 'draw',
      size: 'm',
      fill: 'none',
      color: 'black',
      labelColor: 'black',
      bend: 0,
      start: { x: 0, y: 0 },
      end: { x: 200, y: 0 },
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      richText: toRichText(''),
      labelPosition: 0.5,
      font: 'draw',
      scale: 1,
    },
  }
}

function arrow_binding(to_id: TLShapeId): TLArrowBinding {
  return {
    id: binding_id,
    typeName: 'binding',
    type: 'arrow',
    fromId: arrow_id,
    toId: to_id,
    meta: {},
    props: {
      terminal: 'end',
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: 'none',
    },
  }
}

// Risk, verified: the room keeps no referential integrity. The editor removes bindings and
// reparents children through its side effects; a server write bypasses them. A server delete
// that leaves the user's arrow binding behind keeps a binding to nothing; the same delete that
// also removes the binding lands atomically.
test('server deletes and parents are not checked against bindings or groups', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 300 })))
  scene.network_settle()
  ipad.gesture('connect', () => ipad.store.put([arrow(), arrow_binding(agent_id)]))
  scene.network_settle()
  expect(scene.record<TLArrowBinding>(binding_id)!.toId).toBe(agent_id)

  await scene.room.updateStore((store) => store.delete(agent_id))
  scene.network_settle()
  expect(scene.record(agent_id)).toBeNull()
  expect(scene.record<TLArrowBinding>(binding_id)!.toId).toBe(agent_id)
  expect(ipad.store.get(binding_id)).toBeDefined()

  const clock_before = scene.room.getCurrentDocumentClock()
  await scene.room.updateStore((store) => {
    store.delete(binding_id)
    store.delete(arrow_id)
  })
  expect(scene.room.getCurrentDocumentClock()).toBe(clock_before + 1)
  expect(scene.record(binding_id)).toBeNull()

  // A parent that does not exist is accepted as readily as one that does.
  const orphan = { ...geo(user_id, { index: 'a4' }), parentId: createShapeId('nowhere') }
  await scene.room.updateStore((store) => store.put(orphan))
  scene.network_settle()
  expect(scene.record<TLGeoShape>(user_id)!.parentId).toBe(createShapeId('nowhere'))
  expect(ipad.sync_errors).toEqual([])
})

// Risk, verified: an agent write built from a copy read before the user grouped its shape
// takes the shape back out of the group. The clock guard refuses the same stale write.
test('a stale agent write undoes a user reparent unless guarded by the room clock', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 300 })))
  scene.network_settle()
  const read_clock = scene.room.getCurrentDocumentClock()
  const agent_copy = scene.record<TLGeoShape>(agent_id)!

  const group: TLGroupShape = { ...geo(group_id, { index: 'a5' }), type: 'group', props: {} }
  ipad.gesture('group', () => {
    ipad.store.put([group, { ...ipad.shape<TLGeoShape>(agent_id), parentId: group_id }])
  })
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.parentId).toBe(group_id)

  const refused = await agent_update_guarded(scene, agent_id, read_clock, () => ({
    ...agent_copy,
    x: 320,
  }))
  expect(refused).toBe('conflict')
  expect(scene.record<TLGeoShape>(agent_id)!.parentId).toBe(group_id)

  await scene.room.updateStore((store) => store.put({ ...agent_copy, x: 320 }))
  scene.network_settle()
  expect(scene.record<TLGeoShape>(agent_id)!.parentId).toBe(page_id)
  expect(ipad.shape<TLGeoShape>(agent_id).parentId).toBe(page_id)
})

// Risk, verified: ids carry no generation. When the agent deletes a shape and creates a new one
// under the same id, the user's undo of an older gesture overwrites the new shape with the old
// one. The room clock moves on every step, so a guard keyed to it sees each replacement.
test('reusing a deleted id lets an older undo overwrite the new shape', async () => {
  const scene = scene_open()
  const ipad = scene.connect('ipad', false)
  await scene.room.updateStore((store) => store.put(geo(agent_id, { x: 10 })))
  scene.network_settle()
  ipad.gesture('move', () => ipad.store.put([{ ...ipad.shape<TLGeoShape>(agent_id), x: 300 }]))
  scene.network_settle()

  await scene.room.updateStore((store) => store.delete(agent_id))
  const deleted_clock = scene.room.getCurrentDocumentClock()
  expect(scene.room.getCurrentSnapshot().tombstones?.[agent_id]).toBe(deleted_clock)
  await scene.room.updateStore((store) => {
    store.put(geo(agent_id, { x: 900, color: 'violet', index: 'a2' }))
  })
  scene.network_settle()
  const recreated_clock = scene.changed_clock(agent_id)!
  expect(recreated_clock).toBeGreaterThan(deleted_clock)
  expect(scene.room.getCurrentSnapshot().tombstones?.[agent_id]).toBeUndefined()

  ipad.history.undo()
  scene.network_settle()
  const overwritten = scene.record<TLGeoShape>(agent_id)!
  expect(overwritten.x).toBe(10)
  expect(overwritten.props.color).toBe('black')
  expect(overwritten.index).toBe('a1' as IndexKey)
  expect(scene.changed_clock(agent_id)!).toBeGreaterThan(recreated_clock)
})

type RawPush = { name: string; readonly_session: boolean; invalid: boolean; applies: boolean }

// The last case is the positive control: the same valid record, pushed by an editable session
// without an invalid companion, does apply.
const raw_pushes: RawPush[] = [
  { name: 'editable-with-invalid', readonly_session: false, invalid: true, applies: false },
  { name: 'readonly-valid', readonly_session: true, invalid: false, applies: false },
  { name: 'editable-valid', readonly_session: false, invalid: false, applies: true },
]

// Atomicity of a client push, verified on the wire: a push with one invalid record is refused
// whole and its session closed; a read-only session's push changes nothing however it is made.
test('a client push applies whole or not at all, and read-only pushes never apply', () => {
  const scene = scene_open()
  scene.connect('ipad', false)

  for (const push of raw_pushes) {
    const clock_before = scene.room.getCurrentDocumentClock()
    const sent: string[] = []
    const socket: ServerSocket = {
      readyState: 1,
      send: (data) => sent.push(data),
      close: () => {
        socket.readyState = 3
      },
    }
    scene.room.handleSocketConnect({
      sessionId: push.name,
      socket,
      isReadonly: push.readonly_session,
    })
    scene.room.handleSocketMessage(push.name, raw_connect_message())
    const protocol = `"protocolVersion":${sync_protocol_version}`
    expect(sent.some((message) => message.includes(protocol))).toBe(true)

    scene.room.handleSocketMessage(push.name, raw_push_message(push.invalid))
    scene.network_settle()

    expect(scene.record(user_id)).toBeNull()

    if (push.applies) {

      // Refused and discarded pushes still advance the room clock, so document clocks are
      // monotonic but not dense: guards compare them, never count them.
      expect(scene.room.getCurrentDocumentClock()).toBeGreaterThan(clock_before + 1)
      expect(scene.changed_clock(agent_id)).toBe(scene.room.getCurrentDocumentClock())
      expect(scene.record<TLGeoShape>(agent_id)!.meta).toEqual({ origin: 'agent' })
    } else {
      expect(scene.room.getCurrentDocumentClock()).toBe(clock_before)
      expect(scene.record(agent_id)).toBeNull()
    }

    if (push.readonly_session)
      expect(sent.some((message) => message.includes('discard'))).toBe(true)

    expect(socket.readyState).toBe(push.invalid ? 3 : 1)
  }
})

function raw_connect_message(): string {
  return JSON.stringify({
    type: 'connect',
    connectRequestId: 'raw-connect',
    lastServerClock: 0,
    protocolVersion: sync_protocol_version,
    schema: schema.serialize(),
  })
}

// A client-made record that claims agent origin, optionally alongside one that fails validation.
function raw_push_message(invalid: boolean): string {
  const valid = geo(agent_id, { x: 10 }, { origin: 'agent' })
  const diff: Record<string, unknown> = { [valid.id]: [record_op_put, valid] }

  if (invalid) {
    diff[user_id] = [record_op_put, { ...valid, id: user_id, props: { color: 'plaid' } }]
  }

  return JSON.stringify({ type: 'push', clientClock: 1, diff })
}
