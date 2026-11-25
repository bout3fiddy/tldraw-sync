// The cleaned diagram as a page sees it. A page asks for the small status on a fixed interval,
// one request at a time, and fetches the records only when the revision changes. The status
// also says whether the sketch has moved on since the diagram was made from it.

import { useCallback, useEffect, useState } from 'react'
import { assert } from '../shared/assert'
import { board_query } from '../shared/board_session'
import type { CleanedDocument, CleanedStatus } from '../shared/cleanup_types'
import {
  cleaned_poll_interval_ms,
  path_cleaned_json,
  path_cleaned_restore,
  path_cleaned_status,
} from '../shared/constants'

export type CleanedState = {

  // The board session this cleaned diagram belongs to.
  readonly session: string
  readonly status: CleanedStatus | null
  readonly document: CleanedDocument | null
  refresh(): void
}

export type RestoreOutcome = 'restored' | 'conflict' | 'failed'

const request_timeout_ms = 5000

export function use_cleaned(session: string): CleanedState {
  const [status, status_set] = useState<CleanedStatus | null>(null)
  const [document, document_set] = useState<CleanedDocument | null>(null)
  const [generation, generation_set] = useState(0)
  const refresh = useCallback(() => generation_set((value) => value + 1), [])

  useEffect(() => {
    let stopped = false
    let timer = 0
    let status_text = ''
    let revision_loaded = -1

    // One poll: the status, then the records if they are newer than what is shown.
    const poll = async (): Promise<void> => {
      const query = `?${board_query(session)}`
      const text = window.document.hidden ? null : await text_get(`${path_cleaned_status}${query}`)
      const parsed = text === null ? null : json_parse<CleanedStatus>(text)

      // The sketch hash changes with every stroke. Only what is shown counts as a change, so
      // drawing does not re-render the page at every poll.
      const key = parsed === null ? null : JSON.stringify({ ...parsed, sketch_hash: '' })
      const next = key === status_text ? null : parsed

      if (!stopped && next !== null) {
        status_set(next)

        // The status is remembered as seen only once its records are loaded too, so a failed
        // records request is tried again on the next poll.
        let complete = next.revision === revision_loaded

        if (!complete) {
          const full = await text_get(`${path_cleaned_json}${query}`)
          const loaded = full === null ? null : json_parse<CleanedDocument>(full)

          if (!stopped && loaded !== null) {
            revision_loaded = loaded.revision
            document_set(loaded)
            complete = loaded.revision === next.revision
          }
        }

        if (complete) status_text = key as string
      }

      if (!stopped) timer = window.setTimeout(() => void poll(), cleaned_poll_interval_ms)
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [generation, session])

  return { session, status, document, refresh }
}

function json_parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function text_get(pathname: string): Promise<string | null> {
  try {
    const response = await fetch(pathname, {
      cache: 'no-store',
      signal: AbortSignal.timeout(request_timeout_ms),
    })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

// A restore names the revision it saw as current, so it can never undo a newer publish.
export async function cleaned_restore(
  session: string,
  base_revision: number,
  revision: number,
): Promise<RestoreOutcome> {
  assert(revision < base_revision, 'a restore brings back an earlier revision')

  try {
    const response = await fetch(`${path_cleaned_restore}?${board_query(session)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision, revision }),
      signal: AbortSignal.timeout(request_timeout_ms),
    })

    if (response.ok) return 'restored'

    return response.status === 409 ? 'conflict' : 'failed'
  } catch {
    return 'failed'
  }
}
