// The ledger alone: how authority is derived from room clocks and hashes, the write-ahead
// intent and its settlement (including recovery after a crash), and refusal of damaged saved
// data. Room views here are built by hand; native_scene_plan.test.ts drives a real room.

import { expect, test } from 'bun:test'
import {
  agent_id_mint,
  ledger_authority,
  ledger_create,
  ledger_decode,
  ledger_encode,
  ledger_entries_max,
  ledger_intend,
  ledger_settle,
  record_canonical,
  record_hash,
  room_view_create,
  type Ledger,
  type LedgerPending,
  type RoomSnapshotLike,
  type RoomView,
  type SceneRecord,
} from './native_scene_ledger'

const epoch = 'room-epoch-1'
const namespace = 'abcdef0123'

function shape(id: string, x: number): SceneRecord {
  return { id, typeName: 'shape', type: 'geo', parentId: 'page:p', x, props: { w: 1 } }
}

type Doc = { state: SceneRecord; lastChangedClock: number }

function view_of(clock: number, documents: Doc[], tombstones: Record<string, number> = {}) {
  const snapshot: RoomSnapshotLike = { clock, documentClock: clock, documents, tombstones }
  const viewed = room_view_create(snapshot, epoch)

  if (!viewed.ok) throw new Error(viewed.reason)

  return viewed.view
}

function ledger_fresh(clock = 1): Ledger {
  return ledger_create({ room_epoch: epoch, id_namespace: namespace, document_clock: clock })
}

function intend(ledger: Ledger, pending: Omit<LedgerPending, 'generation'>): Ledger {
  const outcome = ledger_intend(ledger, { ...pending, generation: ledger.generation })

  if (!outcome.ok) throw new Error(outcome.problem)

  return outcome.ledger
}

function settle(ledger: Ledger, view: RoomView, write: 'observe' | 'not_applied'): Ledger {
  const outcome = ledger_settle(ledger, view, write)

  if (!outcome.ok) throw new Error(outcome.problem)

  return outcome.ledger
}

test('a record hash ignores key order and treats __proto__ as data', () => {
  const a = { id: 'shape:a', typeName: 'shape', x: 1, props: { b: 2, a: 1 } }
  const b = { props: { a: 1, b: 2 }, x: 1, typeName: 'shape', id: 'shape:a' }
  expect(record_hash(a)).toBe(record_hash(b))
  expect(record_hash(a)).not.toBe(record_hash({ ...a, x: 2 }))

  const hostile = JSON.parse('{"id":"shape:h","typeName":"shape","__proto__":{"x":1}}')
  expect(record_canonical(hostile)).toContain('"__proto__"')
  expect(({} as Record<string, unknown>)['x']).toBeUndefined()
})

test('authority comes from the room clock and hash, so adoption by a human is permanent', () => {
  const id = agent_id_mint(ledger_fresh(), 'shape', 1)
  const written = shape(id, 10)
  let ledger = intend(ledger_fresh(), {
    write_clock: 2,
    id_sequence_next: 2,
    puts: [{ id, hash: record_hash(written) }],
  })
  ledger = settle(ledger, view_of(2, [{ state: written, lastChangedClock: 2 }]), 'observe')

  const cases: { name: string; doc: Doc | undefined; expected: string }[] = [
    { name: 'as written', doc: { state: written, lastChangedClock: 2 }, expected: 'agent' },
    { name: 'moved', doc: { state: shape(id, 99), lastChangedClock: 5 }, expected: 'human_edited' },

    // Whole-record undo restores the bytes but not the clock.
    { name: 'undone', doc: { state: written, lastChangedClock: 7 }, expected: 'human_edited' },
    { name: 'deleted', doc: undefined, expected: 'human_deleted' },
    {
      name: 'other lineage',
      doc: { state: shape(id, 3), lastChangedClock: 2 },
      expected: 'baseline_mismatch',
    },
  ]

  for (const item of cases) {
    const hash = item.doc === undefined ? null : record_hash(item.doc.state)
    expect([item.name, ledger_authority(ledger, id, item.doc, hash)]).toEqual([
      item.name,
      item.expected,
    ])
  }

  // Client meta claiming agent origin carries no authority.
  const forged = { ...shape('shape:forged', 1), meta: { origin: 'agent' } }
  const forged_doc = { state: forged, lastChangedClock: 2 }
  expect(ledger_authority(ledger, forged.id, forged_doc, record_hash(forged))).toBe(
    'not_agent_record',
  )
  expect(ledger_authority(ledger, 'shape:none', undefined, null)).toBe('absent')
})

