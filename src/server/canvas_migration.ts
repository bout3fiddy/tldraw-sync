import { createHash } from 'node:crypto'
import { assert } from '../shared/assert'
import { cleaned_history_count_max } from '../shared/constants'
import type {
  Diagram,
  DiagramNode,
  Origin,
  ProposalShape,
  ProposalStyle,
} from '../shared/cleanup_types'
import { type State, type Version } from './cleaned'
import { StorageError, type Disk } from './storage'

const names = ['interpretation', 'ideas'] as const
type Name = (typeof names)[number]
type Entry = { digest: string; state: State }
export type Archives = Partial<Record<Name, Entry>>
export const empty = (): State => ({ revision: 0, current: null, history: [] })

export function legacy_check(state: State, name: Name): void {
  assert(state.history.length <= cleaned_history_count_max, 'legacy history validated first')
  assert(state.current !== null || state.revision === 0, 'an empty legacy state is unpublished')

  for (const version of [...state.history, state.current]) {
    if (!version) continue

    const { shapes, diagram } = version
    const items = [...(diagram?.nodes ?? []), ...(diagram?.edges ?? [])]
    const ideas = name === 'ideas'

    if (
      (ideas && !diagram) ||
      shapes.length > (ideas ? 256 : 400) ||
      (diagram?.nodes.length ?? 0) > (ideas ? 64 : 80) ||
      (diagram?.edges.length ?? 0) > 160 ||
      items.reduce((sum, item) => sum + item.strokes.length, 0) > 1000 ||
      items.some((item) => item.origin !== undefined)
    ) {
      throw new StorageError(`Invalid legacy ${name} version.`)
    }
  }
}

// On retry, an already written archive must match the still-active original byte for byte.
export function archives_read(disk: Disk, migrating: boolean, parse: (bytes: Uint8Array) => State) {
  const archives: Archives = {}
  const pending = new Map<`${Name}.archive`, Uint8Array>()

  for (const name of names) {
    const file = `${name}.archive` as const
    const archived = disk.read(file)
    const active = name === 'ideas' ? 'ideas.state' : 'cleaned.state'
    const bytes = migrating ? disk.read(active) : archived

    if (migrating && archived && (!bytes || !Buffer.from(archived).equals(bytes))) {
      throw new StorageError(`Conflicting ${name} archive. Nothing was overwritten.`)
    }

    if (!bytes) continue

    // Nine normalized legacy versions, including defaults added to every saved shape.

    if (bytes.length > 32 * 1024 * 1024) throw new StorageError(`Oversized ${name} archive.`)

    const state = parse(bytes)
    legacy_check(state, name)

    if (migrating && !archived) pending.set(file, bytes)

    archives[name] = { digest: createHash('sha256').update(bytes).digest('hex'), state }
  }

  for (const [file, bytes] of pending) {
    disk.write_atomic(file, bytes)
    const saved = disk.read(file)
    assert(saved !== null, 'legacy archive exists before activation')
    assert(Buffer.from(bytes).equals(saved), 'archive preserves the exact source bytes')
  }

  assert(Object.keys(archives).length <= names.length, 'one archive per legacy file')
  return archives
}

export function archive_manifest(archives: Archives) {
  const manifest = names.map((name) => archives[name]?.digest ?? null)
  assert(manifest.length === 2, 'manifest pins both legacy slots, including absent files')
  assert(
    manifest.every((d) => d === null || d.length === 64),
    'manifest uses full SHA-256',
  )
  return manifest
}

export function archived_diagrams(archives: Archives) {
  return Object.fromEntries(
    names.flatMap((name) => {
      const state = archives[name]?.state

      if (!state) return []

      const versions = [...state.history, ...(state.current ? [state.current] : [])]
      assert(versions.length <= cleaned_history_count_max + 1, 'archived semantics fit snapshot')
      return [[name, versions.map(({ revision, diagram }) => ({ revision, diagram }))]]
    }),
  )
}

