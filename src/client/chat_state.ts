// A board's chat as one page holds it: the conversation read from the Mac with the pairing, a
// mark of the answers this device has seen, and the draft with its one request in flight. Each
// belongs to one board: a page for another board starts afresh with that board's own.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { assert, AssertionError } from '../shared/assert'
import type { ChatItem } from '../shared/board_chat'
import { cleaned_poll_interval_ms } from '../shared/constants'
import {
  chat_fetch,
  draft_empty,
  draft_length_max,
  draft_load,
  draft_save,
  send_event,
  send_prepare,
  SendError,
  sketch_hash_read,
  stage_token_fetch,
  type Draft,
  type DraftStores,
  type Outcome,
  type Receipt,
  type Send,
} from './chat_delivery'
import { request_time_ms, unread_count, type Local } from './chat_thread'

export type Chat = {
  readonly items: readonly ChatItem[] | null
  readonly answers_count: number
  readonly denied: boolean
  readonly refresh: () => void
}

// Polled one request at a time while the page is shown. A reply that says nothing changed is
// a few dozen bytes; the whole conversation is fetched only when it has.
export function use_chat(session: string, token: string | null): Chat {
  const [chat, chat_set] = useState<Omit<Chat, 'refresh'>>({
    items: null,
    answers_count: 0,
    denied: false,
  })
  const wake = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (token === null) return

    let stopped = false
    let timer = 0
    let since: number | null = null

    // One read at a time. A refresh asked for while a read is under way is that read.
    let flying = false
    const run = () => {
      if (flying || stopped) return

      flying = true
      window.clearTimeout(timer)
      void poll().finally(() => {
        flying = false

        if (!stopped) timer = window.setTimeout(run, cleaned_poll_interval_ms)
      })
    }
    const poll = async (): Promise<void> => {
      const read = window.document.hidden ? null : await chat_read(session, token, since)

      if (stopped || read === null) return

      if (read === 'denied') return chat_set({ items: null, answers_count: 0, denied: true })

      if (read.items === null) return

      since = read.changes_count
      chat_set({ items: read.items, answers_count: read.answers_count, denied: false })
    }
    wake.current = run
    run()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      wake.current = () => undefined
    }
  }, [session, token])

  const refresh = useCallback(() => wake.current(), [])
  return { ...chat, refresh }
}

async function chat_read(session: string, token: string, since: number | null) {
  try {
    return await chat_fetch(session, token, since)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    return null
  }
}

