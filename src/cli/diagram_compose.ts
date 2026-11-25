// Typesets a semantic diagram: the agent said what the sketch means, and this lays it out in one
// house style with the pinned ELK layered algorithm. Positions, sizes, spacing and connector
// ports are free; ids, labels, kinds, containment, endpoints and directions are copied exactly,
// and the result is checked against the diagram before it is returned.
//
// The house style is the markerboard: a precise layout drawn with handmade marks. The proposal
// names the style and the renderer draws it (see `proposal_styles`): thin black ink on white,
// with tldraw's deterministic hand-drawn outlines and open arrows and its upright handwritten
// face. No colour, tint or decoration. Every label is measured in the face it is drawn in.
//
// No network, no files, no model, no board: a pure function of the diagram, deterministic for
// the same diagram whatever order its items were listed in. The input limits bound the work:
// at most 80 nodes and 160 edges, laid out once, with no retries.

import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js'
import { assert, AssertionError } from '../shared/assert'
import {
  diagram_edges_count_max,
  diagram_nodes_count_max,
  proposal_size_bytes_max,
} from '../shared/constants'
import {
  proposal_format_styled,
  type Diagram,
  type DiagramEdge,
  type DiagramNode,
  type DiagramProposal,
  type ProposalShape,
  type ProposalStyle,
} from '../shared/cleanup_types'
import { edge_arrowheads, node_shape_kind, oval_label_box } from '../shared/diagram_check'
import { depth_measure } from '../shared/diagram_parse'
import { label_padding_units, style_font, text_block } from '../shared/text_measure'
import { proposal_parse } from '../server/cleanup_proposal'
import { diagram_place, pair_key, type Frame } from './diagram_place'
import { routes_plan, type Box, type Point, type Ports, type RoutePlan } from './diagram_route'

export type Composed = {

  // The styled proposal to publish, as JSON text and as the object it encodes.
  proposal: Record<string, unknown>
  text: string
  shapes: ProposalShape[]
  width_units: number
  height_units: number

  // Predicted crossings: connector paths or labels, as tldraw will draw them, that cross an
  // item they do not join. The planner avoids them where it can and counts the rest.
  route_conflicts_count: number
}

export type ComposeResult = { ok: true; composed: Composed } | { ok: false; message: string }

type Size = { w: number; h: number }
type Layout = { boxes: Map<string, Box>; routes: Map<string, Point[]> }

// The house style: one size of handwritten label, an 8-unit grid, generous but compact gaps.
const composed_style: ProposalStyle = 'markerboard'
const font = style_font(composed_style)
const grid_units = 8
const leaf_wrap_units = 168

// Words placed from the sketch are notes as often as labels, so they run to a longer line.
const note_wrap_units = 336
const heading_wrap_units = 320
const edge_label_wrap_units = 160
const label_slack_units = 8
const leaf_width_min_units = 128
const leaf_height_min_units = 56
const ellipse_factor = 1.3
const group_padding_units = 24
const heading_gap_units = 16
const node_gap_units = 32
const layer_gap_units = 64
const edge_gap_units = 16

// A diagram placed from the sketch: columns stand well apart, lines in a column sit close.
const place_gap_across_units = 48
const place_gap_down_units = 24

// Room on each side of a connector label for the line to leave and enter it.
const leg_room_units = 16

type Planned = { layout: Layout; plans: Map<string, RoutePlan>; conflicts_count: number }

