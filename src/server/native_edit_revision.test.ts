// Reversible agent edits on a real pinned `TLSocketRoom` (sync 4.2.3), with a human editing
// through a real editable session. Human pushes are whole records, which is what the editor's
// history replays on undo and redo (see native_scene_semantics.test.ts), so a human undo here is
// a push of a record's earlier bytes. Virtual time and a fixed seed make every run replayable.
//
// Each refusal checks the room's documents, its document clock and the saved journal are exactly
// as before. Each write checks every record outside the revision is byte-identical afterwards,
// and that the journal acknowledging it was saved first.

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
  record_canonical,
  record_hash,
  room_view_create,
  type RoomView,
  type SceneRecord,
} from './native_scene_ledger'
import { scene_request_parse, type SceneRequest } from './native_scene_plan'
import {
  revision_apply,
  revision_edit_plan,
  revision_intend,
  revision_journal_create,
  revision_journal_decode,
  revision_journal_encode,
  revision_marker,
  revision_revert_plan,
  revision_settle,
  revision_write,
  revisions_retained_max,
  type RevisionConflict,
  type RevisionJournal,
  type RevisionWriteResult,
} from './native_edit_revision'

const schema = createTLSchema()
const page_id = PageRecordType.createId('native')
const room_epoch = 'epoch-test'
const id_namespace = 'testns0001'
const board_seed = 4_219

// The wire protocol of the pinned sync 4.2.3, as native_scene_semantics.test.ts checks.
const sync_protocol_version = 8
const human_session = 'ipad'

type Diff = Record<string, ['put', TLRecord] | ['remove']>
type Point = { x: number; y: number; z: number }
type Options = { x?: number; index?: string; parent?: string; points?: Point[] }
type State = { documents: Map<string, string>; document_clock: number }

class Board {
  readonly time = new VirtualTime()
  readonly globals_uninstall: () => void
  readonly room: TLSocketRoom<TLRecord>
  readonly saved: string[] = []
  readonly human_socket = { readyState: 1, send: (_data: string) => {}, close: () => {} }
  journal: RevisionJournal
  client_clock = 0
  request_count = 0

