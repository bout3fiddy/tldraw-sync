// What a device keeps of a board's chat between visits, and what it sends. A note an earlier
// page kept in the tab moves to the device once, with its unsent request, which carried the
// sketch as every send then did. A request for the retired Interpret is never sent again, and
// the words written with it are kept. Words alone never read the sketch.

import { afterEach, expect, test } from 'bun:test'
import {
  draft_key,
  draft_load,
  draft_save,
  send_prepare,
  SendError,
  type DraftStores,
} from './chat_delivery'

const session = 'abcdabcdabcdabcd'
const request_id = '018f3f2a-0000-7000-8000-000000000001'
const local = new Map<string, string>()
const tab = new Map<string, string>()
const stores: DraftStores = {
  local: {
    getItem: (name) => local.get(name) ?? null,
    setItem: (name, value) => void local.set(name, value),
  },
  tab: {
    getItem: (name) => tab.get(name) ?? null,
    removeItem: (name) => void tab.delete(name),
  },
}

afterEach(() => {
  local.clear()
  tab.clear()
})

const legacy_pending = (kind: string) => ({
  kind,
  sketch_hash: '0'.repeat(16),
  request_id,
  text: 'Keep the left column.',
})

test('a note an earlier page kept moves to this device once, its request with the sketch', () => {
  const saved = { text: 'And the right one.', pending: legacy_pending('sketch_notify') }
  tab.set('tldraw-sync.notify.abcdabcdabcdabcd', JSON.stringify(saved))
  tab.set('tldraw-sync.inbox.abcdabcdabcdabcd', '[]')
  const draft = draft_load(session, stores)
  expect<unknown>(draft).toEqual({
    text: 'And the right one.',
    include_sketch: false,
    pending: { ...legacy_pending('sketch_notify'), include_sketch: true },
  })

  // Moved, not copied: the tab keeps nothing of it, and the next load reads the device's.
  expect(tab.size).toBe(0)
  expect(JSON.parse(local.get(draft_key(session))!)).toEqual(draft)
  expect(draft_load(session, stores)).toEqual(draft)
})

test('an unsent Interpret from before the upgrade is dropped, and its words are kept', () => {
  const saved = { text: 'Keep it.', interpret: true, pending: legacy_pending('interpret_request') }
  tab.set('tldraw-sync.notify.abcdabcdabcdabcd', JSON.stringify(saved))
  expect(draft_load(session, stores)).toEqual({
    text: 'Keep it.',
    include_sketch: false,
    pending: null,
  })
  expect(draft_load('default', stores)).toEqual({ text: '', include_sketch: false, pending: null })
})

test('a draft this page did not write is refused, never guessed at', () => {
  const pending = { ...legacy_pending('sketch_notify'), include_sketch: true }
  const words = { kind: 'sketch_notify', request_id, include_sketch: false, text: 'Hi' }

  for (const damaged of [
    { text: 5, include_sketch: false, pending: null },
    { text: '', pending: null },
    { text: 'x'.repeat(24577), include_sketch: false, pending: null },
    { text: '', include_sketch: false, pending: { ...pending, kind: 'run_code' } },
    { text: '', include_sketch: false, pending: { ...pending, sketch_hash: 'nope' } },
    { text: '', include_sketch: false, pending: { ...pending, request_id: '1' } },
    { text: '', include_sketch: false, pending: { ...pending, text: '\x00' } },
    { text: '', include_sketch: false, pending: { ...words, text: ' ' } },
    { text: '', include_sketch: false, pending: { ...words, sketch_hash: '0'.repeat(16) } },
  ]) {
    local.set(draft_key(session), JSON.stringify(damaged))
    expect(() => draft_load(session, stores)).toThrow()
  }

  const kept = { text: 'Next', include_sketch: true, pending: words as never }
  draft_save(session, stores, kept)
  expect(draft_load(session, stores)).toEqual(kept)
})

test('words alone never read the sketch, and need words; the sketch is read once', () => {
  let reads = 0
  const sketch = () => {
    reads += 1
    return 'a'.repeat(16)
  }

  const words = send_prepare('Say it times out', null)
  expect(words).toMatchObject({
    kind: 'sketch_notify',
    include_sketch: false,
    text: 'Say it times out',
  })
  expect(words).not.toHaveProperty('sketch_hash')
  expect(reads).toBe(0)
  expect(() => send_prepare('  ', null)).toThrow(SendError)
  expect(() => send_prepare('🌱'.repeat(4001), sketch)).toThrow(SendError)
  expect(reads).toBe(0)

  const with_sketch = send_prepare('', sketch)
  expect(with_sketch).toMatchObject({ include_sketch: true, sketch_hash: 'a'.repeat(16) })
  expect(with_sketch).not.toHaveProperty('text')
  expect(reads).toBe(1)
  expect(words.request_id).not.toBe(with_sketch.request_id)
})