export async function diagram_compose(input: DiagramProposal): Promise<ComposeResult> {
  const diagram = diagram_canonical(input.diagram)
  assert(diagram.nodes.length <= diagram_nodes_count_max, 'a composed diagram is bounded')
  assert(diagram.edges.length <= diagram_edges_count_max, 'a composed diagram is bounded')
  const sizes = sizes_measure(diagram)

  const chosen = await layouts_choose(diagram, sizes)

  if (typeof chosen === 'string') return { ok: false, message: chosen }

  const { layout, plans, conflicts_count } = chosen
  const shapes = shapes_build(diagram, layout, plans)
  const proposal = {
    format: proposal_format_styled,
    snapshot: input.snapshot,
    base_revision: input.base_revision,
    agent: input.agent,
    summary: input.summary,

    // Only when given, so a diagram from before sessions composes byte for byte as it did.
    ...(input.session === null ? {} : { session: input.session }),
    ...(input.title === null ? {} : { title: input.title }),
    shapes,
    style: composed_style,
    diagram: input.diagram,
  }
  const text = JSON.stringify(proposal)

  // The same checks the board makes: what is composed here is what a publish accepts.
  const parsed = proposal_parse(JSON.parse(text))

  if (!parsed.ok) return { ok: false, message: `${parsed.path}: ${parsed.message}` }

  if (new TextEncoder().encode(text).byteLength > proposal_size_bytes_max) {
    return { ok: false, message: `The composed diagram exceeds ${proposal_size_bytes_max} bytes.` }
  }

  const extent = extent_measure(layout.boxes)
  assert(parsed.proposal.diagram !== null, 'a composed proposal carries its diagram')
  assert(parsed.proposal.style === composed_style, 'a composed proposal names the house style')
  return {
    ok: true,
    composed: {
      proposal,
      text,
      shapes: parsed.proposal.shapes,
      width_units: extent.w,
      height_units: extent.h,
      route_conflicts_count: conflicts_count,
    },
  }
}

// A label needs a wide gap only where its connector runs between layers; one that ends up as
// an arc around the diagram does not. So the layout runs at most twice: with room for every
// label, then with room only for labelled elbows, keeping the second only when it is no worse.
// Both runs are deterministic. ELK is a third-party engine: an error it throws is reported as
// a failed composition, while an assertion failure of ours still stops the process.
async function layouts_choose(
  diagram: Diagram,
  sizes: ReadonlyMap<string, Size>,
): Promise<Planned | string> {
  assert(sizes.size <= diagram.nodes.length, 'only nodes are sized')

  // A diagram that says where its items sat in the sketch is arranged as the sketch was.
  if (diagram.nodes.every((node) => node.at !== undefined)) return placed_plan(diagram, sizes)

  try {
    const first = await layout_plan(diagram, sizes, null)
    const elbows = new Set(
      diagram.edges
        .filter((edge) => edge.label !== '' && first.plans.get(edge.id)?.route === 'elbow')
        .map((edge) => edge.id),
    )
    const labelled_count = diagram.edges.filter((edge) => edge.label !== '').length

    if (elbows.size === labelled_count) return first

    const second = await layout_plan(diagram, sizes, elbows)
    return second.conflicts_count <= first.conflicts_count ? second : first
  } catch (error) {
    if (error instanceof AssertionError) throw error

    return `The layout engine failed: ${String(error).slice(0, 200)}.`
  }
}

// One ELK layout and its connector plan. `labelled` limits which labelled connectors widen
// the gaps between layers; null widens them for all.
async function layout_plan(
  diagram: Diagram,
  sizes: ReadonlyMap<string, Size>,
  labelled: ReadonlySet<string> | null,
): Promise<Planned> {
  const graph = elk_graph(diagram, sizes, layer_gaps_measure(diagram, labelled))
  const layout = layout_read(await new ELK().layout(graph), diagram)
  const plans = routes_plan(diagram, layout.boxes, ports_find(layout), font)
  let conflicts_count = 0

  for (const plan of plans.values()) conflicts_count += plan.conflicts_count

  assert(plans.size === diagram.edges.length, 'every edge is planned')
  assert(conflicts_count >= 0, 'a count is never negative')
  return { layout, plans, conflicts_count }
}

