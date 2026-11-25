import { expect, test } from 'bun:test'
import { events_count_max, request_text_valid } from '../shared/whiteboard'
import { SimulatedDisk } from '../simulation/simulated_disk'
import { BoardEvents } from './board_events'
import { envelope_decode, envelope_encode, StorageError } from './storage'

const hash = 'f'.repeat(16)
const id = (n: number) => n.toString(16).padStart(36, '0')
const request = (n: number) => ({
  request_id: `00000000-${n.toString(16).padStart(4, '0')}-7000-8000-000000000000`,
  text: '\t📝 你好\r\n ',
})

test('dropped replies, replay conflicts and expiry never create another wake', () => {
  const disk = new SimulatedDisk()
  let events = BoardEvents.open(disk)
  const sent = events.queue('sketch_notify', hash, 0, id(0), request(0))
  events = BoardEvents.open(disk)
  expect(events.queue('sketch_notify', hash, 1, id(1), request(0))).toEqual(sent)
  expect(events.replay('interpret_request', hash, request(0))).toBe('conflict')
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
  disk.write_atomic(
    'events.state',
    envelope_encode({
      kind: 'events',
      label: '-',
      payload: new TextEncoder().encode(JSON.stringify([event])),
    }),
  )
  const events = BoardEvents.open(disk)
  const recovered = events.outstanding()[0]!
  expect(recovered).toMatchObject(event)
  expect(recovered.request_id).toMatch(/-7[0-9a-f]{3}-/)
  expect(BoardEvents.open(disk).outstanding()).toEqual([recovered])
  events.ack(event.id, 'received')
  expect(BoardEvents.open(disk).outstanding()).toEqual([{ ...recovered, state: 'received' }])
})

test('Unicode code points are bounded; journals reject bad text and orphaned request text', () => {
  expect(request_text_valid('🌱'.repeat(4000))).toBe(true)
  expect(request_text_valid('🌱'.repeat(4001))).toBe(false)

  for (const text of ['\0', '\x01', '\x0b', '\x1f', '\ud800']) {
    expect(request_text_valid(text)).toBe(false)
  }

  const disk = new SimulatedDisk()
  BoardEvents.open(disk).queue('interpret_request', hash, 0, id(0), request(0))
  const original = envelope_decode(disk.read('events.state')!, 'events')

  if (!original.ok) throw Error(original.reason)

  for (const change of [{ text: '\x01' }, { request_id: null }, { text: '🌱'.repeat(4001) }]) {
    const state = JSON.parse(new TextDecoder().decode(original.envelope.payload))
    Object.assign(state.events[0], change)
    disk.write_atomic(
      'events.state',
      envelope_encode({
        ...original.envelope,
        payload: new TextEncoder().encode(JSON.stringify(state)),
      }),
    )
    expect(() => BoardEvents.open(disk)).toThrow(StorageError)
  }
})
