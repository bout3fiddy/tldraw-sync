// The iPad's dealings with the agent. The note is closed until asked for and never takes the
// focus by itself; what became of each request is listed apart from it, under the bell.
// Replacing the sketch stays a separate, human-only step.

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from 'tldraw'
import { AgentDock } from './agent_dock'
import { use_pair_token } from './board_pair'
import type { CleanedState } from './cleaned_state'
import { Notice } from './notice'
import { NotifyComposer, use_composer } from './notify_composer'
import { use_inbox } from './notify_inbox_state'
import { replace_sketch } from './replace_sketch'
import type { View } from './views'

type Props = {
  editor: Editor | null
  session: string
  view: View
  cleaned: CleanedState
  online: boolean

  // The place beside the sketch's drawing tools, once the sketch has made it.
  tools: HTMLElement | null
  showSketch: () => void
}

// Long enough to read one line; short enough not to sit on the board.
const notice_ms = 4000

// Move only the band when the keyboard overlays the layout viewport; do not resize the editor.
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

// A line about something the person just did, shown for a moment and then taken away.
function use_notice(): [string, (text: string) => void] {
  const [notice, notice_set] = useState('')
  useEffect(() => {
    if (notice === '') return

    const timer = window.setTimeout(() => notice_set(''), notice_ms)
    return () => window.clearTimeout(timer)
  }, [notice])
  return [notice, notice_set]
}

// Only the person drawing replaces the sketch, in one step that Undo takes back.
function use_replace({ editor, cleaned, online, showSketch }: Props) {
  const [notice, notice_show] = use_notice()
  const replace = () => {
    if (!editor || !cleaned.document?.current || !online) return

    const ok = replace_sketch(editor, cleaned.document)
    notice_show(ok ? 'Sketch replaced. Undo restores your ink.' : 'Could not replace the sketch.')

    if (ok) showSketch()
  }
  return { notice, replace, possible: online && !!cleaned.document?.current }
}

type Readiness = { online: boolean; upgrade: boolean; paired: boolean; available: boolean }

// Why nothing can be sent yet, or '' when it can. Shown where the note would be typed, and
// at the head of the bell's list.
function ready_hint({ online, upgrade, paired, available }: Readiness): string {
  if (!online) return 'Offline. Reconnect before sending.'

  if (upgrade) return 'Upgrade and restart the Mac board before sending.'

  if (!paired) return 'Scan the Mac stage QR to send requests.'

  return available ? '' : 'Cannot read this tab’s draft. Check board status.'
}

// Escape puts away what is open, wherever the focus happens to be: on the button just
// pressed, in the note, on the canvas, or nowhere, as on an iPad, where a tap moves no focus.
// tldraw would take the same key to mean "put the pen down", so it is told the key is spoken
// for. The list of boards, and a label being edited on the sketch, keep their own Escape.
function use_escape(active: boolean, editor: Editor | null, dismiss: () => void) {
  const latest = useRef(dismiss)
  latest.current = dismiss
  useEffect(() => {
    if (!active) return

    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return

      const boards = event.target instanceof Element && event.target.closest('.rail') !== null

      if (boards || (editor !== null && editor.getEditingShapeId() !== null)) return

      editor?.markEventAsHandled(event)
      event.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [active, editor])
}

type Opened = {
  editor: Editor | null
  listing: boolean
  list_set: (open: boolean) => void
  band: RefObject<HTMLElement>
}

// The note is open or closed; so is the list under the bell. Closing either hands the focus
// it held back to its own button, and one Escape closes one of them, the list first.
function use_opened({ editor, listing, list_set, band }: Opened) {
  const [composing, composing_set] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const bell = useRef<HTMLButtonElement>(null)

  // Closing the note puts the keyboard away.
  const compose_close = () => {
    const active = document.activeElement

    if (active instanceof HTMLElement && band.current?.contains(active)) {
      active.blur()
      trigger.current?.focus()
    }

    composing_set(false)
  }
  const list_close = () => {
    const active = document.activeElement
    const within = active instanceof Element && active.closest('.inbox') !== null
    list_set(false)

    if (within) bell.current?.focus()
  }
  use_escape(composing || listing, editor, listing ? list_close : compose_close)
  const compose_toggle = () => (composing ? compose_close() : composing_set(true))
  return { composing, compose_toggle, trigger, bell }
}

export function AgentActions(props: Props) {
  const { view, session, editor, online, cleaned } = props
  const token = use_pair_token(session)
  const latest = cleaned.status?.last_event ?? null
  const inbox = use_inbox(session, cleaned.status !== null, latest)
  const form = use_composer({ editor, online, session, token, post: inbox.post })
  const { notice, replace, possible } = use_replace(props)
  const band = use_keyboard_inset()
  const opened = use_opened({ editor, listing: inbox.open, list_set: inbox.open_set, band })
  const { composing } = opened
  const upgrade = cleaned.status !== null && cleaned.status.protocol !== 2
  const hint = ready_hint({ online, upgrade, paired: token !== null, available: form.available })
  return (
    <>
      <AgentDock
        home={view === 'cleaned' ? 'band' : props.tools}
        composing={composing}
        draft={form.text !== '' || form.waiting}
        entries={inbox.entries}
        listing={inbox.open}
        hint={hint}
        latest_event_id={latest?.id ?? null}
        trigger={opened.trigger}
        bell={opened.bell}
        onCompose={opened.compose_toggle}
        onList={inbox.open_set}
      />
      <footer
        ref={band}
        className="composer"
        aria-label="Whiteboard actions"
        hidden={!composing && view === 'sketch'}
      >
        <NotifyComposer form={form} open={composing} hint={hint} />
        {view !== 'sketch' && (
          <button
            type="button"
            className="composer__replace"
            disabled={!possible}
            onClick={replace}
          >
            Replace sketchboard
          </button>
        )}
      </footer>
      {notice !== '' && <Notice floating text={notice} />}
    </>
  )
}