// The sketch's own arrangement, typeset: no layout engine, one deterministic pass. Connectors
// aim from the middle of one item to the middle of the other, and the planner picks the sides.
function placed_plan(diagram: Diagram, sizes: ReadonlyMap<string, Size>): Planned {
  const frames = new Map(
    diagram.nodes
      .filter((node) => node.kind === 'group')
      .map((node) => [node.id, group_frame(node)]),
  )
  const boxes = diagram_place(diagram, sizes, frames, {
    across: place_gap_across_units,
    down: place_gap_down_units,
    pairs: pair_gaps_measure(diagram),
  })
  const middle = (id: string): Point => {
    const box = boxes.get(id) as Box
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  }
  const ports = new Map(
    diagram.edges.map((edge) => [edge.id, { start: middle(edge.from), end: middle(edge.to) }]),
  )
  const plans = routes_plan(diagram, boxes, ports, font)
  let conflicts_count = 0

  for (const plan of plans.values()) conflicts_count += plan.conflicts_count

  assert(boxes.size === diagram.nodes.length, 'every node is placed')
  assert(plans.size === diagram.edges.length, 'every edge is planned')
  return { layout: { boxes, routes: new Map() }, plans, conflicts_count }
}

// The gap a labelled connector needs between the two items it runs between: its ends, or the
// groups that hold them where the ends are not siblings. Keyed by `pair_key`.
function pair_gaps_measure(diagram: Diagram): Map<string, number> {
  const parents = new Map(diagram.nodes.map((node) => [node.id, node.parent]))
  const gaps = new Map<string, number>()

  // The item directly inside `holder` that is, or holds, `id`.
  const under = (id: string, holder: string | null): string => {
    let current = id

    for (let depth = 0; (parents.get(current) ?? null) !== holder; depth += 1) {
      assert(depth < parents.size, 'containment is acyclic')
      current = parents.get(current) as string
    }

    return current
  }

  for (const edge of diagram.edges) {
    if (edge.label === '') continue

    const holder = holder_common(parents, edge.from, edge.to)
    const key = pair_key(under(edge.from, holder), under(edge.to, holder))
    const label = text_block(edge.label, edge_label_wrap_units, false, font)
    const room = Math.max(label.width_units, label.height_units)
    const gap = grid_ceil(room + label_slack_units * 2 + leg_room_units * 2)
    gaps.set(key, Math.max(gaps.get(key) ?? 0, gap))
  }

  assert(gaps.size <= diagram.edges.length, 'at most one gap per connector')
  assert([...gaps.values()].every((gap) => gap > 0), 'a label needs room')
  return gaps
}

// Items sorted by id, so the listing order an agent happened to use changes nothing.
function diagram_canonical(diagram: Diagram): Diagram {
  const by_id = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const nodes = [...diagram.nodes].sort(by_id)
  const edges = [...diagram.edges].sort(by_id)
  assert(nodes.length === diagram.nodes.length, 'sorting keeps every node')
  assert(edges.length === diagram.edges.length, 'sorting keeps every edge')
  return { flow: diagram.flow, nodes, edges }
}

function grid_ceil(units: number): number {
  assert(Number.isFinite(units) && units >= 0, 'a size is a number')
  const rounded = Math.ceil(units / grid_units) * grid_units
  assert(rounded >= units, 'sizes round up')
  return rounded
}

