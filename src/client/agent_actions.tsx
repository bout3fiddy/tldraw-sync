// The iPad's dealings with the agent. The note is closed until asked for, opens over the
// board without taking the keyboard, and is put away by a press beside it; what became of
// each request is listed apart from it, under the bell. Replacing the sketch stays a
// separate, human-only step, offered at the head of the Agent canvas it copies from.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from 'tldraw'
import { AgentDock, inbox_news } from './agent_dock'
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

  // The head of the Agent canvas, while that canvas is on screen.
  head: HTMLElement | null
  showSketch: () => void
}

// Long enough to read one line; short enough not to sit on the board.
const notice_ms = 4000

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

// Escape puts away what is open, wherever the focus happens to be: in the note, on its
// paper, on the bell, on the canvas, or nowhere, as on an iPad, where a tap moves no focus.
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
}

// The note is open or closed; so is the list under the bell. One of them is open at a time:
// the note lies over everything else, so asking for it shuts the list. Closing either hands
// the focus back to its own button.
function use_opened({ editor, listing, list_set }: Opened) {
  const [composing, composing_set] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const compose_open = () => {
    list_set(false)
    composing_set(true)
  }
  const compose_close = () => composing_set(false)

  // The note is shut and the page behind it can be pressed again. The button that opened it
  // takes the focus the note held: a button raises no keyboard, so the keyboard goes too.
  const compose_closed = () => {
    composing_set(false)
    trigger.current?.focus({ preventScroll: true })
  }
  const list_close = () => {
    const active = document.activeElement
    const within = active instanceof Element && active.closest('.inbox') !== null
    list_set(false)

    if (within) bell.current?.focus()
  }
  use_escape(composing || listing, editor, composing ? compose_close : list_close)
  return { composing, compose_open, compose_close, compose_closed, trigger, bell }
}

export function AgentActions(props: Props) {
  const { view, session, editor, online, cleaned } = props
  const token = use_pair_token(session)
  const latest = cleaned.status?.last_event ?? null
  const inbox = use_inbox(session, cleaned.status !== null, latest)
  const form = use_composer({ editor, online, session, token, post: inbox.post })
  const { notice, replace, possible } = use_replace(props)
  const opened = use_opened({ editor, listing: inbox.open, list_set: inbox.open_set })
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
        onCompose={opened.compose_open}
        onList={inbox.open_set}
      />
      <NotifyComposer
        form={form}
        open={composing}
        hint={hint}
        news={inbox_news(inbox.entries)}
        onDismiss={opened.compose_close}
        onClosed={opened.compose_closed}
      />
      {props.head !== null &&
        createPortal(
          <button type="button" className="cleaned__replace" disabled={!possible} onClick={replace}>
            Replace sketchboard
          </button>,
          props.head,
        )}
      {notice !== '' && <Notice floating text={notice} />}
    </>
  )
}
