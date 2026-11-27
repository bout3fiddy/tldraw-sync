// The chat as it is read. Goal: each request is shown once, with its answer under it; what this
// device alone holds is shown until the board shows it; only answers are news. Method: build
// the thread from board items and local requests as a page would, at each step.

import { expect, test } from 'bun:test'
import type { ChatItem } from '../shared/board_chat'
import type { Send } from './chat_delivery'
import { thread_entries, thread_working, unread_count, type Local } from './chat_thread'

const item = (n: number, change: Partial<ChatItem> = {}): ChatItem => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  request_id: `00000000-000${n}-7000-8000-000000000000`,
  kind: 'sketch_notify',
  include_sketch: false,
  text: `Message ${n}`,
  sketch_hash: null,
  shapes_count: null,
  created_at_ms: n * 1000,
  state: 'queued',
  status: null,
  reply: null,
  answer_seq: null,
  answered_at_ms: null,
  canvas_revision: null,
  ...change,
})

const send = (n: number): Send => ({
  kind: 'sketch_notify',
  request_id: `00000000-000${n}-7000-8000-000000000000`,
  include_sketch: false,
  text: `Message ${n}`,
})
const local = (n: number, state: Local['state']): Local => ({
  send: send(n),
  state,
  at_ms: n * 1000,
  detail: state === 'unconfirmed' ? 'No confirmation.' : '',
})

test('an unsent request shows once, and gives way to the board once the board has it', () => {
  const waiting = thread_entries([item(1)], [local(2, 'unconfirmed')], 0)
  expect(waiting.map((entry) => [entry.type, entry.key])).toEqual([
    ['mine', item(1).id],
    ['mine', send(2).request_id],
  ])
  expect(waiting[1]).toMatchObject({
    state: 'unconfirmed',
    local: true,
    detail: 'No confirmation.',
  })

  // The board turns out to hold it: it is shown as the board's, once, and never as local.
  const held = thread_entries([item(1), item(2, { state: 'received' })], [local(2, 'sending')], 0)
  expect(held.map((entry) => entry.key)).toEqual([item(1).id, item(2).id])
  expect(held[1]).toMatchObject({ state: 'received', local: false })

  // Confirmed but not yet served: shown with its receipt, and not as this device's alone.
  const confirmed = thread_entries([item(1)], [local(2, 'queued')], 0)
  expect(confirmed[1]).toMatchObject({ state: 'queued', local: false })
})

test('an answer is shown under its own request, and only new answers are unread', () => {
  const items = [
    item(1, { state: 'updated', reply: 'First.', answer_seq: 1, answered_at_ms: 9000 }),
    item(2, { state: 'working', status: 'Reading the sketch' }),
    item(3, {
      state: 'failed',
      reply: 'No access.',
      answer_seq: 2,
      canvas_revision: 4,
      include_sketch: true,
      sketch_hash: 'f'.repeat(16),
      shapes_count: 41,
    }),
  ]
  const entries = thread_entries(items, [], 1)
  expect(entries.map((entry) => entry.type)).toEqual(['mine', 'answer', 'mine', 'mine', 'answer'])
  expect(entries[1]).toMatchObject({ text: 'First.', at_ms: 9000, unread: false, failed: false })
  expect(entries[4]).toMatchObject({ failed: true, canvas_revision: 4, unread: true })
  expect(entries[3]).toMatchObject({ include_sketch: true, shapes_count: 41 })
  expect(unread_count(items, 1)).toBe(1)
  expect(unread_count(items, 2)).toBe(0)
  expect(unread_count(items, null)).toBe(0)
  expect(unread_count(null, 0)).toBe(0)

  // Moving from queued to working is the agent's business, not news.
  expect(unread_count([item(4, { state: 'working' })], 0)).toBe(0)
  expect(thread_working(items)).toMatchObject({ id: item(2).id, status: 'Reading the sketch' })
})

// Regression: two requests received, the earlier then worked on. The foot showed the later
// one's bare receipt and hid what the agent said it was doing.
test('the foot shows work in hand over a later request only received', () => {
  const working = item(1, { state: 'working', status: 'Reading the sketch' })
  const received = item(2, { state: 'received' })
  expect(thread_working([working, received])).toMatchObject({
    id: working.id,
    state: 'working',
    status: 'Reading the sketch',
  })
  expect(thread_working([item(1, { state: 'received' }), received])).toMatchObject({
    id: received.id,
  })
  expect(thread_working([item(1, { state: 'updated', reply: 'Done.' }), item(2)])).toBeNull()
})

test('a retired request shows the board’s line under it, and no answer', () => {
  const retired = item(1, {
    kind: 'interpret_request',
    text: null,
    state: 'failed',
    reply: 'Interpret was retired. Send again and say what you want.',
  })
  const entries = thread_entries([retired], [], 0)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    type: 'mine',
    text: 'Interpret my sketch',
    detail: 'Interpret was retired. Send again and say what you want.',
  })
})
