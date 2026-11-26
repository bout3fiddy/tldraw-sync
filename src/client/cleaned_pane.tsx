// The cleaned diagram: read-only, fitted to its pane, with the agent's description of it and
// whether the sketch has changed since. Its records live in a local store of their own, never
// in the sync room, so nothing shown here can reach the human ink. Bringing back an earlier
// revision is the agent's job, through `tldraw-sync cleanup-restore`.

import { useMemo } from 'react'
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
import { asset_urls, components_quiet } from './board_store'
import type { CleanedState } from './cleaned_state'
import { Notice } from './notice'
import { fit_inset_cleaned_px, fit_start } from './stage_mount'

const schema = createTLSchema()

export function CleanedPane({ cleaned }: { cleaned: CleanedState }) {
  const { status, document } = cleaned

  if (status === null) return <Notice text="Opening the agent canvas" />

  if (status.linked && !document) return <Notice text="Loading the agent canvas" />

  if (status.current === null || document === null || document.current === null) {
    return (
      <div className="cleaned">
        <p className="cleaned__empty">
          {status.linked ? 'No agent diagram yet. Turn on Interpret to request a faithful copy.' :
            'No cleaned diagram yet. Ask your agent to clean up the sketch.'}
        </p>
      </div>
    )
  }

  // A published canvas with nothing on it: the faithful copy of an empty sketch. There is
  // nothing for tldraw to fit or draw, so the pane says so in words.
  if (!document.records.some((record) => record.typeName === 'shape')) {
    return (
      <div className="cleaned">
        <p className="cleaned__empty">
          {status.linked ? 'The agent canvas is empty.' : 'The cleaned diagram is empty.'}
        </p>
        <CleanedCaption summary={document.current.summary} stale={status.stale} />
      </div>
    )
  }

  return (
    <div className="cleaned">
      <CleanedCanvas key={document.revision} document={document} />
      <CleanedCaption summary={document.current.summary} stale={status.stale} />
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
  return fit_start(editor, fit_inset_cleaned_px)
}

// The one thing written over the diagram: what the agent says it shows, and a line when the
// sketch has moved on since. Nothing is shown when there is nothing to say.
function CleanedCaption({ summary, stale }: { summary: string; stale: boolean }) {
  if (summary === '' && !stale) return null

  return (
    <aside className="caption" aria-label="About this diagram">
      {summary !== '' && <p className="caption__summary">{summary}</p>}
      {stale && (
        <p className="caption__stale" role="status">
          The sketch has changed since this cleanup.
        </p>
      )}
    </aside>
  )
}
