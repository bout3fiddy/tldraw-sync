// The Agent canvas: read-only, fitted to its pane, with the agent's description of it and
// whether the sketch has changed since. Its records live in a local store of their own, never
// in the sync room, so nothing shown here can reach the human ink. They are native tldraw
// records, shown as they were published, whatever format they were published in. Bringing
// back an earlier revision is the agent's job, through `tldraw-sync cleanup-restore`.

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
  type TLStore,
} from 'tldraw'
import { cleaned_page_id, type CanvasRecord, type CleanedDocument } from '../shared/canvas_types'
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
          {status.linked
            ? 'Nothing on the agent canvas yet. Send your sketch with a note to ask for it.'
            : 'No cleaned diagram on this board.'}
        </p>
      </div>
    )
  }

  // A published canvas with nothing on it. There is nothing for tldraw to fit or draw, so the
  // pane says so in words.
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

// A store holding one canvas and nothing else: its page and the records as published. The
// pane shows a revision from one, and the stage renders a draft from one, so a draft is drawn
// exactly as its publish would be shown.
export function canvas_store(records: readonly CanvasRecord[]): TLStore {
  const page = PageRecordType.create({
    id: cleaned_page_id as TLPageId,
    name: 'Agent canvas',
    index: 'a1' as TLPage['index'],
  })
  const all: TLRecord[] = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    page,
    ...(records as TLRecord[]),
  ]
  const initialData = Object.fromEntries(all.map((record) => [record.id, record]))
  return createTLStore({ schema, initialData })
}

// One store per revision: a new revision replaces the canvas whole, as it was published.
function CleanedCanvas({ document }: { document: CleanedDocument }) {
  const store = useMemo(() => canvas_store(document.records), [document])

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

// The one thing written over the canvas: what the agent says it shows, and a line when the
// sketch has moved on since. Nothing is shown when there is nothing to say.
function CleanedCaption({ summary, stale }: { summary: string; stale: boolean }) {
  if (summary === '' && !stale) return null

  return (
    <aside className="caption" aria-label="About this canvas">
      {summary !== '' && <p className="caption__summary">{summary}</p>}
      {stale && (
        <p className="caption__stale" role="status">
          The sketch has changed since this was made.
        </p>
      )}
    </aside>
  )
}
