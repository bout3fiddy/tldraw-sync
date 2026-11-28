// Agent writes planned against a real pinned `TLSocketRoom` (sync 4.2.3), with a human editing
// through a real editable session. Human pushes are whole records, which is what the editor's
// history replays on undo and redo (see native_scene_semantics.test.ts), so an undo here is a
// push of the record's earlier bytes. Virtual time and a fixed seed make every run replayable.
//
// Each refusal checks the room's documents, its document clock and the saved ledger are exactly
// as before; each write checks every record outside the plan is byte-identical afterwards.

import { afterEach, expect, test } from 'bun:test'
import { TLSocketRoom, type RoomSnapshot } from '@tldraw/sync-core'
import {
  createTLSchema,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  toRichText,
  type IndexKey,
  type TLRecord,
} from 'tldraw'
import { assert } from '../shared/assert'
import { Prng } from '../simulation/prng'
import { globals_install, VirtualTime } from '../simulation/virtual_time'
import {
  ledger_authority,
  ledger_create,
  ledger_decode,
  ledger_encode,
  ledger_intend,
  ledger_settle,
  record_canonical,
  record_hash,
  room_view_create,
  type Ledger,
  type RoomView,
  type SceneRecord,
} from './native_scene_ledger'
import {
  scene_plan,
  scene_plan_apply,
  scene_request_parse,
  scene_write,
  type SceneConflict,
  type ScenePlan,
  type SceneRequest,
  type SceneWriteResult,
} from './native_scene_plan'

const schema = createTLSchema()
const page_id = PageRecordType.createId('native')
const room_epoch = 'epoch-test'
const id_namespace = 'testns0001'
const board_seed = 4_211

// The wire protocol of the pinned sync 4.2.3, as native_scene_semantics.test.ts checks.
const sync_protocol_version = 8
const human_session = 'ipad'

type Diff = Record<string, ['put', TLRecord] | ['remove']>
type Options = { x?: number; index?: string; parent?: string; color?: string }

class Board {
  readonly time = new VirtualTime()
  readonly globals_uninstall: () => void
  readonly room: TLSocketRoom<TLRecord>
  readonly saved: string[] = []
  readonly human_socket = { readyState: 1, send: (_data: string) => {}, close: () => {} }
  ledger: Ledger
  client_clock = 0

  constructor(seed: number) {
    this.globals_uninstall = globals_install(this.time, new Prng(seed))
    this.room = new TLSocketRoom<TLRecord>({ schema, initialSnapshot: snapshot_seeded() })
    const document_clock = this.room.getCurrentDocumentClock()
    this.ledger = ledger_create({ room_epoch, id_namespace, document_clock })
    this.human_socket.close = () => {
      this.human_socket.readyState = 3
    }
    this.room.handleSocketConnect({
      sessionId: human_session,
      socket: this.human_socket,
      isReadonly: false,
    })
    this.room.handleSocketMessage(
      human_session,
      JSON.stringify({
        type: 'connect',
        connectRequestId: 'human-connect',
        lastServerClock: 0,
        protocolVersion: sync_protocol_version,
        schema: schema.serialize(),
      }),
    )
  }

  view(): RoomView {
    const viewed = room_view_create(this.room.getCurrentSnapshot(), room_epoch)
    assert(viewed.ok, 'the test room is always readable')
    return viewed.view
  }

  async agent(value: unknown, epoch = room_epoch): Promise<SceneWriteResult> {
    const parsed = scene_request_parse(value)
    assert(parsed.ok, `the request parses: ${parsed.ok ? '' : parsed.errors.join('; ')}`)
    const result = await scene_write({
      room: this.room,
      room_epoch: epoch,
      ledger: this.ledger,
      request: parsed.request,
      ledger_saver: { save: (ledger) => this.saved.push(ledger_encode(ledger)) },
    })
    this.ledger = result.outcome.ledger
    return result
  }

  // One human gesture: a push of whole records, which the room must accept.
  human(diff: Diff): void {
    this.client_clock += 1
    const push = { type: 'push', clientClock: this.client_clock, diff }
    this.room.handleSocketMessage(human_session, JSON.stringify(push))
    assert(this.human_socket.readyState === 1, 'the human session stays open')

    for (const [id, op] of Object.entries(diff)) {
      const record = this.room.getRecord(id)

      if (op[0] === 'remove') assert(record === undefined, `the human removed ${id}`)
      else assert(record !== undefined, `the human put ${id}`)
    }
  }

  human_put(...records: SceneRecord[]): void {
    const diff: Diff = {}

    for (const record of records) diff[record.id] = ['put', record as unknown as TLRecord]

    this.human(diff)
  }

  human_remove(...ids: string[]): void {
    const diff: Diff = {}

    for (const id of ids) diff[id] = ['remove']

    this.human(diff)
  }

  record(id: string): SceneRecord {
    const record = this.room.getRecord(id)
    assert(record !== undefined, `the room holds ${id}`)
    return record as unknown as SceneRecord
  }

  hash(id: string): string {
    return record_hash(this.record(id))
  }

  changed_clock(id: string): number | null {
    return this.view().documents.get(id)?.lastChangedClock ?? null
  }