  constructor(seed: number) {
    this.globals_uninstall = globals_install(this.time, new Prng(seed))
    this.room = new TLSocketRoom<TLRecord>({ schema, initialSnapshot: snapshot_seeded() })
    const document_clock = this.room.getCurrentDocumentClock()
    this.journal = revision_journal_create({ room_epoch, id_namespace, document_clock })
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

  async write(
    action: Parameters<typeof revision_write>[0]['action'],
  ): Promise<RevisionWriteResult> {
    const result = await revision_write({
      room: this.room,
      room_epoch,
      journal: this.journal,
      action,
      saver: { save: (journal) => this.saved.push(revision_journal_encode(journal)) },
    })
    this.journal = result.journal
    return result
  }

  // An agent edit request goes through the same parser an HTTP or CLI caller would use.
  async edit(value: unknown, request_id?: string): Promise<RevisionWriteResult> {
    const parsed = scene_request_parse(value)
    assert(parsed.ok, `the request parses: ${parsed.ok ? '' : parsed.errors.join('; ')}`)
    this.request_count += 1
    const id = request_id ?? `request-${String(this.request_count).padStart(4, '0')}`
    return this.write({ kind: 'edit', request_id: id, request: parsed.request })
  }

  async revert(sequence: number): Promise<RevisionWriteResult> {
    return this.write({ kind: 'revert', sequence })
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

  state(): State {
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

// A native pen stroke: freehand points carry pressure in `z`, and `isPen` marks Pencil input.
function stroke(id: string, options: Options = {}): SceneRecord {
  const points = options.points ?? [
    { x: 0, y: 0, z: 0.31 },
    { x: 4.5, y: 1.25, z: 0.47 },
    { x: 9, y: 3.5, z: 0.52 },
  ]
  const props = {
    color: 'black',
    fill: 'none',
    dash: 'draw',
    size: 'm',
    segments: [{ type: 'free', points }],
    isComplete: true,
    isClosed: false,
    isPen: true,
    scale: 1,
  }
  return { ...shape_base(id, 'draw', options), props }
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
    color: 'black',
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

function binding(id: string, from_id: string, to_id: string): SceneRecord {
  const props = {
    terminal: 'end',
    normalizedAnchor: { x: 0.5, y: 0.5 },
    isExact: false,
    isPrecise: false,
    snap: 'none',
  }
  return { id, typeName: 'binding', type: 'arrow', fromId: from_id, toId: to_id, meta: {}, props }
}

function update(board: Board, id: string, patch: Record<string, unknown>) {
  return { record: { ...board.record(id), ...patch }, base_hash: board.hash(id) }
}

function removal(board: Board, id: string) {
  return { id, base_hash: board.hash(id) }
}

function request(parts: Partial<SceneRequest>): SceneRequest {
  return { adds: parts.adds ?? [], updates: parts.updates ?? [], deletes: parts.deletes ?? [] }
}

function written(result: RevisionWriteResult): number {
  assert(result.kind === 'written', `the revision landed: ${result.kind}`)
  assert(result.sequence !== null, 'a written revision has a sequence')
  return result.sequence
}

function conflicts(result: RevisionWriteResult): readonly RevisionConflict[] {
  assert(result.plan !== null && result.plan.kind === 'refused', `refused: ${result.kind}`)
  return result.plan.conflicts
}

// Proves an outcome changed nothing at all: room bytes, document clock, journal and saves.
async function unchanged_by(
  board: Board,
  run: () => Promise<RevisionWriteResult>,
): Promise<RevisionWriteResult> {
  const before = board.state()
  const journal_before = revision_journal_encode(board.journal)
  const saved_count = board.saved.length
  const result = await run()
  expect(result.kind).not.toBe('written')
  expect(board.state()).toEqual(before)
  expect(revision_journal_encode(board.journal)).toBe(journal_before)
  expect(board.saved.length).toBe(saved_count)
  return result
}

// Every record outside `ids` is byte-identical between two states.
function outside_equal(before: State, after: State, ids: ReadonlySet<string>): void {
  for (const [id, bytes] of before.documents) {
    if (!ids.has(id)) expect(after.documents.get(id)).toBe(bytes)
  }

  for (const id of after.documents.keys()) {
    if (!ids.has(id)) expect(before.documents.has(id)).toBe(true)
  }
}

// The acknowledged journal is exactly the one saved last, so a restart reads what was reported.
function saved_matches(board: Board): void {
  const last = board.saved[board.saved.length - 1]
  assert(last !== undefined, 'something was saved')
  expect(last).toBe(revision_journal_encode(board.journal))
  const decoded = revision_journal_decode(last)
  assert(decoded.ok, 'the saved journal decodes')
  expect(revision_journal_encode(decoded.journal)).toBe(last)
}

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

const tidied_points: Point[] = [
  { x: 0, y: 0, z: 0.5 },
  { x: 4.5, y: 2, z: 0.5 },
  { x: 9, y: 4, z: 0.5 },
]

test('an agent tidies an original human stroke, and a revert restores its bytes', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough', { index: 'a1' }), stroke('shape:other', { x: 50 }))
  const rough = record_canonical(board.record('shape:rough'))
  const before = board.state()

  // One logical operation: smooth the path and pressure, restack it, and add a box.
  const tidy = update(board, 'shape:rough', {
    index: 'a5',
    props: {
      ...(board.record('shape:rough')['props'] as object),
      segments: [{ type: 'free', points: tidied_points }],
    },
  })
  const sequence = written(
    await board.edit(request({ adds: [geo('shape:new-box', { index: 'a3' })], updates: [tidy] })),
  )
  saved_matches(board)
  const after = board.state()
  expect(after.document_clock).toBe(before.document_clock + 1)
  const box = `shape:edit-${id_namespace}-1`
  expect(after.documents.has(box)).toBe(true)
  expect(record_canonical(board.record('shape:rough'))).toBe(record_canonical(tidy.record))
  outside_equal(before, after, new Set(['shape:rough', box]))

  // The human keeps drawing elsewhere; reverting the agent operation leaves that stroke alone.
  board.human_put(stroke('shape:later', { x: 300, index: 'a9' }))
  const later = board.state()
  const reverted = written(await board.revert(sequence))
  saved_matches(board)
  expect(reverted).toBe(sequence + 1)
  expect(record_canonical(board.record('shape:rough'))).toBe(rough)
  expect(board.room.getRecord(box)).toBeUndefined()
  outside_equal(later, board.state(), new Set(['shape:rough', box]))
  expect(board.journal.entries.map((entry) => [entry.sequence, entry.reverted_by])).toEqual([
    [1, 2],
    [2, null],
  ])
})

test('a stale base refuses the whole edit atomically, whoever changed the record', async () => {
  const board = board_open()
  board.human_put(stroke('shape:a'), stroke('shape:b', { x: 40 }))
  const read_a = update(board, 'shape:a', { x: 5 })
  const read_b = update(board, 'shape:b', { x: 45 })

  // The human moves `b` after the agent read it; the agent's edit of `a` is refused with it.
  board.human_put({ ...board.record('shape:b'), x: 41 })
  const result = await unchanged_by(board, () =>
    board.edit(request({ updates: [read_a, read_b], adds: [geo('shape:new-box')] })),
  )
  expect(conflicts(result)).toEqual([{ id: 'shape:b', reason: 'stale_base', related_id: null }])

  // A delete is guarded the same way, and a missing record is named precisely.
  const gone = removal(board, 'shape:a')
  board.human_remove('shape:a')
  const missing = await unchanged_by(board, () => board.edit(request({ deletes: [gone] })))
  expect(conflicts(missing)).toEqual([
    { id: 'shape:a', reason: 'record_missing', related_id: null },
  ])

  // Changing a record's kind is refused; reading it afresh then succeeds.
  const retyped = { record: geo('shape:b', { x: 41 }), base_hash: board.hash('shape:b') }
  const kind = await unchanged_by(board, () => board.edit(request({ updates: [retyped] })))
  expect(conflicts(kind)[0]?.reason).toBe('type_changed')
  written(await board.edit(request({ updates: [update(board, 'shape:b', { x: 60 })] })))
})

test('deletes carry their group and binding closure; reverts restore original ids', async () => {
  const board = board_open()
  board.human_put(
    group('shape:group'),
    stroke('shape:left', { parent: 'shape:group' }),
    stroke('shape:right', { parent: 'shape:group', index: 'a2' }),
    arrow('shape:arrow', { index: 'a3' }),
  )
  board.human_put(binding('binding:tie', 'shape:arrow', 'shape:left'))
  const original = board.state()

  // Deleting a bound child alone would leave the binding dangling.
  const alone = await unchanged_by(board, () =>
    board.edit(request({ deletes: [removal(board, 'shape:left')] })),
  )
  expect(conflicts(alone)).toEqual([
    { id: 'shape:left', reason: 'dependent_kept', related_id: 'binding:tie' },
  ])

  // Ungroup `right` into a new agent group, and delete `left` with its binding, as one step.
  const sequence = written(
    await board.edit(
      request({
        adds: [group('shape:new-frame', { index: 'a4' })],
        updates: [update(board, 'shape:right', { parentId: 'shape:new-frame' })],
        deletes: [removal(board, 'shape:left'), removal(board, 'binding:tie')],
      }),
    ),
  )
  expect(dangling(board)).toEqual([])
  expect(board.room.getRecord('binding:tie')).toBeUndefined()

  written(await board.revert(sequence))
  expect(board.state().documents).toEqual(original.documents)
  expect(dangling(board)).toEqual([])
})

test('a revert is refused when later work touched its records or depends on them', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  const sequence = written(
    await board.edit(
      request({
        adds: [geo('shape:new-box', { index: 'a2' })],
        updates: [update(board, 'shape:rough', { x: 20 })],
      }),
    ),
  )
  const box = `shape:edit-${id_namespace}-1`

  // A human arrow bound to the agent's box: removing the box would orphan the human's binding.
  board.human_put(arrow('shape:arrow', { index: 'a3' }))
  board.human_put(binding('binding:human', 'shape:arrow', box))
  const bound = await unchanged_by(board, () => board.revert(sequence))
  expect(conflicts(bound)).toEqual([
    { id: box, reason: 'dependent_kept', related_id: 'binding:human' },
  ])
  board.human_remove('binding:human')

  // A human edit and its undo restore identical bytes, but the room clock still moved.
  const revised = board.record('shape:rough')
  board.human_put({ ...revised, x: 99 })
  board.human_put(revised)
  const touched = await unchanged_by(board, () => board.revert(sequence))
  expect(conflicts(touched)).toEqual([
    { id: 'shape:rough', reason: 'changed_since', related_id: null },
  ])

  // A human delete of the agent's box, then its undo, is also later work the revert keeps.
  const box_record = board.record(box)
  board.human_remove(box)
  const deleted = await unchanged_by(board, () => board.revert(sequence))
  expect(
    conflicts(deleted)
      .map((conflict) => conflict.id)
      .sort(),
  ).toEqual([box, 'shape:rough'])
  board.human_put(box_record)
  expect(conflicts(await unchanged_by(board, () => board.revert(sequence))).length).toBe(2)
  expect(board.record(box)).toEqual(box_record)
})

test('a revert never resurrects a stroke the human deleted again after the agent', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'), stroke('shape:other', { x: 40 }))
  const rough = board.record('shape:rough')
  const sequence = written(await board.edit(request({ deletes: [removal(board, 'shape:rough')] })))

  // The human brings the stroke back with undo, then deletes it again: the latest intent is gone.
  board.human_put(rough)
  board.human_remove('shape:rough')
  const result = await unchanged_by(board, () => board.revert(sequence))
  expect(conflicts(result)).toEqual([
    { id: 'shape:rough', reason: 'changed_since', related_id: null },
  ])
  expect(board.room.getRecord('shape:rough')).toBeUndefined()
})

test('undoing two edits of one stroke works newest first and restores the original', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  const original = record_canonical(board.record('shape:rough'))
  const first = written(
    await board.edit(request({ updates: [update(board, 'shape:rough', { x: 10 })] })),
  )
  const second = written(
    await board.edit(request({ updates: [update(board, 'shape:rough', { x: 20 })] })),
  )

  // Out of order, the older revert would wipe the newer edit, so it is refused.
  const early = await unchanged_by(board, () => board.revert(first))
  expect(conflicts(early)[0]?.reason).toBe('changed_since')

  written(await board.revert(second))
  expect(board.record('shape:rough')['x']).toBe(10)
  written(await board.revert(first))
  expect(record_canonical(board.record('shape:rough'))).toBe(original)
})

test('repeated requests and reverts answer from the journal; redo reverts a revert', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  const value = request({
    adds: [geo('shape:new-box', { index: 'a2' })],
    updates: [update(board, 'shape:rough', { x: 30 })],
  })
  const sequence = written(await board.edit(value, 'request-repeat'))
  const box = `shape:edit-${id_namespace}-1`

  const replay = await unchanged_by(board, () => board.edit(value, 'request-repeat'))
  expect([replay.kind, replay.sequence]).toEqual(['replayed', sequence])
  const reused = await unchanged_by(board, () =>
    board.edit(request({ adds: [geo('shape:new-other')] }), 'request-repeat'),
  )
  expect([reused.kind, reused.plan]).toEqual([
    'unavailable',
    { kind: 'unavailable', problem: 'request_id_reused' },
  ])

  const undo = written(await board.revert(sequence))
  const again = await unchanged_by(board, () => board.revert(sequence))
  expect([again.kind, again.sequence]).toEqual(['already_reverted', undo])

  // Redo puts back the agent's exact records, including the minted box id.
  const redone = board.state()
  const redo = written(await board.revert(undo))
  expect(board.record('shape:rough')['x']).toBe(30)
  expect(board.record(box)['typeName']).toBe('shape')
  outside_equal(redone, board.state(), new Set(['shape:rough', box]))
  written(await board.revert(redo))
  expect(board.room.getRecord(box)).toBeUndefined()

  // An unchanged edit records nothing.
  const same = update(board, 'shape:rough', {})
  expect((await unchanged_by(board, () => board.edit(request({ updates: [same] })))).kind).toBe(
    'unchanged',
  )
})