test('settling records only puts seen at the write clock, and recovery replays it', () => {
  const ledger = ledger_fresh(4)
  const first = agent_id_mint(ledger, 'shape', 1)
  const second = agent_id_mint(ledger, 'shape', 2)
  const records = [shape(first, 1), shape(second, 2)]
  const intended = intend(ledger, {
    write_clock: 6,
    id_sequence_next: 3,
    puts: records.map((record) => ({ id: record.id, hash: record_hash(record) })),
  })
  expect(intended.id_sequence_next).toBe(3)
  expect(intended.entries.size).toBe(0)

  // A crash after the intent was saved: the decoded ledger still holds the intent.
  const recovered = ledger_decode(ledger_encode(intended))
  expect(recovered.ok).toBe(true)

  if (!recovered.ok) return

  expect(ledger_encode(recovered.ledger)).toBe(ledger_encode(intended))

  // The write landed for one record only; the other was then changed at a later clock.
  const room = view_of(8, [
    { state: records[0]!, lastChangedClock: 6 },
    { state: shape(second, 50), lastChangedClock: 8 },
  ])
  const settled = settle(recovered.ledger, room, 'observe')
  expect([...settled.entries.keys()]).toEqual([first])
  expect(settled.pending).toBeNull()
  expect(settled.generation).toBe(ledger.generation + 1)
  expect(settled.clock_observed).toBe(8)

  // Known not applied: nothing is recorded even if the room happens to match.
  const refused = settle(
    intended,
    view_of(6, [{ state: records[0]!, lastChangedClock: 6 }]),
    'not_applied',
  )
  expect(refused.entries.size).toBe(0)

  // Reserved ids are never minted again, written or not.
  expect(() => agent_id_mint(refused, 'shape', 2)).toThrow('never reused')
  expect(agent_id_mint(refused, 'shape', 3)).toBe(`shape:agent-${namespace}-3`)
})

test('settling forgets records the room no longer holds', () => {
  const ledger = ledger_fresh()
  const id = agent_id_mint(ledger, 'shape', 1)
  const record = shape(id, 1)
  let settled = settle(
    intend(ledger, {
      write_clock: 2,
      id_sequence_next: 2,
      puts: [{ id, hash: record_hash(record) }],
    }),
    view_of(2, [{ state: record, lastChangedClock: 2 }]),
    'observe',
  )
  expect(settled.entries.has(id)).toBe(true)

  settled = settle(settled, view_of(3, [], { [id]: 3 }), 'observe')
  expect(settled.entries.size).toBe(0)

  // Restored later by a human undo, it is a human record, not the agent's again.
  const restored = { state: record, lastChangedClock: 4 }
  expect(ledger_authority(settled, id, restored, record_hash(record))).toBe('not_agent_record')
})

test('intents are single, current and bounded', () => {
  const ledger = ledger_fresh()
  const pending = { generation: 0, write_clock: 2, id_sequence_next: 1, puts: [] }
  const intended = ledger_intend(ledger, pending)
  expect(intended.ok).toBe(true)

  if (!intended.ok) return

  expect(ledger_intend(intended.ledger, pending)).toEqual({ ok: false, problem: 'ledger_pending' })

  const settled = settle(intended.ledger, view_of(1, []), 'not_applied')
  expect(ledger_intend(settled, pending)).toEqual({
    ok: false,
    problem: 'ledger_generation_stale',
  })

  // One more live record than the ledger can track is refused before anything is reserved.
  const puts = Array.from({ length: ledger_entries_max + 1 }, (_, index) => ({
    id: `shape:many-${index}`,
    hash: '0'.repeat(64),
  }))
  const full = ledger_intend(settled, { ...pending, generation: settled.generation, puts })
  expect(full).toEqual({ ok: false, problem: 'ledger_full' })
  const fits = ledger_intend(settled, {
    ...pending,
    generation: settled.generation,
    puts: puts.slice(1),
  })
  expect(fits.ok).toBe(true)
})