  // Everything a write could change: each document's bytes, and the document clock.
  state(): { documents: Map<string, string>; document_clock: number } {
    const view = this.view()
    const documents = new Map<string, string>()

    for (const [id, document] of view.documents) documents.set(id, record_canonical(document.state))

    return { documents, document_clock: view.document_clock }
  }

  close(): void {
    this.room.close()
    this.globals_uninstall()
  }
}

const boards_open: Board[] = []

afterEach(() => {
  for (const board of boards_open.splice(0)) board.close()
})

function board_open(seed = board_seed): Board {
  const board = new Board(seed)
  boards_open.push(board)
  return board
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

function shape_base(id: string, type: string, options: Options) {
  return {
    id,
    typeName: 'shape',
    type,
    x: options.x ?? 0,
    y: 0,
    rotation: 0,
    index: options.index ?? 'a1',
    parentId: options.parent ?? page_id,
    isLocked: false,
    opacity: 1,
    meta: {},
  }
}

function geo(id: string, options: Options = {}): SceneRecord {
  const props = {
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
  }
  return { ...shape_base(id, 'geo', options), props }
}

function group(id: string, options: Options = {}): SceneRecord {
  return { ...shape_base(id, 'group', options), props: {} }
}

function arrow(id: string, options: Options = {}): SceneRecord {
  const props = {
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
  }
  return { ...shape_base(id, 'arrow', options), props }
}

function binding(id: string, from_id: string, to_id: string, terminal: 'start' | 'end') {
  const props = {
    terminal,
    normalizedAnchor: { x: 0.5, y: 0.5 },
    isExact: false,
    isPrecise: false,
    snap: 'none',
  }
  return { id, typeName: 'binding', type: 'arrow', fromId: from_id, toId: to_id, meta: {}, props }
}

function adds(...records: SceneRecord[]): SceneRequest {
  return { adds: records, updates: [], deletes: [] }
}

function update_of(board: Board, id: string, patch: Record<string, unknown>): SceneRequest {
  const record = { ...board.record(id), ...patch }
  return { adds: [], updates: [{ record, base_hash: board.hash(id) }], deletes: [] }
}

function deletes_of(board: Board, ...ids: string[]): SceneRequest {
  return { adds: [], updates: [], deletes: ids.map((id) => ({ id, base_hash: board.hash(id) })) }
}

function minted(result: SceneWriteResult): Map<string, string> {
  assert(result.outcome.kind === 'written', `the write landed: ${result.outcome.kind}`)
  return new Map(result.outcome.minted.map((pair) => [pair.placeholder, pair.id]))
}

function id_of(ids: Map<string, string>, placeholder: string): string {
  const id = ids.get(placeholder)
  assert(id !== undefined, `${placeholder} was minted`)
  return id
}

function conflicts(result: SceneWriteResult): readonly SceneConflict[] {
  assert(result.plan !== null && result.plan.kind === 'refused', 'the request was refused')
  return result.plan.conflicts
}

// Runs a request that must be refused and proves it changed nothing at all.
async function refused(board: Board, request: unknown): Promise<readonly SceneConflict[]> {
  const before = board.state()
  const ledger_before = ledger_encode(board.ledger)
  const saved_count = board.saved.length
  const result = await board.agent(request)
  expect(result.outcome.kind).toBe('refused')
  expect(board.state()).toEqual(before)
  expect(ledger_encode(board.ledger)).toBe(ledger_before)
  expect(board.saved.length).toBe(saved_count)
  return conflicts(result)
}

// References that point at nothing: shapes whose parent is gone, bindings missing a shape.
function dangling(board: Board): string[] {
  const view = board.view()
  const found: string[] = []

  for (const [id, document] of view.documents) {
    const state = document.state
    const references =
      state.typeName === 'shape'
        ? [state['parentId']]
        : state.typeName === 'binding'
          ? [state['fromId'], state['toId']]
          : []

    for (const reference of references) {
      if (typeof reference === 'string' && !view.documents.has(reference)) found.push(id)
    }
  }

  return found.sort()
}

function paint_order(board: Board): string[] {
  return [...board.view().documents.values()]
    .map((document) => document.state)
    .filter((state) => state.typeName === 'shape' && state['parentId'] === page_id)
    .sort((a, b) => (String(a['index']) < String(b['index']) ? -1 : 1))
    .map((state) => state.id)
}

test('a mixed agent batch lands at one clock beside byte-identical human records', async () => {
  const board = board_open()
  board.human_put(geo('shape:human-a', { index: 'a1' }), geo('shape:human-b', { index: 'a5' }))
  const before = board.state()
  const result = await board.agent(
    adds(
      group('shape:new-group', { index: 'a2' }),
      geo('shape:new-left', { parent: 'shape:new-group', index: 'a1' }),
      geo('shape:new-right', { parent: 'shape:new-group', index: 'a2', x: 300 }),
      arrow('shape:new-arrow', { index: 'a3' }),
      binding('binding:new-start', 'shape:new-arrow', 'shape:new-left', 'start'),
      binding('binding:new-end', 'shape:new-arrow', 'shape:new-right', 'end'),
    ),
  )
  const ids = minted(result)
  const after = board.state()
  expect(after.document_clock).toBe(before.document_clock + 1)

  for (const [id, bytes] of before.documents) expect(after.documents.get(id)).toBe(bytes)

  for (const id of ids.values()) {
    expect(id.startsWith(`${id.split(':')[0]}:agent-${id_namespace}-`)).toBe(true)
    expect(board.changed_clock(id)).toBe(after.document_clock)
    expect(board.ledger.entries.get(id)).toEqual({
      clock: after.document_clock,
      hash: board.hash(id),
    })
  }

  const group_id = id_of(ids, 'shape:new-group')
  expect(board.record(id_of(ids, 'shape:new-left'))['parentId']).toBe(group_id)
  expect(board.record(id_of(ids, 'binding:new-end'))['toId']).toBe(id_of(ids, 'shape:new-right'))
  expect(dangling(board)).toEqual([])

  // Ordinary stacking: agent and human shapes interleave by their own fractional index.
  const arrow_id = id_of(ids, 'shape:new-arrow')
  expect(paint_order(board)).toEqual(['shape:human-a', group_id, arrow_id, 'shape:human-b'])

  // Write-ahead: the intent was saved first, then the settled ledger without it.
  expect(board.saved).toHaveLength(2)
  const intent = ledger_decode(board.saved[0]!)
  const settled = ledger_decode(board.saved[1]!)
  expect(intent.ok && intent.ledger.pending?.puts.length).toBe(6)
  expect(settled.ok && settled.ledger.pending).toBeNull()
})

test('a human edit, undo or redo adopts an agent record for good', async () => {
  const board = board_open()
  const ids = minted(
    await board.agent(
      adds(
        geo('shape:new-box'),
        geo('shape:new-other', {
          index: 'a2',
        }),
      ),
    ),
  )
  const box = id_of(ids, 'shape:new-box')
  const original = board.record(box)
  const human_edited: SceneConflict[] = [{ id: box, reason: 'human_edited', related_id: null }]

  // The agent re-reads after the move, so its base is fresh; the room's clock still refuses.
  board.human_put({ ...original, x: 300 })
  expect(await refused(board, update_of(board, box, { x: 50 }))).toEqual(human_edited)
  expect(await refused(board, deletes_of(board, box))).toEqual(human_edited)

  // Undo restores the agent's exact bytes. Writing now would sit behind the human's redo.
  board.human_put(original)
  expect(board.hash(box)).toBe(board.ledger.entries.get(box)!.hash)
  expect(await refused(board, update_of(board, box, { x: 50 }))).toEqual(human_edited)

  board.human_put({ ...original, x: 300 })
  expect(await refused(board, update_of(board, box, { x: 50 }))).toEqual(human_edited)
  expect(board.record(box)['x']).toBe(300)

  // Positive control: the agent's untouched record updates in the same room.
  const other = id_of(ids, 'shape:new-other')
  expect((await board.agent(update_of(board, other, { x: 450 }))).outcome.kind).toBe('written')
  expect(board.record(other)['x']).toBe(450)
})

test('a human delete is final for the agent, and its undo never hands the id back', async () => {
  const board = board_open()
  const ids = minted(
    await board.agent(adds(geo('shape:new-a'), geo('shape:new-b', { index: 'a2' }))),
  )
  const a = id_of(ids, 'shape:new-a')
  const b = id_of(ids, 'shape:new-b')
  const original = board.record(a)
  const base_hash = board.hash(a)
  board.human_remove(a)

  const removal = { adds: [], updates: [], deletes: [{ id: a, base_hash }] }
  const update = { adds: [], updates: [{ record: { ...original, x: 9 }, base_hash }], deletes: [] }
  expect(await refused(board, update)).toEqual([
    { id: a, reason: 'human_deleted', related_id: null },
  ])
  expect(await refused(board, removal)).toEqual([
    { id: a, reason: 'human_deleted', related_id: null },
  ])

  // The next settle forgets the absent record; it is simply missing from then on.
  expect((await board.agent(update_of(board, b, { x: 5 }))).outcome.kind).toBe('written')
  expect(board.ledger.entries.has(a)).toBe(false)
  expect(await refused(board, update)).toEqual([
    { id: a, reason: 'record_missing', related_id: null },
  ])

  // The human's undo brings it back as theirs.
  board.human_put(original)
  const restored: SceneConflict[] = [{ id: a, reason: 'not_agent_record', related_id: null }]
  expect(await refused(board, update)).toEqual(restored)
  expect(await refused(board, removal)).toEqual(restored)

  // The agent cannot name the id for a new record; a new record gets a later id.
  expect(scene_request_parse(adds(geo(a))).ok).toBe(false)
  const fresh = id_of(minted(await board.agent(adds(geo('shape:new-a')))), 'shape:new-a')
  expect(fresh).not.toBe(a)
  expect(fresh).toBe(`shape:agent-${id_namespace}-3`)
  expect(board.record(a)).toEqual(original)
})

test('a foreign child or a human binding pins the agent unit', async () => {
  const board = board_open()
  const ids = minted(
    await board.agent(
      adds(
        group('shape:new-group'),
        geo('shape:new-child', { parent: 'shape:new-group' }),
        geo('shape:new-box', { index: 'a3', x: 500 }),
      ),
    ),
  )
  const group_id = id_of(ids, 'shape:new-group')
  const child = id_of(ids, 'shape:new-child')
  const box = id_of(ids, 'shape:new-box')

  // The human draws a shape and moves it into the agent's group.
  board.human_put(geo('shape:human-h', { index: 'a4' }))
  board.human_put({ ...board.record('shape:human-h'), parentId: group_id })
  const pinned: SceneConflict[] = [
    { id: group_id, reason: 'foreign_dependent', related_id: 'shape:human-h' },
  ]
  expect(await refused(board, update_of(board, group_id, { x: 40 }))).toEqual(pinned)
  expect(await refused(board, deletes_of(board, group_id, child))).toEqual(pinned)

  // A sibling's own record is still the agent's; the human child is not touched.
  const human_bytes = record_canonical(board.record('shape:human-h'))
  expect((await board.agent(update_of(board, child, { x: 20 }))).outcome.kind).toBe('written')
  expect(record_canonical(board.record('shape:human-h'))).toBe(human_bytes)

  // The human connects their own arrow to the agent's box.
  board.human_put(
    arrow('shape:human-arrow', { index: 'a5' }),
    binding('binding:human-end', 'shape:human-arrow', box, 'end'),
  )
  const bound = await refused(board, update_of(board, box, { x: 600 }))
  expect(bound).toContainEqual({
    id: box,
    reason: 'foreign_dependent',
    related_id: 'binding:human-end',
  })
  expect(bound).toContainEqual({
    id: box,
    reason: 'foreign_dependent',
    related_id: 'shape:human-arrow',
  })
  const deleting = await refused(board, deletes_of(board, box))
  expect(deleting).toContainEqual({
    id: box,
    reason: 'foreign_dependent',
    related_id: 'binding:human-end',
  })
  expect(dangling(board)).toEqual([])
})

test('deletes must carry their whole closure, and then leave nothing dangling', async () => {
  const board = board_open()
  const ids = minted(
    await board.agent(
      adds(
        group('shape:new-group'),
        geo('shape:new-one', { parent: 'shape:new-group' }),
        geo('shape:new-two', { parent: 'shape:new-group', index: 'a2' }),
        arrow('shape:new-arrow', { index: 'a2' }),
        binding('binding:new-end', 'shape:new-arrow', 'shape:new-one', 'end'),
      ),
    ),
  )
  const [group_id, one, two, arrow_id, end] = [
    'shape:new-group',
    'shape:new-one',
    'shape:new-two',
    'shape:new-arrow',
    'binding:new-end',
  ].map((placeholder) => id_of(ids, placeholder))
  assert(group_id !== undefined && one !== undefined && two !== undefined, 'shapes were minted')
  assert(arrow_id !== undefined && end !== undefined, 'the arrow and binding were minted')

  const partial = await refused(board, deletes_of(board, group_id))
  expect(partial).toEqual([
    { id: group_id, reason: 'dependent_kept', related_id: one },
    { id: group_id, reason: 'dependent_kept', related_id: two },
    { id: group_id, reason: 'dependent_kept', related_id: end },
  ])

  const result = await board.agent(deletes_of(board, group_id, one, two, end))
  expect(result.outcome.kind).toBe('written')

  for (const id of [group_id, one, two, end]) expect(board.room.getRecord(id)).toBeUndefined()

  expect(board.record(arrow_id)['type']).toBe('arrow')
  expect(dangling(board)).toEqual([])
  expect([...board.ledger.entries.keys()]).toEqual([arrow_id])
})

test('one conflict refuses the whole batch, and conflicts are reported in a bound', async () => {
  const board = board_open()
  const humans = Array.from({ length: 100 }, (_, index) => geo(`shape:human-${index}`))
  board.human_put(...humans)
  const box = id_of(minted(await board.agent(adds(geo('shape:new-box')))), 'shape:new-box')

  const mixed: SceneRequest = {
    adds: [geo('shape:new-x'), geo('shape:new-y'), geo('shape:new-z', { parent: 'shape:new-x' })],
    updates: [
      { record: { ...board.record(box), x: 70 }, base_hash: board.hash(box) },
      {
        record: { ...board.record('shape:human-7'), x: 70 },
        base_hash: board.hash('shape:human-7'),
      },
    ],
    deletes: [],
  }
  expect(await refused(board, mixed)).toEqual([
    { id: 'shape:human-7', reason: 'not_agent_record', related_id: null },
  ])
  expect(board.ledger.id_sequence_next).toBe(2)

  const many = await board.agent(deletes_of(board, ...humans.map((human) => human.id)))
  expect(many.plan?.kind).toBe('refused')

  if (many.plan?.kind !== 'refused') return

  expect(many.plan.conflicts).toHaveLength(64)
  expect(many.plan.conflicts_count).toBe(100)
  expect(board.room.getRecord('shape:human-99')).toBeDefined()
})

test('stale agent bases and plans from an older ledger are refused', async () => {
  const board = board_open()
  const box = id_of(minted(await board.agent(adds(geo('shape:new-box')))), 'shape:new-box')
  const read = update_of(board, box, { x: 10 })
  const read_again = update_of(board, box, { x: 20 })
  expect((await board.agent(read)).outcome.kind).toBe('written')
  expect(await refused(board, read_again)).toEqual([
    { id: box, reason: 'stale_base', related_id: null },
  ])

  // A plan made before another write settled cannot be intended afterwards.
  const old_ledger = board.ledger
  const planned = scene_plan(old_ledger, board.view(), update_of(board, box, { x: 30 }))
  assert(planned.kind === 'planned', 'the update is plannable')
  expect((await board.agent(update_of(board, box, { x: 40 }))).outcome.kind).toBe('written')
  expect(ledger_intend(board.ledger, planned.plan.intent)).toEqual({
    ok: false,
    problem: 'ledger_generation_stale',
  })

  // Writing the same bytes changes nothing and saves nothing.
  const saved_count = board.saved.length
  expect((await board.agent(update_of(board, box, {}))).outcome.kind).toBe('unchanged')
  expect(board.saved.length).toBe(saved_count)
})

const hostile: { name: string; value: unknown }[] = [
  { name: 'not an object', value: 'shapes' },
  { name: 'empty', value: { adds: [], updates: [], deletes: [] } },
  { name: 'missing list', value: { adds: [] } },
  {
    name: 'too many',
    value: adds(...Array.from({ length: 801 }, (_, i) => geo(`shape:new-${i}`))),
  },
  { name: 'chosen id', value: adds(geo('shape:mine')) },
  {
    name: 'page record',
    value: adds({ ...geo('shape:new-p'), id: 'page:new-p', typeName: 'page' }),
  },
  { name: 'type name lies', value: adds({ ...geo('shape:new-t'), typeName: 'binding' }) },
  { name: 'no type', value: adds({ ...geo('shape:new-t'), type: '' }) },
  { name: 'parent kind', value: adds(geo('shape:new-q', { parent: 'binding:x' })) },
  { name: 'unknown placeholder', value: adds(geo('shape:new-r', { parent: 'shape:new-none' })) },
  {
    name: 'binding to page',
    value: adds(arrow('shape:new-s'), binding('binding:new-s', 'shape:new-s', page_id, 'end')),
  },
  { name: 'duplicate', value: adds(geo('shape:new-d'), geo('shape:new-d')) },
  {
    name: 'update placeholder',
    value: {
      adds: [],
      updates: [{ record: geo('shape:new-u'), base_hash: '0'.repeat(64) }],
      deletes: [],
    },
  },
  {
    name: 'bad base hash',
    value: { adds: [], updates: [], deletes: [{ id: 'shape:x', base_hash: 'x' }] },
  },
  {
    name: 'delete document',
    value: { adds: [], updates: [], deletes: [{ id: TLDOCUMENT_ID, base_hash: '0'.repeat(64) }] },
  },
  { name: 'oversize', value: adds({ ...geo('shape:new-o'), meta: { text: 'x'.repeat(70_000) } }) },
  { name: 'deep', value: adds({ ...geo('shape:new-n'), meta: nested(40) }) },
  {
    name: 'proto key',
    value: adds(
      JSON.parse(
        '{"id":"shape:new-v","typeName":"shape","type":"geo",' +
          '"parentId":"page:native","__proto__":{}}',
      ),
    ),
  },
  { name: 'not finite', value: adds({ ...geo('shape:new-f'), x: Number.NaN }) },
  { name: 'not plain', value: adds({ ...geo('shape:new-g'), meta: { at: new Date(0) } }) },
]

function nested(depth: number): unknown {
  let value: unknown = 'leaf'

  for (let level = 0; level < depth; level += 1) value = { value }

  return value
}

test('hostile requests are rejected before planning, with a reason', () => {
  for (const item of hostile) {
    const parsed = scene_request_parse(item.value)
    expect([item.name, parsed.ok]).toEqual([item.name, false])

    if (!parsed.ok) expect(parsed.errors.length).toBeGreaterThan(0)
  }

  expect(scene_request_parse(adds(geo('shape:new-ok'))).ok).toBe(true)
})

test('requests that would break the scene are refused precisely and change nothing', async () => {
  const board = board_open()
  board.human_put(geo('shape:human-h'))
  const ids = minted(
    await board.agent(
      adds(
        group('shape:new-g1'),
        group('shape:new-g2', {
          index: 'a2',
        }),
        geo('shape:new-box', { index: 'a3' }),
      ),
    ),
  )
  const [g1, g2, box] = ['shape:new-g1', 'shape:new-g2', 'shape:new-box'].map((p) => id_of(ids, p))
  assert(g1 !== undefined && g2 !== undefined, 'both groups were minted')
  assert(box !== undefined, 'the box was minted')

  expect(await refused(board, adds(geo('shape:new-in', { parent: 'shape:human-h' })))).toEqual([
    {
      id: `shape:agent-${id_namespace}-4`,
      reason: 'foreign_dependent',
      related_id: 'shape:human-h',
    },
  ])
  const to_human = adds(
    arrow('shape:new-a'),
    binding('binding:new-b', 'shape:new-a', 'shape:human-h', 'end'),
  )
  expect((await refused(board, to_human))[0]?.reason).toBe('foreign_dependent')
  expect(
    (await refused(board, adds(geo('shape:new-lost', { parent: 'shape:nowhere' }))))[0]?.reason,
  ).toBe('parent_invalid')

  const into_deleted = {
    ...adds(geo('shape:new-c', { parent: g1 })),
    deletes: deletes_of(board, g1).deletes,
  }
  expect((await refused(board, into_deleted))[0]?.reason).toBe('parent_invalid')
  const bound_deleted = {
    ...adds(arrow('shape:new-a'), binding('binding:new-b', 'shape:new-a', box, 'end')),
    deletes: deletes_of(board, box).deletes,
  }
  expect((await refused(board, bound_deleted))[0]?.reason).toBe('binding_endpoint_invalid')

  const cycle: SceneRequest = {
    adds: [],
    updates: [
      { record: { ...board.record(g1), parentId: g2 }, base_hash: board.hash(g1) },
      { record: { ...board.record(g2), parentId: g1 }, base_hash: board.hash(g2) },
    ],
    deletes: [],
  }
  expect((await refused(board, cycle)).map((conflict) => conflict.reason)).toContain('parent_cycle')
  expect(await refused(board, update_of(board, box, { type: 'text' }))).toEqual([
    { id: box, reason: 'type_changed', related_id: null },
  ])
})

test('a human push between plan and write diverges the write, which changes nothing', async () => {
  const board = board_open()
  const box = id_of(minted(await board.agent(adds(geo('shape:new-box')))), 'shape:new-box')
  const planned = scene_plan(board.ledger, board.view(), {
    ...update_of(board, box, { x: 50 }),
    adds: [geo('shape:new-extra', { index: 'a2' })],
  })
  assert(planned.kind === 'planned', 'the request is plannable')
  const intended = ledger_intend(board.ledger, planned.plan.intent)
  assert(intended.ok, 'the plan is current')

  // A caller that awaited between planning and writing lets this push land in between.
  board.human_put({ ...board.record(box), x: 999 })
  const before = board.state()
  const applied = await apply(board, planned.plan)
  expect(applied).toBe('diverged')
  expect(board.state()).toEqual(before)

  const settled = ledger_settle(intended.ledger, board.view(), 'not_applied')
  assert(settled.ok, 'the room is the same lineage')
  expect(settled.ledger.id_sequence_next).toBe(3)
  expect(settled.ledger.entries.has(planned.plan.minted[0]!.id)).toBe(false)
  const view = board.view()
  const box_hash = board.hash(box)
  expect(ledger_authority(settled.ledger, box, view.documents.get(box), box_hash)).toBe(
    'human_edited',
  )
})

async function apply(board: Board, plan: ScenePlan): Promise<'applied' | 'diverged' | null> {
  const result: { applied: 'applied' | 'diverged' | null } = { applied: null }
  await board.room.updateStore((store) => {
    result.applied = scene_plan_apply(store, plan)
  })
  return result.applied
}

test('recovery settles a write whose settle was lost, and a restart keeps baselines', async () => {
  const board = board_open()
  const planned = scene_plan(board.ledger, board.view(), adds(geo('shape:new-box')))
  assert(planned.kind === 'planned', 'the add is plannable')
  const intended = ledger_intend(board.ledger, planned.plan.intent)
  assert(intended.ok, 'the plan is current')
  const saved_intent = ledger_encode(intended.ledger)
  expect(await apply(board, planned.plan)).toBe('applied')

  // Crash: only the intent was saved. The restarted room comes from the room's own snapshot.
  const restarted = new TLSocketRoom<TLRecord>({
    schema,
    initialSnapshot: board.room.getCurrentSnapshot(),
  })
  const viewed = room_view_create(restarted.getCurrentSnapshot(), room_epoch)
  const decoded = ledger_decode(saved_intent)
  assert(viewed.ok && decoded.ok, 'both survive the restart')
  const settled = ledger_settle(decoded.ledger, viewed.view, 'observe')
  assert(settled.ok, 'the lineage is unchanged')
  const box = planned.plan.minted[0]!.id
  const document = viewed.view.documents.get(box)
  const hash = record_hash(document!.state)
  expect(ledger_authority(settled.ledger, box, document, hash)).toBe('agent')
  restarted.close()

  // Crash before the write: recovery records nothing and never mints the reserved id again.
  const second = scene_plan(settled.ledger, board.view(), adds(geo('shape:new-later')))
  assert(second.kind === 'planned', 'the add is plannable')
  const reserved = ledger_intend(settled.ledger, second.plan.intent)
  assert(reserved.ok, 'the plan is current')
  const recovered = ledger_settle(reserved.ledger, board.view(), 'observe')
  assert(recovered.ok, 'the lineage is unchanged')
  expect(recovered.ledger.entries.size).toBe(1)
  expect(recovered.ledger.id_sequence_next).toBe(3)
  board.ledger = recovered.ledger
  const later = id_of(minted(await board.agent(adds(geo('shape:new-later')))), 'shape:new-later')
  expect(later).toBe(`shape:agent-${id_namespace}-3`)
})

// Seeded replay: a human and an agent interleave edits, deletes, reparents, bindings, undo
// and redo on one room. After every agent write the governing properties must hold: nothing
// outside the plan changed, nothing the human ever pushed was written by the agent, every
// written target was the agent's, new ids are fresh, and no reference was left dangling.
// Replay a failure with its printed seed; keep failing seeds in `replay_seeds_kept`.
const replay_seeds_first = 1
const replay_seeds_count = 24
const replay_steps = 60
const replay_seeds_kept: number[] = []

type Model = {
  readonly prng: Prng
  readonly minted: Set<string>
  readonly touched: Set<string>
  readonly history: SceneRecord[]
  readonly tally: Map<string, number>
  humans_count: number
}

function pick<T>(prng: Prng, items: readonly T[]): T | null {
  return items.length === 0 ? null : items[prng.below(items.length)]!
}

function shapes_live(board: Board, filter: (state: SceneRecord) => boolean): SceneRecord[] {
  return [...board.view().documents.values()]
    .map((document) => document.state)
    .filter((state) => state.typeName === 'shape' && filter(state))
}

function closure_of(board: Board, root: string): string[] {
  const view = board.view()
  const closure = [root]

  for (let index = 0; index < closure.length; index += 1) {
    for (const document of view.documents.values()) {
      const state = document.state
      const linked =
        state['parentId'] === closure[index] ||
        state['fromId'] === closure[index] ||
        state['toId'] === closure[index]

      if (linked && !closure.includes(state.id)) closure.push(state.id)
    }
  }

  return closure
}

function agent_request(board: Board, model: Model): SceneRequest {
  const prng = model.prng
  const live = [...model.minted].filter((id) => board.room.getRecord(id) !== undefined)
  const target = pick(prng, live)
  const choice = prng.below(3)

  if (choice === 1 && target !== null) {
    const record = board.record(target)
    const patch =
      record.typeName === 'binding'
        ? { props: { ...(record['props'] as object), isPrecise: true } }
        : { x: Number(record['x']) + 10, parentId: prng.chance(0.2) ? page_id : record['parentId'] }
    return update_of(board, target, patch)
  }

  if (choice === 2 && target !== null) return deletes_of(board, ...closure_of(board, target))

  const groups = shapes_live(board, (state) => state['type'] === 'group')
  const parent = prng.chance(0.5) ? (pick(prng, groups)?.id ?? page_id) : page_id
  const records: SceneRecord[] = [geo('shape:new-a', { parent, x: prng.below(500) })]

  if (prng.chance(0.4)) {
    records.push(group('shape:new-g'), geo('shape:new-c', { parent: 'shape:new-g' }))
  }

  const bound = pick(
    prng,
    shapes_live(board, (state) => state['type'] !== 'group'),
  )

  if (bound !== null && prng.chance(0.4)) {
    records.push(arrow('shape:new-r'), binding('binding:new-b', 'shape:new-r', bound.id, 'end'))
  }

  return adds(...records)
}

function human_step(board: Board, model: Model): void {
  const prng = model.prng
  const choice = prng.below(6)
  const shape = pick(
    prng,
    shapes_live(board, () => true),
  )
  model.humans_count += 1
  const fresh = `shape:human-${model.humans_count}`

  if (choice === 0 || shape === null) return board.human_put(geo(fresh, { x: prng.below(500) }))

  if (choice === 1) {
    const groups = shapes_live(board, (state) => state['type'] === 'group' && state.id !== shape.id)
    const parent = pick(prng, groups)?.id ?? page_id
    const moved = {
      ...shape,
      x: Number(shape['x']) + 1,
      parentId: prng.chance(0.3) ? parent : shape['parentId'],
    }

    if (closure_of(board, shape.id).includes(String(moved.parentId))) return

    model.history.push(shape)
    model.touched.add(shape.id)
    return board.human_put(moved)
  }

  if (
    choice === 2 &&
    closure_of(board, shape.id).every((id) => id === shape.id || id.startsWith('binding:'))
  ) {
    const removed = closure_of(board, shape.id)

    for (const id of removed) {
      model.history.push(board.record(id))
      model.touched.add(id)
    }

    return board.human_remove(...removed)
  }

  if (choice === 3 && shape['type'] !== 'group') {
    return board.human_put(
      arrow(fresh),
      binding(`binding:human-${model.humans_count}`, fresh, shape.id, 'end'),
    )
  }

  human_undo(board, model)
}

// Whole-record undo: the record's earlier bytes come back, recreating it if it was deleted.
function human_undo(board: Board, model: Model): void {
  const earlier = model.history.pop()

  if (earlier === undefined) return

  const view = board.view()
  const references = [earlier['parentId'], earlier['fromId'], earlier['toId']]
  const resolvable = references.every((id) => typeof id !== 'string' || view.documents.has(id))

  if (!resolvable) return

  model.touched.add(earlier.id)
  board.human_put(earlier)
}

async function agent_step(board: Board, model: Model): Promise<string[]> {
  const before = board.state()
  const view = board.view()
  const ledger = board.ledger
  const dangling_before = dangling(board)
  const result = await board.agent(agent_request(board, model))
  const after = board.state()
  const kind =
    result.plan?.kind === 'refused'
      ? `refused:${result.plan.conflicts[0]!.reason}`
      : result.outcome.kind
  model.tally.set(kind, (model.tally.get(kind) ?? 0) + 1)
  const failures = dangling(board).filter((id) => !dangling_before.includes(id))

  if (result.outcome.kind !== 'written') {
    if (JSON.stringify([...after.documents]) !== JSON.stringify([...before.documents]))
      failures.push('changed')

    return failures
  }

  assert(result.plan?.kind === 'planned', 'a written outcome has a plan')
  const targets = new Set([
    ...result.plan.plan.puts.map((record) => record.id),
    ...result.plan.plan.deletes,
  ])

  for (const [id, bytes] of before.documents) {
    if (!targets.has(id) && after.documents.get(id) !== bytes) failures.push(`untouched ${id}`)
  }

  for (const id of targets) {
    const document = view.documents.get(id)
    const hash = document === undefined ? null : record_hash(document.state)

    if (model.touched.has(id)) failures.push(`behind the human ${id}`)

    if (document !== undefined && ledger_authority(ledger, id, document, hash) !== 'agent')
      failures.push(`foreign ${id}`)

    if (document === undefined && model.minted.has(id)) failures.push(`reused ${id}`)

    model.minted.add(id)
  }

  return failures
}

async function replay_run(seed: number, tally: Map<string, number>): Promise<string[]> {
  const board = board_open(seed)
  const model: Model = {
    prng: new Prng(seed),
    minted: new Set(),
    touched: new Set(),
    history: [],
    tally,
    humans_count: 0,
  }

  for (let step = 0; step < replay_steps; step += 1) {
    if (model.prng.chance(0.5)) {
      human_step(board, model)
      continue
    }

    const failures = await agent_step(board, model)

    if (failures.length > 0) return [`SEED=${seed} step ${step}: ${failures.join(', ')}`]
  }

  const inconsistent = ledger_inconsistent(board)
  return inconsistent === null ? [] : [`SEED=${seed} ledger ${inconsistent}`]
}

// Each baseline names a clock the room has reached for that record, with the bytes it had
// then. Absent records stay until the next settle, which reports them as human_deleted.
function ledger_inconsistent(board: Board): string | null {
  const view = board.view()

  for (const [id, entry] of board.ledger.entries) {
    const document = view.documents.get(id)

    if (document === undefined) continue

    if (document.lastChangedClock < entry.clock) return id

    const same_clock = document.lastChangedClock === entry.clock

    if (same_clock && record_hash(document.state) !== entry.hash) return id
  }

  return null
}

test('seeded human and agent interleavings keep every write within the agent unit', async () => {
  const tally = new Map<string, number>()
  const seeds = [...replay_seeds_kept]

  for (let index = 0; index < replay_seeds_count; index += 1) seeds.push(replay_seeds_first + index)

  const failures: string[] = []

  for (const seed of seeds) {
    failures.push(...(await replay_run(seed, tally)))

    for (const board of boards_open.splice(0)) board.close()
  }

  expect(failures).toEqual([])
  console.log(`native scene replay: ${JSON.stringify([...tally].sort())}`)

  // The campaign must exercise both sides: writes that land and each kind of human claim.
  expect(tally.get('written') ?? 0).toBeGreaterThan(50)

  for (const reason of ['human_edited', 'foreign_dependent', 'not_agent_record']) {
    expect([reason, (tally.get(`refused:${reason}`) ?? 0) > 0]).toEqual([reason, true])
  }
})

// Minted ids cannot be guessed into ownership: a client that forges the next one, live or
// already deleted, makes the add fail rather than letting the agent write over it.
test('a forged minted id, live or tombstoned, refuses the add', async () => {
  const board = board_open()
  const next = `shape:agent-${id_namespace}-1`
  board.human_put(geo(next))
  expect(await refused(board, adds(geo('shape:new-box')))).toEqual([
    { id: next, reason: 'id_in_use', related_id: null },
  ])

  board.human_remove(next)
  expect(await refused(board, adds(geo('shape:new-box')))).toEqual([
    { id: next, reason: 'id_in_use', related_id: null },
  ])
})

test('a replaced room lineage or a refused record writes nothing', async () => {
  const board = board_open()
  const before = board.state()
  const elsewhere = await board.agent(adds(geo('shape:new-box')), 'epoch-other')
  expect(elsewhere.outcome.kind).toBe('unavailable')
  expect(elsewhere.plan).toEqual({ kind: 'unavailable', problem: 'room_epoch_mismatch' })

  const ahead = ledger_create({ room_epoch, id_namespace, document_clock: 1_000 })
  expect(scene_plan(ahead, board.view(), adds(geo('shape:new-box')))).toEqual({
    kind: 'unavailable',
    problem: 'room_clock_regressed',
  })

  // The room's schema refuses an invalid colour; the whole push and its intent come to nothing.
  const invalid = await board.agent(
    adds(geo('shape:new-ok'), geo('shape:new-bad', { color: 'plaid' })),
  )
  expect(invalid.outcome.kind).toBe('rejected')
  expect(board.state().documents).toEqual(before.documents)
  expect(board.ledger.entries.size).toBe(0)
  expect(board.ledger.pending).toBeNull()
  expect(board.ledger.id_sequence_next).toBe(3)
})
