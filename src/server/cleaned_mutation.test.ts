// Seeded mutations of an otherwise valid composed proposal, published through the production
// board. The base diagram holds every node kind: nested and empty groups, boxes, ovals and
// standalone text inside and outside groups. Each case changes a node shape's dimensions,
// position or label size to a missing, null, minimum, boundary or out-of-range value.
//
// A refusal must be an ordinary `invalid` result, never a thrown assertion, naming the field
// changed or a node it affects, with nothing written. An acceptance must satisfy an oracle
// written here independently of `diagram_check.ts`. Replay one case with SEED=<seed>.

import { expect, test } from 'bun:test'
import { diagram_compose } from '../cli/diagram_compose'
import { diagram_format, type DiagramNode } from '../shared/cleanup_types'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { label_padding_units, text_block } from '../shared/text_measure'
import { Prng } from '../simulation/prng'
import { sketch_disk, sketch_square } from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Board } from './board'

type Shape = Record<string, unknown> & { id: string; kind: string }
type Box = { x: number; y: number; w: number; h: number }

const source = {
  format: diagram_format,
  snapshot: '0000000000000000',
  base_revision: 0,
  agent: 'mutation-agent',
  summary: 'Every node kind, nested and empty groups.',
  nodes: [
    { id: 'platform', kind: 'group', label: 'Platform services' },
    { id: 'data', kind: 'group', label: 'Data', parent: 'platform' },
    { id: 'db', kind: 'box', label: 'Primary database', parent: 'data' },
    { id: 'cache', kind: 'ellipse', label: 'Cache', parent: 'data' },
    { id: 'api', kind: 'box', label: 'API gateway', parent: 'platform' },
    { id: 'note', kind: 'text', label: 'Owned by the platform team', parent: 'platform' },
    { id: 'empty', kind: 'group', label: 'Future work' },
    { id: 'user', kind: 'ellipse', label: 'User' },
    { id: 'caption', kind: 'text', label: 'Request path overview' },
  ],
  edges: [
    { id: 'user-api', from: 'user', to: 'api', direction: 'forward' },
    { id: 'api-db', from: 'api', to: 'db', direction: 'both' },
    { id: 'api-cache', from: 'api', to: 'cache', direction: 'none' },
    { id: 'cache-user', from: 'cache', to: 'user', direction: 'forward' },
  ],
}

const parsed = diagram_proposal_parse(source)

if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

const nodes: readonly DiagramNode[] = parsed.proposal.diagram.nodes
const composition = await diagram_compose(parsed.proposal)

if (!composition.ok) throw new Error(composition.message)

const composed_text = composition.composed.text

// Values a malformed or careless proposal might hold; `undefined` removes the field.
const values_by_field: Record<string, readonly unknown[]> = {
  w: [undefined, null, 0, 1, 8, 16, 32, 33, 64, -5, 1e7, '100'],
  h: [undefined, null, 0, 1, 8, 16, 24, 48, 64, -5, 1e7, '100'],
  x: [undefined, null, -4, 4, 2000, 1e9, '0'],
  y: [undefined, null, -4, 4, 2000, 1e9, '0'],
  size: [undefined, 's', 'm', 'l', 'xl', 'huge'],
}
const fields = Object.keys(values_by_field)

function proposal_fresh(snapshot: string, base_revision: number) {
  const proposal = JSON.parse(composed_text) as { shapes: Shape[] } & Record<string, unknown>
  return { ...proposal, snapshot, base_revision }
}

// The nodes a change to node `index` may legitimately be blamed on: itself, what it holds,
// what it sits in, and its neighbours, which it may now overlap.
function blamed_allowed(index: number): Set<number> {
  const node = nodes[index] as DiagramNode
  const allowed = new Set<number>([index])
  nodes.forEach((other, other_index) => {
    if (other.parent === node.id || other.parent === node.parent) allowed.add(other_index)

    if (other.id === node.parent) allowed.add(other_index)
  })
  return allowed
}

function box_of(shape: Shape): Box {
  const w = shape.w as number
  const h =
    shape.kind === 'text'
      ? text_block(shape.text as string, w, false).height_units
      : (shape.h as number)
  return { x: shape.x as number, y: shape.y as number, w, h }
}

// What an accepted proposal must hold, measured afresh: every node is drawn at the small size,
// text has a width, labels fit inside their padding, each group fits its heading above what it
// holds, and contents sit inside their group with room to spare.
function oracle_problem(shapes: readonly Shape[]): string | null {
  const by_id = new Map(shapes.map((shape) => [shape.id, shape]))

  for (const node of nodes) {
    const shape = by_id.get(node.id) as Shape

    if (shape.size !== undefined && shape.size !== 's') return `${node.id} size`

    if (typeof shape.w !== 'number' || shape.w < 1) return `${node.id} w`

    if (node.kind !== 'text' && shape.w <= label_padding_units * 2) return `${node.id} w`

    if (node.kind === 'text') continue

    // A group needs its heading, then 8 units above and below whatever it holds.
    const inner_w = shape.w - label_padding_units * 2
    const label = text_block(node.label, inner_w, node.kind === 'group')
    const room =
      node.kind === 'group'
        ? label_padding_units + label.height_units + 16
        : label.height_units + label_padding_units * 2

    if (room > (shape.h as number)) return `${node.id} label`

    if (node.parent === null) continue

    const outer = box_of(by_id.get(node.parent) as Shape)
    const inner = box_of(shape)

    if (inner.x < outer.x || inner.x + inner.w > outer.x + outer.w) return `${node.id} inside`

    if (inner.y < outer.y || inner.y + inner.h > outer.y + outer.h) return `${node.id} inside`
  }

  return null
}