test('the journal retains eight revisions; older ones expire, unknown ones refuse', async () => {
  const board = board_open()

  for (let index = 0; index <= revisions_retained_max; index += 1) {
    written(await board.edit(request({ adds: [geo('shape:new-box', { x: index * 120 })] })))
  }

  expect(board.journal.entries.map((entry) => entry.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  expect((await unchanged_by(board, () => board.revert(1))).kind).toBe('expired')
  expect((await unchanged_by(board, () => board.revert(10))).kind).toBe('unknown')

  // The expired revision's box is ordinary content now; the oldest retained one still reverts.
  expect(board.room.getRecord(`shape:edit-${id_namespace}-1`)).toBeDefined()
  written(await board.revert(2))
  expect(board.room.getRecord(`shape:edit-${id_namespace}-2`)).toBeUndefined()
  expect(board.journal.entries[0]?.sequence).toBe(3)
  saved_matches(board)
})

test('a restart settles a pending revision from the room and never reuses minted ids', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  const parsed = request({
    adds: [geo('shape:new-box', { index: 'a2' })],
    updates: [update(board, 'shape:rough', { x: 70 })],
  })
  const planned = revision_edit_plan(board.journal, board.view(), 'request-crash', parsed)
  assert(planned.kind === 'planned', 'the edit is plannable')
  const intended = revision_intend(board.journal, planned.plan)
  assert(intended.ok, 'the plan is current')
  const saved_intent = revision_journal_encode(intended.journal)
  await board.room.updateStore((store) => {
    expect(revision_apply(store, planned.plan)).toBe('applied')
  })

  // Crash after the write: only the intent was saved. Recovery reads the restarted room.
  const restarted = new TLSocketRoom<TLRecord>({
    schema,
    initialSnapshot: board.room.getCurrentSnapshot(),
  })
  const viewed = room_view_create(restarted.getCurrentSnapshot(), room_epoch)
  const decoded = revision_journal_decode(saved_intent)
  assert(viewed.ok && decoded.ok, 'both survive the restart')
  const settled = revision_settle(decoded.journal, viewed.view, 'observe')
  assert(settled.ok, 'the lineage is unchanged')
  restarted.close()
  expect(settled.journal.entries.map((entry) => entry.request_id)).toEqual(['request-crash'])
  board.journal = settled.journal
  written(await board.revert(1))
  expect(board.record('shape:rough')['x']).toBe(0)

  // Crash before the write: recovery records nothing and keeps the reserved id spent.
  const second = revision_edit_plan(
    board.journal,
    board.view(),
    'request-lost',
    request({
      adds: [geo('shape:new-lost')],
    }),
  )
  assert(second.kind === 'planned', 'the add is plannable')
  const reserved = revision_intend(board.journal, second.plan)
  assert(reserved.ok, 'the plan is current')
  const recovered = revision_settle(reserved.journal, board.view(), 'observe')
  assert(recovered.ok, 'the lineage is unchanged')
  expect(recovered.journal.entries.length).toBe(2)
  expect(recovered.journal.sequence_next).toBe(3)
  board.journal = recovered.journal
  written(await board.edit(request({ adds: [geo('shape:new-later')] })))
  expect(board.room.getRecord(`shape:edit-${id_namespace}-3`)).toBeDefined()
  expect(board.room.getRecord(`shape:edit-${id_namespace}-2`)).toBeUndefined()
})

// A board restart as `board.ts` makes one: the clock jumps and every tombstone is dropped.
function restarted_view(snapshot: RoomSnapshot): RoomView {
  const clock = Math.max(snapshot.clock, snapshot.documentClock ?? 0) + 1_000
  const room = new TLSocketRoom<TLRecord>({
    schema,
    initialSnapshot: { ...snapshot, clock, tombstones: {}, tombstoneHistoryStartsAtClock: clock },
  })
  const viewed = room_view_create(room.getCurrentSnapshot(), room_epoch)
  room.close()
  assert(viewed.ok, 'the restarted room is readable')
  expect(viewed.view.tombstones.size).toBe(0)
  return viewed.view
}

// The same saved room with its document's marker replaced, or its document clock moved.
function marker_replaced(snapshot: RoomSnapshot, marker: unknown, clock_shift = 0): RoomSnapshot {
  const documents = snapshot.documents.map((document) => {
    if (document.state.id !== TLDOCUMENT_ID) return document

    const state = document.state as TLRecord
    assert(state.typeName === 'document', 'the document record is a document')
    const meta = { ...state.meta, native_revision: marker as never }
    const lastChangedClock = document.lastChangedClock + clock_shift
    return { state: { ...state, meta }, lastChangedClock }
  })
  expect(documents.length).toBe(snapshot.documents.length)
  return { ...snapshot, documents }
}

test('a delete-only revision is recognized after a restart by its exact marker only', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  const parsed = request({ deletes: [removal(board, 'shape:rough')] })
  const planned = revision_edit_plan(board.journal, board.view(), 'request-delete', parsed)
  assert(planned.kind === 'planned', 'the delete is plannable')
  const intended = revision_intend(board.journal, planned.plan)
  assert(intended.ok, 'the plan is current')
  const marker = revision_marker(room_epoch, planned.plan.entry)
  await board.room.updateStore((store) => {
    expect(revision_apply(store, planned.plan)).toBe('applied')
    const document = store.get(TLDOCUMENT_ID)
    assert(document !== null && document.typeName === 'document', 'the room has its document')
    store.put({ ...document, meta: { ...document.meta, native_revision: marker } })
  })

  // Crash before the settle. The restart drops the tombstone; the marker is what remains.
  const saved = board.room.getCurrentSnapshot()
  const settle = (snapshot: RoomSnapshot) => {
    const settled = revision_settle(intended.journal, restarted_view(snapshot), 'observe')
    assert(settled.ok, 'the lineage is unchanged')
    expect(settled.journal.pending).toBeNull()
    return settled.journal
  }
  const recovered = settle(saved)
  expect(recovered.entries.map((entry) => entry.request_id)).toEqual(['request-delete'])
  expect(recovered.sequence_next).toBe(2)

  // Negative controls: a room without the marker, a room replaced by another board's, another
  // transaction at the same sequence, and a marker the document no longer holds at its clock.
  const controls: [string, RoomSnapshot][] = [
    ['no marker', marker_replaced(saved, undefined)],
    ['replaced room', marker_replaced(saved, { ...marker, room_epoch: 'epoch-other' })],
    ['other request', marker_replaced(saved, { ...marker, request_hash: 'f'.repeat(64) })],
    ['other clock', marker_replaced(saved, { ...marker, write_clock: marker.write_clock - 1 })],
    ['other sequence', marker_replaced(saved, { ...marker, sequence: 2 })],
    ['page fields only', marker_replaced(saved, { sequence: 1, reverts: null })],
    ['later document edit', marker_replaced(saved, marker, 1)],
  ]

  for (const [name, snapshot] of controls) {
    const journal = settle(snapshot)
    expect([name, journal.entries.length, journal.sequence_next]).toEqual([name, 0, 1])
  }

  // Applied, but its deletion clock is gone: the revert is refused, never resurrecting.
  const reverting = revision_revert_plan(recovered, restarted_view(saved), 1)
  assert(reverting.kind === 'refused', `the revert is refused: ${reverting.kind}`)
  expect(reverting.conflicts).toEqual([
    { id: 'shape:rough', reason: 'changed_since', related_id: null },
  ])
})

