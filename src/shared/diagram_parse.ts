// A semantic diagram is untrusted data from an agent, never code. This module checks one
// completely before anything is laid out or published: every id, label, parent, connection and
// limit. Containment must form a forest of groups at most `diagram_depth_max` deep; connections
// may form any cycles. Nothing is dropped or corrected: the first problem is reported, with the
// path to it, and the agent fixes it.

import { assert } from './assert'
import {
  diagram_at_units_max,
  diagram_depth_max,
  diagram_edges_count_max,
  diagram_label_length_max,
  diagram_nodes_count_max,
  diagram_stroke_ids_count_max,
} from './constants'
import {
  diagram_edge_directions,
  diagram_flows,
  diagram_format,
  diagram_node_kinds,
  type Diagram,
  type DiagramAt,
  type DiagramEdge,
  type DiagramNode,
  type DiagramProposal,
} from './cleanup_types'
import { header_keys, header_read, JsonReader, type Json } from './json_reader'

export type DiagramParsed =
  { ok: true; proposal: DiagramProposal } | { ok: false; path: string; message: string }

// Diagram ids become shape ids, so they follow the same rule as proposal shape ids.
export const diagram_id_pattern = /^[A-Za-z0-9_-]{1,40}$/

// The ids tldraw gives sketch shapes, which an agent may cite as the source of an item.
const stroke_id_pattern = /^shape:[A-Za-z0-9_-]{1,64}$/
const keys_root = [...header_keys, 'flow', 'nodes', 'edges'] as const
const keys_body = ['flow', 'nodes', 'edges'] as const
const keys_node = ['id', 'kind', 'label', 'parent', 'strokes', 'at'] as const
const keys_edge = ['id', 'from', 'to', 'label', 'direction', 'strokes'] as const

export function diagram_proposal_parse(input: unknown): DiagramParsed {
  const reader = new JsonReader()
  const root = reader.object(input, 'diagram', keys_root)

  if (root.format !== diagram_format) reader.fail('diagram.format', `Expected "${diagram_format}".`)

  const header = header_read(reader, root, 'diagram')
  const diagram = diagram_body_read(reader, root, 'diagram')

  if (reader.problem !== null) return { ok: false, ...reader.problem }

  assert(diagram.nodes.length > 0, 'a valid diagram has nodes')
  assert(diagram.nodes.length <= diagram_nodes_count_max, 'a valid diagram is bounded')
  return { ok: true, proposal: { ...header, diagram } }
}

// The diagram a styled proposal or a saved version carries: the same body, without a header.
export function diagram_read(reader: JsonReader, value: unknown, path: string): Diagram {
  assert(path.length > 0, 'a diagram has a path')
  const source = reader.object(value, path, keys_body)
  const diagram = diagram_body_read(reader, source, path)
  assert(diagram.edges.length <= diagram_edges_count_max, 'a read diagram is bounded')
  return diagram
}

function diagram_body_read(reader: JsonReader, source: Json, path: string): Diagram {
  assert(path.length > 0, 'a diagram body has a path')
  const flow = reader.choice(source, 'flow', path, diagram_flows, false)
  const nodes_input = reader.list(source.nodes, `${path}.nodes`, 1, diagram_nodes_count_max)
  const edges_input = reader.list(source.edges, `${path}.edges`, 0, diagram_edges_count_max)
  const nodes = nodes_input.map((item, index) => node_read(reader, item, `${path}.nodes[${index}]`))
  const edges = edges_input.map((item, index) => edge_read(reader, item, `${path}.edges[${index}]`))

  if (reader.problem === null) ids_check(reader, nodes, edges, path)

  if (reader.problem === null) containment_check(reader, nodes, path)

  if (reader.problem === null) edges_check(reader, nodes, edges, path)

  if (reader.problem === null) strokes_check(reader, nodes, edges, path)

  if (reader.problem === null) places_check(reader, nodes, path)

  assert(nodes.length === nodes_input.length, 'every node was read')
  assert(edges.length === edges_input.length, 'every edge was read')
  return { flow, nodes, edges }
}

