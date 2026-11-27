// The order of events behind the key's "just now": a revision arrives when the document a page
// holds advances, not when its print happens to finish drawing, and looking back or returning
// is never an arrival.

import { expect, test } from 'bun:test'
import {
  timeline_arrived,
  timeline_empty,
  timeline_step,
  type Timeline,
  type TimelineEvent,
} from './print_timeline'

type Document = { revision: number }

function run(events: TimelineEvent<Document>[]): Timeline<Document> {
  let timeline = timeline_empty<Document>()

  for (const event of events) timeline = timeline_step(timeline, event)

  return timeline
}

const document = (revision: number): TimelineEvent<Document> => ({
  kind: 'document',
  document: { revision },
})

test('the first document a page loads is not an arrival', () => {
  const timeline = run([document(2)])
  expect(timeline.current?.revision).toBe(2)
  expect(timeline.previous).toBeNull()
  expect(timeline_arrived(timeline)).toBeNull()
})

test('an advancing document arrives at once, whenever its print is drawn', () => {

  // A host trace held revision 3 while the print still showed a chosen view of 2, and only
  // decided the arrival later, from the order the prints finished drawing in.
  const timeline = run([document(2), document(3)])
  expect(timeline_arrived(timeline)).toEqual({ revision: 3, previous: 2 })

  // A reloaded copy of the same revision changes nothing.
  expect(timeline_step(timeline, document(3))).toBe(timeline)
})

test('back-to-back publishes each arrive, and only their own timer ends them', () => {
  const third = run([document(2), document(3)])
  const fourth = timeline_step(third, document(4))
  expect(timeline_arrived(fourth)).toEqual({ revision: 4, previous: 3 })
  expect(fourth.previous?.revision).toBe(3)

  // The timer of revision 3 fires late: revision 4 is still new.
  expect(timeline_step(fourth, { kind: 'expire', revision: 3 })).toBe(fourth)

  const calm = timeline_step(fourth, { kind: 'expire', revision: 4 })
  expect(timeline_arrived(calm)).toBeNull()
  expect(calm.previous?.revision).toBe(3)
})

test('looking back and returning is never an arrival', () => {
  const arrived = run([document(2), document(3)])
  const back = timeline_step(arrived, { kind: 'show_previous' })
  expect(back.showing_previous).toBe(true)
  expect(timeline_arrived(back)).toBeNull()

  // Returning inside the window finds the same arrival, not a new one.
  const returned = timeline_step(back, { kind: 'show_current' })
  expect(returned.arrival).toBe(arrived.arrival)

  // Returning after it ended does not announce the revision again.
  const late = run([
    document(2),
    document(3),
    { kind: 'show_previous' },
    { kind: 'expire', revision: 3 },
    { kind: 'show_current' },
  ])
  expect(late.showing_previous).toBe(false)
  expect(timeline_arrived(late)).toBeNull()
})

test('a newer revision ends a look back; nothing before the first can be looked at', () => {
  const back = run([document(2), document(3), { kind: 'show_previous' }])
  const fourth = timeline_step(back, document(4))
  expect(fourth.showing_previous).toBe(false)
  expect(timeline_arrived(fourth)).toEqual({ revision: 4, previous: 3 })

  const first = run([document(5), { kind: 'show_previous' }])
  expect(first.showing_previous).toBe(false)
})

test('an older document starts afresh, announcing nothing', () => {
  const timeline = run([document(3), document(4), document(1)])
  expect(timeline.current?.revision).toBe(1)
  expect(timeline.previous).toBeNull()
  expect(timeline_arrived(timeline)).toBeNull()
})