test('a replaced or rolled-back room is refused, not reinterpreted', () => {
  const ledger = settle(ledger_fresh(5), view_of(9, []), 'observe')
  expect(ledger.clock_observed).toBe(9)

  const other = room_view_create({ clock: 9, documentClock: 9, documents: [] }, 'room-epoch-2')
  expect(other.ok).toBe(true)

  if (!other.ok) return

  expect(ledger_settle(ledger, other.view, 'observe')).toEqual({
    ok: false,
    problem: 'room_epoch_mismatch',
  })
  expect(ledger_settle(ledger, view_of(8, []), 'observe')).toEqual({
    ok: false,
    problem: 'room_clock_regressed',
  })
  expect(ledger_settle(ledger, view_of(9, []), 'observe').ok).toBe(true)
})

test('damaged saved ledgers are refused with a reason', () => {
  const id = agent_id_mint(ledger_fresh(), 'shape', 1)
  const record = shape(id, 1)
  const ledger = settle(
    intend(ledger_fresh(), {
      write_clock: 2,
      id_sequence_next: 2,
      puts: [{ id, hash: record_hash(record) }],
    }),
    view_of(2, [{ state: record, lastChangedClock: 2 }]),
    'observe',
  )
  const good = JSON.parse(ledger_encode(ledger)) as Record<string, unknown>
  expect(ledger_decode(JSON.stringify(good)).ok).toBe(true)

  const damaged: Record<string, unknown>[] = [
    { ...good, format: 'other' },
    { ...good, version: 2 },
    { ...good, room_epoch: 'bad epoch!' },
    { ...good, id_namespace: 'UPPER' },
    { ...good, generation: -1 },
    { ...good, clock_observed: 1.5 },
    { ...good, id_sequence_next: 0 },
    { ...good, entries: [[id, 2, 'nothex']] },
    { ...good, entries: [[id, 99, record_hash(record)]] },
    {
      ...good,
      entries: [
        [id, 2, record_hash(record)],
        [id, 2, record_hash(record)],
      ],
    },
    { ...good, pending: { generation: 0, write_clock: 3, id_sequence_next: 2, puts: [] } },
    { ...good, pending: { generation: 1, write_clock: 2, id_sequence_next: 2, puts: [] } },
    { ...good, pending: { generation: 1, write_clock: 3, id_sequence_next: 2, puts: [[id]] } },
  ]

  for (const value of damaged) {
    const decoded = ledger_decode(JSON.stringify(value))
    expect(decoded.ok).toBe(false)
  }

  expect(ledger_decode('{').ok).toBe(false)
  expect(ledger_decode('null').ok).toBe(false)
  expect(ledger_decode(' '.repeat(4 * 1024 * 1024 + 1)).ok).toBe(false)
})

test('malformed room snapshots are reported, not indexed', () => {
  const record = shape('shape:a', 1)
  const snapshots: RoomSnapshotLike[] = [
    { clock: -1, documents: [] },
    { clock: 2, documentClock: 3, documents: [] },
    { clock: 2, documents: [{ state: null, lastChangedClock: 1 }] },
    { clock: 2, documents: [{ state: { id: 7, typeName: 'shape' }, lastChangedClock: 1 }] },
    { clock: 2, documents: [{ state: record, lastChangedClock: 3 }] },
    {
      clock: 2,
      documents: [
        { state: record, lastChangedClock: 1 },
        { state: record, lastChangedClock: 2 },
      ],
    },
    { clock: 2, documents: [], tombstones: { 'shape:x': 5 } },
  ]

  for (const snapshot of snapshots) expect(room_view_create(snapshot, epoch).ok).toBe(false)

  const valid = room_view_create(
    { clock: 2, documents: [{ state: record, lastChangedClock: 1 }] },
    epoch,
  )
  expect(valid.ok).toBe(true)
})
