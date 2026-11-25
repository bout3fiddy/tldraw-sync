// The composer through its public function, on the synthetic regression shaped like the live
// sketch and on seeded random diagrams. Two kinds of claim are tested separately:
//
//   meaning: every id, label, kind, parent, endpoint and arrowhead is the agent's, exactly;
//   geometry: items sit inside their groups below the heading, siblings keep apart, labels fit,
//     group members share a width, and the layout is deterministic and order independent.
//
// None of this shows the agent read the sketch correctly: that is the agent's job, not the
// tool's, and no machine check here claims otherwise.

import { expect, test } from 'bun:test'
import fixture from '../../tests/fixtures/nested_groups.diagram.json'
import ovals_fixture from '../../tests/fixtures/text_and_ovals.diagram.json'
import { proposal_parse, proposal_records } from '../server/cleanup_proposal'
import type { DiagramProposal, Proposal, ProposalShape } from '../shared/cleanup_types'
import {
  composition_check,
  group_content_top,
  node_box,
  oval_holds,
  oval_label_box,
} from '../shared/diagram_check'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { label_padding_units, text_block } from '../shared/text_measure'
import { Prng } from '../simulation/prng'
import { diagram_compose, type Composed } from './diagram_compose'

type Box = { x: number; y: number; w: number; h: number }
type Geo = Extract<ProposalShape, { kind: 'rectangle' | 'ellipse' }>
type Arrow = Extract<ProposalShape, { kind: 'arrow' }>

function input(overrides: Record<string, unknown> = {}): DiagramProposal {
  const parsed = diagram_proposal_parse({ ...fixture, ...overrides })

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  return parsed.proposal
}

async function compose(proposal: DiagramProposal): Promise<Composed> {
  const result = await diagram_compose(proposal)

  if (!result.ok) throw new Error(result.message)

  return result.composed
}

// Composed diagrams are drawn in the markerboard style, whose labels are in the draw face.
const font = 'draw'

// The composed proposal as the board reads it: what the renderer is given.
function published(composed: Composed): Proposal {
  const parsed = proposal_parse(JSON.parse(composed.text))

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  return parsed.proposal
}

const by_id = (shapes: readonly ProposalShape[]) => new Map(shapes.map((s) => [s.id, s]))
const box_of = (shape: ProposalShape | undefined): Box => node_box(shape as ProposalShape, font)

test('the fixture keeps labels, kinds, parents, endpoints and arrowheads exactly', async () => {
  const proposal = input()
  const composed = await compose(proposal)
  const shapes = by_id(composed.shapes)
  const kinds = { box: 'rectangle', ellipse: 'ellipse', text: 'text', group: 'rectangle' }
  const heads = { forward: 'end', both: 'both', none: 'none' }

  for (const node of proposal.diagram.nodes) {
    const shape = shapes.get(node.id) as Geo
    expect(shape.kind).toBe(kinds[node.kind] as Geo['kind'])
    expect(shape.text).toBe(node.label)

    if (node.parent !== null) {
      const outer = box_of(shapes.get(node.parent))
      const inner = box_of(shape)
      expect(inner.x).toBeGreaterThanOrEqual(outer.x)
      expect(inner.x + inner.w).toBeLessThanOrEqual(outer.x + outer.w)
      expect(inner.y + inner.h).toBeLessThanOrEqual(outer.y + outer.h)
    }
  }

  for (const edge of proposal.diagram.edges) {
    const arrow = shapes.get(edge.id) as Arrow
    expect([arrow.kind, arrow.from, arrow.to, arrow.text]).toEqual([
      'arrow',
      edge.from,
      edge.to,
      edge.label,
    ])
    expect(arrow.arrowheads).toBe(heads[edge.direction] as Arrow['arrowheads'])
  }

  expect(composed.shapes).toHaveLength(
    proposal.diagram.nodes.length + proposal.diagram.edges.length,
  )
  expect(composition_check(proposal.diagram, composed.shapes, font)).toBeNull()

  // The composed proposal carries the agent's diagram untouched, in the agent's order.
  expect(composed.proposal.diagram).toEqual(proposal.diagram)
})

