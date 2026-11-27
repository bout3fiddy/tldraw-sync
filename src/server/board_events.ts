import { createHash } from 'node:crypto'
import { assert } from '../shared/assert'
import { document_hash_pattern } from '../shared/constants'
import {
  event_kind_retired,
  event_kinds_stored,
  event_request_complete,
  event_state_terminal,
  event_states,
  events_count_max,
  message_length_max,
  type BoardEvent,
  reply_text_valid,
  request_id_pattern,
  request_size_bytes_max,
  request_text_valid,
  retired_message,
  type EventRequest,
  type EventKind,
  type EventState,
} from '../shared/whiteboard'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

const file = 'events.state'
const event_keys = new Set([
  'id',
  'kind',
  'sketch_hash',
  'created_at_ms',
  'state',
  'message',
  'request_id',
  'text',
  'include_sketch',
  'shapes_count',
  'revision_sent',
  'revision_answered',
  'answer_seq',
  'answered_at_ms',
])

// Sixty-four requests, each at most a 16 KiB note and a 16 KiB answer, escaped as JSON, with
// room for the fields around them. A larger journal is not one this board wrote.
const journal_size_bytes_max = 4 * 1024 * 1024
const count_max = 2 ** 48
const terminal = event_state_terminal

// What the board knows when it queues a request: the canvas revision then, and how many
// shapes the sketch held when the sketch goes with it.
export type EventContext = { revision_sent: number; shapes_count?: number }

// The conversation of one board, for the private chat route. `changes_count` moves on every
// write, so a reader can tell in one number whether anything changed. `answers_count` is the
// number of answers ever given; each answer carries its own place in that count.
export type EventsChat = {
  readonly changes_count: number
  readonly answers_count: number
  readonly events: readonly BoardEvent[]
}

type Counts = { retired_through_ms: number; answers_count: number; changes_count: number }

export class BoardEvents {
  private constructor(
    private disk: Disk,
    private events: readonly BoardEvent[],
    private counts: Counts,
  ) {}

