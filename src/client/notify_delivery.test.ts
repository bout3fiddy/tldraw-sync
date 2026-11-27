// What a tab keeps of a note between visits, read back after an upgrade. A request for the
// retired Interpret, left unconfirmed by the page before, must never be sent again; the words
// the person wrote must not be lost with it.

import { afterEach, expect, test } from 'bun:test'
import { inbox_restore } from './notify_inbox'
import { draft_key, draft_load, draft_pending_key } from './notify_delivery'

const session = 'abcdabcdabcdabcd'
const key = draft_key(session)
const request_id = '018f3f2a-0000-7000-8000-000000000001'
const stored = new Map<string, string>()

// The tab's own storage, as far as a draft uses it.
Object.assign(globalThis, {
  sessionStorage: {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => void stored.set(name, value),
  },
})

afterEach(() => stored.clear())

const pending = (kind: string) => ({
  kind,
  sketch_hash: '0'.repeat(16),
  request_id,
  text: 'Keep the left column.',
})

test('an unconfirmed Interpret from before the upgrade is dropped, and its words are kept', () => {
  const saved = {
    text: 'Keep the left column.',
    interpret: true,
    pending: pending('interpret_request'),
  }
  stored.set(key, JSON.stringify(saved))
  expect(draft_load(key)).toEqual({ text: 'Keep the left column.', pending: null })
  expect(draft_pending_key(session)).toBeNull()

  // Its row under the bell was waiting on that request: with nothing left to retry, it goes.
  const row = {
    key: request_id,
    event_id: null,
    subject: 'interpret_request',
    state: 'unconfirmed',
    detail: 'No confirmation.',
    changed_at_ms: 5,
    unread: true,
  }
  const done = { ...row, key: 'older', event_id: 'e1', state: 'updated', detail: '' }
  const rows = inbox_restore(JSON.stringify([done, row]), draft_pending_key(session))
  expect(rows.map((entry) => [entry.key, entry.subject, entry.state])).toEqual([
    ['older', 'interpret_request', 'updated'],
  ])
})

test('an unconfirmed Send is kept exactly, to be sent again as it was', () => {
  const saved = { text: 'Keep the left column.', pending: pending('sketch_notify') }
  stored.set(key, JSON.stringify(saved))
  expect<unknown>(draft_load(key)).toEqual(saved)
  expect(draft_pending_key(session)).toBe(request_id)
  expect(draft_load(draft_key('default'))).toEqual({ text: '', pending: null })
})

test('a draft this page did not write is refused, never guessed at', () => {
  for (const damaged of [
    { text: 5, pending: null },
    { text: 'x'.repeat(8193), pending: null },
    { text: '', pending: pending('run_code') },
    { text: '', pending: { ...pending('sketch_notify'), sketch_hash: 'nope' } },
    { text: '', pending: { ...pending('sketch_notify'), request_id: '1' } },
    { text: '', pending: { ...pending('sketch_notify'), text: '\x00' } },
  ]) {
    stored.set(key, JSON.stringify(damaged))
    expect(() => draft_load(key)).toThrow()
    expect(draft_pending_key(session)).toBeNull()
  }
})
