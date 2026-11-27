// The Agent canvas: read-only, initially fitted to its pane, then free to navigate.
// Its records live in a local store of their own, never
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

  // The linked viewer shows the drawing surface even when its published revision is empty.
  if (!status.linked && !document.records.some((record) => record.typeName === 'shape')) {
    return (
      <div className="cleaned">
        <p className="cleaned__empty">
          The cleaned diagram is empty.
        </p>
      </div>
    )
  }

  return (
    <div className={status.linked ? 'cleaned cleaned--agent' : 'cleaned'}>
      <CleanedCanvas
        key={`${document.revision}:${status.linked}`}
        document={document}
        grid={status.linked}
      />
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
function CleanedCanvas({ document, grid }: { document: CleanedDocument; grid: boolean }) {
  const store = useMemo(() => canvas_store(document.records), [document])

  return (
    <Tldraw
      store={store}
      hideUi
      assetUrls={asset_urls}
      components={components_quiet}
      onMount={(editor) => cleaned_mount(editor, grid)}
    />
  )
}

function cleaned_mount(editor: Editor, grid: boolean): () => void {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.updateInstanceState({ isReadonly: true, isGridMode: grid })
  editor.setCurrentTool('hand')

  // Even distant shapes must fit together in a narrow pane. Allow the scene's longest
  // dimension to shrink to one pixel without losing tldraw's normal navigation steps.
  const bounds = editor.getCurrentPageBounds()
  const steps = editor.getCameraOptions().zoomSteps

  if (bounds) {
    const minimum = 1 / Math.max(1, bounds.w, bounds.h)

    if (minimum < steps[0]!) editor.setCameraOptions({ zoomSteps: [minimum, ...steps] })
  }

  return fit_start(editor, fit_inset_cleaned_px, 0)
}
