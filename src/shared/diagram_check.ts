// Whether composed shapes say exactly what their semantic diagram says, laid out legibly. The
// composer checks its own output with this before anything is published, and the board checks
// every styled proposal that carries a diagram, so a hand-edited or buggy composition is refused.
//
// Meaning: one shape per node and per connection, with the same id, the exact label, the
// matching kind, the same endpoints and the same arrowheads. Layout: every item sits inside its
// group, below the group's heading; items in the same group keep apart; every label fits its
// shape by the conservative text measure. Coordinates themselves are free.

import { assert } from './assert'
import {
  type Diagram,
  type DiagramEdgeDirection,
  type DiagramNode,
  type DiagramNodeKind,
  type ProposalArrowheads,
  type ProposalShape,
} from './cleanup_types'
import { type Problem } from './json_reader'
import { label_padding_units, text_block, type LabelFont } from './text_measure'

// Between a group's outline and what it holds, and between neighbours in the same group.
export const composed_padding_min_units = 8
export const composed_gap_min_units = 8

// The label size `text_measure.ts` estimates, and so the only one a composition may use.
const composed_label_size = 's'

// tldraw draws fixed-width text at least this wide, whatever width it is given.
const text_width_min_units = 16

// Between an oval's words and its outline, at the corners of the words' box.
const oval_margin_units = 4

export type Size = { w: number; h: number }

// tldraw wraps an oval's label at its full width less padding, like a rectangle's, so the
// corners of the words can reach past the curve. This is the box the words may take: a single
// line is no wider than estimated, but several lines may each run to the wrap width, since a
// browser may fit more words per line than the conservative estimate. A margin surrounds it.
export function oval_label_box(label: string, w: number, bold: boolean, font: LabelFont): Size {
  assert(w > label_padding_units * 2, 'an oval is wider than its padding')
  const wrap_units = w - label_padding_units * 2
  const block = text_block(label, wrap_units, bold, font)
  const width = block.lines_count > 1 ? wrap_units : block.width_units
  assert(width <= wrap_units, 'the words stay within the wrap width')
  return { w: width + oval_margin_units * 2, h: block.height_units + oval_margin_units * 2 }
}

// Whether a centred box lies inside the ellipse of this width and height: its corners do.
export function oval_holds(box: Size, w: number, h: number): boolean {
  assert(w > 0 && h > 0, 'an oval has an area')
  assert(box.w >= 0 && box.h >= 0, 'a box has a size')
  return (box.w / w) ** 2 + (box.h / h) ** 2 <= 1
}

type Box = { x: number; y: number; w: number; h: number }
type GeoShape = Extract<ProposalShape, { kind: 'rectangle' | 'ellipse' }>

const shape_kind_by_node_kind: Record<DiagramNodeKind, ProposalShape['kind']> = {
  box: 'rectangle',
  ellipse: 'ellipse',
  text: 'text',
  group: 'rectangle',
}

const arrowheads_by_direction: Record<DiagramEdgeDirection, ProposalArrowheads> = {
  forward: 'end',
  both: 'both',
  none: 'none',
}

export function node_shape_kind(kind: DiagramNodeKind): ProposalShape['kind'] {
  const shape_kind = shape_kind_by_node_kind[kind]
  assert(shape_kind !== undefined, 'every node kind has a shape kind')
  assert(shape_kind !== 'arrow', 'a node is never drawn as an arrow')
  return shape_kind
}

export function edge_arrowheads(direction: DiagramEdgeDirection): ProposalArrowheads {
  const arrowheads = arrowheads_by_direction[direction]
  assert(arrowheads !== undefined, 'every direction has arrowheads')
  assert((direction === 'forward') === (arrowheads === 'end'), 'forward points at the end')
  return arrowheads
}

// `font` is the face the proposal's style draws every label in, so the one it is measured in.
export function composition_check(
  diagram: Diagram,
  shapes: readonly ProposalShape[],
  font: LabelFont,
): Problem | null {
  assert(diagram.nodes.length > 0, 'a diagram has nodes')
  assert(shapes.length > 0, 'a composition has shapes')

  if (shapes.length !== diagram.nodes.length + diagram.edges.length) {
    return { path: 'shapes', message: 'Expected exactly one shape per diagram node and edge.' }
  }

  const by_id = new Map(shapes.map((shape) => [shape.id, shape]))
  const meaning = meaning_check(diagram, by_id)

  if (meaning !== null) return meaning

  const sizes = sizes_check(diagram, by_id, font)

  if (sizes !== null) return sizes

  const boxes = new Map<string, Box>()

  for (const node of diagram.nodes)
    boxes.set(node.id, node_box(by_id.get(node.id) as ProposalShape, font))

  const labels = labels_check(diagram, by_id, font)

  if (labels !== null) return labels

  const placement = placement_check(diagram, by_id, boxes, font)
  assert(boxes.size === diagram.nodes.length, 'every node has a box')
  return placement
}

