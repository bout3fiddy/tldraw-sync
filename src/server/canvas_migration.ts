// Brings a canvas saved in a retired format to native records, once, without losing anything.
//
// Two retired layouts exist on disk. The first kept two documents, a cleaned diagram
// (`cleaned.state`) and the agent's ideas (`ideas.state`). The second, the unified canvas,
// merged them into one file that still pointed at exact copies of the first two
// (`interpretation.archive`, `ideas.archive`). Both saved positioned shapes, not records.
//
// Every file a migration reads is kept, byte for byte, before the new state replaces it: the
// first layout's two documents as the two archives, and a unified canvas as `canvas.archive`.
// An archive already written must match the file still in place, so an interrupted migration
// is finished on the next start, and a conflicting one overwrites nothing. What an older
// board showed for each kept version is what this board shows for it.

import type { TLRecord } from '@tldraw/tlschema'
import { createHash } from 'node:crypto'
import { assert } from '../shared/assert'
import { cleaned_history_count_max } from '../shared/constants'
import { JsonReader } from '../shared/json_reader'
import {
  damaged,
  history_input_read,
  object_read,
  provenance_read,
  revision_valid,
  state_coherent,
  state_decode,
  type Json,
  type Provenance,
} from './canvas_state'
import {
  legacy_drawing_read,
  legacy_records,
  type LegacyDrawing,
  type LegacyShape,
} from './legacy_canvas'
import { StorageError, type Disk } from './storage'

const names = ['interpretation', 'ideas'] as const
type Name = (typeof names)[number]
type LegacyVersion = Provenance & { drawing: LegacyDrawing }
type LegacyState = { revision: number; current: LegacyVersion | null; history: LegacyVersion[] }
type Entry = { digest: string; state: LegacyState }
type Archives = Partial<Record<Name, Entry>>

// A version as the new state keeps it: where it came from, and its native records.
export type MigratedVersion = Provenance & { records: TLRecord[] }
export type Migrated = {
  revision: number
  current: MigratedVersion | null
  history: MigratedVersion[]
}

const format_first = 'tldraw-sync.cleaned.v1'
const format_unified = 'tldraw-sync.canvas.v2'
const archive_size_bytes_max = 32 * 1024 * 1024

// The most shapes each of the first layout's documents ever held.
const shapes_count_max: Record<Name, number> = { interpretation: 400, ideas: 256 }
const empty = (): LegacyState => ({ revision: 0, current: null, history: [] })

// The canvas in `bytes`, which is not in the current format, as native records. Null when the
// data directory holds no canvas at all. `json` is what `bytes` decoded to.
export function canvas_migrate(
  disk: Disk,
  bytes: Uint8Array | null,
  json: Json | null,
): Migrated | null {
  assert((bytes === null) === (json === null), 'a decoded state has its bytes')
  const unified = json !== null && json.format === format_unified
  const archives = archives_read(disk, !unified)
  let state: LegacyState

  if (unified) {
    assert(bytes !== null && json !== null, 'a unified canvas was read from a file')
    state = state_read(json, archives)
    archive_keep(disk, bytes)
  } else {
    if (Object.keys(archives).length === 0) return null

    state = migration_state(archives)
  }

  const migrated = {
    revision: state.revision,
    current: state.current === null ? null : version_records(state.current),
    history: state.history.map(version_records),
  }
  assert(migrated.history.length <= cleaned_history_count_max, 'history is bounded')
  assert(migrated.current === null || migrated.current.revision === migrated.revision, 'latest')
  return migrated
}

function version_records(version: LegacyVersion): MigratedVersion {
  const { drawing, ...provenance } = version
  const records = legacy_records(drawing)

  if (typeof records === 'string') throw damaged(`revision ${version.revision}: ${records}`)

  assert(provenance.revision > 0, 'a kept version has a revision')
  return { ...provenance, records }
}

// The unified canvas is kept whole before the new state replaces it. A copy left by an
// interrupted migration must be this very file.
function archive_keep(disk: Disk, bytes: Uint8Array): void {
  assert(bytes.byteLength > 0, 'a saved canvas is not empty')
  const kept = disk.read('canvas.archive')

  if (kept !== null) {
    if (!Buffer.from(kept).equals(bytes)) {
      throw new StorageError('Conflicting canvas archive. Nothing was overwritten.')
    }

    return
  }

  disk.write_atomic('canvas.archive', bytes)
  const saved = disk.read('canvas.archive')
  assert(saved !== null && Buffer.from(saved).equals(bytes), 'the archive keeps the exact bytes')
}

