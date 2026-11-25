// Plans each connector of a composed diagram as tldraw will draw it. tldraw routes a bound
// connector itself and avoids only the two shapes it joins, so the composer predicts that path
// and chooses one that stays clear of everything else:
//
//   - an elbow, for a connection from one layer to a later one, or between items stacked in the
//     same layer: it leaves the near side, turns once halfway across the gap, and enters the far
//     side, at the heights ELK chose for its ports;
//   - otherwise an arc that leaves and enters the same side of both items and bows out past
//     whatever lies between them, as a feedback loop usually is drawn.
//
// Each candidate path, and its label at the middle of the path, is checked against every item
// the connection does not join. The first clear candidate wins. When none is clear, the one
// with the fewest conflicts is kept and reported, never hidden. Planning works in flow space,
// where layers run left to right; a downward flow is mirrored across the diagonal.

import { assert } from '../shared/assert'
import type { Diagram, DiagramEdge, ProposalAnchor } from '../shared/cleanup_types'
import { text_block, type LabelFont } from '../shared/text_measure'

export type Point = { x: number; y: number }
export type Box = { x: number; y: number; w: number; h: number }
export type Ports = { start: Point; end: Point }

export type RoutePlan = {
  route: 'arc' | 'elbow'
  bend: number
  from_anchor: ProposalAnchor
  to_anchor: ProposalAnchor
  conflicts_count: number
}

type Side = 'bottom' | 'top' | 'right' | 'left'
type Candidate = {
  route: 'arc' | 'elbow'
  path: Point[]
  from_anchor: ProposalAnchor
  to_anchor: ProposalAnchor

  // An arc's chord ends and the way it bows, to compute tldraw's bend once it is chosen.
  arc: { start: Point; end: Point; sagitta: number; normal: Point } | null
}

// Connectors leave the middle part of a side, need some room to turn, and bow by doubling
// sizes up to a bound; the last arc goes around the whole diagram.
const anchor_margin = 0.2
const leg_gap_min_units = 24
const straight_snap_units = 16
const sagittas_units = [48, 96, 192, 384]
const arc_clearance_units = 40
const arc_samples_count = 32
const label_wrap_units = 160
const label_padding_units = 8
const obstacle_inset_units = 1

// `font` is the face connector labels are drawn in, so the one their boxes are measured in.
export function routes_plan(
  diagram: Diagram,
  boxes_page: ReadonlyMap<string, Box>,
  ports_page: ReadonlyMap<string, Ports>,
  font: LabelFont,
): Map<string, RoutePlan> {
  assert(boxes_page.size === diagram.nodes.length, 'every node has a box')
  assert(ports_page.size === diagram.edges.length, 'every edge has ports')
  const mirrored = diagram.flow === 'down'
  const boxes = new Map([...boxes_page].map(([id, box]) => [id, box_flow(box, mirrored)]))
  const plans = new Map<string, RoutePlan>()

  for (const edge of diagram.edges) {
    const ports = ports_page.get(edge.id) as Ports
    const flow_ports = {
      start: point_flow(ports.start, mirrored),
      end: point_flow(ports.end, mirrored),
    }
    const obstacles = obstacles_find(diagram, boxes, edge)
    const best = candidates_rank(edge, boxes, flow_ports, obstacles, font)
    plans.set(edge.id, plan_from(best.candidate, best.conflicts_count, mirrored))
  }

  assert(plans.size === diagram.edges.length, 'every edge is planned')
  return plans
}

function point_flow(point: Point, mirrored: boolean): Point {
  assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'a point is finite')
  return mirrored ? { x: point.y, y: point.x } : point
}

function box_flow(box: Box, mirrored: boolean): Box {
  assert(box.w >= 0 && box.h >= 0, 'a box has a size')
  return mirrored ? { x: box.y, y: box.x, w: box.h, h: box.w } : box
}

// Everything a connection must not cross: items other than its ends, and groups that hold
// neither end. Its own ends' groups are crossed on the way out, which is expected.
function obstacles_find(diagram: Diagram, boxes: ReadonlyMap<string, Box>, edge: DiagramEdge) {
  const parents = new Map(diagram.nodes.map((node) => [node.id, node.parent]))
  const holders = new Set<string>()

  for (const end of [edge.from, edge.to]) {
    let parent = parents.get(end) ?? null

    for (let depth = 0; parent !== null; depth += 1) {
      assert(depth < diagram.nodes.length, 'containment is acyclic')
      holders.add(parent)
      parent = parents.get(parent) ?? null
    }
  }

  const obstacles: Box[] = []

  for (const node of diagram.nodes) {
    if (node.id === edge.from || node.id === edge.to || holders.has(node.id)) continue

    obstacles.push(boxes.get(node.id) as Box)
  }

  assert(obstacles.length <= diagram.nodes.length - 2, 'the ends are never obstacles')
  return obstacles
}

