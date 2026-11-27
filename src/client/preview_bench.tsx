// The stage's workbench for drafts. An agent can ask to see a scene before it publishes it.
// The board hands the stage the records that publish would save; the stage draws them here,
// out of sight, with tldraw itself, and sends the picture back. Nothing of a draft is shown
// to anyone or written anywhere: the bench is laid out but never visible, takes no press, and
// is gone once its picture is sent.
//
// The stage asks the board for a draft on a short, fixed interval, one request at a time.
// Only a stage on the Mac itself is given one.

import { useEffect, useMemo, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import { assert } from '../shared/assert'
import { board_query } from '../shared/board_session'
import type { CanvasRecord, PreviewJob } from '../shared/canvas_types'
import {
  canvas_records_count_max,
  path_preview_json,
  path_preview_png,
  preview_poll_interval_ms,
  upload_attempts_count_max,
  upload_retry_delay_ms,
} from '../shared/constants'
import { asset_urls, components_quiet } from './board_store'
import { canvas_store } from './cleaned_pane'
import { canvas_image } from './stage_mount'

type Draft = { id: string; records: CanvasRecord[] }

const request_timeout_ms = 5000
const draft_id_pattern = /^[0-9a-f-]{36}$/

export function PreviewBench({ session }: { session: string }) {
  const draft = use_draft(session)

  if (draft === null) return null

  return <Bench key={draft.id} session={session} draft={draft} />
}

function Bench({ session, draft }: { session: string; draft: Draft }) {
  const store = useMemo(() => canvas_store(draft.records), [draft])
  const mount = (editor: Editor) => bench_mount(editor, session, draft.id)
  return (
    <div className="bench" aria-hidden="true" data-draft={draft.id}>
      <Tldraw
        store={store}
        hideUi
        autoFocus={false}
        assetUrls={asset_urls}
        components={components_quiet}
        onMount={mount}
      />
    </div>
  )
}

// The draft waiting to be drawn, if there is one. It stays until the board says it has its
// picture, or has another draft, or none.
function use_draft(session: string): Draft | null {
  const [draft, draft_set] = useState<Draft | null>(null)

  useEffect(() => {
    let stopped = false
    let timer = 0
    let held: string | null = null

    const poll = async (): Promise<void> => {
      const have = held === null ? '' : `&have=${held}`
      const job = await job_get(`${path_preview_json}?${board_query(session)}${have}`)

      if (!stopped && job !== null && job.id !== held) {
        const next = job_draft(job)

        // An id without records is a draft this page was not sent: it has nothing to draw.
        held = next?.id ?? null
        draft_set(next)
      }

      if (!stopped) timer = window.setTimeout(() => void poll(), preview_poll_interval_ms)
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [session])

  return draft
}

// What the board answered, checked before a canvas is made from it.
function job_draft(job: PreviewJob): Draft | null {
  const { id, records } = job

  if (id === null || !draft_id_pattern.test(id) || !Array.isArray(records)) return null

  if (records.length === 0 || records.length > canvas_records_count_max) return null

  return { id, records }
}

async function job_get(pathname: string): Promise<PreviewJob | null> {
  try {
    const response = await fetch(pathname, {
      cache: 'no-store',
      signal: AbortSignal.timeout(request_timeout_ms),
    })
    return response.ok ? ((await response.json()) as PreviewJob) : null
  } catch {
    return null
  }
}

// Draws the draft once its lettering is loaded, and sends the picture. A failed attempt is
// tried again a bounded number of times; a draft replaced meanwhile is simply left.
function bench_mount(editor: Editor, session: string, id: string): () => void {
  assert(draft_id_pattern.test(id), 'a draft has an id')
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.updateInstanceState({ isReadonly: true })
  let stopped = false

  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < upload_attempts_count_max && !stopped; attempt += 1) {
      if (await draft_send(editor, session, id)) return

      await new Promise((resolve) => window.setTimeout(resolve, upload_retry_delay_ms))
    }
  }
  void run()
  return () => {
    stopped = true
  }
}

async function draft_send(editor: Editor, session: string, id: string): Promise<boolean> {
  try {
    await editor.fonts.loadRequiredFontsForCurrentPage()
    const bytes = await canvas_image(editor)

    if (bytes === null) return false

    const response = await fetch(`${path_preview_png}?${board_query(session)}&id=${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(request_timeout_ms),
    })

    // A draft replaced meanwhile is refused: there is nothing left to try again for.
    return response.ok || response.status === 409
  } catch {
    return false
  }
}