// Boxes and ovals in the same group share one width, so each group reads as a set; heights
// follow their words. Text keeps its own width. Groups are sized by the layout around them.
function sizes_measure(diagram: Diagram): Map<string, Size> {
  const padding = label_padding_units * 2 + label_slack_units
  const widths = new Map<string | null, number>()

  for (const node of diagram.nodes) {
    if (node.kind !== 'box' && node.kind !== 'ellipse') continue

    const label = text_block(node.label, leaf_wrap_units, false, font)
    const natural = grid_ceil(label.width_units + padding)
    widths.set(node.parent, Math.max(widths.get(node.parent) ?? leaf_width_min_units, natural))
  }

  const sizes = new Map<string, Size>()

  for (const node of diagram.nodes) {
    if (node.kind === 'group') continue

    if (node.kind === 'text') {
      const wrap = node.at === undefined ? leaf_wrap_units : note_wrap_units
      const block = text_block(node.label, wrap, false, font)
      const w = grid_ceil(block.width_units + label_slack_units)
      sizes.set(node.id, { w, h: grid_ceil(text_block(node.label, w, false, font).height_units) })
      continue
    }

    const width = widths.get(node.parent) as number
    const block = text_block(node.label, width - label_padding_units * 2, false, font)
    const h = Math.max(leaf_height_min_units, grid_ceil(block.height_units + padding))

    if (node.kind === 'box') {
      sizes.set(node.id, { w: width, h })
      continue
    }

    // An oval is wider than its box neighbours, and tall enough that its words, as tldraw
    // wraps them, stay inside the curve.
    const w = grid_ceil(width * ellipse_factor)
    const words = oval_label_box(node.label, w, false, font)
    assert(words.w < w, 'an oval is wider than the words it wraps')
    const h_fit = words.h / Math.sqrt(1 - (words.w / w) ** 2)
    sizes.set(node.id, { w, h: grid_ceil(Math.max(h * ellipse_factor, h_fit)) })
  }

  const groups_count = diagram.nodes.filter((node) => node.kind === 'group').length
  assert(sizes.size + groups_count === diagram.nodes.length, 'every item but a group is sized')
  assert(
    [...widths.values()].every((w) => w >= leaf_width_min_units),
    'boxes are wide enough',
  )
  return sizes
}

// The gap between layers inside each group, and at the top level, wide enough for the widest
// connector label among the connections that group holds. Unlabelled diagrams stay compact.
function layer_gaps_measure(
  diagram: Diagram,
  labelled: ReadonlySet<string> | null,
): Map<string, number> {
  const parents = new Map(diagram.nodes.map((node) => [node.id, node.parent]))
  const gaps = new Map<string, number>()

  for (const edge of diagram.edges) {
    if (edge.label === '') continue

    if (labelled !== null && !labelled.has(edge.id)) continue

    const holder = holder_common(parents, edge.from, edge.to) ?? elk_root_id
    const label = text_block(edge.label, edge_label_wrap_units, false, font).width_units
    const gap = grid_ceil(label + label_slack_units * 2 + leg_room_units * 2)
    gaps.set(holder, Math.max(gaps.get(holder) ?? layer_gap_units, gap))
  }

  assert(gaps.size <= diagram.nodes.length + 1, 'one gap per group and the top level')
  assert(
    [...gaps.values()].every((gap) => gap >= layer_gap_units),
    'gaps only widen',
  )
  return gaps
}

// The innermost group that holds both nodes, or null at the top level.
function holder_common(
  parents: ReadonlyMap<string, string | null>,
  a: string,
  b: string,
): string | null {
  assert(parents.has(a) && parents.has(b), 'both nodes are in the diagram')
  const holders_a = new Set<string>()

  for (let parent = parents.get(a) ?? null; parent !== null; parent = parents.get(parent) ?? null) {
    assert(holders_a.size < parents.size, 'containment is acyclic')
    holders_a.add(parent)
  }

  for (let parent = parents.get(b) ?? null; parent !== null; parent = parents.get(parent) ?? null) {
    if (holders_a.has(parent)) return parent
  }

  return null
}

// A group's heading: bold words wrapped at most `heading_wrap_units` wide.
function heading_measure(node: DiagramNode): Size {
  assert(node.kind === 'group', 'only groups have headings')

  if (node.label === '') return { w: 0, h: 0 }

  const block = text_block(node.label, heading_wrap_units, true, font)
  assert(block.width_units <= heading_wrap_units, 'a heading wraps')
  return { w: block.width_units, h: block.height_units }
}