function node_read(reader: JsonReader, value: unknown, path: string): DiagramNode {
  const source = reader.object(value, path, keys_node)
  const id = id_read(reader, source, 'id', path)
  const kind = reader.choice(source, 'kind', path, diagram_node_kinds, true)
  const label = reader.text(source, 'label', path, diagram_label_length_max, '')

  if (kind === 'text' && label.trim().length === 0) {
    reader.fail(`${path}.label`, 'A text node needs the words it shows.')
  }

  const parent =
    source.parent === undefined || source.parent === null
      ? null
      : id_read(reader, source, 'parent', path)
  const strokes = strokes_read(reader, source, path)
  const at = at_read(reader, source, path)
  assert(label.length <= diagram_label_length_max, 'a node label is bounded')
  assert(diagram_node_kinds.includes(kind), 'a node kind is known')

  // Left out when absent, so a diagram without places is stored as it always was.
  const node = { id, kind, label, parent, strokes }
  return at === null ? node : { ...node, at }
}

// An item's box in the sketch: [left, top, width, height], every number finite and bounded.
function at_read(reader: JsonReader, source: Json, path: string): DiagramAt | null {
  assert(path.length > 0, 'a place has a path')

  if (source.at === undefined || source.at === null) return null

  const items = reader.list(source.at, `${path}.at`, 4, 4)
  const numbers: number[] = []
  items.forEach((item, index) => {
    const min = index < 2 ? -diagram_at_units_max : 0

    if (typeof item !== 'number' || !Number.isFinite(item)) {
      reader.fail(`${path}.at[${index}]`, 'Expected a number.')
    } else if (item < min || item > diagram_at_units_max) {
      const range = `${min} to ${diagram_at_units_max}`
      reader.fail(`${path}.at[${index}]`, `Expected a number from ${range}.`)
    } else {
      numbers.push(item)
    }
  })

  if (numbers.length !== 4) return null

  assert(numbers.every((value) => Math.abs(value) <= diagram_at_units_max), 'a place is bounded')
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number, numbers[3] as number]
}

function edge_read(reader: JsonReader, value: unknown, path: string): DiagramEdge {
  const source = reader.object(value, path, keys_edge)
  const id = id_read(reader, source, 'id', path)
  const from = id_read(reader, source, 'from', path)
  const to = id_read(reader, source, 'to', path)
  const label = reader.text(source, 'label', path, diagram_label_length_max, '')
  const direction = reader.choice(source, 'direction', path, diagram_edge_directions, true)
  const strokes = strokes_read(reader, source, path)
  assert(label.length <= diagram_label_length_max, 'an edge label is bounded')
  assert(diagram_edge_directions.includes(direction), 'an edge direction is known')
  return { id, from, to, label, direction, strokes }
}

function id_read(reader: JsonReader, source: Json, key: string, path: string): string {
  assert(key.length > 0, 'an id field is named')
  const id = reader.text(source, key, path, 40, null)

  if (!diagram_id_pattern.test(id)) {
    reader.fail(`${path}.${key}`, 'Expected an id of 1 to 40 letters, digits, _ or -.')
  }

  assert(id.length <= 40, 'a read id is bounded')
  return id
}

function strokes_read(reader: JsonReader, source: Json, path: string): string[] {
  assert(path.length > 0, 'stroke ids have a path')

  if (source.strokes === undefined) return []

  const items = reader.list(source.strokes, `${path}.strokes`, 0, diagram_stroke_ids_count_max)
  const strokes: string[] = []
  items.forEach((item, index) => {
    if (typeof item !== 'string' || !stroke_id_pattern.test(item)) {
      reader.fail(`${path}.strokes[${index}]`, 'Expected a stroke id such as "shape:abc".')
      return
    }

    strokes.push(item)
  })
  assert(strokes.length <= diagram_stroke_ids_count_max, 'stroke ids are bounded')
  return strokes
}

// Nodes and edges both become shapes, so their ids share one namespace.
function ids_check(
  reader: JsonReader,
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  path: string,
): void {
  assert(reader.problem === null, 'ids are checked only in a well-formed diagram')
  const seen = new Set<string>()
  nodes.forEach((node, index) => {
    if (seen.has(node.id)) reader.fail(`${path}.nodes[${index}].id`, 'Ids must be unique.')

    seen.add(node.id)
  })
  edges.forEach((edge, index) => {
    if (seen.has(edge.id)) reader.fail(`${path}.edges[${index}].id`, 'Ids must be unique.')

    seen.add(edge.id)
  })
  assert(seen.size <= nodes.length + edges.length, 'ids are a subset of the items')
}

