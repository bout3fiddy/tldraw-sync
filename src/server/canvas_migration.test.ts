import { expect, test } from 'bun:test'
import { diagram_compose } from '../cli/diagram_compose'
import { diagram_format } from '../shared/cleanup_types'
import { diagram_proposal_parse } from '../shared/diagram_parse'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import { Cleaned } from './cleaned'
import { envelope_encode, envelope_decode, type Disk } from './storage'

const hash = '1'.repeat(16)

async function legacy(label: string) {
  const parsed = diagram_proposal_parse({
    format: diagram_format,
    snapshot: hash,
    base_revision: 0,
    nodes: [
      { id: 'one', kind: 'text', label },
      { id: 'two', kind: 'box', label: 'Next' },
    ],
    edges: [{ id: 'arrow', from: 'one', to: 'two', direction: 'forward' }],
  })

  if (!parsed.ok) throw Error(parsed.message)

  const result = await diagram_compose(parsed.proposal)

  if (!result.ok) throw Error(result.message)

  const { shapes, diagram, style, format } = JSON.parse(result.composed.text)
  const v = {
    revision: 1,
    restored_from: null,
    source_hash: hash,
    agent: 'old',
    summary: label,
    published_at_ms: 0,
    format,
    diagram,
    style,
    shapes,
  }
  const state = {
    format: 'tldraw-sync.cleaned.v1',
    revision: 2,
    current: { ...v, revision: 2 },
    history: [v],
  }
  return envelope_encode({
    kind: 'cleaned',
    label: '-',
    payload: new TextEncoder().encode(JSON.stringify(state)),
  })
}

test('migration applies the old limits to every archived revision before writing', async () => {
  const valid = await legacy('Node')
  const decoded = envelope_decode(valid, 'cleaned')

  if (!decoded.ok) throw Error(decoded.reason)

  for (const [file, count] of [
    ['cleaned.state', 81],
    ['ideas.state', 65],
  ] as const) {
    const disk = new SimulatedDisk()
    const state = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
    const version = state.history[0]
    const node = version.diagram.nodes.find((n: { kind: string }) => n.kind === 'box')
    const shape = version.shapes.find((s: { id: string }) => s.id === node.id)
    version.diagram.nodes = Array.from({ length: count }, (_, i) => ({ ...node, id: `n${i}` }))
    version.diagram.edges = []
    version.shapes = version.diagram.nodes.map((n: { id: string }, i: number) => ({
      ...shape,
      id: n.id,
      x: 500 * i,
    }))
    disk.write_atomic('cleaned.state', valid)
    const oversized = envelope_encode({
      ...decoded.envelope,
      payload: new TextEncoder().encode(JSON.stringify(state)),
    })
    disk.write_atomic(file, oversized)
    expect(() => Cleaned.open(disk)).toThrow(/Invalid legacy/)
    expect(disk.read(file)).toEqual(oversized)
    expect(disk.read('interpretation.archive')).toBeNull()
    expect(disk.read('ideas.archive')).toBeNull()
  }
})

// Each failure schedule interrupts one durable boundary before rename. Reopening must finish the
// migration without dropping either side, reapplying the offset, or changing either archive.
test('interrupted migrations preserve both documents and verbatim archives', async () => {
  const sketch = await legacy('Person'),
    ideas = await legacy('Question')
  let expected: ReturnType<Cleaned['document']> | undefined

  for (const fault of [null, 'interpretation.archive', 'ideas.archive', 'cleaned.state']) {
    const disk = new SimulatedDisk()
    disk.write_atomic('cleaned.state', sketch)
    disk.write_atomic('ideas.state', ideas)
    const broken: Disk = {
      read: (name) => disk.read(name),
      write_atomic(name, bytes) {
        if (name === fault) throw new SimulatedCrash()

        disk.write_atomic(name, bytes)
      },
    }

    if (fault) {
      expect(() => Cleaned.open(broken)).toThrow(SimulatedCrash)
      expect(disk.read('cleaned.state')).toEqual(sketch)
    }

    const canvas = Cleaned.open(disk)
    expect(disk.read('interpretation.archive')).toEqual(sketch)
    expect(disk.read('ideas.archive')).toEqual(ideas)
    expect(disk.read('ideas.state')).toEqual(ideas)
    const document = canvas.document(hash)
    expect(document.records.filter((r) => r.typeName === 'binding')).toHaveLength(4)
    expect(document.current).toMatchObject({ source_hash: hash, shapes_count: 6 })
    const diagram = canvas.diagram_current()!
    const ids = new Set(diagram.nodes.map((n) => n.id))
    expect(ids.size).toBe(4)
    expect(diagram.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true)
    expect(diagram.nodes.map((n) => n.origin)).toEqual(['sketch', 'sketch', 'agent', 'agent'])
    expect(canvas.legacy_diagrams().ideas).toHaveLength(2)
    expect(canvas.legacy_diagrams().interpretation).toHaveLength(2)
    const decoded = envelope_decode(disk.read('cleaned.state')!, 'cleaned')

    if (!decoded.ok) throw Error(decoded.reason)

    expect(JSON.parse(new TextDecoder().decode(decoded.envelope.payload)).format).toBe(
      'tldraw-sync.canvas.v2',
    )
    expect(Cleaned.open(disk).document(hash)).toEqual(document)

    if (expected) expect(document).toEqual(expected)

    expected = document
  }
})