test('the fixture is typeset: padded groups, uniform members, gaps, fitting labels', async () => {
  const composed = await compose(input())
  const shapes = by_id(composed.shapes)
  const members = (group: string) =>
    fixture.nodes.filter((node) => (node as { parent?: string }).parent === group)

  for (const group of ['environments', 'review']) {
    const outer = shapes.get(group) as Geo
    const top = group_content_top(outer, font)
    const widths = new Set(members(group).map((node) => box_of(shapes.get(node.id)).w))
    expect(widths.size).toBe(1)

    for (const node of members(group)) {
      const inner = box_of(shapes.get(node.id))
      expect(inner.x - outer.x).toBeGreaterThanOrEqual(16)
      expect(outer.x + outer.w - inner.x - inner.w).toBeGreaterThanOrEqual(16)
      expect(inner.y).toBeGreaterThanOrEqual(top)
      expect(outer.y + outer.h - inner.y - inner.h).toBeGreaterThanOrEqual(16)
    }
  }

  // Siblings at every level keep at least the house gap apart, minus rounding.
  const levels = new Map<string | null, Box[]>()

  for (const node of fixture.nodes) {
    const parent = (node as { parent?: string }).parent ?? null
    levels.set(parent, [...(levels.get(parent) ?? []), box_of(shapes.get(node.id))])
  }

  for (const boxes of levels.values()) {
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        const gap = Math.max(b.x - a.x - a.w, a.x - b.x - b.w, b.y - a.y - a.h, a.y - b.y - b.h)
        expect(gap).toBeGreaterThanOrEqual(31)
      }
    }
  }

  // The long label wraps onto several lines inside its box, which grew to hold them.
  const metrics = shapes.get('metrics') as Geo
  const lines = text_block(metrics.text, metrics.w - label_padding_units * 2, false, font)
  expect(lines.lines_count).toBeGreaterThan(1)
  expect(lines.height_units).toBeLessThanOrEqual(metrics.h - label_padding_units * 2)

  // Connectors were planned clear of the items they do not join, the feedback loop included.
  expect(composed.route_conflicts_count).toBe(0)
  expect((shapes.get('approve-a') as Arrow).route).toBe('arc')
  expect((shapes.get('a-prod') as Arrow).route).toBe('elbow')
})

test('layout comes from structure: any item order composes identically', async () => {
  const first = await compose(input())
  const again = await compose(input())
  expect(again.text).toBe(first.text)

  const prng = new Prng(5)
  const shuffled = <T>(items: readonly T[]) => {
    const copy = [...items]

    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = prng.below(index + 1)
      ;[copy[index], copy[other]] = [copy[other] as T, copy[index] as T]
    }

    return copy
  }
  const reordered = await compose(
    input({ nodes: shuffled(fixture.nodes), edges: shuffled(fixture.edges) }),
  )
  expect(JSON.stringify(reordered.shapes)).toBe(JSON.stringify(first.shapes))
})

test('adding an item outside a group leaves that group arranged as before', async () => {
  const before = by_id((await compose(input())).shapes)
  const after_composed = await compose(
    input({
      nodes: [...fixture.nodes, { id: 'pager', kind: 'box', label: 'Pager' }],
      edges: [
        ...fixture.edges,
        { id: 'alerts-pager', from: 'alerts', to: 'pager', direction: 'forward' },
      ],
    }),
  )
  const after = by_id(after_composed.shapes)

  // Positions inside each group, relative to the group, are unchanged.
  for (const group of ['environments', 'review']) {
    const relative = (shapes: Map<string, ProposalShape>) =>
      fixture.nodes
        .filter((node) => (node as { parent?: string }).parent === group)
        .map((node) => {
          const inner = box_of(shapes.get(node.id))
          const outer = box_of(shapes.get(group))
          return [node.id, inner.x - outer.x, inner.y - outer.y, inner.w, inner.h]
        })
    expect(relative(after)).toEqual(relative(before))
  }

  expect(after.get('pager')?.text).toBe('Pager')
})

test('the downward flow composes too, with headings above their contents', async () => {
  const composed = await compose(input({ flow: 'down' }))
  const shapes = by_id(composed.shapes)
  const review = shapes.get('review') as Geo
  const triage = box_of(shapes.get('triage'))

  // ELK 0.12.1 rotates a group's minimum size in a downward flow; the composer compensates,
  // so the heading still fits above the contents rather than over them.
  expect(triage.y).toBeGreaterThanOrEqual(group_content_top(review, font))
  expect(box_of(shapes.get('a')).y).toBeLessThan(box_of(shapes.get('prod')).y)
  expect(composed.height_units).toBeGreaterThan(composed.width_units)
})