function meaning_check(diagram: Diagram, by_id: ReadonlyMap<string, ProposalShape>) {
  assert(by_id.size <= diagram.nodes.length + diagram.edges.length, 'shapes are bounded')
  const node_ids = new Set(diagram.nodes.map((node) => node.id))

  for (const node of diagram.nodes) {
    const shape = by_id.get(node.id)
    const path = `diagram.nodes[${diagram.nodes.indexOf(node)}]`

    if (shape === undefined) return problem(path, 'This node has no shape.')

    if (shape.kind !== node_shape_kind(node.kind)) return problem(path, 'Its shape kind differs.')

    if (shape.text !== node.label) return problem(path, 'Its shape does not show its exact label.')

    if (node.kind === 'group' && (shape.kind !== 'rectangle' || shape.label_valign !== 'start')) {
      return problem(path, 'A group is a rectangle with its heading at the top.')
    }
  }

  for (const [index, edge] of diagram.edges.entries()) {
    const shape = by_id.get(edge.id)
    const path = `diagram.edges[${index}]`

    if (shape === undefined || shape.kind !== 'arrow') return problem(path, 'It has no arrow.')

    if (shape.from !== edge.from || shape.to !== edge.to) {
      return problem(path, 'Its arrow joins other nodes, or the other way round.')
    }

    if (shape.text !== edge.label) return problem(path, 'Its arrow does not show its exact label.')

    if (shape.arrowheads !== edge_arrowheads(edge.direction)) {
      return problem(path, 'Its arrowheads do not match its direction.')
    }
  }

  assert(node_ids.size === diagram.nodes.length, 'node ids are unique')
  return null
}

// What the measurements below rely on, checked first so a malformed shape is an ordinary
// problem: every node uses the one label size that was measured, text has a width to wrap at,
// and every group, empty or not, is wide enough for its padding and tall enough for its
// heading, its padding and some room below.
function sizes_check(diagram: Diagram, by_id: ReadonlyMap<string, ProposalShape>, font: LabelFont) {
  assert(by_id.size >= diagram.nodes.length, 'every node has a shape')

  for (const [index, node] of diagram.nodes.entries()) {
    const shape = by_id.get(node.id) as ProposalShape
    const path = `diagram.nodes[${index}]`
    assert(shape.kind !== 'arrow', 'meaning was checked: a node is never an arrow')

    if (shape.size !== composed_label_size) {
      return problem(path, `Its shape uses size "${shape.size}"; composed labels use "s".`)
    }

    if (shape.kind === 'text' && (shape.w === null || shape.w < text_width_min_units)) {
      return problem(path, `Its text needs a width of at least ${text_width_min_units} units.`)
    }

    if (node.kind !== 'group') continue

    const group = shape as GeoShape

    if (group.w <= label_padding_units * 2) {
      return problem(path, `A group is wider than ${label_padding_units * 2} units.`)
    }

    if (group_content_top(group, font) + composed_padding_min_units * 2 > group.y + group.h) {
      return problem(path, 'Its group is too small for its heading and padding.')
    }
  }

  return null
}

// A shape's page box. A text shape's height is what its words take at its width.
export function node_box(shape: ProposalShape, font: LabelFont): Box {
  assert(shape.kind !== 'arrow', 'an arrow has no box of its own')

  if (shape.kind === 'text') {
    assert(shape.w !== null, 'composed text was checked to have a width')
    return {
      x: shape.x,
      y: shape.y,
      w: shape.w,
      h: text_block(shape.text, shape.w, false, font).height_units,
    }
  }

  assert(shape.w > 0 && shape.h > 0, 'a geo shape has an area')
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
}

