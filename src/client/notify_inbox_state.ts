// One board's request rows in this tab: restored when the board opens, saved as they change,
// and brought up to date from the status the page already polls. Nothing here opens the list.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardEvent } from '../shared/whiteboard'
import { draft_pending_key } from './notify_delivery'
import { inbox_apply, inbox_restore, type InboxEntry, type InboxPost } from './notify_inbox'

export type Inbox = {
  entries: readonly InboxEntry[]
  open: boolean
  open_set: (open: boolean) => void
  post: (action: InboxPost) => void
}

// `loaded` is false until the Mac's status first arrives; `latest` is its newest request.
export function use_inbox(session: string, loaded: boolean, latest: BoardEvent | null): Inbox {
  const key = `tldraw-sync.inbox.${session}`
  const [entries, entries_set] = useState<readonly InboxEntry[]>(() =>
    inbox_restore(storage_read(key), draft_pending_key(session)),
  )
  const [open, open_state] = useState(false)

  // Read at the moment a change arrives, which may be between renders.
  const attending = useRef(false)
  const observed = useRef(false)

  const post = useCallback((action: InboxPost) => {
    const stamped = { ...action, now_ms: Date.now(), silent: attending.current }
    entries_set((prior) => inbox_apply(prior, stamped))
  }, [])

  const open_set = useCallback((next: boolean) => {
    attending.current = next
    open_state(next)

    if (next) entries_set((prior) => inbox_apply(prior, { type: 'read' }))
  }, [])

  useEffect(() => {
    if (!loaded) return

    // What the Mac already held when the page opened is history. Whatever follows is news.
    const baseline = !observed.current
    observed.current = true

    if (latest === null) return

    const now_ms = Date.now()
    const silent = attending.current
    entries_set((prior) =>
      inbox_apply(prior, { type: 'observe', event: latest, baseline, now_ms, silent }),
    )
  }, [loaded, latest])

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(entries))
    } catch {
      // The rows are a convenience: without storage they last as long as the page.
    }
  }, [key, entries])

  return { entries, open, open_set, post }
}

function storage_read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