// Compact positional ids also cover legacy ids already at the 40-character limit.
function namespace(version: Version, origin: Origin) {
  const prefix = origin === 'agent' ? 'a' : 's'
  const ids = new Map(version.shapes.map((s, i) => [s.id, `${prefix}_${i}`]))
  assert(ids.size === version.shapes.length, 'legacy shape ids are unique')
  const id = (old: string) => {
    const value = ids.get(old)
    assert(value !== undefined, 'validated graph references an existing shape')
    return value
  }
  const shapes = version.shapes.map((s) =>
    s.kind !== 'arrow'
      ? { ...s, id: id(s.id) }
      : { ...s, id: id(s.id), from: id(s.from), to: id(s.to) },
  )
  const nodes =
    version.diagram?.nodes.map((n) => ({
      ...n,
      origin,
      id: id(n.id),
      parent: n.parent && id(n.parent),
    })) ?? []
  const edges =
    version.diagram?.edges.map((e) => ({
      ...e,
      origin,
      id: id(e.id),
      from: id(e.from),
      to: id(e.to),
    })) ?? []
  assert(shapes.length === version.shapes.length, 'namespace preserves every native shape')
  assert(nodes.length === (version.diagram?.nodes.length ?? 0), 'no semantic nodes lost')
  assert(edges.length === (version.diagram?.edges.length ?? 0), 'all semantic connections kept')
  return { shapes, nodes, edges }
}

function bounds(shapes: ProposalShape[]) {
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity

  for (const s of shapes) {
    if (s.kind === 'arrow') continue

    x = Math.min(x, s.x)
    y = Math.min(y, s.y)
    right = Math.max(right, s.x + (s.w ?? Math.max(1, s.text.length) * 32))
    const lines = s.text.split('\n').length + Math.ceil((s.text.length * 32) / (s.w ?? Infinity))
    bottom = Math.max(bottom, s.y + (s.kind === 'text' ? lines * 48 : s.h))
  }

  assert(Number.isFinite(x) && Number.isFinite(y), 'every legacy graph has a bounded node')
  assert(right >= x && bottom >= y, 'measured bounds contain their origin')
  return { x, y, right, bottom }
}

// A legacy graph supplied every source placement or none. When only one side supplied them,
// preserve those placements and fill the missing side from the actual migrated native shapes.
function complete_places(nodes: DiagramNode[], shapes: ProposalShape[]): void {
  if (!nodes.some((n) => n.at) || nodes.every((n) => n.at)) return

  const by_id = new Map(shapes.map((shape) => [shape.id, shape]))

  for (const node of nodes) {
    if (node.at) continue

    const shape = by_id.get(node.id)
    assert(shape !== undefined && shape.kind !== 'arrow', 'semantic node has native bounds')
    const { x, y, right, bottom } = bounds([shape])
    node.at = [x, y, right - x, bottom - y]
  }

  assert(
    nodes.every((n) => n.at),
    'mixed legacy layouts produce a complete placement',
  )
}

export function migration_state(archives: Archives): State {
  const source = archives.interpretation?.state ?? empty()
  const ideas = archives.ideas?.state.current
  const sketch = source.current

  if (!ideas && !sketch) return empty()

  const s = sketch && namespace(sketch, 'sketch')
  const a = ideas && namespace(ideas, 'agent')

  if (s && a) {
    const left = bounds(s.shapes),
      right = bounds(a.shapes)

    if (
      left.right >= right.x &&
      right.right >= left.x &&
      left.bottom >= right.y &&
      right.bottom >= left.y
    ) {
      for (const shape of a.shapes) {
        if (shape.kind !== 'arrow') shape.x += left.right - right.x + 48
      }
    }
  }

  const shapes = [...(s?.shapes ?? []), ...(a?.shapes ?? [])]
  const nodes = [...(s?.nodes ?? []), ...(a?.nodes ?? [])]
  const edges = [...(s?.edges ?? []), ...(a?.edges ?? [])]
  const base = sketch ?? ideas
  assert(base !== undefined && base !== null, 'migration has a legacy current version')
  const flow = sketch?.diagram?.flow ?? ideas?.diagram?.flow ?? 'right'

  complete_places(nodes, shapes)

  const ids = new Set(shapes.map((shape) => shape.id))
  assert(ids.size === shapes.length, 'namespaces keep colliding legacy IDs distinct')
  assert(
    edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    'remapped endpoints exist',
  )
  assert(
    nodes.every((n) => !n.parent || ids.has(n.parent)),
    'remapped parents exist',
  )
  const diagram: Diagram | null = nodes.length ? { flow, nodes, edges } : null
  const revision = Math.max(source.revision, ideas?.revision ?? 0)
  const agent_style: ProposalStyle | undefined = ideas?.style
  const current = {
    ...base,
    source_hash: sketch?.source_hash ?? null,
    revision,
    shapes,
    diagram,
    migrated: true,
    agent_style,
  }
  assert(shapes.length <= 656, 'both legacy documents fit the unified capacity')
  return { revision, current, history: source.history }
}