// The words of a box or oval fit inside its padding; a group's heading is measured separately.
function labels_check(
  diagram: Diagram,
  by_id: ReadonlyMap<string, ProposalShape>,
  font: LabelFont,
) {
  assert(by_id.size >= diagram.nodes.length, 'every node has a shape')

  for (const [index, node] of diagram.nodes.entries()) {
    const shape = by_id.get(node.id) as ProposalShape

    if (node.kind === 'text' || node.kind === 'group' || node.label === '') continue

    const geo = shape as GeoShape
    const inner_w = geo.w - label_padding_units * 2
    const inner_h = geo.h - label_padding_units * 2

    if (
      inner_w <= 0 ||
      text_block(node.label, inner_w, geo.label_bold, font).height_units > inner_h
    ) {
      return problem(`diagram.nodes[${index}].label`, 'Its label does not fit its shape.')
    }

    if (
      geo.kind === 'ellipse' &&
      !oval_holds(oval_label_box(node.label, geo.w, geo.label_bold, font), geo.w, geo.h)
    ) {
      return problem(`diagram.nodes[${index}].label`, 'Its label reaches past its oval.')
    }
  }

  assert(diagram.nodes.length > 0, 'a diagram has nodes')
  return null
}

// Inside the parent group, below its heading, and apart from every sibling.
function placement_check(
  diagram: Diagram,
  by_id: ReadonlyMap<string, ProposalShape>,
  boxes: ReadonlyMap<string, Box>,
  font: LabelFont,
): Problem | null {
  assert(boxes.size === diagram.nodes.length, 'every node has a box')
  const siblings = new Map<string | null, DiagramNode[]>()

  for (const [index, node] of diagram.nodes.entries()) {
    const box = boxes.get(node.id) as Box
    siblings.set(node.parent, [...(siblings.get(node.parent) ?? []), node])

    if (node.parent === null) continue

    const parent = by_id.get(node.parent) as GeoShape
    const outer = boxes.get(node.parent) as Box

    if (!box_inside(box, outer, group_content_top(parent, font))) {
      return problem(`diagram.nodes[${index}]`, 'It is not inside its group, below the heading.')
    }
  }

  for (const group of siblings.values()) {
    const found = overlap_find(group, boxes)

    if (found !== null) {
      const index = diagram.nodes.indexOf(found)
      return problem(`diagram.nodes[${index}]`, 'It overlaps another item in its group.')
    }
  }

  assert(siblings.size <= diagram.nodes.length + 1, 'sibling groups are bounded')
  return null
}

// Where a group's contents may start: below its heading, if it has one.
export function group_content_top(group: GeoShape, font: LabelFont): number {
  assert(group.kind === 'rectangle', 'a group is a rectangle')
  assert(group.w > label_padding_units * 2, 'a group is wider than its padding')

  if (group.text === '') return group.y + composed_padding_min_units

  const heading = text_block(group.text, group.w - label_padding_units * 2, group.label_bold, font)
  return group.y + label_padding_units + heading.height_units
}

function box_inside(box: Box, outer: Box, content_top: number): boolean {
  assert(box.w >= 0 && box.h >= 0, 'a box has a size')
  assert(content_top >= outer.y, 'content starts inside the group')
  const padding = composed_padding_min_units
  return (
    box.x >= outer.x + padding &&
    box.x + box.w <= outer.x + outer.w - padding &&
    box.y >= content_top &&
    box.y + box.h <= outer.y + outer.h - padding
  )
}

function overlap_find(group: readonly DiagramNode[], boxes: ReadonlyMap<string, Box>) {
  assert(group.length > 0, 'a sibling group is not empty')
  const gap = composed_gap_min_units

  for (let first = 0; first < group.length; first += 1) {
    const a = boxes.get((group[first] as DiagramNode).id) as Box

    for (let second = first + 1; second < group.length; second += 1) {
      const b = boxes.get((group[second] as DiagramNode).id) as Box
      const apart =
        a.x + a.w + gap <= b.x ||
        b.x + b.w + gap <= a.x ||
        a.y + a.h + gap <= b.y ||
        b.y + b.h + gap <= a.y

      if (!apart) return group[second] as DiagramNode
    }
  }

  assert(gap > 0, 'neighbours keep a gap')
  return null
}

function problem(path: string, message: string): Problem {
  assert(path.length > 0, 'a problem names where it is')
  assert(message.endsWith('.'), 'a problem is a full sentence')
  return { path, message }
}