// Each parent is a group, and walking up from any node reaches the top within the depth
// limit. The walk is bounded by the node count, so a cycle is found rather than followed.
function containment_check(reader: JsonReader, nodes: DiagramNode[], path: string): void {
  assert(reader.problem === null, 'containment is checked only in a well-formed diagram')
  const by_id = new Map(nodes.map((node) => [node.id, node]))
  nodes.forEach((node, index) => {
    if (node.parent === null) return

    const parent = by_id.get(node.parent)

    if (parent === undefined || parent.kind !== 'group') {
      reader.fail(`${path}.nodes[${index}].parent`, 'Expected the id of a group node.')
    }
  })

  if (reader.problem !== null) return

  nodes.forEach((node, index) => {
    const depth = depth_measure(by_id, node)
    const where = `${path}.nodes[${index}].parent`

    if (depth === 'cycle') {
      reader.fail(where, 'Groups cannot contain themselves, even indirectly.')
    } else if (depth > diagram_depth_max) {
      reader.fail(where, `Groups nest at most ${diagram_depth_max} deep.`)
    }
  })
  assert(by_id.size === nodes.length, 'node ids are unique')
}

// How many groups hold this node, or 'cycle' when its parents loop.
export function depth_measure(
  by_id: ReadonlyMap<string, DiagramNode>,
  node: DiagramNode,
): number | 'cycle' {
  assert(by_id.get(node.id) === node, 'the node is one of the diagram')
  let depth = 0
  let parent = node.parent

  while (parent !== null) {
    if (parent === node.id || depth >= by_id.size) return 'cycle'

    const next = by_id.get(parent)
    assert(next !== undefined, 'parents were checked to exist')
    depth += 1
    parent = next.parent
  }

  assert(depth <= by_id.size, 'a depth is bounded by the nodes')
  return depth
}

function edges_check(
  reader: JsonReader,
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  path: string,
): void {
  assert(reader.problem === null, 'edges are checked only in a well-formed diagram')
  const by_id = new Map(nodes.map((node) => [node.id, node]))
  edges.forEach((edge, index) => {
    const where = `${path}.edges[${index}]`
    const from = by_id.get(edge.from)
    const to = by_id.get(edge.to)

    if (from === undefined) reader.fail(`${where}.from`, 'Expected the id of a node.')

    if (to === undefined) reader.fail(`${where}.to`, 'Expected the id of a node.')

    if (from === undefined || to === undefined) return

    if (from === to) {
      reader.fail(`${where}.to`, 'A connection joins two different nodes.')
    } else if (ancestor_is(by_id, from, to) || ancestor_is(by_id, to, from)) {
      reader.fail(`${where}.to`, 'A connection cannot join a group to a node inside it.')
    }
  })
  assert(by_id.size === nodes.length, 'node ids are unique')
}

// Whether `group` holds `node`, directly or through other groups. Containment is acyclic here.
function ancestor_is(
  by_id: ReadonlyMap<string, DiagramNode>,
  group: DiagramNode,
  node: DiagramNode,
): boolean {
  assert(group !== node, 'a node is not its own ancestor')
  let parent = node.parent

  for (let depth = 0; parent !== null; depth += 1) {
    assert(depth < by_id.size, 'containment was checked to be acyclic')

    if (parent === group.id) return true

    parent = (by_id.get(parent) as DiagramNode).parent
  }

  return false
}

function strokes_check(
  reader: JsonReader,
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  path: string,
): void {
  assert(reader.problem === null, 'strokes are checked only in a well-formed diagram')
  let count = 0

  for (const item of [...nodes, ...edges]) count += item.strokes.length

  if (count > diagram_stroke_ids_count_max) {
    reader.fail(
      `${path}.strokes`,
      `A diagram cites at most ${diagram_stroke_ids_count_max} stroke ids in all.`,
    )
  }

  assert(count >= 0, 'a count is never negative')
}

// A diagram is placed from the sketch as a whole or not at all: a place on some nodes and not
// on others would leave the rest with nowhere to go.
function places_check(reader: JsonReader, nodes: DiagramNode[], path: string): void {
  assert(reader.problem === null, 'places are checked only in a well-formed diagram')
  const placed_count = nodes.filter((node) => node.at !== undefined).length

  if (placed_count > 0 && placed_count < nodes.length) {
    const index = nodes.findIndex((node) => node.at === undefined)
    reader.fail(
      `${path}.nodes[${index}].at`,
      'Give "at" for every node or for none: this node has none and others do.',
    )
  }

  assert(placed_count <= nodes.length, 'places are a subset of the nodes')
}
