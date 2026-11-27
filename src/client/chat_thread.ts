// The chat as it is read, worked out from what the board holds and what this device has not
// yet had confirmed. Pure: no time is read and nothing is stored here, so every rule can be
// checked without a browser. A request the board holds is shown once, whatever this device
// remembers of it. An answer is shown under the request it answers.

import { assert } from '../shared/assert'
import type { ChatItem } from '../shared/board_chat'
import { event_kind_retired, event_state_terminal, type EventState } from '../shared/whiteboard'
import type { Send } from './chat_delivery'

// What this device alone knows of a request: it is on its way, or nobody knows whether the
// board has it. A request the board has confirmed is the board's from then on.
export type LocalState = 'sending' | 'unconfirmed'
export type ReceiptState = EventState | LocalState

// A request as this device has it: still its own, or confirmed by the board but not yet in the
// chat the board last served.
export type Local = {
  readonly send: Send
  readonly state: ReceiptState
  readonly at_ms: number
  readonly detail: string
}

export type Mine = {
  readonly type: 'mine'
  readonly key: string
  readonly text: string | null
  readonly include_sketch: boolean
  readonly sketch_hash: string | null
  readonly shapes_count: number | null
  readonly at_ms: number
  readonly state: ReceiptState
  readonly local: boolean

  // The board's own line about a request it closed unrun, or why this device is unsure.
  readonly detail: string | null
}

export type Answer = {
  readonly type: 'answer'
  readonly key: string
  readonly text: string
  readonly at_ms: number
  readonly failed: boolean
  readonly canvas_revision: number | null
  readonly unread: boolean
}

export type Entry = Mine | Answer

const receipt_labels: Record<ReceiptState, string> = {
  sending: 'Sending',
  unconfirmed: 'Not confirmed',
  queued: 'Queued on the Mac',
  received: 'Received by your agent',
  working: 'Agent is working',
  updated: 'Done',
  failed: 'Failed',
}

export const receipt_label = (state: ReceiptState) => receipt_labels[state]

// Trouble is said in the weight of ink: a request that failed or that nobody can vouch for.
export const receipt_trouble = (state: ReceiptState) =>
  state === 'failed' || state === 'unconfirmed'

// A square of ink has ended; an open square is on its way.
export const receipt_ended = (state: ReceiptState) => state === 'updated' || state === 'failed'

// The chat in reading order: each request the board holds, its answer under it, and last the
// requests this device holds alone, unless the board already shows them.
export function thread_entries(
  items: readonly ChatItem[],
  locals: readonly Local[],
  read_seq: number | null,
): Entry[] {
  const entries: Entry[] = []

  for (const item of items) {
    entries.push(mine_of(item))
    const answer = answer_of(item, read_seq)

    if (answer !== null) entries.push(answer)
  }

  for (const local of locals) {
    const known = items.some((item) => item.request_id === local.send.request_id)
    const shown = entries.some((entry) => entry.key === local.send.request_id)

    if (!known && !shown) entries.push(mine_local(local))
  }

  assert(entries.length <= 2 * items.length + locals.length, 'one answer to each request')
  assert(new Set(entries.map((entry) => entry.key)).size === entries.length, 'keys are unique')
  return entries
}

function mine_of(item: ChatItem): Mine {
  const retired = event_kind_retired(item.kind)
  return {
    type: 'mine',
    key: item.id,
    text: retired ? (item.text ?? 'Interpret my sketch') : item.text,
    include_sketch: item.include_sketch,
    sketch_hash: item.sketch_hash,
    shapes_count: item.shapes_count,
    at_ms: item.created_at_ms,
    state: item.state,
    local: false,
    detail: retired ? item.reply : null,
  }
}

// The agent's words, once the request has ended with some. A request closed by the board
// itself, because its kind was retired, has the board's line under it and no answer.
function answer_of(item: ChatItem, read_seq: number | null): Answer | null {
  if (!event_state_terminal(item.state) || item.reply === null) return null

  if (event_kind_retired(item.kind)) return null

  const seq = item.answer_seq
  return {
    type: 'answer',
    key: `${item.id}:answer`,
    text: item.reply,
    at_ms: item.answered_at_ms ?? item.created_at_ms,
    failed: item.state === 'failed',
    canvas_revision: item.canvas_revision,
    unread: seq !== null && read_seq !== null && seq > read_seq,
  }
}

function mine_local(local: Local): Mine {
  const { send } = local
  assert(send.include_sketch === (send.sketch_hash !== undefined), 'a sketch is named if it goes')
  return {
    type: 'mine',
    key: send.request_id,
    text: send.text ?? null,
    include_sketch: send.include_sketch,
    sketch_hash: send.sketch_hash ?? null,
    shapes_count: null,
    at_ms: local.at_ms,
    state: local.state,
    local: local.state === 'sending' || local.state === 'unconfirmed',
    detail: local.detail === '' ? null : local.detail,
  }
}

// How many answers this device has not yet seen on this board. Only answers count: a request
// that moves from queued to working is the agent's business, not news.
export function unread_count(items: readonly ChatItem[] | null, read_seq: number | null): number {
  if (items === null || read_seq === null) return 0

  const unread = items.filter((item) => item.answer_seq !== null && item.answer_seq > read_seq)
  assert(
    unread.every((item) => event_state_terminal(item.state)),
    'only an end is news',
  )
  return unread.length
}

// The request the agent holds and has not ended, for the line at the foot of the chat: the
// newest it says it is working on, else the newest it has received. A request merely received
// later never hides the status of one being worked on.
export function thread_working(items: readonly ChatItem[]): ChatItem | null {
  let working: ChatItem | null = null
  let received: ChatItem | null = null

  for (const item of items) {
    if (item.state === 'working') working = item

    if (item.state === 'received') received = item
  }

  const found = working ?? received
  assert(found === null || !event_state_terminal(found.state), 'an ended request is not working')
  assert(working === null || found === working, 'work in hand outranks a receipt')
  return found
}

// The time a request was made, read from its UUIDv7 replay key: this device's own clock.
export function request_time_ms(request_id: string): number {
  const stamp = parseInt(request_id.slice(0, 8) + request_id.slice(9, 13), 16)
  assert(Number.isSafeInteger(stamp) && stamp >= 0, 'a replay key carries its time')
  return stamp
}