test('a failed intent save or a diverged write leaves the room and journal untouched', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  const before = board.state()
  const journal_before = board.journal
  const failing = revision_write({
    room: board.room,
    room_epoch,
    journal: board.journal,
    action: {
      kind: 'edit',
      request_id: 'request-disk',
      request: request({ updates: [update(board, 'shape:rough', { x: 5 })] }),
    },
    saver: {
      save: () => {
        throw new Error('disk full')
      },
    },
  })
  await expect(failing).rejects.toThrow('disk full')
  expect(board.state()).toEqual(before)
  expect(board.journal).toBe(journal_before)

  // A human push lands between planning and the store update: the guard refuses the write.
  const planned = revision_edit_plan(
    journal_before,
    board.view(),
    'request-race',
    request({
      updates: [update(board, 'shape:rough', { x: 6 })],
    }),
  )
  assert(planned.kind === 'planned', 'the edit is plannable')
  const intended = revision_intend(journal_before, planned.plan)
  assert(intended.ok, 'the plan is current')
  board.human_put({ ...board.record('shape:rough'), x: 7 })
  const raced = board.state()
  await board.room.updateStore((store) => {
    expect(revision_apply(store, planned.plan)).toBe('diverged')
  })
  expect(board.state()).toEqual(raced)
  const settled = revision_settle(intended.journal, board.view(), 'not_applied')
  assert(settled.ok, 'the lineage is unchanged')
  expect(settled.journal.entries).toEqual([])
  expect(settled.journal.pending).toBeNull()
})

