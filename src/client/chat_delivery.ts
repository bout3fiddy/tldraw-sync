// What a pad sends to its board's chat and reads back from it. A draft and the one request not
// yet confirmed are kept for each board on this device, so a reload, a lost Mac or a closed tab
// loses no words and a retry is the same request, never a second one. Words alone never read
// the sketch; a request with the sketch names the hash of the sketch as this page shows it.

import type { Editor } from 'tldraw'
import { assert } from '../shared/assert'
import { chat_item_valid, type ChatResponse } from '../shared/board_chat'
import { board_query } from '../shared/board_session'
import { document_hash_pattern, path_status } from '../shared/constants'
import { document_hash } from '../shared/document_hash'
import {
  event_kind_retired,
  event_kinds,
  event_states,
  events_count_max,
  header_board_stage,
  request_id_pattern,
  request_size_bytes_max,
  request_text_valid,
  whiteboard_path,
  whiteboard_protocol,
  type BoardEvent,
  type EventKind,
} from '../shared/whiteboard'

// One request: the words, and the sketch's hash when the sketch goes with them.
export type Send = {
  kind: EventKind
  request_id: string
  include_sketch: boolean
  sketch_hash?: string
  text?: string
}

// The words being written, whether the sketch is to go with them, and the request not yet
// confirmed, if there is one.
export type Draft = { text: string; include_sketch: boolean; pending: Send | null }

// The parts of the browser's storage a draft uses: this device's, and the tab's own, where an
// earlier page kept its note.
export type DraftStores = {
  local: Pick<Storage, 'getItem' | 'setItem'>
  tab: Pick<Storage, 'getItem' | 'removeItem'>
}

// A failure whose words are written for the person sending. Anything else that is thrown, such
// as a lost connection, a timeout or an unreadable reply, is reported as a missing confirmation.
export class SendError extends Error {}

// What may be typed, and words handed back after a refusal put before it: see `use_composer`.
export const draft_length_max = 24576
export const draft_empty: Draft = { text: '', include_sketch: false, pending: null }
export const draft_key = (session: string) => `tldraw-sync.chat.${session}`
const draft_key_legacy = (session: string) => `tldraw-sync.notify.${session}`

const request_timeout_ms = 5000

// A chat is at most sixty-four requests, each with a note and an answer of 16 KiB.
const chat_size_bytes_max = 4 * 1024 * 1024

// This device's draft for a board. A note kept by an earlier page in the tab is moved here,
// once, with its unconfirmed request: that request carried the sketch, as every send then did.
// A draft that this page did not write is refused, never guessed at.
export function draft_load(session: string, stores: DraftStores): Draft {

  // The rows an earlier page kept under its bell held no words, and the chat replaces them.
  stores.tab.removeItem(`tldraw-sync.inbox.${session}`)
  const raw = stores.local.getItem(draft_key(session))

  if (raw !== null) return draft_parse(raw, false)

  const legacy = stores.tab.getItem(draft_key_legacy(session))

  if (legacy === null) return draft_empty

  const draft = draft_parse(legacy, true)
  stores.local.setItem(draft_key(session), JSON.stringify(draft))
  stores.tab.removeItem(draft_key_legacy(session))
  return draft
}

export function draft_save(session: string, stores: DraftStores, draft: Draft): void {
  assert(draft.text.length <= draft_length_max, 'a draft is bounded')
  assert(draft.pending === null || send_valid(draft.pending), 'a pending request is replayable')
  stores.local.setItem(draft_key(session), JSON.stringify(draft))
}

function draft_parse(raw: string, legacy: boolean): Draft {
  const draft = JSON.parse(raw) as Partial<Draft> & { pending?: Partial<Send> | null }
  const text = draft.text

  if (typeof text !== 'string' || text.length > draft_length_max) {
    throw Error('Cannot read this board’s draft. Check the chat before sending.')
  }

  const include_sketch = legacy ? false : draft.include_sketch

  if (typeof include_sketch !== 'boolean') throw Error('Cannot read this board’s draft.')

  const pending = draft.pending ?? null

  // A request for an interpretation, left unconfirmed by a page from before the upgrade, is
  // dropped here and never sent again. The words that were written stay.
  if (pending === null || event_kind_retired(pending.kind)) {
    return { text, include_sketch, pending: null }
  }

  const send = legacy ? { ...pending, include_sketch: true } : pending

  if (!send_valid(send)) {
    throw Error('Cannot read this board’s unsent message. Check the chat before sending.')
  }

  return { text, include_sketch, pending: send }
}

function send_valid(value: Partial<Send>): value is Send {
  const sketch = value.include_sketch
  const text = value.text
  return (
    event_kinds.some((kind) => kind === value.kind) &&
    typeof value.request_id === 'string' &&
    request_id_pattern.test(value.request_id) &&
    typeof sketch === 'boolean' &&
    (text === undefined || (request_text_valid(text) && text.length > 0)) &&
    (sketch
      ? typeof value.sketch_hash === 'string' && document_hash_pattern.test(value.sketch_hash)
      : value.sketch_hash === undefined && text !== undefined && text.trim() !== '')
  )
}

function request_id(): string {

  // UUIDv7 is available on HTTP iPad origins via getRandomValues, unlike randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let time = Date.now()

  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256
    time = Math.floor(time / 256)
  }

  bytes[6] = 0x70 | (bytes[6]! & 15)
  bytes[8] = 0x80 | (bytes[8]! & 63)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  )
}

