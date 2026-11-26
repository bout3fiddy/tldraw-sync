import { expect, test } from 'bun:test'
import type { BoardEvent } from '../shared/whiteboard'
import {
  inbox_apply,
  inbox_entries_count_max,
  inbox_entry_stale,
  inbox_restore,
  type InboxAction,
  type InboxEntry,
} from './notify_inbox'

const request = '018f3f2a-0000-7000-8000-000000000001'
const event = (id: string, state: BoardEvent['state'], message?: string): BoardEvent => ({
  id,
  kind: 'interpret_request',
  sketch_hash: '0'.repeat(16),
  created_at_ms: 1000,
  state,
  message,
})
const local = (key: string, state: 'sending' | 'unconfirmed' | 'refused', detail = '') =>
  ({
    type: 'local',
    key,
    subject: 'interpret_request',
    state,
    detail,
    now_ms: 5,
    silent: false,
  }) as const
const run = (actions: InboxAction[], start: readonly InboxEntry[] = []) =>
  actions.reduce(inbox_apply, start)

// The goal: a request is one row from the tap to its end. Method: replay the lifecycle a tab
// really sees, including the status poll overtaking the receipt, and count rows at each step.
test('one request stays one row from sending to its end, and never moves backwards', () => {
  let rows = run([local(request, 'sending')])
  expect(rows).toMatchObject([{ key: request, state: 'sending', unread: false, event_id: null }])

  // The poll shows the request first, already received; then the late receipt says queued.
  rows = inbox_apply(rows, {
    type: 'observe',
    event: event('e1', 'received'),
    now_ms: 6,
    silent: false,
    baseline: false,
  })
  expect(rows).toHaveLength(2)
  rows = inbox_apply(rows, {
    type: 'confirm',
    key: request,
    event: event('e1', 'queued'),
    now_ms: 7,
    silent: false,
  })
  expect(rows).toMatchObject([{ key: request, event_id: 'e1', state: 'received', unread: true }])

  for (const [state, message] of [
    ['working', undefined],
    ['queued', undefined],
    ['failed', 'The sketch was empty.'],
    ['working', undefined],
  ] as const) {
    rows = inbox_apply(rows, {
      type: 'observe',
      event: event('e1', state, message),
      now_ms: 8,
      silent: false,
      baseline: false,
    })
    expect(rows).toHaveLength(1)
  }

  expect(rows[0]).toMatchObject({ state: 'failed', detail: 'The sketch was empty.' })

  // A late local report cannot take a confirmed row back either.
  expect(inbox_apply(rows, local(request, 'unconfirmed', 'late'))).toBe(rows)
})

test('a refused or unconfirmed send is unread until read; a retry reuses its row', () => {
  let rows = run([local(request, 'sending'), local(request, 'unconfirmed', 'No confirmation.')])
  expect(rows).toMatchObject([{ state: 'unconfirmed', detail: 'No confirmation.', unread: true }])
  rows = run([{ type: 'read' }, local(request, 'sending')], rows)
  expect(rows).toMatchObject([{ state: 'sending', unread: false }])
  expect(inbox_apply(rows, { type: 'read' })).toBe(rows)

  // Updates that arrive while the list is open are already seen.
  const seen = inbox_apply(rows, { ...local(request, 'refused', 'Ink is syncing.'), silent: true })
  expect(seen).toMatchObject([{ state: 'refused', unread: false }])
})

test('the first status seen is history; later ones are news; unchanged ones change nothing', () => {
  const observe = (item: BoardEvent, baseline: boolean): InboxAction => ({
    type: 'observe',
    event: item,
    now_ms: 9000,
    silent: false,
    baseline,
  })
  let rows = run([observe(event('old', 'updated'), true)])
  expect(rows).toMatchObject([{ key: 'old', unread: false, changed_at_ms: 1000 }])
  expect(inbox_apply(rows, observe(event('old', 'updated'), false))).toBe(rows)
  rows = inbox_apply(rows, observe(event('new', 'queued'), false))
  expect(rows[1]).toMatchObject({ key: 'new', unread: true, changed_at_ms: 9000 })

  // Only the newest request is published: the older one is marked as last known, unless done.
  expect(inbox_entry_stale(rows[1]!, 'new')).toBe(false)
  expect(inbox_entry_stale(rows[1]!, 'newer')).toBe(true)
  expect(inbox_entry_stale(rows[1]!, null)).toBe(false)
  expect(inbox_entry_stale(rows[0]!, 'newer')).toBe(false)
})

test('status from the network is checked before it becomes a row', () => {
  const bad = [
    { ...event('e1', 'queued'), state: 'done' },
    { ...event('e1', 'queued'), kind: 'chat' },
    { ...event('e1', 'queued'), id: 'x'.repeat(65) },
    { ...event('e1', 'queued'), message: 'm'.repeat(281) },
    { ...event('e1', 'queued'), created_at_ms: 1.5 },
  ] as unknown as BoardEvent[]

  for (const item of bad) {
    const action = { event: item, now_ms: 1, silent: false }
    expect(inbox_apply([], { type: 'observe', baseline: false, ...action })).toEqual([])
    expect(inbox_apply([], { type: 'confirm', key: request, ...action })).toEqual([])
  }
})

test('the inbox holds its bound on both sides and drops the oldest row first', () => {
  const fill = Array.from({ length: inbox_entries_count_max }, (_, n) => local(`k${n}`, 'refused'))
  const full = run(fill)
  expect(full).toHaveLength(inbox_entries_count_max)
  const over = inbox_apply(full, local('extra', 'refused'))
  expect(over).toHaveLength(inbox_entries_count_max)
  expect(over[0]!.key).toBe('k1')
  expect(over.at(-1)!.key).toBe('extra')
})

test('saved rows are restored whole or not at all; a reload settles a row left mid-send', () => {
  const rows = run([
    local('gone', 'sending'),
    local(request, 'sending'),
    { type: 'confirm', key: 'k', event: event('e9', 'working'), now_ms: 3, silent: true },
  ])
  const restored = inbox_restore(JSON.stringify(rows), request)
  expect(restored.map((entry) => [entry.key, entry.state])).toEqual([
    [request, 'unconfirmed'],
    ['k', 'working'],
  ])
  expect(restored[0]!.detail).toContain('No confirmation')
  expect(inbox_restore(JSON.stringify(rows), null).map((entry) => entry.key)).toEqual(['k'])

  for (const text of [
    null,
    '',
    '{',
    '{}',
    JSON.stringify([{ ...rows[2], state: 'done' }]),
    JSON.stringify([{ ...rows[2], detail: 5 }]),
    JSON.stringify(Array.from({ length: inbox_entries_count_max + 1 }, () => rows[2])),
    ' '.repeat(40_000),
  ]) {
    expect(inbox_restore(text, null)).toEqual([])
  }

  // A row saved twice is shown once.
  expect(inbox_restore(JSON.stringify([rows[2], rows[2]]), null)).toHaveLength(1)
})
