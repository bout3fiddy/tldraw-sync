import { expect, test } from 'bun:test'
import { events_count_max, request_text_valid, retired_message } from '../shared/whiteboard'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import { BoardEvents } from './board_events'
import { envelope_decode, envelope_encode, StorageError } from './storage'

const hash = 'f'.repeat(16)
const id = (n: number) => n.toString(16).padStart(36, '0')
const request = (n: number) => ({
  request_id: `00000000-${n.toString(16).padStart(4, '0')}-7000-8000-000000000000`,
  text: '\t📝 你好\r\n ',
})

function journal_write(disk: SimulatedDisk, state: object): void {
  const payload = new TextEncoder().encode(JSON.stringify(state))
  disk.write_atomic('events.state', envelope_encode({ kind: 'events', label: '-', payload }))
}

test('dropped replies, replay conflicts and expiry never create another wake', () => {
  const disk = new SimulatedDisk()
  let events = BoardEvents.open(disk)
  const sent = events.queue('sketch_notify', hash, 0, id(0), request(0))
  events = BoardEvents.open(disk)
  expect(events.queue('sketch_notify', hash, 1, id(1), request(0))).toEqual(sent)
  expect(events.replay('sketch_notify', hash, { ...request(0), text: 'other' })).toBe('conflict')
  expect(events.replay('sketch_notify', '0'.repeat(16), request(0))).toBe('conflict')
  expect(events.outstanding()).toHaveLength(1)

  for (let n = 1; n < events_count_max; n++) {
    expect(events.queue('sketch_notify', hash, n, id(n), request(n))).toMatchObject(request(n))
  }

  for (const state of ['received', 'updated'] as const) events.ack(id(0), state)

  expect(events.queue('sketch_notify', hash, 64, id(64), request(64))).toMatchObject(request(64))
  events = BoardEvents.open(disk)

  // Leave an evictable slot. Without the watermark the retired request really would wake again.
  for (const state of ['received', 'updated'] as const) events.ack(id(1), state)

  const before = disk.read('events.state')
  expect(events.queue('sketch_notify', hash, 65, id(65), request(0))).toBe('expired')
  expect(disk.read('events.state')).toEqual(before)
})

test('legacy outstanding events retain stable delivery and ACK identities across upgrade', () => {
  const disk = new SimulatedDisk()
  const event = {
    id: id(1),
    kind: 'sketch_notify',
    state: 'queued',
    sketch_hash: hash,
    created_at_ms: 10,
  }
  journal_write(disk, [event])
  const events = BoardEvents.open(disk)
  const recovered = events.outstanding()[0]!
  expect(recovered).toMatchObject(event)
  expect(recovered.request_id).toMatch(/-7[0-9a-f]{3}-/)
  expect(BoardEvents.open(disk).outstanding()).toEqual([recovered])
  events.ack(event.id, 'received')
  expect(BoardEvents.open(disk).outstanding()).toEqual([{ ...recovered, state: 'received' }])
})

// Requests made with the Interpret switch this board no longer has. Whatever state an upgrade
// found them in, none is ever handed to a host, and none is lost from the record.
test('interpret requests left from before the upgrade are closed unrun at open', () => {
  const disk = new SimulatedDisk()
  const interpret = (n: number, state: string) => ({
    id: id(n),
    kind: 'interpret_request',
    state,
    sketch_hash: hash,
    created_at_ms: n,
    ...request(n),
  })
  const done = { ...interpret(3, 'updated'), message: 'Published revision 4.' }
  const note = { ...interpret(4, 'queued'), kind: 'sketch_notify' }
  const saved = [interpret(1, 'queued'), interpret(2, 'working'), done, note]
  journal_write(disk, { events: saved, retired_through_ms: -1 })
  const before = disk.read('events.state')

  // A crash while closing them leaves the journal as it was, and the next start closes them.
  disk.write_fault_armed = true
  expect(() => BoardEvents.open(disk)).toThrow(SimulatedCrash)
  expect(disk.read('events.state')).toEqual(before)

  const events = BoardEvents.open(disk)
  expect(events.outstanding()).toEqual([note as never])
  expect(events.latest()).toEqual(note as never)
  const closed = { state: 'failed', message: retired_message }
  const after = disk.read('events.state')!
  const journal = envelope_decode(after, 'events')

  if (!journal.ok) throw Error(journal.reason)

  expect(JSON.parse(new TextDecoder().decode(journal.envelope.payload)).events).toEqual([
    { ...interpret(1, 'queued'), ...closed },
    { ...interpret(2, 'working'), ...closed },
    done,
    note,
  ])

  // Closed is final: a host that was working on one cannot finish it, and a retry of its
  // request is the old receipt's business, never a new request.
  expect(events.ack(id(1), 'received')).toBe('transition')
  expect(events.ack(id(2), 'updated')).toBe('transition')
  expect(events.replay('sketch_notify', hash, request(1))).toBe('conflict')
  expect(events.queue('sketch_notify', hash, 9, id(9), request(2))).toBe('conflict')
  expect(events.outstanding()).toEqual([note as never])

  // Opening again finds nothing left to close, and writes nothing.
  expect(BoardEvents.open(disk).outstanding()).toEqual([note as never])
  expect(disk.read('events.state')).toEqual(after)
})

test('a journal from before request ids closes its interpret requests the same way', () => {
  const disk = new SimulatedDisk()
  const old = { id: id(1), state: 'received', sketch_hash: hash, created_at_ms: 10 }
  journal_write(disk, [
    { ...old, kind: 'interpret_request' },
    { ...old, id: id(2), kind: 'sketch_notify' },
  ])
  const events = BoardEvents.open(disk)
  expect(events.outstanding().map((event) => [event.id, event.kind])).toEqual([
    [id(2), 'sketch_notify'],
  ])
  expect(events.ack(id(1), 'working')).toBe('transition')
  expect(events.ack(id(2), 'working')).toMatchObject({ state: 'working' })
})

test('Unicode code points are bounded; journals reject bad text and orphaned request text', () => {
  expect(request_text_valid('🌱'.repeat(4000))).toBe(true)
  expect(request_text_valid('🌱'.repeat(4001))).toBe(false)

  for (const text of ['\0', '\x01', '\x0b', '\x1f', '\ud800']) {
    expect(request_text_valid(text)).toBe(false)
  }

  const disk = new SimulatedDisk()
  BoardEvents.open(disk).queue('sketch_notify', hash, 0, id(0), request(0))
  const original = envelope_decode(disk.read('events.state')!, 'events')

  if (!original.ok) throw Error(original.reason)

  for (const change of [
    { text: '\x01' },
    { request_id: null },
    { text: '🌱'.repeat(4001) },
    { kind: 'run_code' },
  ]) {
    const state = JSON.parse(new TextDecoder().decode(original.envelope.payload))
    Object.assign(state.events[0], change)
    journal_write(disk, state)
    expect(() => BoardEvents.open(disk)).toThrow(StorageError)
  }
})