// Node ids are letters, digits, _ and -, so the colon keeps the root apart from every node.
const elk_root_id = 'root:diagram'

// Spacing is set on the root and on every group, so nested contents keep the same rhythm. Only
// the gap between layers widens, where a group holds labelled connectors.
function elk_spacing(layer_gap: number): Record<string, string> {
  assert(layer_gap >= layer_gap_units, 'a layer gap only widens')
  assert(layer_gap % grid_units === 0, 'a layer gap is on the grid')
  return {
    'elk.spacing.nodeNode': String(node_gap_units),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(layer_gap),
    'elk.spacing.edgeNode': String(edge_gap_units),
    'elk.spacing.edgeEdge': String(edge_gap_units),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(edge_gap_units),
    'elk.layered.spacing.edgeEdgeBetweenLayers': String(edge_gap_units),
  }
}

// Connector labels are not given to ELK: tldraw centers each label on its connector, and the
// layer gaps above leave room for it. Labels as ELK nodes would push items into extra layers.
function elk_graph(
  diagram: Diagram,
  sizes: ReadonlyMap<string, Size>,
  gaps: ReadonlyMap<string, number>,
): ElkNode {
  const root: ElkNode = {
    id: elk_root_id,
    layoutOptions: {
      ...elk_spacing(gaps.get(elk_root_id) ?? layer_gap_units),
      'elk.algorithm': 'layered',
      'elk.direction': diagram.flow === 'down' ? 'DOWN' : 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': '1',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children: [],
    edges: diagram.edges.map(elk_edge),
  }
  const elk_nodes = new Map(
    diagram.nodes.map((node) => [node.id, elk_node(node, sizes, gaps.get(node.id), diagram.flow)]),
  )

  for (const node of diagram.nodes) {
    const parent = node.parent === null ? root : elk_nodes.get(node.parent)
    assert(parent !== undefined && parent.children !== undefined, 'a parent is a group')
    parent.children.push(elk_nodes.get(node.id) as ElkNode)
  }

  assert(elk_nodes.size === diagram.nodes.length, 'every node is in the graph')
  return root
}

function elk_node(
  node: DiagramNode,
  sizes: ReadonlyMap<string, Size>,
  gap: number | undefined,
  flow: Diagram['flow'],
): ElkNode {
  if (node.kind !== 'group') {
    const size = sizes.get(node.id)
    assert(size !== undefined, 'every leaf was sized')
    return { id: node.id, width: size.w, height: size.h }
  }

  const { top, side, width_min: w } = group_frame(node)
  const h = top + group_padding_units + grid_units

  // ELK 0.12.1 applies a compound node's minimum size in its rotated frame when the flow runs
  // down, so the minimum is given transposed there (checked by `diagram_compose.test.ts`).
  const minimum = flow === 'down' ? `(${h}, ${w})` : `(${w}, ${h})`
  assert(top >= group_padding_units, 'a heading only adds space')
  return {
    id: node.id,
    width: w,
    height: h,
    children: [],
    layoutOptions: {
      ...elk_spacing(gap ?? layer_gap_units),
      'elk.padding': `[top=${top},left=${side},bottom=${side},right=${side}]`,
      'elk.nodeSize.constraints': 'MINIMUM_SIZE',
      'elk.nodeSize.minimum': minimum,
    },
  }
}

// The room a group keeps around what it holds: its heading above, padding on the other sides,
// and a width that fits the heading whatever it holds.
function group_frame(node: DiagramNode): Frame {
  const heading = heading_measure(node)
  const top =
    heading.h === 0
      ? group_padding_units
      : grid_ceil(label_padding_units + heading.h + heading_gap_units)
  const width_min = grid_ceil(
    Math.max(heading.w + label_padding_units * 2 + label_slack_units, 96),
  )
  assert(top >= group_padding_units, 'a heading only adds space')
  assert(width_min % grid_units === 0, 'a group width is on the grid')
  return { top, side: group_padding_units, width_min }
}

function elk_edge(edge: DiagramEdge): ElkExtendedEdge {
  assert(edge.from !== edge.to, 'an edge joins two nodes')
  assert(edge.id !== elk_root_id, 'an edge id is never the root id')
  return { id: edge.id, sources: [edge.from], targets: [edge.to] }
}

// Page boxes for every node and page polylines for every edge, from ELK's nested coordinates:
// a child is placed relative to its parent, an edge relative to the node that contains it.
// The walk uses an explicit stack bounded by the node count. The diagram is moved so its top
// left corner is at (0, 0), and boxes snap to whole units.
function layout_read(result: ElkNode, diagram: Diagram): Layout {
  const offsets = new Map<string, { x: number; y: number }>([[elk_root_id, { x: 0, y: 0 }]])
  const raw = new Map<string, Box>()
  const pending: Array<{ node: ElkNode; x: number; y: number }> = [{ node: result, x: 0, y: 0 }]

  while (pending.length > 0) {
    const { node, x, y } = pending.pop() as { node: ElkNode; x: number; y: number }
    assert(raw.size <= diagram.nodes.length, 'the walk visits each node once')

    for (const child of node.children ?? []) {
      const box = {
        x: x + (child.x ?? 0),
        y: y + (child.y ?? 0),
        w: child.width ?? 0,
        h: child.height ?? 0,
      }
      raw.set(child.id, box)
      offsets.set(child.id, { x: box.x, y: box.y })
      pending.push({ node: child, x: box.x, y: box.y })
    }
  }

  assert(raw.size === diagram.nodes.length, 'ELK placed every node')
  const origin = origin_find(diagram, raw)
  const boxes = new Map<string, Box>()

  for (const [id, box] of raw) {
    const x = Math.round(box.x - origin.x)
    const y = Math.round(box.y - origin.y)
    boxes.set(id, {
      x,
      y,
      w: Math.ceil(box.x + box.w - origin.x) - x,
      h: Math.ceil(box.y + box.h - origin.y) - y,
    })
  }

  return { boxes, routes: routes_read(result, offsets, origin) }
}

function origin_find(diagram: Diagram, raw: ReadonlyMap<string, Box>): { x: number; y: number } {
  const tops = diagram.nodes.filter((node) => node.parent === null)
  assert(tops.length > 0, 'containment is a forest with at least one root')
  const origin = { x: Infinity, y: Infinity }

  for (const node of tops) {
    const box = raw.get(node.id) as Box
    origin.x = Math.min(origin.x, box.x)
    origin.y = Math.min(origin.y, box.y)
  }

  assert(Number.isFinite(origin.x) && Number.isFinite(origin.y), 'the diagram has a corner')
  return origin
}

function routes_read(
  result: ElkNode,
  offsets: ReadonlyMap<string, { x: number; y: number }>,
  origin: { x: number; y: number },
): Layout['routes'] {
  const routes: Layout['routes'] = new Map()

  for (const edge of result.edges ?? []) {
    const offset = offsets.get(edge.container ?? elk_root_id)
    assert(offset !== undefined, 'an edge lies in a known node')
    const points: Array<{ x: number; y: number }> = []

    for (const section of edge.sections ?? []) {
      for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
        points.push({ x: offset.x + point.x - origin.x, y: offset.y + point.y - origin.y })
      }
    }

    assert(points.length >= 2, 'ELK routed every edge')
    routes.set(edge.id, points)
  }

  return routes
}