test('a replaced or rolled-back room lineage plans and settles nothing', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  written(await board.edit(request({ updates: [update(board, 'shape:rough', { x: 1 })] })))
  const view = board.view()
  const other = { ...view, room_epoch: 'epoch-other' }
  const rolled = { ...view, document_clock: 1, clock: 1 }
  expect(revision_revert_plan(board.journal, other, 1)).toEqual({
    kind: 'unavailable',
    problem: 'room_epoch_mismatch',
  })
  expect(revision_revert_plan(board.journal, rolled, 1)).toEqual({
    kind: 'unavailable',
    problem: 'room_clock_regressed',
  })
  expect(revision_settle(board.journal, rolled, 'observe')).toEqual({
    ok: false,
    problem: 'room_clock_regressed',
  })
})

test('damaged saved journals are refused with a reason', async () => {
  const board = board_open()
  board.human_put(stroke('shape:rough'))
  written(await board.edit(request({ updates: [update(board, 'shape:rough', { x: 1 })] })))
  const text = revision_journal_encode(board.journal)
  const json = JSON.parse(text) as Record<string, unknown>
  const entry = (json['entries'] as Record<string, unknown>[])[0]!
  const damaged: [string, unknown][] = [
    ['not json', null],
    ['format', { ...json, format: 'other' }],
    ['sequence', { ...json, sequence_next: 0 }],
    ['order', { ...json, sequence_next: 1 }],
    ['unobserved', { ...json, clock_observed: 0 }],
    ['request', { ...json, entries: [{ ...entry, request_id: 'x' }] }],
    [
      'record',
      { ...json, entries: [{ ...entry, changes: [['shape:a', { id: 'shape:b' }, null]] }] },
    ],
    ['empty', { ...json, entries: [{ ...entry, changes: [] }] }],
    ['pending', { ...json, pending: { entry, id_sequence_next: 1 } }],
  ]

  for (const [name, value] of damaged) {
    const decoded = revision_journal_decode(name === 'not json' ? '{' : JSON.stringify(value))
    expect([name, decoded.ok]).toEqual([name, false])
  }

  expect(revision_journal_decode(text).ok).toBe(true)
})

