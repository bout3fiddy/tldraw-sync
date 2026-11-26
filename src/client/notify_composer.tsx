// The note to the agent: a capsule with a field, the Interpret switch and one send button.
// It says nothing itself. What became of a request is told by the bell's list, so a failure
// never moves or resizes the field, and a draft is only ever cleared by a confirmed send.

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Editor } from 'tldraw'
import { AssertionError } from '../shared/assert'
import type { BoardEvent } from '../shared/whiteboard'
import { icon_interpret, icon_send } from './icons'
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
  interpret: boolean,
  save: (value: Draft) => void,
): Send | string {
  if (draft.pending) return draft.pending

  let request: Send

  try {
    request = send_prepare(editor, interpret ? 'interpret_request' : 'sketch_notify', draft.text)
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
  | { ok: true; event: BoardEvent }
  | { ok: false; message: string }
  | { ok: null; message: string }

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
// exactly what is still written. Interpret is for one send; a refused send has not happened.
function draft_settled(draft: Draft, request: Send, confirmed: boolean, unedited: boolean): Draft {
  const clear = confirmed && unedited && draft.text === (request.text ?? '')
  return {
    text: clear ? '' : draft.text,
    pending: null,
    interpret: confirmed ? false : draft.interpret === true,
  }
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
  const [interpret, interpret_set] = useState(
    () => draft.current.interpret ?? draft.current.pending?.kind === 'interpret_request',
  )
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

    const next = draft_settled({ ...draft.current, interpret }, request, outcome.ok, unedited)
    keep(next)
    text_set(next.text)
    interpret_set(next.interpret === true)

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
      const request = request_stage(editor, draft.current, interpret, save)

      if (typeof request === 'string') {
        const subject = interpret ? 'interpret_request' : 'sketch_notify'
        return refuse({ key: 'unsent', subject, state: 'refused', detail: request })
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
  return { send, busy, interpret, interpret_set, refusals_count }
}

export type Composer = ReturnType<typeof use_composer>

export function use_composer(props: Delivery) {
  const notes = use_draft(props)
  const flight = use_send(props, notes)
  const pending = notes.draft.current.pending
  const interpret_choose = (value: boolean) => {
    flight.interpret_set(value)
    notes.keep({ ...notes.draft.current, interpret: value })
  }
  return {
    text: notes.text,
    change: notes.change,
    send: flight.send,
    interpret: pending ? pending.kind === 'interpret_request' : flight.interpret,
    interpret_choose,

    // An unconfirmed request is sent again as it was: its kind is no longer a choice.
    interpret_locked: pending !== null || flight.busy,
    disabled: !notes.initial || flight.busy || !props.editor || !props.token || !props.online,
    available: notes.initial !== null,
    waiting: pending !== null,
    retry: pending !== null && !flight.busy,
    refusals_count: flight.refusals_count,
  }
}

// Closing hides the field without unmounting it, so its text, caret and undo history stay.
// A browser that drops the caret of a hidden field gets it back here, without taking focus.
function use_caret(open: boolean) {
  const field = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<[number, number, 'forward' | 'backward' | 'none'] | null>(null)
  useLayoutEffect(() => {
    const element = field.current

    if (!element) return

    if (!open) {
      caret.current = [element.selectionStart, element.selectionEnd, element.selectionDirection]
      return
    }

    const saved = caret.current

    if (saved === null) return

    if (element.selectionStart !== saved[0] || element.selectionEnd !== saved[1]) {
      element.setSelectionRange(saved[0], saved[1], saved[2])
    }
  }, [open])
  return field
}

type ComposerProps = { form: Composer; open: boolean; hint: string }

export function NotifyComposer({ form, open, hint }: ComposerProps) {
  const field = use_caret(open)
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
  const nudge = form.refusals_count === 0 ? undefined : form.refusals_count % 2 ? 'a' : 'b'
  return (
    <div
      id={composer_id}
      className="composer__capsule"
      hidden={!open}
      data-nudge={nudge}
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
  )
}

// Two fixed targets on the capsule's bottom line: the switch for the next send, and the send.
function ComposerControls({ form, describe }: { form: Composer; describe: string }) {
  return (
    <>
      <button
        type="button"
        role="switch"
        className="composer__icon composer__interpret"
        aria-checked={form.interpret}
        aria-label="Interpret"
        title="Interpret: ask for a faithful, typeset copy with the next send"
        disabled={form.interpret_locked}
        onClick={() => form.interpret_choose(!form.interpret)}
      >
        <span className="composer__plate">{icon_interpret}</span>
      </button>
      <button
        type="button"
        className="composer__icon composer__send"
        aria-label="Notify agent"
        aria-describedby={describe === '' ? undefined : hint_id}
        title="Notify agent"
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