  static open(disk: Disk): BoardEvents {
    const bytes = disk.read(file)

    if (!bytes) return new BoardEvents(disk, [], counts_empty())

    if (bytes.length > journal_size_bytes_max) throw new StorageError('Oversized event journal.')

    const decoded = envelope_decode(bytes, 'events')

    if (!decoded.ok) throw new StorageError('Damaged event journal.')

    let items: unknown

    try {
      items = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded.envelope.payload))
    } catch {
      throw new StorageError('Event journal is not JSON.')
    }

    const legacy = Array.isArray(items)
    const counts = legacy ? counts_empty() : counts_read(items)
    const listed = legacy ? items : (items as { events?: unknown }).events
    const events = events_read(listed, legacy)
    const answered = events.flatMap((event) => (event.answer_seq ? [event.answer_seq] : []))

    if (answered.some((seq) => seq > counts.answers_count)) {
      throw new StorageError('An answer is numbered past the count.')
    }

    if (new Set(answered).size !== answered.length) throw new StorageError('Duplicate answer.')

    const journal = new BoardEvents(disk, events, counts)
    journal.retire_outstanding()
    return journal
  }

  // A request of a kind this board no longer runs, still waiting from before an upgrade, is
  // closed here before any host can be handed it. It is never executed: it ends as failed,
  // with a line for the person who sent it, and keeps its place and its replay key.
  private retire_outstanding(): void {
    const waiting = (event: BoardEvent) => event_kind_retired(event.kind) && !terminal(event.state)

    if (!this.events.some(waiting)) return

    const next = this.events.map((event) =>
      waiting(event) ? { ...event, state: 'failed' as const, message: retired_message } : event,
    )
    assert(next.length === this.events.length, 'retiring removes no request')
    assert(next.every(event_valid), 'retired requests are replayable')
    this.commit(next)
    assert(!this.outstanding().some((event) => event_kind_retired(event.kind)), 'none is left')
  }

  latest(): BoardEvent | undefined {
    const last = this.events.at(-1)
    assert((last === undefined) === (this.events.length === 0), 'only empty journals lack a tail')
    return last
  }

  outstanding(): BoardEvent[] {
    const pending = this.events.filter((event) => !terminal(event.state))
    assert(pending.length <= events_count_max, 'the poll response fits the journal bound')
    assert(
      pending.every((event) => !terminal(event.state)),
      'terminal events cannot wake a host',
    )
    return pending
  }

  chat(): EventsChat {
    const { changes_count, answers_count } = this.counts
    assert(this.events.length <= events_count_max, 'the conversation fits the journal bound')
    assert(Number.isSafeInteger(changes_count) && changes_count >= 0, 'changes are counted')
    return { changes_count, answers_count, events: this.events }
  }

  // The receipt already given for this request, if it was made before. A retry gets the same
  // receipt and never a second request. Words alone are the same words whatever the sketch
  // has become since; a request with the sketch is also the same sketch.
  replay(kind: EventKind, hash: string, request: EventRequest) {
    if (!request.request_id) return null

    const prior = this.events.find((e) => e.request_id === request.request_id)

    if (!prior) {
      return request_ms(request.request_id) <= this.counts.retired_through_ms ? 'expired' : null
    }

    const sketch = request.include_sketch !== false

    if (prior.kind !== kind || prior.text !== request.text) return 'conflict'

    if ((prior.include_sketch !== false) !== sketch) return 'conflict'

    if (sketch && prior.sketch_hash !== hash) return 'conflict'

    assert(prior.request_id === request.request_id, 'retry returns its own receipt')
    assert(event_valid(prior), 'replay only echoes validated durable events')
    return prior
  }

  queue(
    kind: EventKind,
    hash: string,
    now_ms: number,
    id: string,
    request: EventRequest = {},
    context: EventContext | null = null,
  ) {
    assert(!this.events.some((item) => item.id === id), 'event ids are unique')
    assert(event_request_complete(request), 'words alone were checked at the door')
    const replay = this.replay(kind, hash, request)

    if (replay !== null) return replay

    if (request.request_id && request_ms(request.request_id) > now_ms + 300_000) return 'clock'

    const events = this.events.slice()
    let watermark = this.counts.retired_through_ms

    if (events.length === events_count_max) {
      const index = events.findIndex((event) => terminal(event.state))

      if (index < 0) return 'full'

      const [retired] = events.splice(index, 1)
      assert(retired !== undefined && terminal(retired.state), 'only terminal events are retired')

      if (retired.request_id) watermark = Math.max(watermark, request_ms(retired.request_id))
    }

    const event = event_create({ kind, hash, now_ms, id, request, context })
    assert(event_valid(event), 'new events are replayable')
    this.commit([...events, event], watermark)
    assert(this.latest() === event, 'the queued event is durable before delivery')
    return event
  }

  // An end numbers the answer, so a reader can tell which answers it has not yet seen, and
  // records when it came and the canvas revision then, so the answer can say whether the
  // canvas moved.
  ack(
    id: string,
    state: EventState,
    message?: string,
    answered?: { revision: number; now_ms: number },
  ): BoardEvent | 'missing' | 'transition' {
    const prior = this.events.find((event) => event.id === id)

    if (!prior) return 'missing'

    if (prior.state === state) return prior

    if (terminal(prior.state) || state === 'queued') return 'transition'

    if (prior.state === 'queued' && state !== 'received') return 'transition'

    if (prior.state === 'working' && !terminal(state)) return 'transition'

    const { message: _, ...rest } = prior
    const ending = terminal(state)
    const answers_count = this.counts.answers_count + (ending ? 1 : 0)
    const updated: BoardEvent = {
      ...rest,
      state,
      ...(message === undefined ? {} : { message }),
      ...(ending ? { answer_seq: answers_count } : {}),
      ...(ending && answered !== undefined
        ? { revision_answered: answered.revision, answered_at_ms: answered.now_ms }
        : {}),
    }
    assert(event_valid(updated), 'acknowledgements are replayable')
    const next = this.events.map((item) => (item === prior ? updated : item))
    assert(next.length === this.events.length, 'acknowledgement never removes a request')
    assert(updated.sketch_hash === prior.sketch_hash, 'the source does not move on receipt')
    this.commit(next, this.counts.retired_through_ms, answers_count)
    assert(this.events.includes(updated), 'the acknowledgement is durable')
    return updated
  }

  private commit(
    next: BoardEvent[],
    watermark = this.counts.retired_through_ms,
    answers_count = this.counts.answers_count,
  ): void {
    assert(next.length > 0 && next.length <= events_count_max, 'event history fits')
    assert(watermark >= this.counts.retired_through_ms, 'expired requests never become fresh')
    assert(answers_count >= this.counts.answers_count, 'answers are never unnumbered')
    const requests = next.flatMap((item) => (item.request_id ? [item.request_id] : []))
    assert(new Set(requests).size === requests.length, 'each replay key has one receipt')
    const changes_count = this.counts.changes_count + 1
    assert(changes_count < count_max, 'the change counter stays exact')
    const payload = new TextEncoder().encode(
      JSON.stringify({
        events: next,
        retired_through_ms: watermark,
        answers_count,
        changes_count,
      }),
    )
    assert(payload.length <= journal_size_bytes_max - 1024, 'the journal fits its own bound')
    const encoded = envelope_encode({ kind: 'events', label: '-', payload })
    this.disk.write_atomic(file, encoded)
    const written = this.disk.read(file)
    assert(written !== null && Buffer.from(encoded).equals(written), 'the journal reads back')
    assert(new Set(next.map((e) => e.id)).size === next.length, 'each id is addressable')
    this.events = next
    this.counts = { retired_through_ms: watermark, answers_count, changes_count }
  }
}

