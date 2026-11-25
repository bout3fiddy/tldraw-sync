// A proposal is the one input an agent controls, so most of these tests feed it mistakes and
// damage: each must be refused with the path to the problem, and nothing must throw.

import { expect, test } from 'bun:test'
import { createTLSchema } from '@tldraw/tlschema'
import fixture from '../../tests/fixtures/nested_groups.diagram.json'
import { diagram_compose } from '../cli/diagram_compose'
import { proposal_shapes_count_max, proposal_text_length_max } from '../shared/constants'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { Prng } from '../simulation/prng'
import { proposal_example } from '../simulation/test_sketch'
import { text_block } from '../shared/text_measure'
import { index_key, proposal_parse, proposal_records } from './cleanup_proposal'

const snapshot = '0123456789abcdef'
const schema = createTLSchema()

function parse_ok(input: unknown) {
  const parsed = proposal_parse(input)

  if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`)

  return parsed.proposal
}

test('a valid proposal becomes native tldraw records that pass the tldraw schema', () => {
  const proposal = parse_ok(proposal_example(snapshot, 0))
  expect(proposal.agent).toBe('test-agent')
  expect(proposal.shapes.map((shape) => shape.kind)).toEqual([
    'text',
    'rectangle',
    'ellipse',
    'arrow',
  ])
  const records = proposal_records(proposal)
  const by_id = new Map(
    records.map((record) => [
      record.id as string,
      record as unknown as {
        type: string
        props: Record<string, unknown>
        fromId?: string
        toId?: string
      },
    ]),
  )
  expect(by_id.get('shape:cleaned-api')?.props.geo).toBe('rectangle')
  expect(by_id.get('shape:cleaned-db')?.props.geo).toBe('ellipse')
  expect(by_id.get('shape:cleaned-db')?.props.color).toBe('blue')
  expect(by_id.get('shape:cleaned-title')?.type).toBe('text')
  expect(by_id.get('shape:cleaned-title')?.props.autoSize).toBe(true)
  expect(by_id.get('shape:cleaned-writes')?.type).toBe('arrow')
  expect(by_id.get('binding:cleaned-writes-start')?.toId).toBe('shape:cleaned-api')
  expect(by_id.get('binding:cleaned-writes-end')?.toId).toBe('shape:cleaned-db')
  expect(by_id.get('binding:cleaned-writes-end')?.fromId).toBe('shape:cleaned-writes')

  for (const record of records) {
    const types = record.typeName === 'shape' ? schema.types.shape : schema.types.binding
    expect(() => types.validate(record)).not.toThrow()
  }
})

test('defaults fill what an agent leaves out', () => {
  const proposal = parse_ok({
    format: 'tldraw-sync.cleanup.v1',
    snapshot,
    base_revision: 2,
    shapes: [{ kind: 'rectangle', id: 'a', x: 1, y: 2, w: 3, h: 4 }],
  })
  expect(proposal.agent).toBe('external agent')
  expect(proposal.summary).toBe('')
  expect(proposal.shapes[0]).toMatchObject({ color: 'black', size: 'm', text: '' })
})

const mistakes: Array<[string, (proposal: ReturnType<typeof base>) => void, string]> = [
  [
    'wrong format',
    (p) => {
      p.format = 'v0'
    },
    'proposal.format',
  ],
  [
    'missing snapshot',
    (p) => {
      delete (p as Partial<typeof p>).snapshot
    },
    'proposal.snapshot',
  ],
  [
    'malformed snapshot',
    (p) => {
      p.snapshot = 'ABC'
    },
    'proposal.snapshot',
  ],
  [
    'fractional revision',
    (p) => {
      p.base_revision = 1.5
    },
    'proposal.base_revision',
  ],
  [
    'negative revision',
    (p) => {
      p.base_revision = -1
    },
    'proposal.base_revision',
  ],
  [
    'revision as text',
    (p) => {
      ;(p as Record<string, unknown>).base_revision = '1'
    },
    'proposal.base_revision',
  ],
  [
    'unknown top field',
    (p) => {
      ;(p as Record<string, unknown>).code = 'x'
    },
    'proposal.code',
  ],
  [
    'agent with markup',
    (p) => {
      p.agent = '<script>'
    },
    'proposal.agent',
  ],
  [
    'no shapes',
    (p) => {
      p.shapes = []
    },
    'proposal.shapes',
  ],
  [
    'shapes not a list',
    (p) => {
      ;(p as Record<string, unknown>).shapes = {}
    },
    'proposal.shapes',
  ],
  [
    'unknown kind',
    (p) => {
      p.shapes[0]!.kind = 'image'
    },
    'shapes[0].kind',
  ],
  [
    'missing kind',
    (p) => {
      delete (p.shapes[0] as Record<string, unknown>).kind
    },
    'shapes[0].kind',
  ],
  [
    'field of another kind',
    (p) => {
      ;(p.shapes[0] as Record<string, unknown>).from = 'api'
    },
    'shapes[0].from',
  ],
  [
    'script field',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).onclick = 'x'
    },
    'shapes[1].onclick',
  ],
  [
    'bad id',
    (p) => {
      p.shapes[1]!.id = 'a b'
    },
    'shapes[1].id',
  ],
  [
    'duplicate id',
    (p) => {
      p.shapes[2]!.id = 'api'
    },
    'shapes[2].id',
  ],
  [
    'infinite x',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).x = Infinity
    },
    'shapes[1].x',
  ],
  [
    'x as text',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).x = '3'
    },
    'shapes[1].x',
  ],
  [
    'zero width',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).w = 0
    },
    'shapes[1].w',
  ],
  [
    'missing height',
    (p) => {
      delete (p.shapes[1] as Record<string, unknown>).h
    },
    'shapes[1].h',
  ],
  [
    'far away',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).y = 1e9
    },
    'shapes[1].y',
  ],
  [
    'unknown colour',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).color = 'pink'
    },
    'shapes[1].color',
  ],
  [
    'unknown size',
    (p) => {
      ;(p.shapes[1] as Record<string, unknown>).size = 'huge'
    },
    'shapes[1].size',
  ],
  [
    'empty text shape',
    (p) => {
      ;(p.shapes[0] as Record<string, unknown>).text = '  '
    },
    'shapes[0].text',
  ],
  [
    'text too long',
    (p) => {
      ;(p.shapes[0] as Record<string, unknown>).text = 'x'.repeat(proposal_text_length_max + 1)
    },
    'shapes[0].text',
  ],
  [
    'arrow to nothing',
    (p) => {
      ;(p.shapes[3] as Record<string, unknown>).to = 'cache'
    },
    'shapes[3].to',
  ],
  [
    'arrow to itself',
    (p) => {
      ;(p.shapes[3] as Record<string, unknown>).to = 'api'
    },
    'shapes[3].to',
  ],
  [
    'arrow to an arrow',
    (p) => {
      p.shapes.push({ kind: 'arrow', id: 'again', from: 'api', to: 'writes' } as never)
    },
    'shapes[4].to',
  ],
]

function base() {
  return proposal_example(snapshot, 0) as ReturnType<typeof proposal_example> & {
    shapes: Array<Record<string, unknown> & { kind: string; id: string }>
  }
}

for (const [name, damage, path] of mistakes) {
  test(`refused: ${name}`, () => {
    const proposal = base()
    damage(proposal)
    const parsed = proposal_parse(proposal)
    expect(parsed.ok).toBe(false)

    if (!parsed.ok) {
      expect(parsed.path).toBe(path)
      expect(parsed.message).toEndWith('.')
    }
  })
}

test('the shape limit is exact on both sides', () => {
  const shapes = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'rectangle',
      id: `r${index}`,
      x: index,
      y: 0,
      w: 1,
      h: 1,
    }))
  const at_limit = parse_ok({ ...base(), shapes: shapes(proposal_shapes_count_max) })
  expect(proposal_records(at_limit)).toHaveLength(proposal_shapes_count_max)
  const over = proposal_parse({ ...base(), shapes: shapes(proposal_shapes_count_max + 1) })
  expect(over.ok).toBe(false)
})

test('index keys stay ordered across the change of width', () => {
  const keys = Array.from({ length: proposal_shapes_count_max }, (_, index) => index_key(index))
  expect([...keys].sort()).toEqual(keys)
  expect(new Set(keys).size).toBe(keys.length)
  expect(keys.slice(60, 64)).toEqual(['ay', 'az', 'b10', 'b11'])
})

test('non-objects and garbage are refused without throwing', () => {
  for (const input of [null, undefined, 3, 'proposal', [], [proposal_example(snapshot, 0)]]) {
    const parsed = proposal_parse(input)
    expect(parsed.ok).toBe(false)
  }
})

// Seeded damage: random fields of a valid proposal replaced with random values. Whatever is
// accepted must still make records tldraw accepts; nothing may throw.
test('randomly damaged proposals are refused or valid, never thrown', () => {
  const seed = Number(process.env.SEED ?? 11)
  const prng = new Prng(seed)
  const values: unknown[] = [
    null,
    -1,
    0,
    0.5,
    1e12,
    NaN,
    '',
    'api',
    'db',
    'x'.repeat(3000),
    [],
    {},
    true,
    'rectangle',
    'arrow',
    'red',
    'xl',
  ]
  let accepted = 0

  for (let round = 0; round < 2000; round += 1) {
    const proposal = base() as unknown as Record<string, unknown>
    const damages_count = prng.between(1, 3)

    for (let damage = 0; damage < damages_count; damage += 1) {

      // An earlier damage may have replaced the list itself.
      const shapes = Array.isArray(proposal.shapes)
        ? (proposal.shapes as Array<Record<string, unknown>>)
        : []
      const target =
        shapes.length === 0 || prng.chance(0.2) ? proposal : shapes[prng.below(shapes.length)]!
      const keys = [...Object.keys(target), 'extra']
      target[keys[prng.below(keys.length)]!] = values[prng.below(values.length)]
    }

    const parsed = proposal_parse(proposal)

    if (parsed.ok) {
      accepted += 1
      expect(proposal_records(parsed.proposal).length).toBeGreaterThan(0)
    } else {
      expect(parsed.path.length, `seed ${seed} round ${round}`).toBeGreaterThan(0)
    }
  }

  // Both outcomes happened, so the property was exercised on both sides.

  expect(accepted).toBeGreaterThan(0)
  expect(accepted).toBeLessThan(2000)
})

// v1 proposals published before styling existed must render exactly as they always did.
test('a v1 proposal keeps its v1 records: no fill, one head, centre bindings', () => {
  const records = proposal_records(parse_ok(proposal_example(snapshot, 0)))
  const props = (id: string) =>
    (records.find((record) => record.id === id) as unknown as { props: Record<string, unknown> })
      .props
  expect(props('shape:cleaned-api')).toMatchObject({
    fill: 'none',
    align: 'middle',
    verticalAlign: 'middle',
    labelColor: 'black',
  })
  expect(props('shape:cleaned-title')).toMatchObject({ textAlign: 'start', autoSize: true })
  expect(props('shape:cleaned-writes')).toMatchObject({
    kind: 'arc',
    bend: 0,
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
  })
  expect(props('binding:cleaned-writes-start')).toMatchObject({
    normalizedAnchor: { x: 0.5, y: 0.5 },
    isPrecise: false,
  })
})

// The style is a bounded v2 control. Unnamed, it is plain: the records a proposal always got.
test('a v2 proposal names its style: plain by default, markerboard drawn by hand', () => {
  const shapes = [
    { kind: 'rectangle', id: 'a', x: 0, y: 0, w: 100, h: 60, text: 'A' },
    { kind: 'text', id: 't', x: 0, y: 100, w: 80, text: 'Note' },
    { kind: 'arrow', id: 'at', from: 'a', to: 't' },
  ]
  const v2 = { ...base(), format: 'tldraw-sync.cleanup.v2', shapes }
  const looks = (style: unknown) => {
    const proposal = parse_ok(style === undefined ? v2 : { ...v2, style })
    const records = proposal_records(proposal) as unknown as Array<{
      id: string
      typeName: string
      type: string
      props: Record<string, unknown>
    }>
    return {
      style: proposal.style,
      fonts: records.filter((r) => r.typeName === 'shape').map((r) => r.props.font),
      dashes: records
        .filter((r) => r.type !== 'text' && r.typeName === 'shape')
        .map((r) => r.props.dash),

      // Neither style adds a record: a shape each and two bindings for the arrow.
      records: records.length,
    }
  }
  expect(looks(undefined)).toEqual({
    style: 'plain',
    fonts: ['sans', 'sans', 'sans'],
    dashes: ['solid', 'solid'],
    records: 5,
  })
  expect(looks('plain')).toEqual(looks(undefined))
  expect(looks('markerboard')).toEqual({
    style: 'markerboard',
    fonts: ['draw', 'draw', 'draw'],
    dashes: ['draw', 'draw'],
    records: 5,
  })
  expect(parse_ok(base()).style).toBe('plain')
  expect(proposal_parse({ ...v2, style: 'neon' })).toMatchObject({
    ok: false,
    path: 'proposal.style',
  })
  expect(proposal_parse({ ...base(), style: 'markerboard' }).ok).toBe(false)
})

// A markerboard is black ink on white. Plain revisions keep every colour they were published
// with, while a markerboard asking for a colour, a coloured label or a tinted fill is refused.
test('a markerboard proposal is refused any colour or tint; a plain one keeps its colours', () => {
  const shapes = () => [
    { kind: 'rectangle', id: 'a', x: 0, y: 0, w: 100, h: 60, text: 'A', fill: 'semi' },
    { kind: 'ellipse', id: 'b', x: 200, y: 0, w: 100, h: 60, text: 'B', fill: 'none' },
    { kind: 'text', id: 't', x: 0, y: 100, w: 80, text: 'Note' },
    { kind: 'arrow', id: 'ab', from: 'a', to: 'b', text: 'HTTP' },
  ]
  const proposal = (style: string, index: number, change: Record<string, unknown>) => {
    const changed: Array<Record<string, unknown>> = shapes()
    changed[index] = { ...changed[index], ...change }
    return { ...base(), format: 'tldraw-sync.cleanup.v2', style, shapes: changed }
  }
  const black = { ...base(), format: 'tldraw-sync.cleanup.v2', style: 'markerboard' }
  expect(parse_ok({ ...black, shapes: shapes() }).style).toBe('markerboard')
  const refusals: Array<[number, Record<string, unknown>, string]> = [
    [1, { color: 'light-blue' }, 'shapes[1].color'],
    [0, { color: 'yellow' }, 'shapes[0].color'],
    [0, { color: 'grey' }, 'shapes[0].color'],
    [3, { color: 'blue' }, 'shapes[3].color'],
    [2, { color: 'red' }, 'shapes[2].color'],
    [0, { label_color: 'blue' }, 'shapes[0].label_color'],
    [1, { fill: 'solid' }, 'shapes[1].fill'],
  ]

  for (const [index, change, path] of refusals) {
    expect(proposal_parse(proposal('markerboard', index, change))).toMatchObject({
      ok: false,
      path,
    })
    expect(proposal_parse(proposal('plain', index, change)).ok).toBe(true)
  }
})

// Labels are checked in the face they are drawn in. Digits are wider in the handwritten face
// than the sans estimate, so a box sized to hold one sans line is refused as a markerboard.
test('a label sized for the sans face is refused when drawn in the handwritten face', () => {
  const label = '2024 2025 2026'
  const w = Math.ceil(text_block(label, 10_000, false, 'sans').width_units) + 33
  const h = Math.ceil(text_block(label, 10_000, false, 'sans').height_units) + 33
  expect(text_block(label, w - 32, false, 'sans').lines_count).toBe(1)
  expect(text_block(label, w - 32, false, 'draw').lines_count).toBe(2)
  const proposal = (style: string) => ({
    ...base(),
    format: 'tldraw-sync.cleanup.v2',
    style,
    shapes: [{ kind: 'rectangle', id: 'year', x: 0, y: 0, w, h, text: label, size: 's' }],
    diagram: {
      flow: 'right',
      nodes: [{ id: 'year', kind: 'box', label }],
      edges: [],
    },
  })
  expect(proposal_parse(proposal('plain')).ok).toBe(true)
  expect(proposal_parse(proposal('markerboard'))).toMatchObject({
    ok: false,
    path: 'diagram.nodes[0].label',
  })
})

test('styling controls belong to v2: a v1 proposal with them is refused', () => {
  const styled = base()
  styled.shapes[1]!.fill = 'solid'
  expect(proposal_parse(styled)).toMatchObject({ ok: false, path: 'shapes[1].fill' })
  expect(proposal_parse({ ...base(), diagram: {} })).toMatchObject({
    ok: false,
    path: 'proposal.diagram',
  })
})

function styled(shapes: unknown[]) {
  return { ...base(), format: 'tldraw-sync.cleanup.v2', shapes }
}

test('a v2 proposal without a diagram takes its bounded styling and routing controls', () => {
  const proposal = parse_ok(
    styled([
      { kind: 'rectangle', id: 'a', x: 0, y: 0, w: 100, h: 60, fill: 'solid', label_bold: true },
      { kind: 'ellipse', id: 'b', x: 300, y: 0, w: 100, h: 60, label_color: 'grey' },
      {
        kind: 'arrow',
        id: 'ab',
        from: 'a',
        to: 'b',
        arrowheads: 'both',
        route: 'arc',
        bend: -40,
        from_anchor: { x: 1, y: 0.5 },
      },
    ]),
  )
  expect(proposal.format).toBe('tldraw-sync.cleanup.v2')
  expect(proposal.diagram).toBeNull()
  expect(proposal.shapes[2]).toMatchObject({ bend: -40, to_anchor: null, arrowheads: 'both' })
  expect(proposal_records(proposal).length).toBe(5)

  const refusals: Array<[Record<string, unknown>, string]> = [
    [{ kind: 'arrow', id: 'ab', from: 'a', to: 'b', route: 'elbow', bend: 5 }, 'shapes[2].bend'],
    [
      { kind: 'arrow', id: 'ab', from: 'a', to: 'b', to_anchor: { x: 2, y: 0 } },
      'shapes[2].to_anchor.x',
    ],
    [{ kind: 'arrow', id: 'ab', from: 'a', to: 'b', route: 'spline' }, 'shapes[2].route'],
    [{ kind: 'arrow', id: 'ab', from: 'a', to: 'b', arrowheads: 'start' }, 'shapes[2].arrowheads'],
  ]

  for (const [arrow, path] of refusals) {
    const parsed = proposal_parse(styled([...shapes_two(), arrow]))
    expect(parsed).toMatchObject({ ok: false, path })
  }
})

function shapes_two() {
  return [
    { kind: 'rectangle', id: 'a', x: 0, y: 0, w: 100, h: 60 },
    { kind: 'rectangle', id: 'b', x: 300, y: 0, w: 100, h: 60 },
  ]
}

async function composed_fixture(): Promise<Record<string, unknown> & { shapes: any[] }> {
  const parsed = diagram_proposal_parse({ ...fixture, snapshot })

  if (!parsed.ok) throw new Error(parsed.message)

  const result = await diagram_compose(parsed.proposal)

  if (!result.ok) throw new Error(result.message)

  return JSON.parse(result.composed.text)
}

// A composed proposal must say exactly what its diagram says. Each tampering below is caught
// by the board, however the proposal was produced.
const tamperings: Array<[string, (shapes: any[]) => void, string]> = [
  [
    'a label reworded',
    (s) => (s.find((x) => x.id === 'prod').text = 'Production'),
    'diagram.nodes[2]',
  ],
  [
    'endpoints swapped',
    (s) => {
      const arrow = s.find((x) => x.id === 'a-prod')
      ;[arrow.from, arrow.to] = [arrow.to, arrow.from]
    },
    'diagram.edges[0]',
  ],
  [
    'an arrowhead dropped',
    (s) => (s.find((x) => x.id === 'audit-triage').arrowheads = 'end'),
    'diagram.edges[7]',
  ],
  [
    'a plain line given a head',
    (s) => (s.find((x) => x.id === 'triage-approve').arrowheads = 'end'),
    'diagram.edges[8]',
  ],
  [
    'a box drawn as an oval',
    (s) => (s.find((x) => x.id === 'a').kind = 'ellipse'),
    'diagram.nodes[1]',
  ],
  [
    'an item moved out of its group',
    (s) => (s.find((x) => x.id === 'test').x -= 2000),
    'diagram.nodes[3]',
  ],
  [
    'an item over the heading',
    (s) => (s.find((x) => x.id === 'a').y = s.find((x) => x.id === 'environments').y + 4),
    'diagram.nodes[1]',
  ],
  [
    'two items overlapping',
    (s) => {
      const [prod, test_box] = [s.find((x) => x.id === 'prod'), s.find((x) => x.id === 'test')]
      test_box.y = prod.y + 10
      test_box.x = prod.x + 10
    },
    'diagram.nodes[3]',
  ],
  [
    'a label that no longer fits',
    (s) => (s.find((x) => x.id === 'metrics').h = 40),
    'diagram.nodes[4].label',
  ],
  [
    'a label set larger than the size it was measured at',
    (s) => (s.find((x) => x.id === 'prod').size = 'xl'),
    'diagram.nodes[2]',
  ],
  [
    'a group shrunk below its heading',
    (s) => (s.find((x) => x.id === 'review').h = 30),
    'diagram.nodes[7]',
  ],
  [
    'a connector dropped',
    (s) =>
      s.splice(
        s.findIndex((x) => x.id === 'a-test'),
        1,
      ),
    'shapes',
  ],
]

for (const [name, tamper, path] of tamperings) {
  test(`a composed proposal is refused when ${name}`, async () => {
    const proposal = await composed_fixture()
    expect(proposal_parse(proposal).ok).toBe(true)
    tamper(proposal.shapes)
    const parsed = proposal_parse(proposal)
    expect(parsed.ok).toBe(false)

    if (!parsed.ok) expect(parsed.path).toBe(path)
  })
}

// Standalone text and an empty group: shapes whose measurements the placement checks never
// reach. A malformed one is an ordinary problem, never an assertion failure.
async function composed_sparse(): Promise<Record<string, unknown> & { shapes: any[] }> {
  const parsed = diagram_proposal_parse({
    ...fixture,
    snapshot,
    nodes: [
      { id: 'empty', kind: 'group', label: 'Release review board' },
      { id: 'note', kind: 'text', label: 'Remember to check the rollout window' },
      { id: 'api', kind: 'box', label: 'API' },
    ],
    edges: [{ id: 'note-api', from: 'note', to: 'api', direction: 'none' }],
  })

  if (!parsed.ok) throw new Error(parsed.message)

  const result = await diagram_compose(parsed.proposal)

  if (!result.ok) throw new Error(result.message)

  return JSON.parse(result.composed.text)
}

const tamperings_sparse: Array<[string, (shapes: any[]) => void, string]> = [
  ['text loses its width', (s) => delete s.find((x) => x.id === 'note').w, 'diagram.nodes[1]'],
  ['text width set to null', (s) => (s.find((x) => x.id === 'note').w = null), 'diagram.nodes[1]'],
  [
    'an empty group shrunk below its heading',
    (s) =>
      Object.assign(
        s.find((x) => x.id === 'empty'),
        { w: 40, h: 24 },
      ),
    'diagram.nodes[0]',
  ],
  [
    'an empty group narrower than its padding',
    (s) => (s.find((x) => x.id === 'empty').w = 20),
    'diagram.nodes[0]',
  ],
]

for (const [name, tamper, path] of tamperings_sparse) {
  test(`a composed proposal is refused, not asserted on, when ${name}`, async () => {
    const proposal = await composed_sparse()
    expect(proposal_parse(proposal)).toMatchObject({ ok: true })
    tamper(proposal.shapes)
    const parsed = proposal_parse(proposal)
    expect(parsed).toMatchObject({ ok: false, path })
  })
}