// The first layout's two documents. While `migrating` they are read from where they lie and
// copied aside; afterwards they are read from the copies. On a retry, a copy already written
// must match the still-active original byte for byte.
function archives_read(disk: Disk, migrating: boolean): Archives {
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

    if (bytes.length > archive_size_bytes_max) throw new StorageError(`Oversized ${name} archive.`)

    const state = state_read(state_decode(bytes), null)
    first_layout_check(state, name)

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

function first_layout_check(state: LegacyState, name: Name): void {
  assert(state.history.length <= cleaned_history_count_max, 'legacy history validated first')
  assert(state.current !== null || state.revision === 0, 'an empty legacy state is unpublished')

  for (const version of [...state.history, state.current]) {
    if (version !== null && version.drawing.shapes.length > shapes_count_max[name]) {
      throw new StorageError(`Invalid legacy ${name} version.`)
    }
  }
}

function archive_manifest(archives: Archives): Array<string | null> {
  const manifest = names.map((name) => archives[name]?.digest ?? null)
  assert(manifest.length === 2, 'manifest pins both legacy slots, including absent files')
  assert(
    manifest.every((digest) => digest === null || digest.length === 64),
    'manifest uses full SHA-256',
  )
  return manifest
}

// A saved state of either retired layout. `archives` is given for a unified canvas, which
// names the copies it was merged from and may point at the merged version instead of holding
// it.
function state_read(json: Json, archives: Archives | null): LegacyState {
  if (archives && JSON.stringify(json.archives) !== JSON.stringify(archive_manifest(archives))) {
    throw new StorageError('The active canvas does not match its archives.')
  }

  const revision = json.revision
  const expected = archives ? format_unified : format_first

  if (json.format !== expected || !revision_valid(revision) || revision < 0) {
    throw damaged('unknown format or revision')
  }

  const read = (value: unknown) => version_read(value, archives)
  const current = json.current === null ? null : read(json.current)
  const history = history_input_read(json).map(read)

  if (!state_coherent(revision, current, history)) throw damaged('revisions do not agree')

  assert(current === null || current.revision === revision, 'current is the latest revision')
  assert(current !== null || history.length === 0, 'history follows a published diagram')
  return { revision, current, history }
}

function version_read(value: unknown, archives: Archives | null): LegacyVersion {
  const version = object_read(value)

  if (version === null) throw damaged('a version is malformed')

  if (archives !== null && version.migrated === true) return merged_read(version, archives)

  const provenance = provenance_read(version, archives !== null)
  const reader = new JsonReader()
  const drawing = legacy_drawing_read(reader, version)

  if (provenance === null || reader.problem !== null) throw damaged('a version is malformed')

  assert(provenance.revision > 0, 'a read version has a revision')
  assert(drawing.shapes.length <= 800, 'a read version is bounded')
  return { ...provenance, drawing }
}

// A unified canvas saved the version it merged from the two documents as a pointer to them,
// with only its own revision and time.
function merged_read(version: Json, archives: Archives): LegacyVersion {
  const base = migration_state(archives).current
  const { revision, restored_from, published_at_ms } = version
  const valid =
    base !== null &&
    revision_valid(revision) &&
    revision >= base.revision &&
    typeof published_at_ms === 'number' &&
    Number.isFinite(published_at_ms) &&
    (restored_from === null ||
      (revision_valid(restored_from) && restored_from > 0 && restored_from < revision))

  if (!valid) throw new StorageError('Damaged migration reference.')

  assert(base !== null && revision_valid(revision), 'a merged version has its documents')
  assert(typeof published_at_ms === 'number', 'a merged version has its time')
  return { ...base, revision, published_at_ms, restored_from: restored_from as number | null }
}

// Compact positional ids keep the two documents' shapes apart, and also cover ids already at
// the length limit.
function namespace(version: LegacyVersion, prefix: 's' | 'a'): LegacyShape[] {
  const { shapes } = version.drawing
  const ids = new Map(shapes.map((shape, index) => [shape.id, `${prefix}_${index}`]))
  assert(ids.size === shapes.length, 'legacy shape ids are unique')
  const id = (old: string) => {
    const value = ids.get(old)
    assert(value !== undefined, 'a read arrow references an existing shape')
    return value
  }
  const renamed = shapes.map((shape) =>
    shape.kind !== 'arrow'
      ? { ...shape, id: id(shape.id) }
      : { ...shape, id: id(shape.id), from: id(shape.from), to: id(shape.to) },
  )
  assert(renamed.length === shapes.length, 'namespace preserves every shape')
  return renamed
}

function bounds(shapes: readonly LegacyShape[]) {
  let [x, y, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]

  for (const shape of shapes) {

    // The first layout held no drawings: those came with the unified canvas.
    if (shape.kind === 'arrow' || shape.kind === 'ink') continue

    const w = shape.w ?? Math.max(1, shape.text.length) * 32
    const lines =
      shape.text.split('\n').length + Math.ceil((shape.text.length * 32) / (shape.w ?? Infinity))
    x = Math.min(x, shape.x)
    y = Math.min(y, shape.y)
    right = Math.max(right, shape.x + w)
    bottom = Math.max(bottom, shape.y + (shape.kind === 'text' ? lines * 48 : shape.h))
  }

  assert(Number.isFinite(x) && Number.isFinite(y), 'every legacy document has a placed shape')
  assert(right >= x && bottom >= y, 'measured bounds contain their origin')
  return { x, y, right, bottom }
}

// The first layout's two documents as one canvas: the cleaned diagram, with the ideas beside
// it when the two would overlap. Its history is the cleaned diagram's.
function migration_state(archives: Archives): LegacyState {
  const source = archives.interpretation?.state ?? empty()
  const ideas = archives.ideas?.state.current ?? null
  const sketch = source.current
  const base = sketch ?? ideas

  if (base === null) return empty()

  const sketched = sketch === null ? [] : namespace(sketch, 's')
  const added = ideas === null ? [] : namespace(ideas, 'a')

  if (sketched.length > 0 && added.length > 0) {
    const [left, right] = [bounds(sketched), bounds(added)]
    const overlap =
      left.right >= right.x &&
      right.right >= left.x &&
      left.bottom >= right.y &&
      right.bottom >= left.y

    for (const shape of added) {
      if (overlap && shape.kind !== 'arrow') shape.x += left.right - right.x + 48
    }
  }

  const shapes = [...sketched, ...added]
  const revision = Math.max(source.revision, archives.ideas?.state.revision ?? 0)
  const drawing = { shapes, style: base.drawing.style, agent_style: ideas?.drawing.style }
  const current = { ...base, source_hash: sketch?.source_hash ?? null, revision, drawing }
  assert(new Set(shapes.map((shape) => shape.id)).size === shapes.length, 'ids stay distinct')
  assert(shapes.length <= 656, 'both legacy documents fit the unified capacity')
  return { revision, current, history: source.history }
}
