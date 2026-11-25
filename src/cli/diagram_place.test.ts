// A diagram that says where its items sat in the sketch keeps that arrangement. The fixture is
// the board that escaped: requirements written side by side above core entities and an API
// list, which the composer, told nothing about position, typeset as one row 2756 units wide
// and 416 tall. These tests state the arrangement the sketch had and check the composed boxes
// for it, then check that an edit to one section leaves the others where they were.

import { expect, test } from 'bun:test'
import fixture from '../../tests/fixtures/sketched_notes.diagram.json'
import type { DiagramProposal, ProposalShape } from '../shared/cleanup_types'
import { composition_check, node_box } from '../shared/diagram_check'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { Prng } from '../simulation/prng'
import { diagram_compose, type Composed } from './diagram_compose'

type Box = { x: number; y: number; w: number; h: number }
type Node = { id: string; kind: string; label: string; at?: number[]; parent?: string }
type Input = { nodes: Node[]; edges: unknown[]; [key: string]: unknown }

const font = 'draw'
const base = (): Input => JSON.parse(JSON.stringify(fixture)) as Input

function parse(input: unknown): DiagramProposal {
  const parsed = diagram_proposal_parse(input)

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  return parsed.proposal
}

async function compose(input: unknown): Promise<Composed> {
  const result = await diagram_compose(parse(input))

  if (!result.ok) throw new Error(result.message)

  return result.composed
}

function boxes_of(composed: Composed): Map<string, Box> {
  const nodes = composed.shapes.filter((shape) => shape.kind !== 'arrow')
  return new Map(nodes.map((shape: ProposalShape) => [shape.id, node_box(shape, font)]))
}

const right = (box: Box) => box.x + box.w
const bottom = (box: Box) => box.y + box.h
const overlap = (a: Box, b: Box) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)

test('the board that landed on one line keeps the arrangement it was sketched in', async () => {
  const composed = await compose(base())
  const boxes = boxes_of(composed)
  const box = (id: string) => boxes.get(id) as Box

  // Not a row: the sketch was about as tall as it was wide.
  expect(composed.width_units / composed.height_units).toBeLessThan(2)
  expect(composed.height_units / composed.width_units).toBeLessThan(2)

  // The two lists of requirements stand side by side.
  expect(right(box('func'))).toBeLessThan(box('nonfunc').x)
  expect(box('func').y).toBeLessThan(bottom(box('nonfunc')))
  expect(box('nonfunc').y).toBeLessThan(bottom(box('func')))

  // Core entities are below the functional requirements, and the API list below them, all
  // from the same left edge.
  expect(bottom(box('func'))).toBeLessThan(box('core').y)
  expect(bottom(box('core'))).toBeLessThan(box('api').y)
  expect(box('core').x).toBe(box('func').x)
  expect(box('api').x).toBe(box('core').x)

  // Inside a section the lines keep their order, and each entity has its meaning beside it.
  expect(bottom(box('f1'))).toBeLessThan(box('f2').y)
  expect(bottom(box('merchant'))).toBeLessThan(box('intent').y)
  expect(bottom(box('intent'))).toBeLessThan(box('txn').y)
  expect(right(box('merchant'))).toBeLessThan(box('merchant_d').x)
  expect(right(box('txn'))).toBeLessThan(box('txn_d').x)
})

test('a placed diagram passes the board\'s checks, and its notes read from the left', async () => {
  const proposal = parse(base())
  const composed = await compose(base())
  expect(composition_check(proposal.diagram, composed.shapes, font)).toBeNull()
  expect(composed.route_conflicts_count).toBe(0)

  for (const shape of composed.shapes) {
    expect(shape.color).toBe('black')

    if (shape.kind === 'text') expect(shape.align).toBe('start')
  }
})

// One more endpoint in the API list: that list grows, and nothing else moves.
test('adding a line to one section leaves every other item where it was', async () => {
  const before = boxes_of(await compose(base()))
  const edited = base()
  edited.nodes.push({
    id: 'api3',
    kind: 'text',
    label: '/get/check_status',
    at: [220, 1750, 360, 100],
    parent: 'api',
  })
  const after = boxes_of(await compose(edited))
  const api_before = before.get('api') as Box
  const api_after = after.get('api') as Box
  expect(api_after.h).toBeGreaterThan(api_before.h)
  expect({ x: api_after.x, y: api_after.y }).toEqual({ x: api_before.x, y: api_before.y })
  expect(bottom(after.get('api2') as Box)).toBeLessThan((after.get('api3') as Box).y)

  for (const [id, box] of before) {
    if (id !== 'api') expect(after.get(id)).toEqual(box)
  }
})

test('placement is deterministic and independent of the order items are listed in', async () => {
  const first = await compose(base())
  const reversed = base()
  reversed.nodes.reverse()
  reversed.edges.reverse()
  const second = await compose(reversed)
  expect(boxes_of(second)).toEqual(boxes_of(first))
  expect((await compose(base())).text).toBe(first.text)
})

test('a place on some nodes and not on others is refused, and so is a malformed one', () => {
  const partial = base()
  delete (partial.nodes[3] as Node).at
  expect(diagram_proposal_parse(partial)).toMatchObject({ ok: false, path: 'diagram.nodes[3].at' })

  for (const at of [[0, 0, 10], [0, 0, 10, -1], [0, 0, 10, '4'], [0, 0, 1e9, 4], 'here', {}]) {
    const bad = base()
    ;(bad.nodes[0] as { at: unknown }).at = at
    const parsed = diagram_proposal_parse(bad)
    expect(parsed.ok).toBe(false)

    if (!parsed.ok) expect(parsed.path).toStartWith('diagram.nodes[0].at')
  }

  // A diagram with no places at all is as valid as it always was.
  const plain = base()

  for (const node of plain.nodes) delete node.at

  expect(diagram_proposal_parse(plain).ok).toBe(true)
})

// Whatever boxes an agent reads off a sketch, however they overlap, no two items in one group
// end up on top of each other, and every item stays inside the group that holds it.
test('random places, overlapping or empty, never compose into overlapping items', async () => {
  const prng = new Prng(20261125)

  for (let round = 0; round < 60; round += 1) {
    const count = prng.between(2, 24)
    const nodes: Node[] = []

    for (let index = 0; index < count; index += 1) {
      const groups = nodes.filter((node) => node.kind === 'group')
      const kind = ['box', 'ellipse', 'text', 'group'][prng.below(4)] as string
      const held = groups.length > 0 && prng.below(2) === 0
      const parent = held ? groups[prng.below(groups.length)] : null
      const at = [prng.below(900), prng.below(900), prng.below(400), prng.below(200)]
      const node: Node = { id: `n${index}`, kind, label: `item ${index}`, at }

      if (parent != null) node.parent = parent.id

      nodes.push(node)
    }

    const input = { ...base(), nodes, edges: [] }
    const proposal = parse(input)
    const composed = await compose(input)
    const boxes = boxes_of(composed)
    expect(composition_check(proposal.diagram, composed.shapes, font)).toBeNull()

    for (const a of proposal.diagram.nodes) {
      for (const b of proposal.diagram.nodes) {
        if (a.id >= b.id || a.parent !== b.parent) continue

        expect(overlap(boxes.get(a.id) as Box, boxes.get(b.id) as Box)).toBe(false)
      }
    }
  }
})
