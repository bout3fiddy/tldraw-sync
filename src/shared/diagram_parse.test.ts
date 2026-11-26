// A semantic diagram is the input an agent controls, so these tests feed it mistakes: each must
// be refused with the path to the problem and an actionable sentence, nothing may throw, and
// valid oddities (cycles of connections, deep nesting, empty group headings) must be accepted.

import { expect, test } from 'bun:test'
import fixture from '../../tests/fixtures/nested_groups.diagram.json'
import { Prng } from '../simulation/prng'
import {
  diagram_depth_max,
  diagram_edges_count_max,
  diagram_label_length_max,
  diagram_nodes_count_max,
  diagram_stroke_ids_count_max,
} from './constants'
import { diagram_proposal_parse } from './diagram_parse'

type Input = {
  format: string
  snapshot: string
  base_revision: number
  flow?: unknown
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  [key: string]: unknown
}

function base(): Input {
  return JSON.parse(JSON.stringify({ ...fixture, snapshot: '0123456789abcdef' })) as Input
}

function parse_ok(input: unknown) {
  const parsed = diagram_proposal_parse(input)

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  return parsed.proposal
}

function chain(depth: number): Input {
  const input = base()
  input.nodes = Array.from({ length: depth }, (_, index) => ({
    id: `g${index}`,
    kind: 'group',
    label: `Level ${index}`,
    ...(index === 0 ? {} : { parent: `g${index - 1}` }),
  }))
  input.nodes.push({ id: 'leaf', kind: 'box', label: 'Leaf', parent: `g${depth - 1}` })
  input.edges = []
  return input
}

test('the fixture is valid and keeps its order, labels, parents and directions exactly', () => {
  const { diagram, snapshot, agent } = parse_ok(base())
  expect(snapshot).toBe('0123456789abcdef')
  expect(agent).toBe('fixture-agent')
  expect(diagram.flow).toBe('right')
  expect(diagram.nodes.map((node) => node.id)).toEqual(fixture.nodes.map((node) => node.id))
  expect(diagram.nodes.find((node) => node.id === 'metrics')?.label).toBe(
    'Metrics collector with a deliberately long handwritten label',
  )
  expect(diagram.nodes.find((node) => node.id === 'prod')?.parent).toBe('environments')
  expect(diagram.edges.map((edge) => edge.direction as string)).toEqual(
    fixture.edges.map((edge) => edge.direction),
  )
  expect(diagram.edges.find((edge) => edge.id === 'a-test')?.label).toBe('')
})

test('cycles of connections are ordinary: a loop and a two-way pair are accepted', () => {
  const input = base()
  input.edges.push({ id: 'back', from: 'prod', to: 'a', direction: 'forward' })
  input.edges.push({ id: 'pair', from: 'test', to: 'a', direction: 'both' })
  expect(parse_ok(input).diagram.edges).toHaveLength(fixture.edges.length + 2)
})

test('nesting is limited exactly at its depth, and groups may have no heading', () => {
  expect(parse_ok(chain(diagram_depth_max)).diagram.nodes).toHaveLength(diagram_depth_max + 1)
  const deep = diagram_proposal_parse(chain(diagram_depth_max + 1))
  expect(deep).toMatchObject({ ok: false, path: 'diagram.nodes[9].parent' })

  const empty = base()
  empty.nodes[0] = { id: 'environments', kind: 'group', label: '' }
  expect(parse_ok(empty).diagram.nodes[0]?.label).toBe('')
})

