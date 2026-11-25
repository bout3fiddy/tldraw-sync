// The list of boards as a page sees it. A page asks for the list on a fixed interval, one request
// at a time, so a name set on another device, or by an agent's first cleanup, shows up without
// a reload. Creating and renaming answer with the board as it now is, which is merged into the
// list at once; a list requested before that merge is dropped rather than allowed to undo it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { assert } from '../shared/assert'
import { board_id_pattern, type BoardSession } from '../shared/board_session'
import {
  board_sessions_count_max,
  board_sessions_poll_interval_ms,
  path_sessions,
  path_sessions_rename,
} from '../shared/constants'

export type SessionsState = {

  // Null until the first list arrives.
  readonly list: readonly BoardSession[] | null

  // The board did not answer the last request for the list.
  readonly failed: boolean
  merge(session: BoardSession): void
}

export type CreateOutcome =
  { kind: 'created'; session: BoardSession } | { kind: 'full' } | { kind: 'failed' }

export type RenameOutcome = { kind: 'renamed'; session: BoardSession } | { kind: 'failed' }

const request_timeout_ms = 5000

export function use_sessions(): SessionsState {
  const [list, list_set] = useState<readonly BoardSession[] | null>(null)
  const [failed, failed_set] = useState(false)

  // Counts merges, so a list requested before a merge is known to be older than it.
  const merges = useRef(0)

  useEffect(() => {
    let stopped = false
    let timer = 0
    let text_shown = ''

    // One poll. A hidden page asks only for its first list, and catches up once shown.
    const poll = async (): Promise<void> => {
      const merges_before = merges.current
      const skipped = window.document.hidden && text_shown !== ''
      const text = skipped ? text_shown : await list_get()

      if (!stopped && !skipped) {
        const sessions = text === null ? null : sessions_parse(text)
        failed_set(sessions === null)

        if (sessions !== null && text !== text_shown && merges.current === merges_before) {
          text_shown = text as string
          list_set(sessions)
        }
      }

      if (!stopped) timer = window.setTimeout(() => void poll(), board_sessions_poll_interval_ms)
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [])

  const merge = useCallback((session: BoardSession) => {
    assert(board_id_pattern.test(session.id), 'a merged board has a valid id')
    merges.current += 1
    list_set((previous) => {
      const others = (previous ?? []).filter((candidate) => candidate.id !== session.id)
      const index = (previous ?? []).findIndex((candidate) => candidate.id === session.id)

      if (index < 0) return [...others, session]

      return [...others.slice(0, index), session, ...others.slice(index)]
    })
  }, [])

  return { list, failed, merge }
}

async function list_get(): Promise<string | null> {
  try {
    const response = await fetch(path_sessions, {
      cache: 'no-store',
      signal: AbortSignal.timeout(request_timeout_ms),
    })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

// Only what a page needs, checked: a list from the board is still read as untrusted.
function sessions_parse(text: string): BoardSession[] | null {
  let json: unknown

  try {
    json = JSON.parse(text)
  } catch {
    return null
  }

  const sessions = (json as { sessions?: unknown } | null)?.sessions

  if (!Array.isArray(sessions) || sessions.length > board_sessions_count_max) return null

  const valid = sessions.every((session) => session_valid(session))
  return valid ? (sessions as BoardSession[]) : null
}

function session_valid(value: unknown): value is BoardSession {
  if (value === null || typeof value !== 'object') return false

  const session = value as Record<string, unknown>
  return (
    typeof session.id === 'string' &&
    board_id_pattern.test(session.id) &&
    (session.name === null || typeof session.name === 'string') &&
    typeof session.created_at_ms === 'number'
  )
}

export async function session_create(): Promise<CreateOutcome> {
  const response = await post(path_sessions, {})

  if (response === null) return { kind: 'failed' }

  if (response.status === 409) return { kind: 'full' }

  const session = (response.body as { session?: unknown }).session

  if (!response.ok || !session_valid(session)) return { kind: 'failed' }

  return { kind: 'created', session }
}

export async function session_rename(id: string, name: string): Promise<RenameOutcome> {
  assert(board_id_pattern.test(id), 'a renamed board has a valid id')
  const response = await post(path_sessions_rename, { session: id, name })

  if (response === null) return { kind: 'failed' }

  const session = (response.body as { session?: unknown }).session

  if (!response.ok || !session_valid(session)) return { kind: 'failed' }

  return { kind: 'renamed', session }
}

type Posted = { ok: boolean; status: number; body: object }

async function post(pathname: string, body: object): Promise<Posted | null> {
  try {
    const response = await fetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request_timeout_ms),
    })
    const parsed = (await response.json()) as unknown
    const object = typeof parsed === 'object' && parsed !== null ? parsed : {}
    return { ok: response.ok, status: response.status, body: object }
  } catch {
    return null
  }
}