// Standalone text, long oval labels and an empty group. tldraw wraps an oval's words at its
// full width less padding, so the oval must be tall enough that their corners stay inside it.
test('standalone text and long oval labels are sized to stay inside their shapes', async () => {
  const parsed = diagram_proposal_parse(ovals_fixture)

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  const composed = await compose(parsed.proposal)
  const shapes = by_id(composed.shapes)
  expect(composed.shapes).toHaveLength(13)
  expect(composition_check(parsed.proposal.diagram, composed.shapes, font)).toBeNull()
  expect(composed.route_conflicts_count).toBe(0)

  for (const node of parsed.proposal.diagram.nodes) {
    const shape = shapes.get(node.id) as ProposalShape

    if (node.kind === 'ellipse') {
      const oval = shape as Geo
      const words = oval_label_box(node.label, oval.w, false, font)
      expect(oval_holds(words, oval.w, oval.h)).toBe(true)
    }

    if (node.kind === 'text') {
      const text = shape as Extract<ProposalShape, { kind: 'text' }>
      expect(text.w).toBeGreaterThanOrEqual(16)
      const block = text_block(node.label, text.w as number, false, font)
      expect(block.width_units).toBeLessThanOrEqual(text.w as number)
    }
  }

  // The long oval label wraps; the empty group still draws its heading with room below.
  const status = shapes.get('status') as Geo
  expect(text_block(status.text, status.w - 32, false, font).lines_count).toBeGreaterThan(1)
  const later = shapes.get('later') as Geo
  expect(later.y + later.h - group_content_top(later, font)).toBeGreaterThanOrEqual(16)
})

test('the composed shapes become native tldraw records that pass the tldraw schema', async () => {
  const composed = await compose(input())
  const records = proposal_records(published(composed)) as unknown as Array<Record<string, unknown>>
  const record = (id: string) =>
    records.find((candidate) => candidate.id === id) as {
      props: Record<string, unknown>
    }
  expect(record('shape:cleaned-environments').props).toMatchObject({
    fill: 'none',
    verticalAlign: 'start',
    labelColor: 'black',
  })
  expect(record('shape:cleaned-audit-triage').props).toMatchObject({
    kind: 'elbow',
    arrowheadStart: 'arrow',
    arrowheadEnd: 'arrow',
  })
  expect(record('shape:cleaned-triage-approve').props).toMatchObject({
    arrowheadStart: 'none',
    arrowheadEnd: 'none',
  })
  expect(record('binding:cleaned-a-prod-start').props).toMatchObject({ isPrecise: true })
})

type Drawn = {
  id: string
  type: string
  x: number
  y: number
  index: string
  opacity: number
  typeName: string
  toId?: string
  props: Record<string, unknown>
}

// The records of a markerboard against the monochrome fine-liner look: one native record per
// proposal shape and two bindings per connector, nothing else; every outline, connector and
// word in black at the thin size, in the hand-drawn dash and handwritten face; interiors open or
// white; open V arrowheads only. Returns every broken rule, so a seed shows them all at once.
function monochrome_problems(records: readonly Drawn[], shapes_count: number): string[] {
  const problems: string[] = []
  const shapes = records.filter((record) => record.typeName === 'shape')
  const bindings = records.filter((record) => record.typeName === 'binding')
  const arrows = shapes.filter((record) => record.type === 'arrow')

  if (shapes.length !== shapes_count) problems.push(`${shapes.length} shapes for ${shapes_count}`)

  if (bindings.length !== arrows.length * 2) problems.push('bindings are not two per connector')

  for (const record of shapes) {
    const { id, props } = record

    if (!id.startsWith('shape:cleaned-')) problems.push(`${id}: not a diagram item`)

    if (!['geo', 'text', 'arrow'].includes(record.type)) problems.push(`${id}: a ${record.type}`)

    if (record.opacity !== 1) problems.push(`${id}: opacity ${record.opacity}`)

    for (const key of ['color', 'labelColor'] as const) {
      if (props[key] !== undefined && props[key] !== 'black') {
        problems.push(`${id}: ${key} ${props[key]}`)
      }
    }

    if (props.size !== 's') problems.push(`${id}: size ${props.size}`)

    if (props.font !== 'draw') problems.push(`${id}: font ${props.font}`)

    if (record.type !== 'text' && props.dash !== 'draw') problems.push(`${id}: dash ${props.dash}`)

    if (record.type === 'geo' && !['none', 'semi'].includes(props.fill as string)) {
      problems.push(`${id}: fill ${props.fill}`)
    }

    if (record.type === 'arrow') {
      if (props.fill !== 'none') problems.push(`${id}: arrow fill ${props.fill}`)

      for (const head of [props.arrowheadStart, props.arrowheadEnd]) {
        if (head !== 'arrow' && head !== 'none') problems.push(`${id}: arrowhead ${head}`)
      }
    }
  }

  return problems
}