// Seeded replay: a human and an agent interleave strokes, edits, deletes and undo-like re-puts
// with agent edits and reverts. After every agent action: a refusal changed nothing; a write
// changed only its revision's records, put exactly their recorded bytes, left nothing dangling,
// and was saved before it was acknowledged. Replay a failure with its printed seed; keep failing
// seeds in `replay_seeds_kept`.
const replay_seeds_first = 1
const replay_seeds_count = 16
const replay_steps = 40
const replay_seeds_kept: number[] = []

function pick<T>(prng: Prng, items: readonly T[]): T | null {
  return items.length === 0 ? null : items[prng.below(items.length)]!
}

function shapes(board: Board): string[] {
  return [...board.view().documents.values()]
    .filter((document) => document.state.typeName === 'shape')
    .map((document) => document.state.id)
    .sort()
}

function human_step(board: Board, prng: Prng, step: number): void {
  const target = pick(prng, shapes(board))
  const roll = prng.below(3)

  if (target === null || roll === 0) {
    board.human_put(
      stroke(`shape:human-${step}`, { x: prng.below(500), index: `a${1 + prng.below(8)}` }),
    )
  } else if (roll === 1) {
    board.human_put({ ...board.record(target), x: prng.below(500) })
  } else {
    board.human_remove(target)
  }
}

