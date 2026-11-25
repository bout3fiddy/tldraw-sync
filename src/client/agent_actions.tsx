import { useRef, useState } from 'react'
import type { Editor, TLRecord } from 'tldraw'
import { board_query } from '../shared/board_session'
import { cleaned_page_id, type CleanedDocument } from '../shared/cleanup_types'
import { document_hash } from '../shared/document_hash'
import {
  layers,
  whiteboard_path,
  type BoardEvent,
  type EventKind,
  type Layer,
} from '../shared/whiteboard'
import { use_pair_token } from './board_pair'
import type { CleanedState } from './cleaned_state'
import type { View } from './views'

export function LayerChoice({ layer, choose }: { layer: Layer; choose: (v: Layer) => void }) {
  return (
    <div role="group" aria-label="Agent layer" className="layer-choice">
      {layers.map((item) => (
        <button key={item} aria-pressed={layer === item} onClick={() => choose(item)}>
          {item === 'ideas' ? 'Ideas' : 'Interpretation'}
        </button>
      ))}
    </div>
  )
}

type Props = {
  editor: Editor | null
  session: string
  view: View
  cleaned: CleanedState
  layer: Layer
  choose: (layer: Layer) => void
  online: boolean
  showSketch: () => void
}

export function AgentActions(props: Props) {
  const { view, session, editor, online, cleaned, layer, choose } = props
  const token = use_pair_token(session)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState<BoardEvent | null>(null)
  const sending = useRef(false)
  const send = async (kind: EventKind) => {
    if (!editor || !token || sending.current || !online) return

    sending.current = true
    setPending(true)
    setNotice('Checking ink…')

    try {
      const response = await send_event(editor, session, token, kind)
      const event = await response.json()

      if (response.ok) setSent(event)

      setNotice(response.ok ? '' : (event.message ?? 'Not sent. Tap again to retry.'))
    } catch {
      setNotice('No confirmation. Check request status before retrying.')
    } finally {
      sending.current = false
      setPending(false)
    }
  }
  const replace = () => {
    if (!editor || !cleaned.document?.current || !online) return

    const ok = replace_sketch(editor, cleaned.document)
    setNotice(ok ? 'Sketch replaced. Undo restores your ink.' : 'Could not replace the sketch.')

    if (ok) props.showSketch()
  }
  const last = cleaned.status?.last_event
  const event = sent && (!last || last.created_at_ms < sent.created_at_ms) ? sent : last
  const state = event
    ? `${event.kind === 'sketch_notify' ? 'Notification' : 'Interpretation'}: ` +
      `${event.state}${event.message ? ` · ${event.message}` : ''}`
    : 'Ready to send'
  const feedback = online
    ? notice || (!token ? 'Scan the Mac stage QR to send requests.' : state)
    : 'Offline. Reconnect before sending.'
  const disabled = pending || !online || !token || !editor
  return (
    <footer className="agent-rail" aria-label="Whiteboard actions">
      {view !== 'sketch' && <LayerChoice layer={layer} choose={choose} />}
      {view === 'sketch' ? (
        <>
          <button disabled={disabled} onClick={() => void send('sketch_notify')}>
            Notify agent
          </button>
          <button disabled={disabled} onClick={() => void send('interpret_request')}>
            Interpret sketchboard
          </button>
        </>
      ) : (
        <button disabled={!online || !cleaned.document?.current} onClick={replace}>
          Replace sketchboard
        </button>
      )}
      <span role="status">{feedback}</span>
    </footer>
  )
}

async function send_event(editor: Editor, session: string, token: string, kind: EventKind) {
  const types = editor.store.scopedTypes.document
  const records = editor.store.allRecords().filter((r) => types.has(r.typeName))
  const body = JSON.stringify({ kind, sketch_hash: document_hash(records) })
  return fetch(`${whiteboard_path}event?${board_query(session)}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  })
}

// tldraw's paste transaction remaps shape ids, parent ids and both ends of each binding. Make
// deletion and paste a single undo stop; roll back on migration errors or a rejected paste.
function replace_sketch(editor: Editor, document: CleanedDocument): boolean {
  const records = document.records as TLRecord[]
  const shapes = records.filter((r) => r.typeName === 'shape')
  const bindings = records.filter((r) => r.typeName === 'binding')

  if (!shapes.length || shapes.length > editor.options.maxShapesPerPage) return false

  const rootShapeIds = shapes.filter((s) => s.parentId === cleaned_page_id).map((s) => s.id)

  if (!rootShapeIds.length) return false

  const mark = editor.markHistoryStoppingPoint('replace sketchboard')

  try {
    editor.run(() => {
      editor.selectNone().deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.putContentOntoCurrentPage(
        { shapes, bindings, rootShapeIds, assets: [], schema: editor.store.schema.serialize() },
        { preservePosition: true },
      )

      if (editor.getCurrentPageShapeIds().size !== shapes.length) throw Error('Incomplete paste')
    })
    editor.markHistoryStoppingPoint()
    editor.setCurrentTool('select')
    editor.zoomToFit()
    return true
  } catch {
    editor.bailToMark(mark)
    return false
  }
}