test('the unmutated proposal is accepted and satisfies the oracle', () => {
  const proposal = proposal_fresh('0000000000000000', 0)
  expect(oracle_problem(proposal.shapes)).toBeNull()
})

type Mutation = { index: number; field: string; value: unknown }

// One board for a whole run: refusals leave it as it was, acceptances advance its revision.
class MutationRun {
  readonly disk = sketch_disk([sketch_square('shape:a', 0)])
  readonly board = Board.open({ time: new VirtualTime(), disk: this.disk })
  readonly hash = this.board.document_state().hash
  revision = 0
  refused_count = 0
  accepted_count = 0

  publish(mutations: readonly Mutation[], label: string): void {
    expect(mutations.length).toBeGreaterThan(0)
    const proposal = proposal_fresh(this.hash, this.revision)
    const shape_indexes = new Set<number>()
    const blamed_nodes = new Set<number>()

    for (const { index, field, value } of mutations) {
      const shape_index = proposal.shapes.findIndex((shape) => shape.id === nodes[index]?.id)
      const shape = proposal.shapes[shape_index] as Shape
      shape_indexes.add(shape_index)

      for (const blamed of blamed_allowed(index)) blamed_nodes.add(blamed)

      if (value === undefined) delete shape[field]
      else shape[field] = value
    }

    const kept_document = JSON.stringify(this.board.cleaned_document())
    const kept_disk = this.disk.read('cleaned.state')
    const result = this.board.cleaned_publish(proposal)

    if (result.kind === 'published') {
      expect(oracle_problem(proposal.shapes), label).toBeNull()
      this.revision += 1
      this.accepted_count += 1
      return
    }

    expect(result.kind, label).toBe('invalid')
    this.refused_count += 1
    const path = (result as { path: string }).path
    const node = /^diagram\.nodes\[(\d+)\]/.exec(path)
    const shape = /^shapes\[(\d+)\]/.exec(path)
    const blamed_ok =
      node !== null
        ? blamed_nodes.has(Number(node[1]))
        : shape !== null && shape_indexes.has(Number(shape[1]))
    expect(blamed_ok, `${label} blamed ${path}`).toBe(true)
    expect(JSON.stringify(this.board.cleaned_document()), label).toBe(kept_document)
    expect(this.disk.read('cleaned.state'), label).toEqual(kept_disk)
  }
}

const mutations_all: Mutation[] = nodes.flatMap((_, index) =>
  fields.flatMap((field) =>
    (values_by_field[field] as readonly unknown[]).map((value) => ({ index, field, value })),
  ),
)

// Every node, every field, every value: about four hundred single changes.
test('every single dimension mutation is refused as an ordinary problem or passes', () => {
  const run = new MutationRun()

  for (const mutation of mutations_all) {
    const node = nodes[mutation.index] as DiagramNode
    run.publish([mutation], `${node.id}.${mutation.field} = ${String(mutation.value)}`)
  }

  // Both outcomes occur, so the run exercises refusals and the oracle alike.
  expect(run.refused_count).toBeGreaterThan(150)
  expect(run.accepted_count).toBeGreaterThan(20)
  run.board.destroy()
}, 60_000)

// Two changes at once, drawn from the same table, so one change can mask or compound another.
test('seeded pairs of mutations are refused as ordinary problems or pass', () => {
  const seed_first = Number(process.env.SEED ?? 1)
  const seeds_count = process.env.SEED === undefined ? 150 : 1
  const run = new MutationRun()

  for (let seed = seed_first; seed < seed_first + seeds_count; seed += 1) {
    const prng = new Prng(seed)
    const pair = [0, 1].map(() => mutations_all[prng.below(mutations_all.length)] as Mutation)
    const label = pair
      .map((m) => `${nodes[m.index]?.id}.${m.field} = ${String(m.value)}`)
      .join(', ')
    run.publish(pair, `seed ${seed}: ${label}`)
  }

  expect(run.refused_count + run.accepted_count).toBe(seeds_count)
  run.board.destroy()
}, 60_000)

// Boundary controls on the empty group: the smallest height that holds its heading, padding
// and room below is accepted, and one unit less is refused, on the group itself.
test('an empty group is accepted at its minimum height and refused one unit below', () => {
  const board_disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = Board.open({ time: new VirtualTime(), disk: board_disk })
  const hash = board.document_state().hash
  const index = nodes.findIndex((node) => node.id === 'empty')
  const smallest = (proposal: { shapes: Shape[] }) => {
    const group = proposal.shapes.find((shape) => shape.id === 'empty') as Shape
    const heading = text_block('Future work', (group.w as number) - label_padding_units * 2, true)
    return { group, h: Math.ceil(label_padding_units + heading.height_units + 16) }
  }

  const short = proposal_fresh(hash, 0)
  const short_group = smallest(short)
  short_group.group.h = short_group.h - 1
  expect(board.cleaned_publish(short)).toMatchObject({
    kind: 'invalid',
    path: `diagram.nodes[${index}]`,
  })
  expect(board_disk.read('cleaned.state')).toBeNull()

  const exact = proposal_fresh(hash, 0)
  const exact_group = smallest(exact)
  exact_group.group.h = exact_group.h
  expect(board.cleaned_publish(exact)).toMatchObject({ kind: 'published', revision: 1 })
  board.destroy()
})