type Creation = {
  kind: EventKind
  hash: string
  now_ms: number
  id: string
  request: EventRequest
  context: EventContext | null
}

// A new request as it is saved. Words alone record no shape count: no sketch went with them.
function event_create({ kind, hash, now_ms, id, request, context }: Creation): BoardEvent {
  const sketch = request.include_sketch !== false
  const event: BoardEvent = {
    ...(request.request_id === undefined ? {} : { request_id: request.request_id }),
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.include_sketch === undefined ? {} : { include_sketch: request.include_sketch }),
    id,
    kind,
    sketch_hash: hash,
    created_at_ms: now_ms,
    state: 'queued',
    ...(context === null ? {} : { revision_sent: context.revision_sent }),
    ...(sketch && context?.shapes_count !== undefined
      ? { shapes_count: context.shapes_count }
      : {}),
  }
  assert(event.include_sketch !== false || event.shapes_count === undefined, 'no sketch, no count')
  assert(event.text === request.text, 'the words are kept exactly')
  return event
}

function counts_empty(): Counts {
  return { retired_through_ms: -1, answers_count: 0, changes_count: 0 }
}

// The counters beside the events. A journal written before answers were counted has none.
function counts_read(items: unknown): Counts {
  if (!items || typeof items !== 'object' || !('events' in items)) {
    throw new StorageError('Event journal is malformed.')
  }

  const saved = items as Partial<Record<keyof Counts, unknown>>
  const retired = saved.retired_through_ms
  const answers = saved.answers_count ?? 0
  const changes = saved.changes_count ?? 0

  if (retired === undefined || !count_valid(retired, -1)) {
    throw new StorageError('Invalid replay watermark.')
  }

  for (const count of [answers, changes]) {
    if (count === undefined || !count_valid(count, 0)) {
      throw new StorageError('Invalid journal counter.')
    }
  }

  const counts = {
    retired_through_ms: retired as number,
    answers_count: answers as number,
    changes_count: changes as number,
  }
  assert(counts.retired_through_ms >= -1, 'the watermark is a time or none')
  assert(counts.answers_count >= 0 && counts.changes_count >= 0, 'counters count from zero')
  return counts
}