// The Mac stage reads its board's chat with the pairing the board hands a page on this Mac.
export function use_stage_token(session: string, linked: boolean): string | null {
  const [token, token_set] = useState<string | null>(null)
  useEffect(() => {
    if (!linked) return

    let cancelled = false
    stage_token_fetch(session)
      .then((loaded) => {
        if (!cancelled) token_set(loaded)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session, linked])
  return linked ? token : null
}

const read_key = (session: string) => `tldraw-sync.chat.read.${session}`

// The answers this device has seen on this board, as a count of the board's answers. The
// first time a device reads a board, what is already there is history, not news. While the
// chat is on screen every answer is seen as it arrives. Other tabs on the device agree.
export function use_chat_read(session: string, chat: Chat, viewing: boolean) {
  const key = read_key(session)
  const [read_seq, read_set] = useState<number | null>(() => read_stored(key))
  const loaded = chat.items !== null

  useEffect(() => {
    const heard = (event: StorageEvent) => {
      if (event.key === key) read_set(read_stored(key))
    }
    window.addEventListener('storage', heard)
    return () => window.removeEventListener('storage', heard)
  }, [key])

  useEffect(() => {
    if (!loaded) return

    const behind = read_seq === null || (viewing && read_seq < chat.answers_count)

    if (!behind) return

    read_set(chat.answers_count)
    read_store(key, chat.answers_count)
  }, [key, loaded, viewing, read_seq, chat.answers_count])

  return { read_seq, unread: unread_count(chat.items, read_seq) }
}

function read_stored(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key) ?? 'NaN')
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function read_store(key: string, seq: number): void {
  assert(Number.isSafeInteger(seq) && seq >= 0, 'a read mark is a count')

  try {
    window.localStorage.setItem(key, String(seq))
  } catch {
    // Without storage the mark lasts as long as the page.
  }
}

const stores: DraftStores = {
  get local() {
    return window.localStorage
  },
  get tab() {
    return window.sessionStorage
  },
}

type ComposerProps = {
  session: string
  token: string | null
  online: boolean
  linked: boolean
  editor: Editor | null
  chat: Chat
}

// The draft as loaded. Words still in the field that are also the unconfirmed request were
// mid-send when the page went away: the request holds them now, above the field.
function draft_initial(session: string): { draft: Draft; readable: boolean } {
  try {
    const draft = draft_load(session, stores)
    const moved = draft.pending !== null && draft.pending.text === draft.text
    return { draft: moved ? { ...draft, text: '' } : draft, readable: true }
  } catch {
    return { draft: draft_empty, readable: false }
  }
}

type BoardChatProps = {
  session: string
  token: string | null
  linked: boolean
  online: boolean
  editor: Editor | null
  viewing: boolean
}

// Everything a page needs for its board's chat, whichever view is shown: the unread mark
// stays current on the tabs, and a message in flight settles even after the chat is left.
export function use_board_chat(props: BoardChatProps) {
  const { session, token, viewing } = props
  const chat = use_chat(session, token)
  const { read_seq, unread } = use_chat_read(session, chat, viewing)
  const composer_props = { ...props, chat }
  const composer = use_composer(composer_props)
  return { chat, read_seq, unread, composer, composer_props }
}

export type Composer = ReturnType<typeof use_composer>

export function use_composer(props: ComposerProps) {
  const { session } = props
  const [initial] = useState(() => draft_initial(session))
  const draft = useRef<Draft>(initial.draft)
  const [shown, shown_set] = useState<Draft>(initial.draft)
  const [busy, busy_set] = useState(false)
  const [refusal, refusal_set] = useState<string | null>(null)
  const [doubt, doubt_set] = useState('')
  const [stored, stored_set] = useState(true)
  const [sent, sent_set] = useState<{ send: Send; receipt: Receipt } | null>(null)
  const locked = useRef(false)

  // Lenient: an edit is kept for this visit even when the device cannot save it.
  const keep = useCallback(
    (next: Draft) => {
      draft.current = next
      shown_set(next)

      try {
        draft_save(session, stores, next)
        stored_set(true)
      } catch (error) {
        if (error instanceof AssertionError) throw error

        stored_set(false)
      }
    },
    [session],
  )

  use_pending_settled(props.chat.items, busy, draft, keep)
  const flight = { props, draft, keep, locked, busy_set, refusal_set, doubt_set, sent_set }
  const send = () => void composer_send(flight)
  const retry = () => void composer_retry(flight)
  const change = (text: string) => {
    if (locked.current || text.length > draft_typing_length_max) return

    refusal_set(null)
    keep({ ...draft.current, text })
  }
  const attach = (on: boolean) => {
    if (locked.current) return

    keep({ ...draft.current, include_sketch: on })
  }
  const locals = composer_locals(sent, shown.pending, busy, doubt)
  const readable = initial.readable
  return { ...shown, readable, stored, busy, refusal, locals, send, retry, change, attach }
}

// What this device holds that the board's chat may not show yet. A confirmed request is shown
// as confirmed until the board's chat shows it itself; an unconfirmed one, until it is sent.
function composer_locals(
  sent: { send: Send; receipt: Receipt } | null,
  pending: Send | null,
  busy: boolean,
  doubt: string,
): Local[] {
  const locals: Local[] = []

  if (sent !== null) {
    const { send, receipt } = sent
    locals.push({ send, state: receipt.state, at_ms: receipt.created_at_ms, detail: '' })
  }

  if (pending !== null) {
    const state = busy ? 'sending' : 'unconfirmed'
    const at_ms = request_time_ms(pending.request_id)
    locals.push({ send: pending, state, at_ms, detail: busy ? '' : doubt })
  }

  assert(locals.length <= 2, 'one request confirmed and one waiting, at most')
  return locals
}

// What may be typed: one note and room for words handed back after a refusal.
const draft_typing_length_max = 16384
assert(draft_typing_length_max + 2 + 8000 <= draft_length_max, 'handed-back words always fit')

// A request this device could not confirm, which the board turns out to hold, was sent: the
// board shows it now, and it is never sent again. One still in flight is its send's to settle.
function use_pending_settled(
  items: readonly ChatItem[] | null,
  busy: boolean,
  draft: { current: Draft },
  keep: (next: Draft) => void,
) {
  useEffect(() => {
    const pending = draft.current.pending

    if (busy || items === null || pending === null) return

    if (items.some((item) => item.request_id === pending.request_id)) {
      keep({ ...draft.current, pending: null })
    }
  }, [items, busy, draft, keep])
}

type Flight = {
  props: ComposerProps
  draft: { current: Draft }
  keep: (next: Draft) => void
  locked: { current: boolean }
  busy_set: (busy: boolean) => void
  refusal_set: (refusal: string | null) => void
  doubt_set: (doubt: string) => void
  sent_set: (sent: { send: Send; receipt: Receipt } | null) => void
}

// Whether the field's words can go now, and if not, why. Words alone need words; the sketch
// needs this page's sketch to read.
export function composer_ready(composer: Composer, props: ComposerProps): boolean {
  const { token, online, linked, editor } = props
  const words = composer.text.trim() !== ''
  const content = composer.include_sketch ? editor !== null : words
  return (
    linked &&
    online &&
    token !== null &&
    composer.readable &&
    !composer.busy &&
    composer.pending === null &&
    content
  )
}

// The words in the field, saved as a request before a byte is sent, then sent once.
async function composer_send(flight: Flight) {
  const { props, draft, locked } = flight
  const { token, online, linked, editor, session } = props
  const current = draft.current

  if (locked.current || token === null || !online || !linked || current.pending !== null) return

  if (current.include_sketch && editor === null) return

  let request: Send

  try {
    const sketch = current.include_sketch && editor !== null ? () => sketch_hash_read(editor) : null
    request = send_prepare(current.text, sketch)
  } catch (error) {
    if (error instanceof SendError) return flight.refusal_set(error.message)

    throw error
  }

  // Strict: a request that cannot be saved cannot be retried, so it is not sent.
  try {
    draft_save(session, stores, { ...current, pending: request })
  } catch (error) {
    if (error instanceof AssertionError) throw error

    return flight.refusal_set('This device cannot save the message. Nothing was sent.')
  }

  flight.keep({ ...current, pending: request })
  await composer_fly(flight, request, true)
}

async function composer_retry(flight: Flight) {
  const { props, draft, locked } = flight
  const pending = draft.current.pending

  if (locked.current || pending === null || props.token === null || !props.online) return

  await composer_fly(flight, pending, false)
}

// One request in flight at a time. A second tap or key while it flies does nothing.
async function composer_fly(flight: Flight, request: Send, from_field: boolean) {
  const { props, locked } = flight
  assert(props.token !== null, 'only a paired page sends')
  locked.current = true
  flight.busy_set(true)
  flight.refusal_set(null)
  let outcome: Outcome

  try {
    outcome = await request_fly(props.session, props.token, request)
  } finally {
    locked.current = false
    flight.busy_set(false)
  }

  composer_settle(flight, request, outcome, from_field)
}

// `ok: null` means nobody knows whether the Mac has the request: it stays, to be sent again.
async function request_fly(session: string, token: string, request: Send): Promise<Outcome> {
  try {
    return await send_event(session, token, request)
  } catch (error) {
    if (error instanceof AssertionError) throw error

    const message = error instanceof SendError ? error.message : unconfirmed_detail
    return { ok: null, message }
  }
}

export const unconfirmed_detail = 'No confirmation. Send again to retry the same message.'

// What the Mac's answer leaves. Confirmed: the request is the board's, the field is cleared of
// the words it sent, and the sketch comes off. Refused: nothing happened, and the words go
// back into the field. Unknown: the request waits above the field, and the field is free.
function composer_settle(flight: Flight, request: Send, outcome: Outcome, from_field: boolean) {
  const current = flight.draft.current
  assert(current.pending?.request_id === request.request_id, 'only its own request settles')
  const words = request.text ?? ''
  const sent_from_field = from_field && current.text === words

  const include_sketch = from_field ? false : current.include_sketch

  if (outcome.ok === true) {
    const text = sent_from_field ? '' : current.text
    flight.keep({ text, include_sketch, pending: null })
    flight.sent_set({ send: request, receipt: outcome.receipt })
    flight.doubt_set('')
    flight.props.chat.refresh()
    return
  }

  if (outcome.ok === false) {

    // From the field the words never left it. From above it, they are put back before what
    // has been written since, so nothing is lost.
    const back = from_field ? current.text : words_join(words, current.text)
    flight.keep({ text: back, include_sketch: request.include_sketch, pending: null })
    flight.refusal_set(outcome.message)
    return
  }

  flight.doubt_set(outcome.message)
  flight.keep({ ...current, text: sent_from_field ? '' : current.text, include_sketch })
}

function words_join(earlier: string, later: string): string {
  const joined = earlier === '' || later === '' ? earlier + later : `${earlier}\n\n${later}`
  assert(joined.length <= draft_length_max, 'handed-back words fit the draft')
  return joined
}
