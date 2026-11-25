import { assert } from '../shared/assert'
import { document_hash_pattern } from '../shared/constants'
import {
  event_kinds,
  event_states,
  events_count_max,
  message_length_max,
  type BoardEvent,
  type EventKind,
  type EventState,
} from '../shared/whiteboard'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

const file = 'events.state'
const terminal = (state: EventState) => state === 'updated' || state === 'failed'

export class BoardEvents {
  private constructor(
    private disk: Disk,
    private events: readonly BoardEvent[],
  ) {}

  static open(disk: Disk): BoardEvents {
    const bytes = disk.read(file)

    if (!bytes) return new BoardEvents(disk, [])

    const decoded = envelope_decode(bytes, 'events')

    if (!decoded.ok) throw new StorageError('Damaged event journal.')

    let items: unknown

    try {
      items = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
    } catch {
      throw new StorageError('Event journal is not JSON.')
    }

    if (!Array.isArray(items) || items.length > events_count_max || !items.every(event_valid)) {
      throw new StorageError('Event journal is malformed.')
    }

    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new StorageError('Duplicate event in journal.')
    }

    return new BoardEvents(disk, items)
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

  queue(kind: EventKind, hash: string, now_ms: number, id: string): BoardEvent | 'full' {
    assert(!this.events.some((item) => item.id === id), 'event ids are unique')
    const events = this.events.slice()

    if (events.length === events_count_max) {
      const index = events.findIndex((event) => terminal(event.state))

      if (index < 0) return 'full'

      const [retired] = events.splice(index, 1)
      assert(retired !== undefined && terminal(retired.state), 'only terminal events are retired')
    }

    const event: BoardEvent = {
      id,
      kind,
      sketch_hash: hash,
      created_at_ms: now_ms,
      state: 'queued',
    }
    assert(event_valid(event), 'new events are replayable')
    this.commit([...events, event])
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

  private commit(next: BoardEvent[]): void {
    assert(next.length > 0 && next.length <= events_count_max, 'event history fits')
    const payload = new TextEncoder().encode(JSON.stringify(next))
    const encoded = envelope_encode({ kind: 'events', label: '-', payload })
    this.disk.write_atomic(file, encoded)
    const written = this.disk.read(file)
    assert(written !== null && Buffer.from(encoded).equals(written), 'the journal reads back')
    assert(new Set(next.map((e) => e.id)).size === next.length, 'each id is addressable')
    this.events = next
  }
}

function event_valid(value: unknown): value is BoardEvent {
  const e = value as BoardEvent | null
  return (
    !!e &&
    typeof e.id === 'string' &&
    /^[0-9a-f-]{36}$/.test(e.id) &&
    event_kinds.includes(e.kind) &&
    event_states.includes(e.state) &&
    typeof e.sketch_hash === 'string' &&
    document_hash_pattern.test(e.sketch_hash) &&
    Number.isSafeInteger(e.created_at_ms) &&
    e.created_at_ms >= 0 &&
    (e.message === undefined ||
      (typeof e.message === 'string' && e.message.length <= message_length_max))
  )
}
