// Arranges a diagram as its sketch was arranged. The agent gives each item the box its ink
// filled; this keeps how those boxes lay relative to each other and nothing else about them.
// What was left of something stays left of it, what was above stays above, and items that
// shared a column or a row still share it, while every item takes the size its typeset words
// need and the whole closes up to an even gap.
//
// Inside each group, and at the top level, every pair of items is ordered along each axis on
// which their sketch boxes are apart; a pair apart on neither axis is ordered along the one
// where their centres differ most. So every pair is ordered on at least one axis, and no two
// items can overlap. Each axis is then packed towards its origin: an item starts just past the
// furthest item ordered before it. A group is sized around what it holds, and placed among its
// own siblings the same way.
//
// A pure function of the diagram: no layout engine, no search, no retries. The work is one
// pass over the pairs of each group, bounded by the node limit squared.

import { assert } from '../shared/assert'
import { diagram_nodes_count_max } from '../shared/constants'
import type { Diagram, DiagramAt, DiagramNode } from '../shared/cleanup_types'
import type { Box } from './diagram_route'

export type Size = { w: number; h: number }

// The room a group keeps around what it holds: above for its heading, and on the other sides.
export type Frame = { top: number; side: number; width_min: number }

export type PlaceGaps = {
  // Between neighbours side by side, and between neighbours one above the other.
  readonly across: number
  readonly down: number

  // A wider gap for a pair joined by a labelled connector, keyed by `pair_key`.
  readonly pairs: ReadonlyMap<string, number>
}

type Axis = 0 | 1
type Item = { id: string; at: DiagramAt; size: Size }

// Sketch boxes that share less than this much of the smaller one's extent are apart.
const apart_fraction_max = 0.3

export function pair_key(a: string, b: string): string {
  assert(a !== b, 'a pair is two items')
  return a < b ? `${a} ${b}` : `${b} ${a}`
}

// `sizes` holds every item but the groups; `frames` holds every group.
export function diagram_place(
  diagram: Diagram,
  sizes: ReadonlyMap<string, Size>,
  frames: ReadonlyMap<string, Frame>,
  gaps: PlaceGaps,
): Map<string, Box> {
  assert(diagram.nodes.length <= diagram_nodes_count_max, 'a placed diagram is bounded')
  assert(diagram.nodes.every((node) => node.at !== undefined), 'every node has a place')
  const children = children_find(diagram)
  const local = new Map<string, Box>()
  const measured = new Map<string, Size>(sizes)

  // Deepest groups first, so each group is sized before its parent places it.
  for (const group of groups_inner_first(diagram)) {
    const frame = frames.get(group.id) as Frame
    const extent = siblings_place(children.get(group.id) ?? [], measured, gaps, local)
    measured.set(group.id, {
      w: Math.max(extent.w + frame.side * 2, frame.width_min),
      h: frame.top + extent.h + frame.side,
    })
  }

  siblings_place(children.get(null) ?? [], measured, gaps, local)
  assert(local.size === diagram.nodes.length, 'every node was placed among its siblings')
  return boxes_absolute(diagram, local, frames)
}

function children_find(diagram: Diagram): Map<string | null, DiagramNode[]> {
  const children = new Map<string | null, DiagramNode[]>()

  for (const node of diagram.nodes) {
    const siblings = children.get(node.parent) ?? []
    siblings.push(node)
    children.set(node.parent, siblings)
  }

  assert((children.get(null) ?? []).length > 0, 'a diagram has top-level items')
  return children
}

// Groups ordered so that a group comes before the group that holds it.
function groups_inner_first(diagram: Diagram): DiagramNode[] {
  const by_id = new Map(diagram.nodes.map((node) => [node.id, node]))
  const depth = (node: DiagramNode): number => {
    let count = 0

    for (let parent = node.parent; parent !== null; count += 1) {
      assert(count < by_id.size, 'containment is acyclic')
      parent = (by_id.get(parent) as DiagramNode).parent
    }

    return count
  }
  const groups = diagram.nodes.filter((node) => node.kind === 'group')
  const depths = new Map<string, number>()

  for (const group of groups) depths.set(group.id, depth(group))

  groups.sort((a, b) => (depths.get(b.id) as number) - (depths.get(a.id) as number))
  assert(groups.length <= diagram.nodes.length, 'groups are some of the nodes')
  return groups
}

// Places one group's items relative to the group's content corner, into `local`, and returns
// the extent they fill. An empty group fills nothing.
function siblings_place(
  nodes: readonly DiagramNode[],
  sizes: ReadonlyMap<string, Size>,
  gaps: PlaceGaps,
  local: Map<string, Box>,
): Size {
  const items = nodes.map((node) => {
    const size = sizes.get(node.id)
    assert(size !== undefined && node.at !== undefined, 'a placed item has a size and a place')
    return { id: node.id, at: node.at, size }
  })
  const xs = axis_pack(items, 0, gaps)
  const ys = axis_pack(items, 1, gaps)
  const extent = { w: 0, h: 0 }

  for (const item of items) {
    const box = { x: xs.get(item.id) as number, y: ys.get(item.id) as number, ...item.size }
    local.set(item.id, box)
    extent.w = Math.max(extent.w, box.x + box.w)
    extent.h = Math.max(extent.h, box.y + box.h)
  }

  assert(extent.w >= 0 && extent.h >= 0, 'an extent is never negative')
  return extent
}

