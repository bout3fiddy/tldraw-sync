// The note to the agent: a slip of paper with a field and one send button, laid over the
// board as a modal dialog of the browser's own. A send is the sketch as it is and whatever
// was written, or the sketch alone: the words say what is wanted, so there is nothing else
// to choose. The slip shows no words of its own. What became of a request is told by the
// bell's list, so a failure never moves or resizes the field, and a draft is only ever
// cleared by a confirmed send.

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { Editor } from 'tldraw'
import { assert, AssertionError } from '../shared/assert'
import type { BoardEvent } from '../shared/whiteboard'
import { icon_send } from './icons'
import {
  draft_key,
  draft_length_max,
  draft_load,
  send_event,
  send_prepare,
  SendError,
  type Draft,
  type Send,
} from './notify_delivery'
import { unconfirmed_detail, type InboxPost } from './notify_inbox'

export const composer_id = 'agent-composer'
const hint_id = 'agent-composer-hint'

type Delivery = {
  editor: Editor | null
  online: boolean
  session: string
  token: string | null
  post: (action: InboxPost) => void
}

const storage_problem: InboxPost = {
  type: 'local',
  key: 'storage',
  subject: 'draft',
  state: 'refused',
  detail: 'Tab storage is unavailable. The note stays until this page closes.',
}
const length_problem: InboxPost = {
  type: 'local',
  key: 'draft',
  subject: 'draft',
  state: 'refused',
  detail: 'Note too long. Use up to 4000 characters.',
}

type Notes = ReturnType<typeof use_draft>
type LocalRow = Omit<Extract<InboxPost, { type: 'local' }>, 'type'>

function use_draft({ session, post }: Delivery) {
  const key = draft_key(session)
  const [initial] = useState(() => {
    try {
      return draft_load(key)
    } catch {
      return null
    }
  })
  const draft = useRef<Draft>(initial ?? { text: '', pending: null })
  const [text, text_set] = useState(draft.current.text)
  const edits = useRef(0)

  // Strict: a request that cannot be saved cannot be replayed, so it must not be sent.
  const save = (value: Draft) => {
    sessionStorage.setItem(key, JSON.stringify(value))
    draft.current = value
  }

  // Lenient: an edit is kept for this visit even when the tab cannot save it.
  const keep = (value: Draft) => {
    draft.current = value

    try {
      save(value)
    } catch {
      post(storage_problem)
    }
  }
  const change = (value: string) => {
    if (value.length > draft_length_max) return post(length_problem)

    edits.current++
    text_set(value)
    keep({ ...draft.current, text: value })
  }
  return { initial, draft, text, text_set, edits, save, keep, change }
}

// Reuse the unconfirmed request, or make one and save it before a byte is sent. A string is
// the reason nothing can be sent.
function request_stage(
  editor: Editor,
  draft: Draft,
  save: (value: Draft) => void,
): Send | string {
  if (draft.pending) return draft.pending

  let request: Send

  try {
    request = send_prepare(editor, draft.text)
  } catch (error) {
    if (error instanceof SendError) return error.message

    throw error
  }

  try {
    save({ ...draft, pending: request })
  } catch {
    return 'Tab storage is unavailable. Nothing was sent.'
  }

  return request
}

type Outcome =
  { ok: true; event: BoardEvent } | { ok: false; message: string } | { ok: null; message: string }

// `ok: null` means nobody knows whether the Mac has the request: it stays pending for a retry.
async function request_fly(session: string, token: string, request: Send): Promise<Outcome> {
  try {
    return await send_event(session, token, request)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    return { ok: null, message: error instanceof SendError ? error.message : unconfirmed_detail }
  }
}

// The draft to keep once the Mac has answered. The note is cleared only if the Mac confirmed
// exactly what is still written. A refused send has not happened: its words stay.
function draft_settled(draft: Draft, request: Send, confirmed: boolean, unedited: boolean): Draft {
  const clear = confirmed && unedited && draft.text === (request.text ?? '')
  return { text: clear ? '' : draft.text, pending: null }
}