type Tally = { edits: number; reverts: number; refusals: number }

async function agent_step(board: Board, prng: Prng, step: number, tally: Tally): Promise<void> {
  const before = board.state()
  const saved_count = board.saved.length
  const target = pick(prng, shapes(board))
  const retained = board.journal.entries.map((entry) => entry.sequence)
  const revert = prng.chance(0.4) ? pick(prng, retained) : null
  let result: RevisionWriteResult

  if (revert !== null) {
    result = await board.revert(revert)
  } else {
    const updates = target === null ? [] : [update(board, target, { x: prng.below(500) })]
    const deletes = target !== null && prng.chance(0.3) ? [removal(board, target)] : []
    const adds = [stroke(`shape:new-${step}`, { points: tidied_points })]
    result = await board.edit(
      deletes.length > 0 ? request({ adds, deletes }) : request({ adds, updates }),
    )
  }

  if (result.kind !== 'written') {
    expect(board.state()).toEqual(before)
    expect(board.saved.length).toBe(saved_count)
    tally.refusals += 1
    return
  }

  const entry = board.journal.entries[board.journal.entries.length - 1]!

  if (entry.reverts === null) tally.edits += 1
  else tally.reverts += 1

  const after = board.state()
  outside_equal(before, after, new Set(entry.changes.map((change) => change.id)))

  for (const change of entry.changes) {
    const bytes = change.after === null ? undefined : record_canonical(change.after)
    expect(after.documents.get(change.id)).toBe(bytes)
  }

  expect(dangling(board)).toEqual([])
  saved_matches(board)
}

test('seeded human and agent interleavings never change untracked records', async () => {
  const seeds = [...replay_seeds_kept]
  const tally: Tally = { edits: 0, reverts: 0, refusals: 0 }

  for (let seed = replay_seeds_first; seed < replay_seeds_first + replay_seeds_count; seed += 1) {
    seeds.push(seed)
  }

  for (const seed of seeds) {

    // One board at a time: each installs and restores the virtual-time globals in turn.
    const board = new Board(seed)
    const prng = new Prng(seed)

    try {
      for (let step = 0; step < replay_steps; step += 1) {
        if (prng.chance(0.5)) human_step(board, prng, step)
        else await agent_step(board, prng, step, tally)
      }
    } catch (error) {
      throw new Error(`replay seed ${seed}: ${String(error)}`)
    } finally {
      board.close()
    }
  }

  // The schedule must exercise every outcome, or the properties above hold vacuously.
  expect(tally.edits).toBeGreaterThan(50)
  expect(tally.reverts).toBeGreaterThan(10)
  expect(tally.refusals).toBeGreaterThan(10)
})
