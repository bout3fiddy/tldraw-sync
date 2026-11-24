// A proposal is the one input an agent controls, so most of these tests feed it mistakes and
// damage: each must be refused with the path to the problem, and nothing must throw.

import { expect, test } from 'bun:test'
import { createTLSchema } from '@tldraw/tlschema'
import { proposal_shapes_count_max, proposal_text_length_max } from '../shared/constants'
import { Prng } from '../simulation/prng'
import { proposal_example } from '../simulation/test_sketch'
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
  const records = proposal_records(proposal.shapes)
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
  expect(proposal_records(at_limit.shapes)).toHaveLength(proposal_shapes_count_max)
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
      expect(proposal_records(parsed.proposal.shapes).length).toBeGreaterThan(0)
    } else {
      expect(parsed.path.length, `seed ${seed} round ${round}`).toBeGreaterThan(0)
    }
  }

  // Both outcomes happened, so the property was exercised on both sides.

  expect(accepted).toBeGreaterThan(0)
  expect(accepted).toBeLessThan(2000)
})