// Groups first, outermost first, so each is drawn behind what it holds; then the items; then
// the connectors on top. Within each layer, canonical id order.
function shapes_build(
  diagram: Diagram,
  layout: Layout,
  plans: ReadonlyMap<string, RoutePlan>,
): ProposalShape[] {
  const by_id = new Map(diagram.nodes.map((node) => [node.id, node]))
  const depth = (node: DiagramNode) => depth_measure(by_id, node) as number
  const groups = diagram.nodes
    .filter((node) => node.kind === 'group')
    .sort((a, b) => depth(a) - depth(b))
  const items = diagram.nodes.filter((node) => node.kind !== 'group')
  const shapes: ProposalShape[] = [
    ...groups.map((node) => group_shape(node, layout.boxes.get(node.id) as Box)),
    ...items.map((node) => item_shape(node, layout.boxes.get(node.id) as Box)),
    ...diagram.edges.map((edge) => arrow_shape(edge, plans.get(edge.id))),
  ]
  assert(shapes.length === diagram.nodes.length + diagram.edges.length, 'one shape per item')
  assert(groups.length + items.length === diagram.nodes.length, 'every node is drawn')
  return shapes
}

// A group is a fine black outline around what it holds, open to the white board, so nesting
// reads by outline alone. Its heading is bold black handwriting.
function group_shape(node: DiagramNode, box: Box): ProposalShape {
  assert(node.kind === 'group', 'a group shape draws a group')
  assert(box.w > 0 && box.h > 0, 'a group has an area')
  return {
    kind: 'rectangle',
    id: node.id,
    ...box,
    text: node.label,
    color: 'black',
    size: 's',
    fill: 'none',
    label_color: 'black',
    label_align: 'start',
    label_valign: 'start',
    label_bold: true,
  }
}