const mistakes: Array<[string, (input: Input) => void, string]> = [
  ['wrong format', (d) => (d.format = 'tldraw-sync.cleanup.v1'), 'diagram.format'],
  ['malformed snapshot', (d) => (d.snapshot = 'ABC'), 'diagram.snapshot'],
  ['unknown top field', (d) => (d.coordinates = true), 'diagram.coordinates'],
  ['unknown flow', (d) => (d.flow = 'left'), 'diagram.flow'],
  ['nodes not a list', (d) => (d.nodes = {} as never), 'diagram.nodes'],
  ['connections without nodes', (d) => (d.nodes = []), 'diagram.edges[0].from'],
  [
    'drawing with a label',
    (d) => d.nodes.push({ id: 'art', kind: 'drawing', label: 'Sun', strokes: ['shape:s1'] }),
    'diagram.nodes[10].label',
  ],
  [
    'drawing without strokes',
    (d) => d.nodes.push({ id: 'art', kind: 'drawing' }),
    'diagram.nodes[10].strokes',
  ],
  [
    'drawing of the agent',
    (d) => d.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1'], origin: 'agent' }),
    'diagram.nodes[10].origin',
  ],
  [
    'drawing with a stroke twice',
    (d) => d.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1', 'shape:s1'] }),
    'diagram.nodes[10].strokes[1]',
  ],
  [
    'two drawings with one stroke',
    (d) => {
      d.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1', 'shape:s2'] })
      d.nodes.push({ id: 'more', kind: 'drawing', strokes: ['shape:s3', 'shape:s2'] })
    },
    'diagram.nodes[11].strokes[1]',
  ],
  [
    'connection into a drawing',
    (d) => {
      d.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1'] })
      d.edges.push({ id: 'to-art', from: 'a', to: 'art', direction: 'forward' })
    },
    'diagram.edges[10].to',
  ],
  [
    'connection out of a drawing',
    (d) => {
      d.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1'] })
      d.edges.push({ id: 'from-art', from: 'art', to: 'a', direction: 'none' })
    },
    'diagram.edges[10].from',
  ],
  [
    'drawing as a parent',
    (d) => {
      d.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1'] })
      d.nodes.push({ id: 'inside', kind: 'box', label: 'In', parent: 'art' })
    },
    'diagram.nodes[11].parent',
  ],
  ['edges not a list', (d) => (d.edges = {} as never), 'diagram.edges'],
  ['node coordinates', (d) => (d.nodes[1]!.x = 3), 'diagram.nodes[1].x'],
  ['missing kind', (d) => delete d.nodes[1]!.kind, 'diagram.nodes[1].kind'],
  ['unknown kind', (d) => (d.nodes[1]!.kind = 'cylinder'), 'diagram.nodes[1].kind'],
  ['bad id', (d) => (d.nodes[1]!.id = 'a b'), 'diagram.nodes[1].id'],
  ['label not text', (d) => (d.nodes[1]!.label = 7), 'diagram.nodes[1].label'],
  [
    'label too long',
    (d) => (d.nodes[1]!.label = 'x'.repeat(diagram_label_length_max + 1)),
    'diagram.nodes[1].label',
  ],
  [
    'text without words',
    (d) => (d.nodes[1] = { id: 'a', kind: 'text', label: ' ', parent: 'environments' }),
    'diagram.nodes[1].label',
  ],
  ['dangling parent', (d) => (d.nodes[1]!.parent = 'nowhere'), 'diagram.nodes[1].parent'],
  ['parent not a group', (d) => (d.nodes[2]!.parent = 'a'), 'diagram.nodes[2].parent'],
  ['group in itself', (d) => (d.nodes[0]!.parent = 'environments'), 'diagram.nodes[0].parent'],
  [
    'containment cycle',
    (d) => {
      d.nodes[0]!.parent = 'review'
      d.nodes[7]!.parent = 'environments'
    },
    'diagram.nodes[0].parent',
  ],
  ['duplicate node id', (d) => (d.nodes[2]!.id = 'a'), 'diagram.nodes[2].id'],
  ['edge id reuses a node id', (d) => (d.edges[0]!.id = 'a'), 'diagram.edges[0].id'],
  ['missing direction', (d) => delete d.edges[1]!.direction, 'diagram.edges[1].direction'],
  ['unknown direction', (d) => (d.edges[1]!.direction = 'back'), 'diagram.edges[1].direction'],
  ['edge to nothing', (d) => (d.edges[1]!.to = 'cache'), 'diagram.edges[1].to'],
  ['edge from nothing', (d) => (d.edges[1]!.from = 'cache'), 'diagram.edges[1].from'],
  ['edge to itself', (d) => (d.edges[1]!.to = 'a'), 'diagram.edges[1].to'],
  [
    'edge from a group into itself',
    (d) => d.edges.push({ id: 'in', from: 'environments', to: 'prod', direction: 'forward' }),
    'diagram.edges[10].to',
  ],
  ['edge bend', (d) => (d.edges[1]!.bend = 40), 'diagram.edges[1].bend'],
  ['stroke id malformed', (d) => (d.nodes[1]!.strokes = ['abc']), 'diagram.nodes[1].strokes[0]'],
  ['strokes not a list', (d) => (d.edges[1]!.strokes = 'shape:a'), 'diagram.edges[1].strokes'],
]

for (const [name, damage, path] of mistakes) {
  test(`refused: ${name}`, () => {
    const input = base()
    damage(input)
    const parsed = diagram_proposal_parse(input)
    expect(parsed.ok).toBe(false)

    if (!parsed.ok) {
      expect(parsed.path).toBe(path)
      expect(parsed.message.endsWith('.')).toBe(true)
    }
  })
}

