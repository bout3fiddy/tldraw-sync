import { useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { replace_sketch } from './replace_sketch'
import type { BoardEvent } from '../shared/whiteboard'
import { use_pair_token } from './board_pair'
import type { CleanedState } from './cleaned_state'
import { NotifyComposer } from './notify_composer'
import type { View } from './views'

type Props = {
  editor: Editor | null
  session: string
  view: View
  cleaned: CleanedState
  online: boolean
  showSketch: () => void
}

// Move only the rail when the keyboard overlays the layout viewport; do not resize the editor.
function use_keyboard_inset() {
  const rail = useRef<HTMLElement>(null)
  useEffect(() => {
    const viewport = window.visualViewport

    if (!viewport) return

    const update = () => {
      const bottom = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      rail.current?.style.setProperty('--keyboard', `${bottom}px`)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return rail
}

export function AgentActions(props: Props) {
  const { view, session, editor, online, cleaned } = props
  const token = use_pair_token(session)
  const [notice, setNotice] = useState('')
  const [sent, setSent] = useState<BoardEvent | null>(null)
  const rail = use_keyboard_inset()
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
  const upgrade =
    cleaned.status && cleaned.status.protocol !== 2
      ? 'Upgrade and restart the Mac board before sending.'
      : ''
  const feedback = online
    ? notice || upgrade || (!token ? 'Scan the Mac stage QR to send requests.' : state)
    : 'Offline. Reconnect before sending.'
  return (
    <footer ref={rail} className="agent-rail composer" aria-label="Whiteboard actions">
      <NotifyComposer
        editor={editor}
        token={token}
        session={session}
        online={online}
        confirm={setSent}
        feedback={setNotice}
      />
      {view !== 'sketch' && (
        <button disabled={!online || !cleaned.document?.current} onClick={replace}>
          Replace sketchboard
        </button>
      )}
      <span role="status">{feedback}</span>
    </footer>
  )
}
