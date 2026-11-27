// What the print holds of the agent's revisions while a page is open, and when a revision is new.
// The page keeps the newest document and the one it replaced. A revision arrives when the
// canonical document a page holds advances past one it already held: the first document a page
// loads is not an arrival, and neither is looking back at the revision before or returning from
// it, nor choosing a view. Pure, so its order of events can be replayed without a browser;
// `print_engine` drives it and draws whatever it names.

import { assert } from '../shared/assert'

// A revision that replaced the one before while this page was open, and the one it replaced.
export type Arrival = { revision: number; previous: number }

export type Timeline<Document extends { revision: number }> = {
  current: Document | null
  previous: Document | null
  showing_previous: boolean
  arrival: Arrival | null
}

export type TimelineEvent<Document extends { revision: number }> =
  | { kind: 'document'; document: Document }
  | { kind: 'show_previous' }
  | { kind: 'show_current' }

  // The arrival window of `revision` ended. A later arrival is left alone.
  | { kind: 'expire'; revision: number }

export function timeline_empty<Document extends { revision: number }>(): Timeline<Document> {
  return { current: null, previous: null, showing_previous: false, arrival: null }
}

export function timeline_step<Document extends { revision: number }>(
  last: Timeline<Document>,
  event: TimelineEvent<Document>,
): Timeline<Document> {
  timeline_check(last)
  const next = timeline_next(last, event)
  timeline_check(next)
  return next
}

function timeline_next<Document extends { revision: number }>(
  last: Timeline<Document>,
  event: TimelineEvent<Document>,
): Timeline<Document> {
  if (event.kind === 'show_previous') {
    if (last.previous === null || last.showing_previous) return last

    return { ...last, showing_previous: true }
  }

  if (event.kind === 'show_current') {
    if (!last.showing_previous) return last

    return { ...last, showing_previous: false }
  }

  if (event.kind === 'expire') {
    if (last.arrival === null || last.arrival.revision !== event.revision) return last

    return { ...last, arrival: null }
  }

  const document = event.document
  assert(Number.isSafeInteger(document.revision) && document.revision >= 0, 'a revision is whole')
  const held = last.current

  // A reloaded copy of the revision held leaves the person where they chose to be.
  if (held !== null && held.revision === document.revision) return last

  // The first document, or one older than the one held (a different board's, or a stale
  // answer): a fresh start, with nothing before it to offer and nothing new to announce.
  if (held === null || document.revision < held.revision) {
    return { current: document, previous: null, showing_previous: false, arrival: null }
  }

  const arrival = { revision: document.revision, previous: held.revision }
  return { current: document, previous: held, showing_previous: false, arrival }
}

// The revision just arrived, while the person looks at the current one.
export function timeline_arrived<Document extends { revision: number }>(
  timeline: Timeline<Document>,
): Arrival | null {
  const { arrival, current } = timeline

  if (arrival === null || current === null || timeline.showing_previous) return null

  assert(arrival.revision === current.revision, 'an arrival names the revision held')
  return arrival
}

function timeline_check<Document extends { revision: number }>(timeline: Timeline<Document>) {
  const { current, previous, arrival } = timeline
  assert(current !== null || previous === null, 'a revision before needs a current one')
  assert(previous === null || previous.revision < current!.revision, 'the one before is older')
  assert(!timeline.showing_previous || previous !== null, 'only a held revision is looked at')

  if (arrival !== null) {
    assert(current?.revision === arrival.revision, 'an arrival is the revision held')
    assert(previous?.revision === arrival.previous, 'an arrival replaced the one before')
  }
}