// The hash of the sketch as this page shows it: read only when the sketch is to go.
export function sketch_hash_read(editor: Editor): string {
  const types = editor.store.scopedTypes.document
  const records = editor.store.allRecords().filter((r) => types.has(r.typeName))
  const hash = document_hash(records)
  assert(document_hash_pattern.test(hash), 'a sketch hash is well formed')
  return hash
}

// A request ready to be saved and sent. Words alone take no editor, so they cannot read the
// sketch; the sketch takes one, and is read here, once.
export function send_prepare(text: string, sketch: (() => string) | null): Send {
  if (!request_text_valid(text)) {
    throw new SendError('Use up to 4000 characters without control marks.')
  }

  if (sketch === null && text.trim() === '') {
    throw new SendError('Write a message, or add the sketch to send it.')
  }

  const body: Send = {
    kind: event_kinds[0],
    request_id: request_id(),
    include_sketch: sketch !== null,
    ...(sketch === null ? {} : { sketch_hash: sketch() }),
    ...(text ? { text } : {}),
  }

  if (new TextEncoder().encode(JSON.stringify(body)).length > request_size_bytes_max) {
    throw new SendError('The message is over 16 KiB. Shorten it.')
  }

  assert(send_valid(body), 'a prepared request is replayable')
  return body
}

const fetch_options = (token: string | null) =>
  ({
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(request_timeout_ms),
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
  }) as const

export type Receipt = Pick<BoardEvent, 'id' | 'state' | 'created_at_ms' | 'sketch_hash'>
export type Outcome =
  { ok: true; receipt: Receipt } | { ok: false; message: string } | { ok: null; message: string }

export async function send_event(session: string, token: string, send: Send): Promise<Outcome> {
  const query = `?${board_query(session)}`
  const status = await fetch(path_status + query, fetch_options(null))

  if (!status.ok) throw new SendError('Cannot confirm the board version. Reconnect and retry.')

  const capability = await status.json()

  if (capability.protocol !== whiteboard_protocol || capability.session !== session) {
    return { ok: null, message: 'Upgrade and restart the Mac board. Your message is kept.' }
  }

  // Fence the POST as well: an older daemon replacing the one just checked must not strip text.
  const response = await fetch(`${whiteboard_path}event/v2${query}`, {
    ...fetch_options(token),
    method: 'POST',
    body: JSON.stringify(send),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  })
  const body = await response.json()

  if (!response.ok) {
    if (response.status < 500) return { ok: false, message: String(body.message) }

    throw new SendError('No durable confirmation. Send again to retry the same message.')
  }

  return { ok: true, receipt: receipt_checked(body, send) }
}

function receipt_checked(value: unknown, send: Send): Receipt {
  const e = value as Partial<BoardEvent>
  const sketch = (e.include_sketch ?? true) === send.include_sketch

  if (
    e.request_id !== send.request_id ||
    e.kind !== send.kind ||
    e.text !== send.text ||
    !sketch ||
    (send.include_sketch && e.sketch_hash !== send.sketch_hash) ||
    typeof e.id !== 'string' ||
    typeof e.sketch_hash !== 'string' ||
    !Number.isSafeInteger(e.created_at_ms) ||
    !event_states.some((state) => state === e.state)
  ) {
    throw new SendError('No exact confirmation. Upgrade the Mac board before retrying.')
  }

  return { id: e.id, state: e.state!, created_at_ms: e.created_at_ms!, sketch_hash: e.sketch_hash }
}

// The board's chat, read with the pairing. `since` is the change count last seen: an answer
// with no items means nothing changed. 'denied' means this page is not paired with the board.
export async function chat_fetch(
  session: string,
  token: string,
  since: number | null,
): Promise<ChatResponse | 'denied' | null> {
  const after = since === null ? '' : `&since=${since}`
  const response = await fetch(
    `${whiteboard_path}chat?${board_query(session)}${after}`,
    fetch_options(token),
  )

  if (response.status === 403) return 'denied'

  if (!response.ok) return null

  const text = await response.text()

  if (text.length > chat_size_bytes_max) return null

  return chat_checked(JSON.parse(text), session)
}

function chat_checked(value: unknown, session: string): ChatResponse | null {
  const chat = value as Partial<ChatResponse> & { protocol?: unknown }
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
  const items = chat.items

  if (chat.protocol !== whiteboard_protocol || chat.session !== session) return null

  if (!count(chat.changes_count) || !count(chat.answers_count)) return null

  if (items !== null && (!Array.isArray(items) || items.length > events_count_max)) return null

  if (items !== null && !items!.every(chat_item_valid)) return null

  return chat as ChatResponse
}

// The Mac stage's pairing with its own board, handed only to a page on this Mac.
export async function stage_token_fetch(session: string): Promise<string | null> {
  const response = await fetch(`${whiteboard_path}stage?${board_query(session)}`, {
    ...fetch_options(null),
    headers: { [header_board_stage]: 'chat' },
  })

  if (!response.ok) return null

  const body = (await response.json()) as { session?: unknown; token?: unknown }
  const token = body.token

  if (body.session !== session || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    return null
  }

  return token
}