// The escaped cleanup had no way to say "this part is a picture": every node was a box, an
// oval, words or a group, so a landscape came back as scattered glyphs. A drawing node names
// the pen strokes to keep instead, alone, beside a diagram or inside a group.
test('a drawing keeps strokes of the sketch, beside typeset items and inside a group', () => {
  const input = base()
  input.nodes.push({ id: 'art', kind: 'drawing', strokes: ['shape:s1', 'shape:s2'] })
  input.nodes.push({
    id: 'doodle',
    kind: 'drawing',
    label: '',
    parent: 'environments',
    strokes: ['shape:s3'],
    origin: 'sketch',
  })
  const { diagram } = parse_ok(input)
  const art = diagram.nodes.find((node) => node.id === 'art')
  expect(art).toMatchObject({ kind: 'drawing', label: '', parent: null })
  expect(art?.strokes).toEqual(['shape:s1', 'shape:s2'])
  expect(diagram.nodes.find((node) => node.id === 'doodle')?.parent).toBe('environments')

  const alone = { ...base(), nodes: [{ id: 'art', kind: 'drawing', strokes: ['shape:s1'] }] }
  alone.edges = []
  expect(parse_ok(alone).diagram.nodes.map((node) => node.kind)).toEqual(['drawing'])
})

// A sketch with nothing left on it cleans up to an empty canvas, so an empty diagram is valid.
test('a diagram with no nodes and no connections is valid', () => {
  const { diagram } = parse_ok({ ...base(), nodes: [], edges: [] })
  expect(diagram).toEqual({ flow: 'right', nodes: [], edges: [] })
})

test('node, edge and stroke limits are exact on both sides', () => {
  const nodes = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `n${index}`, kind: 'box', label: '' }))
  const edges = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `e${index}`,
      from: 'n0',
      to: 'n1',
      direction: 'none',
    }))
  const sized = (nodes_count: number, edges_count: number) => ({
    ...base(),
    nodes: nodes(nodes_count),
    edges: edges(edges_count),
  })
  expect(
    parse_ok(sized(diagram_nodes_count_max, diagram_edges_count_max)).diagram.edges,
  ).toHaveLength(diagram_edges_count_max)
  expect(diagram_proposal_parse(sized(diagram_nodes_count_max + 1, 0)).ok).toBe(false)
  expect(diagram_proposal_parse(sized(2, diagram_edges_count_max + 1)).ok).toBe(false)

  const strokes = (count: number) => {
    const input = sized(2, 0)
    input.nodes[0] = { ...input.nodes[0]!, strokes: Array(count).fill('shape:abc') } as never
    return input
  }
  expect(parse_ok(strokes(diagram_stroke_ids_count_max)).diagram.nodes[0]?.strokes).toHaveLength(
    diagram_stroke_ids_count_max,
  )
  expect(diagram_proposal_parse(strokes(diagram_stroke_ids_count_max + 1)).ok).toBe(false)
})

test('non-objects and garbage are refused without throwing', () => {
  for (const input of [null, undefined, 3, 'diagram', [], [base()]]) {
    expect(diagram_proposal_parse(input).ok).toBe(false)
  }
})

// Seeded damage: random fields replaced with random values. Whatever is accepted is still a
// well-formed forest of groups whose connections name existing nodes; nothing may throw.
test('randomly damaged diagrams are refused or valid, never thrown', () => {
  const seed = Number(process.env.SEED ?? 17)
  const prng = new Prng(seed)
  const values: unknown[] = [
    null,
    -1,
    0,
    '',
    'a',
    'prod',
    'review',
    'environments',
    'group',
    'box',
    'forward',
    'both',
    'x'.repeat(300),
    [],
    {},
    true,
    ['shape:a'],
  ]
  let accepted = 0

  for (let round = 0; round < 2000; round += 1) {
    const input = base() as unknown as Record<string, unknown>

    for (let damage = prng.between(1, 3); damage > 0; damage -= 1) {

      // An earlier damage may have put plain values in a list; only objects take fields.
      const items = [...(input.nodes as unknown[]), ...(input.edges as unknown[])].filter(
        (item) => typeof item === 'object' && item !== null && !Array.isArray(item),
      )
      const target = (
        items.length === 0 || prng.chance(0.15) ? input : items[prng.below(items.length)]
      ) as Record<string, unknown>
      const keys = [...Object.keys(target), 'extra']
      target[keys[prng.below(keys.length)]!] = values[prng.below(values.length)]

      if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) break
    }

    const parsed = diagram_proposal_parse(input)

    if (!parsed.ok) {
      expect(parsed.path.length, `seed ${seed} round ${round}`).toBeGreaterThan(0)
      continue
    }

    accepted += 1
    const ids = new Set(parsed.proposal.diagram.nodes.map((node) => node.id))

    for (const edge of parsed.proposal.diagram.edges) {
      expect(ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to).toBe(true)
    }
  }

  expect(accepted).toBeGreaterThan(0)
  expect(accepted).toBeLessThan(2000)
})