function use_mounted() {
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

// One request in flight at a time. A second tap or key while it flies does nothing.
function use_send(props: Delivery, notes: Notes) {
  const { initial, draft, edits, save, keep, text_set } = notes
  const [busy, busy_set] = useState(false)
  const [refusals_count, refusals_count_set] = useState(0)
  const locked = useRef(false)
  const mounted = use_mounted()
  const refuse = (row: LocalRow) => {
    refusals_count_set((count) => count + 1)
    props.post({ type: 'local', ...row })
  }
  const settle = (request: Send, outcome: Outcome, unedited: boolean) => {
    const row = { key: request.request_id, subject: request.kind }

    if (outcome.ok === null) {
      return refuse({ ...row, state: 'unconfirmed', detail: outcome.message })
    }

    const next = draft_settled(draft.current, request, outcome.ok, unedited)
    keep(next)
    text_set(next.text)

    if (outcome.ok) return props.post({ type: 'confirm', key: row.key, event: outcome.event })

    refuse({ ...row, state: 'refused', detail: outcome.message })
  }
  const send = async () => {
    const { editor, token, online, session } = props

    if (!editor || !token || !online || locked.current || !initial) return

    locked.current = true
    busy_set(true)
    const generation = edits.current

    try {
      const request = request_stage(editor, draft.current, save)

      if (typeof request === 'string') {
        const row = { key: 'unsent', subject: 'sketch_notify' } as const
        return refuse({ ...row, state: 'refused', detail: request })
      }

      const { request_id: key, kind: subject } = request
      props.post({ type: 'local', key, subject, state: 'sending', detail: '' })
      const outcome = await request_fly(session, token, request)

      if (mounted.current) settle(request, outcome, edits.current === generation)
    } finally {
      locked.current = false
      busy_set(false)
    }
  }
  return { send, busy, refusals_count }
}

export type Composer = ReturnType<typeof use_composer>

export function use_composer(props: Delivery) {
  const notes = use_draft(props)
  const flight = use_send(props, notes)
  const pending = notes.draft.current.pending
  return {
    text: notes.text,
    change: notes.change,
    send: flight.send,
    disabled: !notes.initial || flight.busy || !props.editor || !props.token || !props.online,
    available: notes.initial !== null,
    waiting: pending !== null,
    retry: pending !== null && !flight.busy,
    refusals_count: flight.refusals_count,
  }
}

type Caret = [number, number, 'forward' | 'backward' | 'none']

// The note is shown as a modal dialog of the browser's own. While it is open the browser
// keeps every press and key from the page behind it, so a press beside the note can put it
// away and can never leave a mark on the sketch.
//
// Opening must not raise the keyboard: a bare send needs none. The browser hands a dialog's
// first focus to the first thing inside that can take it, which would be the field. Nothing
// inside can take it while the dialog opens, so it rests on the dialog itself, and the field
// waits for a tap of its own.
//
// Closing hides the field without unmounting it, so its text, caret and undo history stay.
// A browser that drops the caret of a hidden field gets it back here, without taking focus.
function use_modal(open: boolean) {
  const sheet = useRef<HTMLDialogElement>(null)
  const paper = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<Caret | null>(null)
  useLayoutEffect(() => {
    const dialog = sheet.current
    const slip = paper.current
    const element = field.current

    if (!dialog || !slip || !element) return

    if (!open) {
      caret.current = [element.selectionStart, element.selectionEnd, element.selectionDirection]

      if (dialog.open) dialog.close()

      return
    }

    if (!dialog.open) {
      slip.inert = true

      try {
        dialog.showModal()
      } finally {
        slip.inert = false
      }
    }

    const saved = caret.current

    if (saved === null) return

    if (element.selectionStart !== saved[0] || element.selectionEnd !== saved[1]) {
      element.setSelectionRange(saved[0], saved[1], saved[2])
    }
  }, [open])
  return { sheet, paper, field }
}

// The part of the screen that can be seen, told to the note as four lengths. The keyboard
// and a rotation change it; the page's own size stays as it was. The note is laid out
// against these, so it keeps its place in what is visible and no canvas is resized.
function use_visible(sheet: RefObject<HTMLElement>, open: boolean) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport
    const element = sheet.current

    if (!open || !viewport || !element) return

    const update = () => {
      element.style.setProperty('--visible-left', `${viewport.offsetLeft}px`)
      element.style.setProperty('--visible-top', `${viewport.offsetTop}px`)
      element.style.setProperty('--visible-width', `${viewport.width}px`)
      element.style.setProperty('--visible-height', `${viewport.height}px`)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [sheet, open])
}

// A send that did not go through: the slip shakes its head once, as it is refused. The reason
// is under the bell. The motion is played here, at the refusal, and not by a style the slip
// keeps: the browser plays such a style again each time the put-away note is shown, and the
// slip would shake, off its centre, at every opening. The shake is only for the open note
// that was refused: putting the note away ends it, so a note shown again, however soon, rests
// still at its centre, and a refusal heard while the note is away plays nothing.
const nudge_keyframes: Keyframe[] = [
  { transform: 'none', easing: 'ease-out' },
  { transform: 'translateX(-5px)', offset: 0.3, easing: 'ease-out' },
  { transform: 'translateX(4px)', offset: 0.7, easing: 'ease-out' },
  { transform: 'none' },
]
const nudge_ms = 260

