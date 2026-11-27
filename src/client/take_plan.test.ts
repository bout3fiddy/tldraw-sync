// What a take copies, worked out without an editor: whole top-level shapes with everything they
// hold, bindings only between copied shapes, nothing reparented that was not copied, and the
// arc of an arrow that loses a binding kept on its circle. The editor journey is covered by
// the browser check; here every case is exact.

import { expect, test } from 'bun:test'
import { Prng } from '../simulation/prng'
import {
  arc_bend,
  print_subtree_hash,
  print_tree,
  taken_key,
  take_plan,
  type PrintRecord,
  type TakeRequest,
} from './take_plan'

const page = 'page:page'
const sketch_page = 'page:sketch'

function shape(id: string, type: string, parentId: string, extra: object = {}): PrintRecord {
  return {
    id: `shape:${id}`,
    typeName: 'shape',
    type,
    parentId,
    index: 'a1',
    x: 10,
    y: 20,
    rotation: 0,
    isLocked: true,
    opacity: 1,
    props: {},
    meta: { from_agent: true },
    ...extra,
  }
}

function binding(id: string, from: string, to: string): PrintRecord {
  return {
    id: `binding:${id}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: `shape:${from}`,
    toId: `shape:${to}`,
    props: { terminal: 'end' },
    meta: {},
  }
}

// A group of a box and an arrow bound inside it, a box outside it, an arrow from the group's
// box to the outside box, and an unrelated note.
const records: PrintRecord[] = [
  shape('group', 'group', page),
  shape('inner', 'geo', 'shape:group'),
  shape('inner_arrow', 'arrow', 'shape:group', { props: { kind: 'arc' } }),
  shape('outside', 'geo', page),
  shape('bridge', 'arrow', page, { props: { kind: 'arc' } }),
  shape('note', 'note', page),
  binding('inside', 'inner_arrow', 'inner'),
  binding('bridge_start', 'bridge', 'inner'),
  binding('bridge_end', 'bridge', 'outside'),
]

function request(roots: string[], from: PrintRecord[] = records): TakeRequest {
  let made = 0
  return {
    records: from,
    roots: roots.map((root) => `shape:${root}`),
    page_print: page,
    page_sketch: sketch_page,
    root_indices: roots.map((_, index) => `b${index}`),
    revision: 5,
    sketch_hash: '0123456789abcdef',
    id_make: (kind) => `${kind}:copy-${(made += 1)}`,
  }
}

test('a group is taken whole, parents first, onto the sketch page, with its own binding', () => {
  const plan = take_plan(request(['group']))
  expect(plan.kind).toBe('ready')

  if (plan.kind !== 'ready') return

  expect(plan.shapes.map((copy) => copy.source)).toEqual([
    'shape:group',
    'shape:inner',
    'shape:inner_arrow',
  ])
  const [group, inner, arrow] = plan.shapes.map((copy) => copy.record)
  expect(group).toMatchObject({ parentId: sketch_page, index: 'b0', isLocked: false })
  expect(inner).toMatchObject({ parentId: group!.id, index: 'a1', x: 10, y: 20 })
  expect(arrow!.parentId).toBe(group!.id)
  expect(group).not.toHaveProperty('typeName')
  expect(plan.shapes.every((copy) => !String(copy.record.id).includes('group'))).toBe(true)

  // Only the root records where it came from; children keep the agent's own metadata.
  expect((group!.meta as Record<string, unknown>).taken_from).toEqual({
    revision: 5,
    sketch_hash: '0123456789abcdef',
    shape_id: 'shape:group',
    print_hash: print_subtree_hash(print_tree(records), 'shape:group'),
  })
  expect(inner!.meta).toEqual({ from_agent: true })

  // The binding inside the group is copied between the copies. The bridge, which joins the
  // group to a shape left behind, is not taken: its bindings are left alone.
  expect(plan.bindings).toEqual([
    expect.objectContaining({ fromId: arrow!.id, toId: inner!.id, type: 'arrow' }),
  ])
  expect(plan.bindings[0]).not.toHaveProperty('typeName')
  expect(plan.arrows_loose.size).toBe(0)
})

test('an arrow bound to shapes left behind is taken unbound, its ends pinned by the board', () => {
  const plan = take_plan(request(['bridge']))
  expect(plan.kind).toBe('ready')

  if (plan.kind !== 'ready') return

  expect(plan.shapes).toHaveLength(1)
  expect(plan.bindings).toEqual([])
  const copy = String(plan.shapes[0]!.record.id)
  expect([...plan.arrows_loose.entries()]).toEqual([[copy, 'shape:bridge']])
})

test('taking every top-level shape keeps the bindings between them', () => {
  const plan = take_plan(request(['group', 'outside', 'bridge', 'note']))
  expect(plan.kind).toBe('ready')

  if (plan.kind !== 'ready') return

  expect(plan.shapes).toHaveLength(6)
  expect(plan.bindings).toHaveLength(3)
  expect(plan.arrows_loose.size).toBe(0)
  const ids = new Set(plan.shapes.map((copy) => copy.record.id))

  for (const copied of plan.bindings) {
    expect(ids.has(copied.fromId as string)).toBe(true)
    expect(ids.has(copied.toId as string)).toBe(true)
  }

  const roots = plan.shapes.filter((copy) => copy.record.parentId === sketch_page)
  expect(roots.map((copy) => copy.record.index)).toEqual(['b0', 'b1', 'b2', 'b3'])
})

test('a take is refused, whole, for what it cannot copy faithfully', () => {
  expect(take_plan(request(['inner']))).toEqual({ kind: 'refused', reason: 'not_top_level' })
  expect(take_plan(request(['missing']))).toEqual({ kind: 'refused', reason: 'missing' })

  // Media need assets the board does not keep, even inside a group.
  const pictured = [...records, shape('photo', 'image', 'shape:group')]
  expect(take_plan(request(['group'], pictured))).toEqual({
    kind: 'refused',
    reason: 'unsupported',
  })

  // An elbow arrow's route depends on what it joins: without them it would be redrawn.
  const elbow = records.map((record) =>
    record.id === 'shape:bridge' ? { ...record, props: { kind: 'elbow' } } : record,
  )
  expect(take_plan(request(['bridge'], elbow))).toEqual({ kind: 'refused', reason: 'elbow_bound' })
})

test('a fade key is read only from a well-formed take record', () => {
  expect(taken_key({ taken_from: { shape_id: 'shape:a', print_hash: 'ff' } })).toBe('shape:a ff')

  for (const meta of [null, {}, { taken_from: 'shape:a' }, { taken_from: { shape_id: 1 } }]) {
    expect(taken_key(meta)).toBeNull()
  }
})

// tldraw's own construction of an arc: the middle sits at med + per(u) * -bend, and the arc
// runs through both ends and that middle.
function arc_of(start: Point, end: Point, bend: number) {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const unit = { x: (end.x - start.x) / length, y: (end.y - start.y) / length }
  const per = { x: unit.y, y: -unit.x }
  const med = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const middle = { x: med.x - per.x * bend, y: med.y - per.y * bend }
  const centre = circle_centre(start, middle, end)
  return { middle, centre, radius: Math.hypot(start.x - centre.x, start.y - centre.y) }
}

type Point = { x: number; y: number }

function circle_centre(a: Point, b: Point, c: Point): Point {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  const square = (p: Point) => p.x * p.x + p.y * p.y
  return {
    x: (square(a) * (b.y - c.y) + square(b) * (c.y - a.y) + square(c) * (a.y - b.y)) / d,
    y: (square(a) * (c.x - b.x) + square(b) * (a.x - c.x) + square(c) * (b.x - a.x)) / d,
  }
}

// Seeded: a failing seed replays with the same arcs.
test('an arc keeps its circle and its side when its ends are pinned anywhere on it', () => {
  const prng = new Prng(20261127)

  for (let case_index = 0; case_index < 200; case_index += 1) {
    const start = { x: prng.between(-500, 500), y: prng.between(-500, 500) }
    const end = { x: start.x + prng.between(40, 600), y: start.y + prng.between(-300, 300) }
    const bend = prng.between(-200, 200) || 1
    const arc = arc_of(start, end, bend)

    // Unclipped, the bend comes back as it was.
    expect(arc_bend(start, end, arc.centre, arc.radius, arc.middle)).toBeCloseTo(bend, 6)

    // Clipped inward along the circle, the new arc keeps the circle and bulges the same way.
    const angle = (point: Point) => Math.atan2(point.y - arc.centre.y, point.x - arc.centre.x)
    const toward = (from: Point, to: Point, share: number) => {
      const a = angle(from)
      let delta = angle(to) - a
      delta = Math.atan2(Math.sin(delta), Math.cos(delta))
      const at = a + delta * share
      const { centre, radius } = arc
      return { x: centre.x + radius * Math.cos(at), y: centre.y + radius * Math.sin(at) }
    }
    const near = toward(start, arc.middle, 0.2)
    const far = toward(end, arc.middle, 0.2)
    const pinned = arc_of(near, far, arc_bend(near, far, arc.centre, arc.radius, arc.middle))
    expect(pinned.radius).toBeCloseTo(arc.radius, 4)
    expect(pinned.centre.x).toBeCloseTo(arc.centre.x, 4)
    expect(pinned.centre.y).toBeCloseTo(arc.centre.y, 4)
  }
})