const lo = (at: DiagramAt, axis: Axis): number => at[axis]
const length = (at: DiagramAt, axis: Axis): number => at[axis + 2] as number
const centre = (at: DiagramAt, axis: Axis): number => lo(at, axis) + length(at, axis) / 2

// How far apart two sketch boxes are along an axis: negative where they share some of it.
function gap(a: DiagramAt, b: DiagramAt, axis: Axis): number {
  const distance =
    Math.max(lo(a, axis), lo(b, axis)) -
    Math.min(lo(a, axis) + length(a, axis), lo(b, axis) + length(b, axis))
  assert(Number.isFinite(distance), 'sketch boxes are finite')
  return distance
}

// Whether two sketch boxes are apart along an axis: they share little of the smaller one.
// Handwriting slants and sprawls, so boxes that were meant apart often touch.
function apart(a: DiagramAt, b: DiagramAt, axis: Axis): boolean {
  const smaller = Math.min(length(a, axis), length(b, axis))
  assert(smaller >= 0, 'a sketch box has a size')

  if (smaller === 0) return gap(a, b, axis) > 0 || centre(a, axis) !== centre(b, axis)

  return -gap(a, b, axis) <= smaller * apart_fraction_max
}

// How far two centres are apart along an axis, in units of the boxes' mean extent there, so
// lines of writing, which are wide and short, count as stacked rather than side by side.
function centres_apart(a: DiagramAt, b: DiagramAt, axis: Axis): number {
  const extent = (length(a, axis) + length(b, axis)) / 2
  const distance = Math.abs(centre(a, axis) - centre(b, axis))
  assert(distance >= 0, 'a distance is never negative')
  return extent === 0 ? distance : distance / extent
}

// Whether a pair is ordered along `axis`. Apart on one axis only: that axis. Apart on both,
// a diagonal: every axis with clear space between the boxes, or else the one they are
// furthest apart on, so a wide item below does not push a column above it sideways. Apart on
// neither: the axis their centres differ most on. Every pair is ordered on at least one axis.
function ordered(a: DiagramAt, b: DiagramAt, axis: Axis): boolean {
  const other: Axis = axis === 0 ? 1 : 0
  const here = apart(a, b, axis)
  const there = apart(a, b, other)

  // A tie goes to the vertical axis, so exactly one axis wins it.
  const wins = (measure: (a: DiagramAt, b: DiagramAt, axis: Axis) => number): boolean =>
    axis === 1
      ? measure(a, b, axis) >= measure(a, b, other)
      : measure(a, b, axis) > measure(a, b, other)

  if (here && there) return gap(a, b, axis) > 0 || wins(gap)

  if (here || there) return here

  return wins(centres_apart)
}

// Positions along one axis. Items are visited by the centre of their sketch box, then by id,
// so the pairs ordered on this axis form no cycle and one pass packs them all.
function axis_pack(items: readonly Item[], axis: Axis, gaps: PlaceGaps): Map<string, number> {
  const sorted = [...items].sort((a, b) => {
    const difference = centre(a.at, axis) - centre(b.at, axis)
    return difference !== 0 ? difference : a.id < b.id ? -1 : 1
  })
  const gap = axis === 0 ? gaps.across : gaps.down
  const positions = new Map<string, number>()

  sorted.forEach((item, index) => {
    let position = 0

    for (const before of sorted.slice(0, index)) {
      if (!ordered(before.at, item.at, axis)) continue

      const extent = axis === 0 ? before.size.w : before.size.h
      const between = Math.max(gap, gaps.pairs.get(pair_key(before.id, item.id)) ?? 0)
      position = Math.max(position, (positions.get(before.id) as number) + extent + between)
    }

    positions.set(item.id, position)
  })

  assert(positions.size === items.length, 'every item has a position')
  assert([...positions.values()].every((position) => position >= 0), 'positions start at zero')
  return positions
}

// Page boxes from boxes relative to each parent's content corner, outermost groups first.
function boxes_absolute(
  diagram: Diagram,
  local: ReadonlyMap<string, Box>,
  frames: ReadonlyMap<string, Frame>,
): Map<string, Box> {
  const boxes = new Map<string, Box>()
  const pending = diagram.nodes.filter((node) => node.parent === null)
  const children = children_find(diagram)

  while (pending.length > 0) {
    const node = pending.pop() as DiagramNode
    const box = local.get(node.id) as Box
    const parent = node.parent === null ? null : (boxes.get(node.parent) as Box)
    const frame = node.parent === null ? null : (frames.get(node.parent) as Frame)
    const origin =
      parent === null || frame === null
        ? { x: 0, y: 0 }
        : { x: parent.x + frame.side, y: parent.y + frame.top }
    boxes.set(node.id, { x: origin.x + box.x, y: origin.y + box.y, w: box.w, h: box.h })
    pending.push(...(children.get(node.id) ?? []))
    assert(boxes.size <= diagram.nodes.length, 'the walk visits each node once')
  }

  assert(boxes.size === diagram.nodes.length, 'every node has a page box')
  return boxes
}