function use_nudge(
  sheet: RefObject<HTMLDialogElement>,
  paper: RefObject<HTMLElement>,
  refusals_count: number,
  open: boolean,
) {
  assert(
    Number.isSafeInteger(refusals_count) && refusals_count >= 0,
    `refusals_count is a count: ${refusals_count}`,
  )

  const motion = useRef<Animation | null>(null)

  // `use_modal` has already shown or shut the dialog for this render, so `open` is current.
  useLayoutEffect(() => {
    const element = paper.current

    if (refusals_count === 0 || !element || sheet.current?.open !== true) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const played = element.animate(nudge_keyframes, { duration: nudge_ms })
    motion.current = played
    return () => {
      played.cancel()

      if (motion.current === played) motion.current = null
    }
  }, [sheet, paper, refusals_count])
  useLayoutEffect(() => {
    if (open || motion.current === null) return

    motion.current.cancel()
    motion.current = null
  }, [open])
}

// A press that travels this far is a stroke. A touch screen makes no click of a stroke, and
// every browser's allowance for a wavering tap is well under it.
const stroke_px_min = 24

type Press = { id: number; x: number; y: number }

// A press beside the note puts the note away. The browser gives such a press to the dialog
// itself and to nothing on the page, so it draws nothing. A tap is answered at its click,
// when the whole gesture is over: closing any sooner would let the browser hand that click
// to whatever lies under the finger. A stroke makes no click on a touch screen, so it is
// answered when the pen lifts. A press that began on the note, such as a selection dragged
// out past its edge, is the note's own and closes nothing.
function use_press_beside(dismiss: () => void) {
  const press = useRef<Press | null>(null)
  const beside = (event: { target: EventTarget; currentTarget: EventTarget }) =>
    event.target === event.currentTarget
  return {
    onPointerDown: (event: PointerEvent<HTMLDialogElement>) => {
      const { pointerId: id, clientX: x, clientY: y } = event
      press.current = beside(event) ? { id, x, y } : null
    },
    onPointerUp: (event: PointerEvent<HTMLDialogElement>) => {
      const from = press.current

      if (from === null || from.id !== event.pointerId) return

      if (!beside(event)) {
        press.current = null
        return
      }

      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) < stroke_px_min) return

      press.current = null
      dismiss()
    },
    onPointerCancel: () => {
      press.current = null
    },
    onClick: (event: MouseEvent<HTMLDialogElement>) => {
      const pressed = press.current !== null
      press.current = null

      if (pressed && beside(event)) dismiss()
    },
  }
}

type ComposerProps = {
  form: Composer
  open: boolean
  hint: string

  // The newest change not yet seen, for a screen reader: while the note is open the page
  // behind it, and the bell's own announcement with it, cannot be heard.
  news: string

  // Asks for the note to be put away.
  onDismiss: () => void

  // The note has been put away, by this page or by the browser itself.
  onClosed: () => void
}

export function NotifyComposer({ form, open, hint, news, onDismiss, onClosed }: ComposerProps) {
  const { sheet, paper, field } = use_modal(open)
  use_visible(sheet, open)
  use_nudge(sheet, paper, form.refusals_count, open)
  const beside = use_press_beside(onDismiss)
  const describe = form.retry ? 'Sends the pending request again.' : hint
  const key_down = (event: KeyboardEvent<HTMLElement>) => {

    // Typing a note must never reach the canvas shortcuts. Escape is heard by the page.
    event.stopPropagation()

    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return

    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return

    if (event.target !== field.current) return

    event.preventDefault()
    void form.send()
  }

  // The browser says so a moment after the dialog shuts. If the note was opened again in
  // that moment, the word is about the time before, and is let go.
  const closed = () => {
    if (sheet.current?.open === false) onClosed()
  }
  return (
    <dialog
      ref={sheet}
      id={composer_id}
      className="notepad"
      aria-label="Agent note"
      tabIndex={-1}
      onClose={closed}
      {...beside}
    >
      <div
        ref={paper}
        className="composer"
        onKeyDown={key_down}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <div className="composer__field">
          <div className="composer__mirror" aria-hidden="true">{`${form.text}​`}</div>
          <textarea
            ref={field}
            className="composer__input"
            rows={1}
            aria-label="Note to agent"
            placeholder={hint || 'Add a note (optional)'}
            value={form.text}
            disabled={!form.available}
            onChange={(event) => form.change(event.target.value)}
          />
        </div>
        <ComposerControls form={form} describe={describe} />
      </div>
      <p className="visually-hidden" role="status">
        {news}
      </p>
    </dialog>
  )
}

// One fixed target on the paper's bottom line: the send.
function ComposerControls({ form, describe }: { form: Composer; describe: string }) {
  return (
    <>
      <button
        type="button"
        className="composer__icon composer__send"
        aria-label="Send to agent"
        aria-describedby={describe === '' ? undefined : hint_id}
        title="Send to agent"
        disabled={form.disabled}
        onClick={() => void form.send()}
      >
        <span className="composer__plate">{icon_send}</span>
      </button>
      <span id={hint_id} className="visually-hidden">
        {describe}
      </span>
    </>
  )
}
