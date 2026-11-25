// What a board session is to every part of the system: an opaque id, a plain-text name, and the
// page addresses that open it. The default board is the board from before sessions existed, so
// its addresses stay exactly as they were: `/` for the stage and `/draw` for the pen.

import { assert } from './assert'
import { path_draw, type Role } from './constants'

export const board_default_id = 'default'

// Ids are made by the board, never chosen by a caller: sixteen hex digits of randomness.
export const board_id_pattern = /^(default|[0-9a-f]{16})$/

// Who gave a board its name. A person's name always wins over an agent's title.
export const board_namers = ['person', 'agent'] as const
export type BoardNamer = (typeof board_namers)[number]

export type BoardSession = {
  readonly id: string
  readonly name: string | null
  readonly named_by: BoardNamer | null
  readonly created_at_ms: number
}

// A deep link names the board and the role: `/s/<id>` presents it and `/s/<id>/draw` draws.
const path_session_pattern = /^\/s\/([^/]{1,64})(\/draw)?$/

// The two Unicode separators that end a line, as the C0 and C1 controls do.
const line_separator_code = 0x2028
const paragraph_separator_code = 0x2029

// A name is plain text: one line, no control characters, spaces collapsed, within its limit.
// Null means the value cannot be a name; the caller refuses it rather than correct it.
export function board_name_clean(value: unknown, length_max: number): string | null {
  assert(length_max > 0, 'a name limit is positive')

  if (typeof value !== 'string' || value.length > length_max * 4) return null

  // Control characters, line breaks included, are refused, not stripped.
  for (let index = 0; index < value.length; index += 1) {
    if (character_forbidden(value.charCodeAt(index))) return null
  }

  const name = value.trim().replace(/\s+/g, ' ')

  if (name.length === 0 || name.length > length_max) return null

  assert(name === name.trim(), 'a clean name has no outer spaces')
  return name
}

function character_forbidden(code: number): boolean {
  assert(Number.isInteger(code) && code >= 0, 'a character code is a whole number')
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === line_separator_code ||
    code === paragraph_separator_code
  )
}

export function board_stage_path(id: string): string {
  assert(board_id_pattern.test(id), 'a board id is well formed')
  return id === board_default_id ? '/' : `/s/${id}`
}

export function board_draw_path(id: string): string {
  assert(board_id_pattern.test(id), 'a board id is well formed')
  return id === board_default_id ? path_draw : `/s/${id}/draw`
}

// Which board and role a page address names, or null when it names neither.
export function board_page_parse(pathname: string): { id: string; role: Role } | null {
  if (pathname === '/') return { id: board_default_id, role: 'stage' }

  if (pathname === path_draw) return { id: board_default_id, role: 'draw' }

  const match = path_session_pattern.exec(pathname)

  if (match === null) return null

  const id = match[1] ?? ''

  if (!board_id_pattern.test(id)) return null

  assert(id.length > 0, 'a parsed id is not empty')
  return { id, role: match[2] === undefined ? 'stage' : 'draw' }
}

// The query that names a board on every API route.
export function board_query(id: string): string {
  assert(board_id_pattern.test(id), 'a board id is well formed')
  return `session=${id}`
}

// How a board is labelled when nobody has named it yet.
export function board_label(session: BoardSession): string {
  assert(board_id_pattern.test(session.id), 'a board id is well formed')
  return session.name ?? 'Untitled board'
}