const drawn = (proposal: Proposal) => proposal_records(proposal) as unknown as Drawn[]

// The markerboard is the default look of every newly composed diagram: thin black ink on white,
// tldraw's native hand-drawn line and handwritten face, white boxes and ovals, open groups, open
// V arrowheads, and no colour or decoration of any kind.
test('a composed diagram is a monochrome markerboard: black ink on white only', async () => {
  for (const source of [input(), input(ovals_fixture)]) {
    const proposal = published(await compose(source))
    expect(proposal.style).toBe('markerboard')
    const records = drawn(proposal)
    const props = (id: string) => (records.find((record) => record.id === id) as Drawn).props
    expect(monochrome_problems(records, proposal.shapes.length)).toEqual([])
    expect(records.filter((record) => record.type === 'highlight')).toEqual([])

    for (const node of proposal.diagram?.nodes ?? []) {
      const expected = { group: 'none', box: 'semi', ellipse: 'semi' }[node.kind as string]

      if (expected !== undefined) {
        expect([node.id, props(`shape:cleaned-${node.id}`).fill]).toEqual([node.id, expected])
      }
    }

    // Drawn identically every time: tldraw seeds each hand-drawn line from its shape's id.
    const again = drawn(published(await compose(source)))
    expect(JSON.stringify(again)).toBe(JSON.stringify(records))
  }
})

// Negative controls: the previous look's sky-blue ovals, grey groups and yellow heading swipes
// are each caught by the records check, and a markerboard proposal asking for them is refused.
test('pastel ovals, grey outlines and yellow swipes are caught and refused', async () => {
  const proposal = published(await compose(input()))
  const pastel = proposal.shapes.map((shape) => {
    if (shape.id === 'alerts') return { ...shape, color: 'light-blue', fill: 'solid' }

    return shape.id === 'review' ? { ...shape, color: 'grey' } : shape
  }) as ProposalShape[]
  const records = drawn({ ...proposal, shapes: pastel })
  expect(monochrome_problems(records, proposal.shapes.length)).toEqual([
    'shape:cleaned-review: color grey',
    'shape:cleaned-alerts: color light-blue',
    'shape:cleaned-alerts: fill solid',
  ])
  const swipe = {
    id: 'shape:accent-review-0',
    typeName: 'shape',
    type: 'highlight',
    opacity: 0.5,
    props: { color: 'yellow', size: 's' },
  } as unknown as Drawn
  expect(monochrome_problems([...drawn(proposal), swipe], proposal.shapes.length)).toEqual([
    `${proposal.shapes.length + 1} shapes for ${proposal.shapes.length}`,
    'shape:accent-review-0: not a diagram item',
    'shape:accent-review-0: a highlight',
    'shape:accent-review-0: opacity 0.5',
    'shape:accent-review-0: color yellow',
    'shape:accent-review-0: font undefined',
    'shape:accent-review-0: dash undefined',
  ])

  // The same colours in a published markerboard are refused with their path.
  const text = JSON.parse(JSON.stringify({ ...proposal, shapes: pastel }))
  const index = pastel.findIndex((shape) => shape.id === 'review')
  expect(proposal_parse(text)).toMatchObject({ ok: false, path: `shapes[${index}].color` })
})

