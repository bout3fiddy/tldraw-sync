// The identity of a drawing is the hash of its document records. The server hashes the records
// it holds, the stage hashes the records it rendered, and an image is "fresh" exactly when the
// two agree. This replaces any reasoning about clocks, message order, or timing.

import { assert } from './assert'
import { document_hash_length, document_hash_pattern } from './constants'

export type DocumentRecord = { readonly id: string; readonly typeName: string }

const records_count_max = 1_000_000

export function document_hash(records: readonly DocumentRecord[]): string {
  assert(records.length <= records_count_max, 'records count is bounded')

  const sorted = [...records].sort(compare_by_id)
  let state: HashState = { high: 0xdeadbeef, low: 0x41c6ce57 }
  for (const record of sorted) {
    state = hash_update(state, canonical_json(record))
    // A separator keeps two adjacent records from hashing like one concatenated record.
    state = hash_update(state, '\n')
  }
  const hash = hash_finish(state)

  assert(hash.length === document_hash_length, 'hash has the fixed length')
  assert(document_hash_pattern.test(hash), 'hash is lowercase hex')
  return hash
}

export function shapes_count(records: readonly DocumentRecord[]): number {
  let count = 0
  for (const record of records) {
    if (record.typeName === 'shape') count += 1
  }
  assert(count <= records.length, 'shapes are a subset of records')
  return count
}

function compare_by_id(a: DocumentRecord, b: DocumentRecord): number {
  assert(a.id !== b.id, `record ids are unique: ${a.id}`)
  return a.id < b.id ? -1 : 1
}

// Key order is not part of a record's meaning, so keys are sorted before hashing. The server
// and the browser build the same record through different code paths.
function canonical_json(record: DocumentRecord): string {
  const json = JSON.stringify(record, (_key, value: unknown) => {
    if (value === null) return value
    if (typeof value !== 'object') return value
    if (Array.isArray(value)) return value
    const source = value as Record<string, unknown>
    const target: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      target[key] = source[key]
    }
    return target
  })
  assert(typeof json === 'string', 'a record always serialises')
  assert(json.startsWith('{'), 'a record is an object')
  return json
}

type HashState = { readonly high: number; readonly low: number }

// Two interleaved 32-bit multiplicative hashes (the "cyrb" construction). It is not
// cryptographic: it only has to tell apart versions of one person's drawing. It is used in
// place of SHA-256 because browsers withhold `crypto.subtle` from plain-HTTP pages.
function hash_update(state: HashState, text: string): HashState {
  let high = state.high
  let low = state.low
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    high = Math.imul(high ^ code, 2654435761)
    low = Math.imul(low ^ code, 1597334677)
  }
  return { high, low }
}

function hash_finish(state: HashState): string {
  let high = state.high
  let low = state.low
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909)
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909)
  const hash = hex_32(high) + hex_32(low)
  assert(hash.length === document_hash_length, 'hash has the fixed length')
  return hash
}

function hex_32(value: number): string {
  const hex = (value >>> 0).toString(16).padStart(8, '0')
  assert(hex.length === 8, 'thirty-two bits are eight hex characters')
  return hex
}
