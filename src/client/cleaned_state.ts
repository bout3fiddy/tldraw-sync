// The Agent canvas as a page sees it. A page asks for the small status on a fixed interval,
// one request at a time, and fetches the records only when the revision changes. The status
// also says whether the sketch has moved on since the diagram was made from it.

import { useEffect, useState } from 'react'
import { board_query } from '../shared/board_session'
import type { CleanedDocument, CleanedStatus } from '../shared/canvas_types'
import {
  cleaned_poll_interval_ms,
  path_cleaned_json,
  path_cleaned_status,
} from '../shared/constants'

import type { BoardEvent } from '../shared/whiteboard'

type LayerStatus = CleanedStatus & {
  protocol?: number; linked: boolean; last_event: BoardEvent | null
}
export type CleanedState = {
  readonly status: LayerStatus | null
  readonly document: CleanedDocument | null
}

const request_timeout_ms = 5000

export function use_cleaned(session: string): CleanedState {
  const [status, status_set] = useState<LayerStatus | null>(null)
  const [loaded, document_set] = useState<CleanedDocument | null>(null)

  useEffect(() => {
    let stopped = false
    let timer = 0
    let status_text = ''
    let revision_loaded = -1

    // One poll: the status, then the records if they are newer than what is shown.
    const poll = async (): Promise<void> => {
      const query = `?${board_query(session)}&layer=canvas`
      const text = window.document.hidden ? null : await text_get(`${path_cleaned_status}${query}`)
      const parsed = text === null ? null : json_parse<LayerStatus>(text)

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
  }, [session])

  const document = loaded?.revision === status?.revision ? loaded : null
  return { status, document }
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