function events_read(items: unknown, legacy: boolean): BoardEvent[] {
  if (!Array.isArray(items) || items.length > events_count_max || !items.every(event_valid)) {
    throw new StorageError('Event journal is malformed.')
  }

  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new StorageError('Duplicate event in journal.')
  }

  if (legacy && items.some((e) => Object.keys(e).some((key) => !legacy_keys.has(key)))) {
    throw new StorageError('Legacy journal contains protocol 2 fields.')
  }

  const events = legacy ? items.map((e) => ({ ...e, request_id: legacy_request_id(e) })) : items
  const ids = events.flatMap((e) => (e.request_id ? [e.request_id] : []))

  if (new Set(ids).size !== ids.length) throw new StorageError('Duplicate request in journal.')

  assert(events.length === items.length, 'reading keeps every saved request')
  assert(!legacy || ids.length === events.length, 'an upgraded request has a replay key')
  return events
}

const legacy_keys = new Set(['id', 'kind', 'sketch_hash', 'created_at_ms', 'state', 'message'])

// Old events predate request IDs. Preserve their event IDs for ACK and give their delivery a
// deterministic replay key, including on repeated opens before the next journal write.
function legacy_request_id(event: BoardEvent): string {
  assert(event_valid(event), 'legacy receipt has already passed journal validation')
  const hash = createHash('sha256').update(event.id).digest('hex')
  const stamp = Math.min(event.created_at_ms, 2 ** 48 - 1)
    .toString(16)
    .padStart(12, '0')
  const id =
    `${stamp.slice(0, 8)}-${stamp.slice(8)}-7${hash.slice(0, 3)}-` +
    `8${hash.slice(3, 6)}-${hash.slice(6, 18)}`
  assert(request_id_pattern.test(id), 'legacy and new receipts use the same delivery schema')
  return id
}

function request_ms(id: string): number {
  assert(request_id_pattern.test(id), 'request carries a UUIDv7 timestamp')
  const stamp = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
  assert(Number.isSafeInteger(stamp) && stamp < 2 ** 48, 'logical retirement time is exact')
  return stamp
}

const count_valid = (value: unknown, minimum: number) =>
  value === undefined ||
  (Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) < count_max)

// A message saved before answers were longer than a status line is kept as it was.
const message_stored_valid = (value: unknown) =>
  value === undefined ||
  (typeof value === 'string' && (value.length <= message_length_max || reply_text_valid(value)))

function event_valid(value: unknown): value is BoardEvent {
  const e = value as BoardEvent | null
  return (
    !!e &&
    Object.keys(e).every((key) => event_keys.has(key)) &&
    typeof e.id === 'string' &&
    /^[0-9a-f-]{36}$/.test(e.id) &&
    event_kinds_stored.includes(e.kind) &&
    event_states.includes(e.state) &&
    typeof e.sketch_hash === 'string' &&
    document_hash_pattern.test(e.sketch_hash) &&
    Number.isSafeInteger(e.created_at_ms) &&
    e.created_at_ms >= 0 &&
    (e.request_id === undefined ||
      (typeof e.request_id === 'string' && request_id_pattern.test(e.request_id))) &&
    (e.text === undefined ||
      (e.request_id !== undefined && request_text_valid(e.text) && e.text.length > 0)) &&
    (e.include_sketch === undefined ||
      (typeof e.include_sketch === 'boolean' && e.request_id !== undefined)) &&
    event_request_complete(e) &&
    (e.request_id === undefined ||
      Buffer.byteLength(
        JSON.stringify({
          kind: e.kind,
          sketch_hash: e.sketch_hash,
          request_id: e.request_id,
          text: e.text,
          include_sketch: e.include_sketch,
        }),
      ) <= request_size_bytes_max) &&
    message_stored_valid(e.message) &&
    count_valid(e.shapes_count, 0) &&
    count_valid(e.revision_sent, 0) &&
    count_valid(e.revision_answered, 0) &&
    count_valid(e.answer_seq, 1) &&
    count_valid(e.answered_at_ms, 0) &&
    (e.answer_seq === undefined || terminal(e.state)) &&
    (e.answered_at_ms === undefined || terminal(e.state)) &&
    (e.revision_answered === undefined || terminal(e.state))
  )
}
