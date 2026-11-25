import type { Editor } from 'tldraw'
import { board_query } from '../shared/board_session'
import { path_status, document_hash_pattern } from '../shared/constants'
import { document_hash } from '../shared/document_hash'
import {
  event_kinds,
  event_states,
  request_id_pattern,
  request_size_bytes_max,
  request_text_valid,
  whiteboard_path,
  type BoardEvent,
  type EventKind,
} from '../shared/whiteboard'

export type Send = { kind: EventKind; sketch_hash: string; request_id: string; text?: string }
export type Draft = { text: string; pending: Send | null }

export function draft_load(key: string): Draft {
  const raw = sessionStorage.getItem(key)

  if (!raw) return { text: '', pending: null }

  const draft = JSON.parse(raw) as Draft
  const p = draft.pending

  if (
    typeof draft.text !== 'string' ||
    draft.text.length > 8192 ||
    (p !== null &&
      (!event_kinds.includes(p.kind) ||
        !document_hash_pattern.test(p.sketch_hash) ||
        !request_id_pattern.test(p.request_id) ||
        (p.text !== undefined && !request_text_valid(p.text))))
  )
    throw Error('Cannot read this tab’s pending request. Check status before sending.')

  return draft
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

export function send_prepare(editor: Editor, kind: EventKind, text: string): Send {
  if (!request_text_valid(text)) throw Error('Use up to 4000 characters without control marks.')

  const types = editor.store.scopedTypes.document
  const records = editor.store.allRecords().filter((r) => types.has(r.typeName))
  const body = {
    kind,
    sketch_hash: document_hash(records),
    request_id: request_id(),
    ...(text ? { text } : {}),
  }

  if (new TextEncoder().encode(JSON.stringify(body)).length > request_size_bytes_max) {
    throw Error('The encoded request exceeds 16 KiB. Shorten the note.')
  }

  return body
}

export async function send_event(session: string, token: string, send: Send) {
  const query = `?${board_query(session)}`
  const opts = { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) } as const
  const status = await fetch(path_status + query, opts)

  if (!status.ok) throw Error('Cannot confirm the board version. Reconnect and retry.')

  const capability = await status.json()

  if (capability.protocol !== 2 || capability.session !== session) {
    throw Error('Upgrade and restart the Mac board before sending. Your note is kept.')
  }

  // Fence the POST as well: an older daemon replacing the one just checked must not strip text.
  const response = await fetch(`${whiteboard_path}event/v2${query}`, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(send),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  })
  const body = await response.json()

  if (!response.ok) {
    if (response.status < 500) return { ok: false as const, message: String(body.message) }

    throw Error('No durable confirmation. Retry the same request.')
  }

  const e = body as BoardEvent

  if (
    e.request_id !== send.request_id ||
    e.kind !== send.kind ||
    e.sketch_hash !== send.sketch_hash ||
    e.text !== send.text ||
    typeof e.id !== 'string' ||
    !event_states.includes(e.state)
  ) {
    throw Error('No exact confirmation. Upgrade the Mac board before retrying.')
  }

  return { ok: true as const, event: e }
}
