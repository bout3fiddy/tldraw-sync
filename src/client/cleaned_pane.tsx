// The cleaned diagram: read-only, fitted to its pane, with where it came from and whether the
// sketch has changed since. Its records live in a local store of their own, never in the sync
// room, so nothing shown here can reach the human ink.

import { useEffect, useMemo, useState } from 'react'
import {
  createTLSchema,
  createTLStore,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  Tldraw,
  type Editor,
  type TLPage,
  type TLPageId,
  type TLRecord,
} from 'tldraw'
import { cleaned_page_id, type CleanedDocument } from '../shared/cleanup_types'
import type { CleanedProvenance, CleanedStatus } from '../shared/cleanup_types'
import { asset_urls, components_quiet } from './board_store'
import { cleaned_restore, type CleanedState, type RestoreOutcome } from './cleaned_state'
import { Notice } from './notice'
import { fit_start } from './stage_mount'

const restore_confirm_ms = 3000
const schema = createTLSchema()

export function CleanedPane({ cleaned }: { cleaned: CleanedState }) {
  const { status, document } = cleaned

  if (status === null) return <Notice text="Opening the cleaned diagram" />

  if (status.current === null || document === null || document.current === null) {
    return (
      <div className="cleaned">
        <p className="cleaned__empty">
          No cleaned diagram yet. Ask your agent to clean up the sketch: it runs “tldraw-sync
          cleanup-snapshot” and publishes the result here.
        </p>
      </div>
    )
  }

  return (
    <div className="cleaned">
      <CleanedCanvas key={document.revision} document={document} />
      <CleanedBar status={status} shown={document.current} onRestored={cleaned.refresh} />
    </div>
  )
}

// One store per revision: a new revision replaces the canvas whole, as it was published.
function CleanedCanvas({ document }: { document: CleanedDocument }) {
  const store = useMemo(() => {
    const page = PageRecordType.create({
      id: cleaned_page_id as TLPageId,
      name: 'Cleaned',
      index: 'a1' as TLPage['index'],
    })
    const records: TLRecord[] = [
      DocumentRecordType.create({ id: TLDOCUMENT_ID }),
      page,
      ...(document.records as TLRecord[]),
    ]
    const initialData = Object.fromEntries(records.map((record) => [record.id, record]))
    return createTLStore({ schema, initialData })
  }, [document])

  return (
    <Tldraw
      store={store}
      hideUi
      assetUrls={asset_urls}
      components={components_quiet}
      onMount={cleaned_mount}
    />
  )
}

function cleaned_mount(editor: Editor): () => void {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.updateInstanceState({ isReadonly: true })
  editor.setCameraOptions({ isLocked: true })
  return fit_start(editor)
}

type CleanedBarProps = { status: CleanedStatus; shown: CleanedProvenance; onRestored: () => void }

function CleanedBar({ status, shown, onRestored }: CleanedBarProps) {
  const published = new Date(shown.published_at_ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  const origin = shown.restored_from === null ? '' : `, restored from ${shown.restored_from}`
  return (
    <aside className="cleaned__bar" aria-label="Cleaned diagram details">
      <p className="cleaned__provenance">
        Revision {shown.revision}
        {origin} · {shown.agent} · from sketch {shown.source_hash.slice(0, 8)} · {published}
      </p>
      {shown.summary !== '' && <p className="cleaned__summary">{shown.summary}</p>}
      {status.stale && (
        <p className="cleaned__stale" role="status">
          The sketch has changed since this cleanup.
        </p>
      )}
      <RestoreButton status={status} onRestored={onRestored} />
    </aside>
  )
}

// Two taps, like Clear: the first arms, the second restores the most recent earlier revision.
function RestoreButton({ status, onRestored }: { status: CleanedStatus; onRestored: () => void }) {
  const [armed, armed_set] = useState(false)
  const [outcome, outcome_set] = useState<RestoreOutcome | null>(null)
  const previous = status.history.at(-1)

  useEffect(() => {
    if (!armed) return

    const timer = window.setTimeout(() => armed_set(false), restore_confirm_ms)
    return () => window.clearTimeout(timer)
  }, [armed])

  if (previous === undefined) return null

  const press = async () => {
    if (!armed) return armed_set(true)

    armed_set(false)
    const result = await cleaned_restore(status.revision, previous.revision)
    outcome_set(result)
    onRestored()
  }
  return (
    <div className="cleaned__restore">
      <button type="button" data-armed={armed} onClick={() => void press()}>
        {armed
          ? `Tap again to restore revision ${previous.revision}`
          : `Restore revision ${previous.revision}`}
      </button>
      {outcome === 'conflict' && <span>A newer cleanup arrived first; nothing was restored.</span>}
      {outcome === 'failed' && <span>The board did not answer; nothing was restored.</span>}
    </div>
  )
}
