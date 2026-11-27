// Reads untrusted JSON: a scene proposal written by an agent, or a saved canvas. Reading
// never throws on bad input. The reader keeps the first problem it meets, with the path to it,
// and the caller reports that problem as an ordinary error.

import { assert } from './assert'
import { board_id_pattern, board_name_clean } from './board_session'
import {
  board_title_length_max,
  document_hash_pattern,
  proposal_summary_length_max,
} from './constants'

export type Json = Record<string, unknown>

export type Problem = { path: string; message: string }

// Every proposal starts with the same header: what it was made from, and by whom. The board
// session is the one the snapshot was taken from; a header without one is read as null, and
// the caller decides whether that is allowed. A title is offered for a board that has no name
// yet.
export type Header = {
  snapshot: string
  base_revision: number
  agent: string
  summary: string
  session: string | null
  title: string | null
}

export const header_keys = [
  'format', 'snapshot', 'base_revision', 'agent', 'summary', 'session', 'title',
] as const

const agent_pattern = /^[A-Za-z0-9 ._:/-]{1,64}$/
const agent_default = 'external agent'
const revision_max = 2 ** 52

export class JsonReader {
  problem: Problem | null = null

  fail(path: string, message: string): void {
    assert(path.length > 0, 'a problem names where it is')
    assert(message.endsWith('.'), 'a problem is a full sentence')

    if (this.problem === null) this.problem = { path, message }
  }

  object(value: unknown, path: string, keys: readonly string[]): Json {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.fail(path, 'Expected a JSON object.')
      return {}
    }

    const unknown = Object.keys(value).find((key) => !keys.includes(key))

    if (unknown !== undefined) this.fail(`${path}.${unknown}`, 'Unknown field; see the schema.')

    assert(typeof value === 'object', 'an object was read')
    assert(keys.length > 0, 'an object has allowed fields')
    return value as Json
  }

  number(source: Json, key: string, path: string, min: number, max: number): number {
    assert(min < max, 'a number range is not empty')
    const value = source[key]

    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      this.fail(`${path}.${key}`, `Expected a number from ${min} to ${max}.`)
      return min
    }

    assert(value >= min && value <= max, 'a read number is in range')
    return value
  }

  text(source: Json, key: string, path: string, length_max: number, fallback: string | null) {
    assert(length_max > 0, 'a text bound is positive')
    const value = source[key]

    if (value === undefined && fallback !== null) return fallback

    if (typeof value !== 'string' || value.length > length_max) {
      this.fail(`${path}.${key}`, `Expected text of at most ${length_max} characters.`)
      return fallback ?? ''
    }

    assert(value.length <= length_max, 'read text is bounded')
    return value
  }

  // A missing optional choice takes the first option, which is its default.
  choice<T extends string>(
    source: Json,
    key: string,
    path: string,
    values: readonly T[],
    required: boolean,
  ): T {
    assert(values.length > 0, 'a choice has options')
    const value = required ? source[key] : (source[key] ?? values[0])
    const found = values.find((candidate) => candidate === value)

    if (found === undefined) {
      this.fail(`${path}.${key}`, `Expected one of: ${values.join(', ')}.`)
      return values[0] as T
    }

    assert(values.includes(found), 'a read choice is one of the options')
    return found
  }

  // A list of count_min to count_max items, or an empty list after a problem.
  list(value: unknown, path: string, count_min: number, count_max: number): unknown[] {
    assert(count_min >= 0, 'a list minimum is never negative')
    assert(count_min <= count_max, 'a list range is not empty')

    if (!Array.isArray(value) || value.length < count_min || value.length > count_max) {
      this.fail(path, `Expected a list of ${count_min} to ${count_max} items.`)
      return []
    }

    return value
  }

  boolean(source: Json, key: string, path: string, fallback: boolean): boolean {
    const value = source[key] ?? fallback

    if (typeof value !== 'boolean') {
      this.fail(`${path}.${key}`, 'Expected true or false.')
      return fallback
    }

    assert(typeof value === 'boolean', 'a read flag is a boolean')
    return value
  }
}

// The snapshot and revision a proposal builds on, and who made it.
export function header_read(reader: JsonReader, root: Json, path: string): Header {
  assert(path.length > 0, 'a header has a path')
  const snapshot = reader.text(root, 'snapshot', path, 16, null)

  if (!document_hash_pattern.test(snapshot)) {
    reader.fail(`${path}.snapshot`, 'Expected the snapshot token from whiteboard-snapshot.')
  }

  const base_revision = reader.number(root, 'base_revision', path, 0, revision_max)

  if (!Number.isInteger(base_revision)) {
    reader.fail(`${path}.base_revision`, 'Expected a whole revision number.')
  }

  const agent = reader.text(root, 'agent', path, 64, agent_default)

  if (!agent_pattern.test(agent)) {
    reader.fail(`${path}.agent`, 'Expected a short name of letters, digits and . _ - : /.')
  }

  const summary = reader.text(root, 'summary', path, proposal_summary_length_max, '')
  assert(summary.length <= proposal_summary_length_max, 'a summary is bounded')
  const session = header_session_read(reader, root, path)
  const title = header_title_read(reader, root, path)
  return { snapshot, base_revision, agent, summary, session, title }
}

// Null reads as absent, as a parsed header writes it, so a read header can be written back.
function header_session_read(reader: JsonReader, root: Json, path: string): string | null {
  if (root.session === undefined || root.session === null) return null

  const session = reader.text(root, 'session', path, 16, null)

  if (!board_id_pattern.test(session)) {
    reader.fail(`${path}.session`, 'Expected the session from whiteboard-snapshot.')
    return null
  }

  assert(session.length > 0, 'a read session is not empty')
  return session
}

function header_title_read(reader: JsonReader, root: Json, path: string): string | null {
  if (root.title === undefined || root.title === null) return null

  const title = board_name_clean(root.title, board_title_length_max)

  if (title === null) {
    const message = `Expected a title of 1 to ${board_title_length_max} characters on one line.`
    reader.fail(`${path}.title`, message)
    return null
  }

  assert(title.length <= board_title_length_max, 'a read title is bounded')
  return title
}