// The style adds no records: the same shapes drawn plain have the same ids, bindings and
// geometry, and differ only in the face and the dash.
test('a markerboard and a plain drawing differ only in face and dash', async () => {
  const proposal = published(await compose(input()))
  const strip = (record: Drawn) => {
    const { font: _font, dash: _dash, ...props } = record.props
    return { ...record, props }
  }
  const markerboard = drawn(proposal)
  const plain = drawn({ ...proposal, style: 'plain' })
  expect(plain.map(strip)).toEqual(markerboard.map(strip))
  expect(new Set(plain.map((record) => record.props.font).filter(Boolean))).toEqual(
    new Set(['sans']),
  )
})

test('nesting to the depth limit and the item limits compose within a second', async () => {
  const deep = Array.from({ length: 8 }, (_, index) => ({
    id: `g${index}`,
    kind: 'group',
    label: `Level ${index} with a heading`,
    ...(index === 0 ? {} : { parent: `g${index - 1}` }),
  }))
  const nested = await compose(
    input({
      nodes: [...deep, { id: 'leaf', kind: 'box', label: 'Leaf', parent: 'g7' }],
      edges: [],
    }),
  )
  expect(nested.shapes).toHaveLength(9)

  const nodes = Array.from({ length: 80 }, (_, index) => ({
    id: `n${index}`,
    kind: index % 10 === 0 ? 'group' : 'box',
    label: `Item ${index}`,
    ...(index % 10 === 0 || index < 10 ? {} : { parent: `n${index - (index % 10)}` }),
  }))
  const edges = Array.from({ length: 160 }, (_, index) => ({
    id: `e${index}`,
    from: `n${(index * 7 + 1) % 80}`,
    to: `n${(index * 13 + 3) % 80}`,
    direction: 'forward',
  })).filter((edge) => edge.from !== edge.to && !edge.to.endsWith('0') && !edge.from.endsWith('0'))
  const started_ms = performance.now()
  const large = await compose(input({ nodes, edges }))
  expect(performance.now() - started_ms).toBeLessThan(1000)
  expect(large.shapes).toHaveLength(nodes.length + edges.length)
})

// Seeded random diagrams: groups, nesting, cycles, long and wide labels, both flows. Every one
// composes into shapes the board accepts. Replay with SEED=<seed> bun test diagram_compose.
test('random diagrams always compose into a valid, meaning-preserving proposal', async () => {
  const seed_first = Number(process.env.SEED ?? 1)
  const words = ['API', 'Queue', 'Worker pool', 'a much longer label that wraps', 'x', '日本語']

  for (let seed = seed_first; seed < seed_first + 40; seed += 1) {
    const prng = new Prng(seed)
    const nodes: Array<Record<string, string>> = []

    for (let index = prng.between(1, 24); index > 0; index -= 1) {
      const groups = nodes.filter((node) => node.kind === 'group')
      const kind = ['box', 'box', 'ellipse', 'text', 'group'][prng.below(5)] as string
      const parent =
        groups.length > 0 && prng.chance(0.5) ? groups[prng.below(groups.length)] : null
      nodes.push({
        id: `n${index}`,
        kind,
        label: words[prng.below(words.length)] as string,
        ...(parent === null || parent === undefined ? {} : { parent: parent.id as string }),
      })
    }

    const holds = (a: string, b: string) => {
      for (let p = nodes.find((n) => n.id === b)?.parent; p !== undefined;) {
        if (p === a) return true

        p = nodes.find((n) => n.id === p)?.parent
      }

      return false
    }
    const edges = Array.from({ length: prng.below(nodes.length * 2) }, (_, index) => ({
      id: `e${index}`,
      from: nodes[prng.below(nodes.length)]?.id as string,
      to: nodes[prng.below(nodes.length)]?.id as string,
      direction: ['forward', 'both', 'none'][prng.below(3)] as string,
    })).filter((e) => e.from !== e.to && !holds(e.from, e.to) && !holds(e.to, e.from))
    const proposal = input({ nodes, edges, flow: prng.chance(0.5) ? 'right' : 'down' })
    const result = await diagram_compose(proposal)
    expect(result.ok ? 'ok' : result.message, `seed ${seed}`).toBe('ok')

    if (!result.ok) continue

    const shapes_count = result.composed.shapes.length
    const problems = monochrome_problems(drawn(published(result.composed)), shapes_count)
    expect(problems, `seed ${seed}`).toEqual([])
  }
})