// Boxes and ovals are fine black outlines around a white interior. The two kinds differ only
// as the sketch's shapes do, by outline: there is no colour to stand for anything.
function item_shape(node: DiagramNode, box: Box): ProposalShape {
  assert(node.kind !== 'group', 'groups are drawn apart')
  const kind = node_shape_kind(node.kind)

  if (kind === 'text') {
    return {
      kind,
      id: node.id,
      x: box.x,
      y: box.y,
      w: box.w,
      text: node.label,
      color: 'black',
      size: 's',

      // Words placed from the sketch are read as lines of notes, from a common left edge.
      align: node.at === undefined ? 'middle' : 'start',
    }
  }

  assert(kind === 'rectangle' || kind === 'ellipse', 'an item is text, a box or an oval')
  return {
    kind,
    id: node.id,
    ...box,
    text: node.label,
    color: 'black',
    size: 's',
    fill: 'semi',
    label_color: 'black',
    label_align: 'middle',
    label_valign: 'middle',
    label_bold: false,
  }
}

function arrow_shape(edge: DiagramEdge, plan: RoutePlan | undefined): ProposalShape {
  assert(plan !== undefined, 'every edge has a planned route')
  assert(plan.route === 'arc' || plan.bend === 0, 'only arcs bend')
  return {
    kind: 'arrow',
    id: edge.id,
    from: edge.from,
    to: edge.to,
    text: edge.label,
    color: 'black',
    size: 's',
    arrowheads: edge_arrowheads(edge.direction),
    route: plan.route,
    bend: plan.bend,
    from_anchor: plan.from_anchor,
    to_anchor: plan.to_anchor,
  }
}

// Where ELK attached each edge: the heights the planner gives elbow connectors.
function ports_find(layout: Layout): Map<string, Ports> {
  const ports = new Map<string, Ports>()

  for (const [id, route] of layout.routes) {
    assert(route.length >= 2, 'a route has two ends')
    ports.set(id, { start: route[0] as Point, end: route.at(-1) as Point })
  }

  assert(ports.size === layout.routes.size, 'every route has ports')
  return ports
}

function extent_measure(boxes: ReadonlyMap<string, Box>): Size {
  assert(boxes.size > 0, 'a diagram has boxes')
  let w = 0
  let h = 0

  for (const box of boxes.values()) {
    w = Math.max(w, box.x + box.w)
    h = Math.max(h, box.y + box.h)
  }

  assert(w > 0 && h > 0, 'a diagram has an extent')
  return { w, h }
}
