import { createHash } from 'node:crypto'
import { assert } from '../shared/assert'
import { document_hash_pattern } from '../shared/constants'
import {
  event_kinds,
  event_states,
  events_count_max,
  message_length_max,
  type BoardEvent,
  request_id_pattern,
  request_size_bytes_max,
  request_text_valid,
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
])
const terminal = (state: EventState) => state === 'updated' || state === 'failed'

export class BoardEvents {
  private constructor(
    private disk: Disk,
    private events: readonly BoardEvent[],
    private retired_through_ms = -1,
  ) {}

  static open(disk: Disk): BoardEvents {
    const bytes = disk.read(file)

    if (!bytes) return new BoardEvents(disk, [])

    if (bytes.length > 2 * 1024 * 1024) throw new StorageError('Oversized event journal.')

    const decoded = envelope_decode(bytes, 'events')

    if (!decoded.ok) throw new StorageError('Damaged event journal.')

    let items: unknown

    try {
      items = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded.envelope.payload))
    } catch {
      throw new StorageError('Event journal is not JSON.')
    }

    const legacy = Array.isArray(items)
    let retired = -1

    if (items && typeof items === 'object' && 'events' in items) {
      const saved = items as { events: unknown; retired_through_ms: number }
      retired = saved.retired_through_ms

      if (!Number.isSafeInteger(retired) || retired < -1 || retired >= 2 ** 48) {
        throw new StorageError('Invalid replay watermark.')
      }

      items = saved.events
    }

    if (!Array.isArray(items) || items.length > events_count_max || !items.every(event_valid)) {
      throw new StorageError('Event journal is malformed.')
    }

    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new StorageError('Duplicate event in journal.')
    }

    if (legacy && items.some((e) => e.request_id !== undefined || e.text !== undefined)) {
      throw new StorageError('Legacy journal contains protocol 2 fields.')
    }

    const events = legacy ? items.map((e) => ({ ...e, request_id: legacy_request_id(e) })) : items
    const ids = events.flatMap((e) => (e.request_id ? [e.request_id] : []))

    if (new Set(ids).size !== ids.length) throw new StorageError('Duplicate request in journal.')

    return new BoardEvents(disk, events, retired)
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

  replay(kind: EventKind, hash: string, request: EventRequest) {
    if (!request.request_id) return null

    const prior = this.events.find((e) => e.request_id === request.request_id)

    if (!prior) {
      return request_ms(request.request_id) <= this.retired_through_ms ? 'expired' : null
    }

    if (prior.kind !== kind || prior.sketch_hash !== hash || prior.text !== request.text) {
      return 'conflict'
    }

    assert(prior.request_id === request.request_id, 'retry returns its own receipt')
    assert(event_valid(prior), 'replay only echoes validated durable events')
    return prior
  }

  queue(kind: EventKind, hash: string, now_ms: number, id: string, request: EventRequest = {}) {
    assert(!this.events.some((item) => item.id === id), 'event ids are unique')
    const replay = this.replay(kind, hash, request)

    if (replay !== null) return replay

    if (request.request_id && request_ms(request.request_id) > now_ms + 300_000) return 'clock'

    const events = this.events.slice()
    let watermark = this.retired_through_ms

    if (events.length === events_count_max) {
      const index = events.findIndex((event) => terminal(event.state))

      if (index < 0) return 'full'

      const [retired] = events.splice(index, 1)
      assert(retired !== undefined && terminal(retired.state), 'only terminal events are retired')

      if (retired.request_id) watermark = Math.max(watermark, request_ms(retired.request_id))
    }

    const event: BoardEvent = {
      ...request,
      id,
      kind,
      sketch_hash: hash,
      created_at_ms: now_ms,
      state: 'queued',
    }
    assert(event_valid(event), 'new events are replayable')
    this.commit([...events, event], watermark)
    assert(this.latest() === event, 'the queued event is durable before delivery')
    return event
  }

  ack(id: string, state: EventState, message?: string): BoardEvent | 'missing' | 'transition' {
    const prior = this.events.find((event) => event.id === id)

    if (!prior) return 'missing'

    if (prior.state === state) return prior

    if (terminal(prior.state) || state === 'queued') return 'transition'

    if (prior.state === 'queued' && state !== 'received') return 'transition'

    if (prior.state === 'working' && !terminal(state)) return 'transition'

    const updated = { ...prior, state, message }
    assert(event_valid(updated), 'acknowledgements are replayable')
    const next = this.events.map((item) => (item === prior ? updated : item))
    assert(next.length === this.events.length, 'acknowledgement never removes a request')
    assert(updated.sketch_hash === prior.sketch_hash, 'the source does not move on receipt')
    this.commit(next)
    assert(this.events.includes(updated), 'the acknowledgement is durable')
    return updated
  }

  private commit(next: BoardEvent[], watermark = this.retired_through_ms): void {
    assert(next.length > 0 && next.length <= events_count_max, 'event history fits')
    assert(watermark >= this.retired_through_ms, 'expired requests never become fresh')
    const requests = next.flatMap((item) => (item.request_id ? [item.request_id] : []))
    assert(new Set(requests).size === requests.length, 'each replay key has one receipt')
    const payload = new TextEncoder().encode(
      JSON.stringify({
        events: next,
        retired_through_ms: watermark,
      }),
    )
    const encoded = envelope_encode({ kind: 'events', label: '-', payload })
    this.disk.write_atomic(file, encoded)
    const written = this.disk.read(file)
    assert(written !== null && Buffer.from(encoded).equals(written), 'the journal reads back')
    assert(new Set(next.map((e) => e.id)).size === next.length, 'each id is addressable')
    this.events = next
    this.retired_through_ms = watermark
  }
}

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

function event_valid(value: unknown): value is BoardEvent {
  const e = value as BoardEvent | null
  return (
    !!e &&
    Object.keys(e).every((key) => event_keys.has(key)) &&
    typeof e.id === 'string' &&
    /^[0-9a-f-]{36}$/.test(e.id) &&
    event_kinds.includes(e.kind) &&
    event_states.includes(e.state) &&
    typeof e.sketch_hash === 'string' &&
    document_hash_pattern.test(e.sketch_hash) &&
    Number.isSafeInteger(e.created_at_ms) &&
    e.created_at_ms >= 0 &&
    (e.request_id === undefined ||
      (typeof e.request_id === 'string' && request_id_pattern.test(e.request_id))) &&
    (e.text === undefined ||
      (e.request_id !== undefined && request_text_valid(e.text) && e.text.length > 0)) &&
    (e.request_id === undefined ||
      Buffer.byteLength(
        JSON.stringify({
          kind: e.kind,
          sketch_hash: e.sketch_hash,
          request_id: e.request_id,
          text: e.text,
        }),
      ) <= request_size_bytes_max) &&
    (e.message === undefined ||
      (typeof e.message === 'string' && e.message.length <= message_length_max))
  )
}
