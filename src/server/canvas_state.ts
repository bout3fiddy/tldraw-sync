// What every saved canvas file has in common, whichever format it was written in: an envelope
// around one JSON object, a revision that only grows, and versions that each say where they
// came from. The saved file is untrusted like any input. Damage stops the server instead of
// silently dropping a canvas.

import { assert } from '../shared/assert'
import { cleaned_history_count_max } from '../shared/constants'
import { header_read, JsonReader } from '../shared/json_reader'
import { envelope_decode, StorageError } from './storage'

export type Json = Record<string, unknown>

// Where one version came from, as it is saved with it.
export type Provenance = {
  revision: number
  source_hash: string | null
  agent: string
  summary: string
  published_at_ms: number
  restored_from: number | null
}

export const canvas_file_name = 'cleaned.state'
const placeholder_hash = '0'.repeat(16)

export function damaged(reason: string): StorageError {
  assert(reason.length > 0, 'damage is described')
  assert(!reason.endsWith('.'), 'a reason is a clause: the caller ends the sentence')
  return new StorageError(`${canvas_file_name} is damaged: ${reason}`)
}

// The JSON object inside a saved canvas file.
export function state_decode(bytes: Uint8Array): Json {
  const decoded = envelope_decode(bytes, 'cleaned')

  if (!decoded.ok) throw damaged(decoded.reason)

  let parsed: unknown

  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
  } catch {
    throw damaged('it is not JSON')
  }

  // Valid JSON need not be an object: null, a number, text or a list are refused here.
  const json = object_read(parsed)

  if (json === null) throw damaged('it is not a JSON object')

  assert(typeof json === 'object' && !Array.isArray(json), 'a decoded state is an object')
  assert(decoded.envelope.kind === 'cleaned', 'a canvas file holds a canvas')
  return json
}

// A JSON object with named fields, or null for null, a list or any other JSON value.
export function object_read(value: unknown): Json | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  assert(!Array.isArray(value), 'a read object is not a list')
  return value as Json
}

export function revision_valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

// The revision, time and origin of one saved version, or null when any of them is malformed.
// A restore copies a strictly older revision, so it can only name one below its own.
// `sourceless` allows a version made from no sketch, which the unified canvas could hold.
export function provenance_read(version: Json, sourceless: boolean): Provenance | null {
  const { revision, published_at_ms, restored_from, source_hash } = version
  const reader = new JsonReader()
  const snapshot = source_hash === null && sourceless ? placeholder_hash : source_hash
  const header = { snapshot, base_revision: 0, agent: version.agent, summary: version.summary }
  const { agent, summary } = header_read(reader, header, 'version')
  const valid =
    reader.problem === null &&
    revision_valid(revision) &&
    revision > 0 &&
    typeof published_at_ms === 'number' &&
    Number.isFinite(published_at_ms) &&
    (restored_from === null ||
      (revision_valid(restored_from) && restored_from > 0 && restored_from < revision))

  if (!valid) return null

  assert(restored_from === null || restored_from < revision, 'a restore names an older revision')
  assert(source_hash === null || typeof source_hash === 'string', 'a read source is a hash')
  return {
    revision,
    source_hash: source_hash as string | null,
    agent,
    summary,
    published_at_ms,
    restored_from: restored_from as number | null,
  }
}

// Whether the three parts describe a state a publish or a restore can leave behind. Nothing
// published means revision 0 and no history. Otherwise the current version is the revision,
// and the history holds strictly older versions, oldest first.
export function state_coherent(
  revision: number,
  current: { revision: number } | null,
  history: ReadonlyArray<{ revision: number }>,
): boolean {
  assert(revision >= 0, 'a revision is never negative')
  assert(history.length <= cleaned_history_count_max, 'history is bounded')

  if (current === null) return revision === 0 && history.length === 0

  if (current.revision !== revision) return false

  let newer = current.revision

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const older = (history[index] as { revision: number }).revision

    if (older >= newer) return false

    newer = older
  }

  return true
}

// The list of kept versions of a saved state, or a storage error when it is not one.
export function history_input_read(json: Json): unknown[] {
  const history = Array.isArray(json.history) ? (json.history as unknown[]) : null

  if (history === null || history.length > cleaned_history_count_max) {
    throw damaged('history is malformed')
  }

  assert(history.length <= cleaned_history_count_max, 'a read history is bounded')
  assert(Array.isArray(history), 'a read history is a list')
  return history
}