function candidates_rank(
  edge: DiagramEdge,
  boxes: ReadonlyMap<string, Box>,
  ports: Ports,
  obstacles: readonly Box[],
  font: LabelFont,
): { candidate: Candidate; conflicts_count: number } {
  const from = boxes.get(edge.from) as Box
  const to = boxes.get(edge.to) as Box
  const label = edge.label === '' ? null : text_block(edge.label, label_wrap_units, false, font)
  const extent = extent_find(boxes)
  let best: { candidate: Candidate; conflicts_count: number } | null = null

  for (const candidate of candidates_list(from, to, ports, extent)) {
    const label_box =
      label === null
        ? null
        : box_around(path_middle(candidate.path), label.width_units, label.height_units)
    const conflicts_count = conflicts_count_find(candidate.path, label_box, obstacles, from, to)

    if (best === null || conflicts_count < best.conflicts_count) {
      best = { candidate, conflicts_count }
    }

    if (conflicts_count === 0) break
  }

  assert(best !== null, 'there is always an arc to fall back on')
  assert(best.conflicts_count >= 0, 'a count is never negative')
  return best
}

function candidates_list(from: Box, to: Box, ports: Ports, extent: Box): Candidate[] {
  assert(from !== to, 'a connection joins two items')
  const candidates: Candidate[] = []
  const forward = elbow_forward(from, to, ports)

  if (forward !== null) candidates.push(forward)

  const stacked = elbow_stacked(from, to)

  if (stacked !== null) candidates.push(stacked)

  for (const sagitta of [...sagittas_units, null]) {
    for (const side of ['bottom', 'top', 'right', 'left'] as const) {
      const arc = arc_candidate(from, to, side, sagitta, extent)

      if (arc !== null) candidates.push(arc)
    }
  }

  assert(candidates.length > 0, 'some side always faces away from the chord')
  return candidates
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function elbow_forward(from: Box, to: Box, ports: Ports): Candidate | null {
  assert(from.w > 0 && to.w > 0, 'items have widths')
  const x1 = from.x + from.w
  const x2 = to.x

  if (x2 - x1 < leg_gap_min_units) return null

  const range = (box: Box) => ({
    lo: box.y + box.h * anchor_margin,
    hi: box.y + box.h * (1 - anchor_margin),
  })
  const a = range(from)
  const b = range(to)
  let y1 = clamp(ports.start.y, a.lo, a.hi)
  let y2 = clamp(ports.end.y, b.lo, b.hi)
  const lo = Math.max(a.lo, b.lo)
  const hi = Math.min(a.hi, b.hi)

  // Nearly level ends become one straight line where both items allow it.
  if (lo <= hi && Math.abs(y1 - y2) <= straight_snap_units) {
    y1 = clamp((y1 + y2) / 2, lo, hi)
    y2 = y1
  }

  const middle_x = (x1 + x2) / 2
  assert(middle_x > x1 && middle_x < x2, 'the turn is in the gap')
  return {
    route: 'elbow',
    path: [
      { x: x1, y: y1 },
      { x: middle_x, y: y1 },
      { x: middle_x, y: y2 },
      { x: x2, y: y2 },
    ],
    from_anchor: { x: 1, y: fraction((y1 - from.y) / from.h) },
    to_anchor: { x: 0, y: fraction((y2 - to.y) / to.h) },
    arc: null,
  }
}

// Items in the same layer, one above the other: from the near side of one to the other.
function elbow_stacked(from: Box, to: Box): Candidate | null {
  const below = to.y >= from.y + from.h + leg_gap_min_units
  const above = from.y >= to.y + to.h + leg_gap_min_units

  if (!below && !above) return null

  const lo = Math.max(from.x + from.w * anchor_margin, to.x + to.w * anchor_margin)
  const hi = Math.min(from.x + from.w * (1 - anchor_margin), to.x + to.w * (1 - anchor_margin))
  const x1 = lo <= hi ? (lo + hi) / 2 : from.x + from.w / 2
  const x2 = lo <= hi ? x1 : to.x + to.w / 2
  const y1 = below ? from.y + from.h : from.y
  const y2 = below ? to.y : to.y + to.h
  const middle_y = (y1 + y2) / 2
  assert(Math.abs(y2 - y1) >= leg_gap_min_units, 'there is room to turn')
  return {
    route: 'elbow',
    path: [
      { x: x1, y: y1 },
      { x: x1, y: middle_y },
      { x: x2, y: middle_y },
      { x: x2, y: y2 },
    ],
    from_anchor: { x: fraction((x1 - from.x) / from.w), y: below ? 1 : 0 },
    to_anchor: { x: fraction((x2 - to.x) / to.w), y: below ? 0 : 1 },
    arc: null,
  }
}

function fraction(value: number): number {
  const rounded = Math.round(clamp(value, 0, 1) * 1000) / 1000
  assert(rounded >= 0 && rounded <= 1, 'an anchor is on its item')
  return rounded
}

const side_anchor: Record<Side, ProposalAnchor> = {
  bottom: { x: 0.5, y: 1 },
  top: { x: 0.5, y: 0 },
  right: { x: 1, y: 0.5 },
  left: { x: 0, y: 0.5 },
}

const side_normal: Record<Side, Point> = {
  bottom: { x: 0, y: 1 },
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
}

// An arc from the middle of one side of `from` to the same side of `to`, bowing outwards by
// `sagitta`, or, when that is null, far enough to pass around the whole diagram.
function arc_candidate(
  from: Box,
  to: Box,
  side: Side,
  sagitta: number | null,
  extent: Box,
): Candidate | null {
  const normal = side_normal[side]
  const anchor = side_anchor[side]
  const start = { x: from.x + from.w * anchor.x, y: from.y + from.h * anchor.y }
  const end = { x: to.x + to.w * anchor.x, y: to.y + to.h * anchor.y }
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  assert(length > 0, 'two items never share a side midpoint')
  const across = { x: (end.y - start.y) / length, y: -(end.x - start.x) / length }
  const facing = across.x * normal.x + across.y * normal.y

  // An arc can only bow away from both items when the chord runs mostly along their sides.
  if (Math.abs(facing) < 0.5) return null

  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const corners = [
    { x: extent.x, y: extent.y },
    { x: extent.x + extent.w, y: extent.y },
    { x: extent.x, y: extent.y + extent.h },
    { x: extent.x + extent.w, y: extent.y + extent.h },
  ]
  const far = Math.max(...corners.map((corner) => corner.x * normal.x + corner.y * normal.y))
  const around =
    (far + arc_clearance_units - (middle.x * normal.x + middle.y * normal.y)) / Math.abs(facing)
  const bow = sagitta ?? Math.max(around, sagittas_units[0] as number)
  const bow_normal = facing > 0 ? across : { x: -across.x, y: -across.y }
  assert(bow > 0, 'an arc bows outwards')
  return {
    route: 'arc',
    path: arc_sample(start, end, bow, bow_normal),
    from_anchor: anchor,
    to_anchor: anchor,
    arc: { start, end, sagitta: bow, normal: bow_normal },
  }
}

// Points along the circular arc through `start`, `end` and the point `sagitta` off the chord's
// middle along `normal`: the arc tldraw draws for the matching bend.
function arc_sample(start: Point, end: Point, sagitta: number, normal: Point): Point[] {
  assert(sagitta > 0, 'an arc bows')
  const half = Math.hypot(end.x - start.x, end.y - start.y) / 2
  const radius = (half * half + sagitta * sagitta) / (2 * sagitta)
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const center = {
    x: middle.x + normal.x * (sagitta - radius),
    y: middle.y + normal.y * (sagitta - radius),
  }
  const angle_start = Math.atan2(start.y - center.y, start.x - center.x)
  const angle_apex = Math.atan2(normal.y, normal.x)
  let sweep = angle_apex - angle_start

  while (sweep > Math.PI) sweep -= 2 * Math.PI

  while (sweep < -Math.PI) sweep += 2 * Math.PI

  const points: Point[] = []

  for (let index = 0; index <= arc_samples_count; index += 1) {
    const angle = angle_start + (sweep * 2 * index) / arc_samples_count
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
  }

  assert(points.length === arc_samples_count + 1, 'an arc is sampled evenly')
  return points
}

function extent_find(boxes: ReadonlyMap<string, Box>): Box {
  assert(boxes.size > 0, 'a diagram has items')
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]

  for (const box of boxes.values()) {
    x0 = Math.min(x0, box.x)
    y0 = Math.min(y0, box.y)
    x1 = Math.max(x1, box.x + box.w)
    y1 = Math.max(y1, box.y + box.h)
  }

  assert(x1 > x0 && y1 > y0, 'a diagram has an extent')
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// The point halfway along a polyline, where tldraw centers a connector's label.
function path_middle(path: readonly Point[]): Point {
  assert(path.length >= 2, 'a path has two ends')
  const lengths = path.slice(1).map((point, index) => {
    const previous = path[index] as Point
    return Math.hypot(point.x - previous.x, point.y - previous.y)
  })
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2

  for (const [index, length] of lengths.entries()) {
    const a = path[index] as Point
    const b = path[index + 1] as Point

    if (remaining <= length && length > 0) {
      const t = remaining / length
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }

    remaining -= length
  }

  return path.at(-1) as Point
}

function box_around(center: Point, w: number, h: number): Box {
  assert(w >= 0 && h >= 0, 'a label has a size')
  const padded_w = w + label_padding_units * 2
  const padded_h = h + label_padding_units
  return { x: center.x - padded_w / 2, y: center.y - padded_h / 2, w: padded_w, h: padded_h }
}

function conflicts_count_find(
  path: readonly Point[],
  label: Box | null,
  obstacles: readonly Box[],
  from: Box,
  to: Box,
): number {
  assert(path.length >= 2, 'a path has two ends')
  let count = 0

  for (const obstacle of obstacles) {
    if (path_crosses(path, obstacle)) count += 1

    if (label !== null && boxes_overlap(label, obstacle)) count += 1
  }

  // A label must also stay off the two items it sits between.
  if (label !== null && (boxes_overlap(label, from) || boxes_overlap(label, to))) count += 1

  assert(count <= obstacles.length * 2 + 1, 'each obstacle counts at most twice')
  return count
}

function boxes_overlap(a: Box, b: Box): boolean {
  assert(a.w >= 0 && b.w >= 0, 'boxes have sizes')
  const inset = obstacle_inset_units
  return (
    a.x + a.w > b.x + inset &&
    b.x + b.w - inset > a.x &&
    a.y + a.h > b.y + inset &&
    b.y + b.h - inset > a.y
  )
}

// Whether any segment enters the box, shrunk by the inset: Liang-Barsky clipping per segment.
function path_crosses(path: readonly Point[], box: Box): boolean {
  assert(path.length >= 2, 'a path has two ends')
  const inset = obstacle_inset_units
  const [x0, y0] = [box.x + inset, box.y + inset]
  const [x1, y1] = [box.x + box.w - inset, box.y + box.h - inset]

  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1] as Point
    const b = path[index] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    let t0 = 0
    let t1 = 1
    const edges: Array<[number, number]> = [
      [-dx, a.x - x0],
      [dx, x1 - a.x],
      [-dy, a.y - y0],
      [dy, y1 - a.y],
    ]
    let inside = true

    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) inside = false
      } else if (p < 0) {
        t0 = Math.max(t0, q / p)
      } else {
        t1 = Math.min(t1, q / p)
      }
    }

    if (inside && t0 < t1) return true
  }

  return false
}

// Back from flow space to the page: anchors swap their axes, and tldraw's bend is the signed
// distance of the arc's middle from the chord, measured on the page.
function plan_from(candidate: Candidate, conflicts_count: number, mirrored: boolean): RoutePlan {
  assert(conflicts_count >= 0, 'a count is never negative')
  const anchor = (value: ProposalAnchor) => (mirrored ? { x: value.y, y: value.x } : value)
  let bend = 0

  if (candidate.arc !== null) {
    const start = point_flow(candidate.arc.start, mirrored)
    const end = point_flow(candidate.arc.end, mirrored)
    const normal = point_flow(candidate.arc.normal, mirrored)
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    const per = { x: (end.y - start.y) / length, y: -(end.x - start.x) / length }

    // tldraw puts the arc's middle at the chord's middle plus per(u) times -bend.
    const sign = per.x * normal.x + per.y * normal.y > 0 ? -1 : 1
    bend = Math.round(sign * candidate.arc.sagitta)
  }

  assert(candidate.route === 'arc' || bend === 0, 'only arcs bend')
  return {
    route: candidate.route,
    bend,
    from_anchor: anchor(candidate.from_anchor),
    to_anchor: anchor(candidate.to_anchor),
    conflicts_count,
  }
}
