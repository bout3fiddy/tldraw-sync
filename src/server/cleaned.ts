// The Agent canvas: a separate document an external agent publishes whole, as a scene. It never
// touches the sync room, so human ink stays exactly as drawn. A publish is accepted only from
// the canvas revision as it is now (compare-and-swap) and, when it was made from the sketch,
// only from the sketch as it is now (the source hash). The new state is written to disk
// before it replaces the old one, so a failed write leaves the previous canvas in place, in
// memory and on disk.
//
// A draft is prepared by the same steps as a publish, up to but not including the write. So a
// preview shows exactly the records a publish of the same proposal would save, and a draft
// that would be refused is refused as a draft.
//
// Prior revisions are kept, up to a bound, for an explicit restore. A restore is itself a new
// revision and goes through the same compare-and-swap, so it cannot clobber a newer publish.
// A revision published in a retired format is kept as the native records it was shown as
// (see `canvas_migration.ts`): it can be shown and restored, and has no scene to edit.
//
// A published canvas may be empty. It is a revision like any other.

import type { TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { board_id_pattern } from '../shared/board_session'
import type {
  CanvasRecord,
  CanvasView,
  CleanedDocument,
  CleanedProvenance,
  CleanedStatus,
} from '../shared/canvas_types'
import {
  canvas_records_count_max,
  cleaned_history_count_max,
  document_hash_pattern,
} from '../shared/constants'
import { document_hash } from '../shared/document_hash'
import { JsonReader } from '../shared/json_reader'
import {
  scene_controls_write,
  view_state_read,
  view_state_rest,
  view_states_count,
  type SceneControl,
  type ViewState,
} from '../shared/scene_controls'
import type { SceneElement } from '../shared/scene_types'
import { canvas_migrate, type MigratedVersion } from './canvas_migration'
import { canvas_records_problem, canvas_shapes_count } from './canvas_records'
import {
  canvas_file_name,
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
import { ink_resolve, type SketchRecords } from './scene_ink'
import { scene_elements_read, scene_elements_write, scene_parse } from './scene_proposal'
import { scene_controls_read } from './scene_control_reader'
import { view_records, view_taps } from './scene_view_records'
import { envelope_encode, type Disk } from './storage'

export type PublishRefusal =
  | { kind: 'invalid'; path: string; message: string }
  | { kind: 'session_mismatch'; session: string }
  | { kind: 'sketch_changed'; sketch_hash: string }
  | { kind: 'revision_conflict'; revision: number }

// A published result carries the title the proposal offered, for the board's registry to apply
// to a board that is still unnamed. The canvas itself keeps no title. `records_hash` names the
// records that were saved: the same proposal, previewed first, gave the same hash.
export type PublishResult =
  | {
      kind: 'published'
      revision: number
      shapes_count: number
      records_hash: string
      title: string | null
    }
  | PublishRefusal

// A draft: the records a publish of the same proposal would save now, and nothing saved.
export type DraftResult =
  | {
      kind: 'draft'
      base_revision: number
      snapshot: string
      shapes_count: number
      records_hash: string
      records: TLRecord[]

      // The view the records show, the rest state unless one was asked for, and how many
      // views the controls choose between: 1 for a scene without controls.
      state: ViewState
      states_count: number
    }
  | PublishRefusal

export type RestoreResult =
  | { kind: 'restored'; revision: number; restored_from: number }
  | { kind: 'revision_conflict'; revision: number }
  | { kind: 'not_found' }

// One view of the current revision, for a page that shows the controls. Refused when the state
// names a control or value the revision does not have; nothing changes either way.
export type ViewResult =
  { kind: 'view'; view: CanvasView } | { kind: 'invalid'; path: string; message: string }

// One revision. `scene` is what the agent published, with the strokes the board copied, and
// null for a revision from a retired format. `controls` are the scene's, empty for a scene of
// one view and for a retired format. `records` is what is shown for it: its view at rest.
type Version = Provenance & {
  scene: SceneElement[] | null
  controls: SceneControl[]
  records: TLRecord[]
}
type State = { revision: number; current: Version | null; history: Version[] }
type Prepared = { version: Omit<Version, 'revision' | 'published_at_ms'>; title: string | null }

const state_format = 'tldraw-sync.canvas.v3'
const label = '-'

export class Cleaned {
  private constructor(
    private readonly disk: Disk,
    private state: State,
  ) {}

  // A board that never had a canvas has no file: it opens with nothing published. A canvas
  // saved in a retired format is brought to native records here, once.
  static open(disk: Disk): Cleaned {
    const bytes = disk.read(canvas_file_name)
    const json = bytes === null ? null : state_decode(bytes)

    if (json !== null && json.format === state_format) return new Cleaned(disk, state_read(json))

    const migrated = canvas_migrate(disk, bytes, json)
    const state: State =
      migrated === null
        ? { revision: 0, current: null, history: [] }
        : {
            revision: migrated.revision,
            current: migrated.current === null ? null : version_migrated(migrated.current),
            history: migrated.history.map(version_migrated),
          }
    const cleaned = new Cleaned(disk, state)

    if (migrated !== null) cleaned.persist(state)

    assert(cleaned.state.revision >= 0, 'a revision is never negative')
    assert(cleaned.state.history.length <= cleaned_history_count_max, 'history is bounded')
    return cleaned
  }

  // `session` is the board this canvas belongs to. A proposal is bound to the session of its
  // snapshot: two boards can hold the same sketch at the same revision, so the hash and the
  // revision alone cannot tell a proposal for one from a replay against the other. `sketch`
  // gives the sketch's records as they are now, for a scene to copy strokes from.
  publish(
    input: unknown,
    sketch_hash: string,
    session: string,
    now_ms: number,
    sketch: SketchRecords = () => [],
  ): PublishResult {
    assert(Number.isFinite(now_ms), 'time is a number')
    const prepared = this.prepare(input, sketch_hash, session, sketch)

    if ('kind' in prepared) return prepared

    const version: Version = {
      ...prepared.version,
      revision: this.state.revision + 1,
      published_at_ms: now_ms,
    }
    this.commit(version)
    assert(this.state.current === version, 'the published version is current')
    return {
      kind: 'published',
      revision: version.revision,
      shapes_count: canvas_shapes_count(version.records),
      records_hash: document_hash(version.records),
      title: prepared.title,
    }
  }

  // Everything a publish checks and makes, and nothing a publish writes. `state_input` asks for
  // one view of a scene with controls, as untrusted JSON; null is the view at rest, whose
  // records are exactly what the publish would save. One draft is one view: the views of a
  // scene are never drawn all at once.
  draft(
    input: unknown,
    sketch_hash: string,
    session: string,
    sketch: SketchRecords = () => [],
    state_input: unknown = null,
  ): DraftResult {
    const before = this.state
    const prepared = this.prepare(input, sketch_hash, session, sketch)

    if ('kind' in prepared) return prepared

    const { scene, controls } = prepared.version
    const read = view_state_read(controls, state_input)

    if (!read.ok) return { kind: 'invalid', path: read.path, message: read.message }

    assert(scene !== null, 'a draft is a scene')
    const records =
      state_input === null ? prepared.version.records : view_records(scene, read.state)
    assert(this.state === before, 'a draft changes nothing')
    assert(records.length <= canvas_records_count_max, 'a draft is bounded')
    return {
      kind: 'draft',
      base_revision: this.state.revision,
      snapshot: sketch_hash,
      shapes_count: canvas_shapes_count(records),
      records_hash: document_hash(records),
      records,
      state: read.state,
      states_count: view_states_count(controls),
    }
  }

  // One view of the current revision. A revision without controls, or from a retired format,
  // has one view: its records, whatever was asked.
  view(state_input: unknown): ViewResult {
    const current = this.state.current
    const controls = current?.controls ?? []
    const read = view_state_read(controls, state_input)

    if (!read.ok) return { kind: 'invalid', path: read.path, message: read.message }

    const scene = current?.scene ?? null
    const rest = state_input === null || scene === null
    const records: CanvasRecord[] = rest
      ? (current?.records ?? [])
      : view_records(scene, read.state)
    const view: CanvasView = {
      revision: this.state.revision,
      controls: scene_controls_write(controls),
      state: read.state,
      states_count: view_states_count(controls),
      records,
      taps: scene === null ? [] : view_taps(scene, read.state),
    }
    assert(records.length <= canvas_records_count_max, 'a served view is bounded')
    assert(current !== null || records.length === 0, 'records belong to the current revision')
    return { kind: 'view', view }
  }

  // The controls of the current revision's scene, as an agent may send them again.
  controls_current(): ReturnType<typeof scene_controls_write> {
    const controls = this.state.current?.controls ?? []
    assert(controls.length === 0 || this.state.current?.scene != null, 'controls need a scene')
    return scene_controls_write(controls)
  }

  // Restores a prior revision, the most recent one when none is named.
  restore(base_revision: number, revision: number | null, now_ms: number): RestoreResult {
    assert(Number.isInteger(base_revision), 'a base revision is whole')
    assert(revision === null || Number.isInteger(revision), 'a restored revision is whole')

    if (base_revision !== this.state.revision) {
      return { kind: 'revision_conflict', revision: this.state.revision }
    }

    const { history } = this.state
    const target =
      revision === null ? history.at(-1) : history.find((version) => version.revision === revision)

    if (target === undefined) return { kind: 'not_found' }

    const version: Version = {
      ...target,
      revision: this.state.revision + 1,
      published_at_ms: now_ms,
      restored_from: target.revision,
    }
    this.commit(version)
    assert(this.state.current === version, 'the restored version is current')
    return { kind: 'restored', revision: version.revision, restored_from: target.revision }
  }

  status(sketch_hash: string): CleanedStatus {
    assert(document_hash_pattern.test(sketch_hash), 'the sketch hash is well formed')
    const { current, history, revision } = this.state
    const status = {
      revision,
      sketch_hash,
      current: current === null ? null : provenance(current),
      stale: current?.source_hash != null && current.source_hash !== sketch_hash,
      history: history.map(provenance),
    }
    assert(status.current === null || status.current.revision === revision, 'current is latest')
    return status
  }

  // The scene behind the current revision, as an agent may send it again: without the copied
  // strokes, which an agent only ever names. Null when there is none to edit.
  scene_current(): Json[] | null {
    const scene = this.state.current?.scene ?? null
    const written = scene === null ? null : scene_elements_write(scene, 'without_ink')
    assert(written === null || written.length === scene?.length, 'every element is offered')
    assert(written === null || this.state.current !== null, 'a scene belongs to a revision')
    return written
  }

  document(sketch_hash: string): CleanedDocument {
    const status = this.status(sketch_hash)
    const records: CanvasRecord[] = this.state.current?.records ?? []
    assert(status.current !== null || records.length === 0, 'records belong to the current')
    assert(records.length <= canvas_records_count_max, 'a served canvas is bounded')
    return { ...status, records }
  }

  // The checks of a publish, in the order their refusals matter, and the version it would
  // save. Nothing is written.
  private prepare(
    input: unknown,
    sketch_hash: string,
    session: string,
    sketch: SketchRecords,
  ): Prepared | PublishRefusal {
    assert(document_hash_pattern.test(sketch_hash), 'the sketch hash is well formed')
    assert(board_id_pattern.test(session), 'the board session is well formed')
    const parsed = scene_parse(input)

    if (!parsed.ok) return { kind: 'invalid', path: parsed.path, message: parsed.message }

    const { proposal } = parsed
    const current = this.state.current
    const from_sketch = proposal.basis === 'sketch'

    if (proposal.session !== session) return { kind: 'session_mismatch', session }

    if (from_sketch && proposal.snapshot !== sketch_hash) {
      return { kind: 'sketch_changed', sketch_hash }
    }

    if (proposal.base_revision !== this.state.revision) {
      return { kind: 'revision_conflict', revision: this.state.revision }
    }

    // A scene made from the sketch takes its strokes from the sketch as it is now. A change
    // to the canvas alone keeps the strokes the canvas holds.
    const scene = ink_resolve(
      proposal.elements,
      from_sketch
        ? { kind: 'sketch', records: sketch, hash: sketch_hash }
        : { kind: 'canvas', held: current?.scene ?? null },
    )

    if (!Array.isArray(scene)) return { kind: 'invalid', ...scene }

    const source_hash = from_sketch ? proposal.snapshot : (current?.source_hash ?? null)
    assert(!from_sketch || source_hash === sketch_hash, 'a sketch reading names the live ink')
    assert(
      from_sketch || source_hash === (current?.source_hash ?? null),
      'a canvas change cannot mark the sketch as read',
    )

    // What every page shows, and what a publish saves, is the view at rest.
    const { agent, summary, title, controls } = proposal
    const records = view_records(scene, view_state_rest(controls))
    const provenance = { source_hash, agent, summary, restored_from: null }
    return { version: { ...provenance, scene, controls, records }, title }
  }

  // Write first, then swap. A throwing disk leaves the state, and the file, as they were.
  private commit(version: Version): void {
    assert(version.revision === this.state.revision + 1, 'revisions grow one at a time')
    assert(canvas_records_problem(version.records) === null, 'a committed canvas can be served')
    const previous = this.state.current
    const history =
      previous === null
        ? this.state.history
        : [...this.state.history, previous].slice(-cleaned_history_count_max)
    const next: State = { revision: version.revision, current: version, history }

    this.persist(next)
    this.state = next
  }

  private persist(next: State): void {
    const payload = new TextEncoder().encode(JSON.stringify(state_json(next)))
    const encoded = envelope_encode({ kind: 'cleaned', label, payload })
    this.disk.write_atomic(canvas_file_name, encoded)

    // Pair assertion: the file now on disk reads back as the state about to be served.
    const written = this.disk.read(canvas_file_name)
    assert(written !== null, 'the canvas state was written')
    assert(Buffer.from(written).equals(encoded), 'the durable state matches the prepared state')
  }
}

function provenance(version: Version): CleanedProvenance {
  const { scene, records, controls: _controls, ...rest } = version
  assert(records.length <= canvas_records_count_max, 'a published version is bounded')
  assert(rest.revision > 0, 'a published version has a revision')
  return { ...rest, shapes_count: canvas_shapes_count(records), legacy: scene === null }
}

function version_migrated(version: MigratedVersion): Version {
  assert(version.revision > 0, 'a migrated version has a revision')
  assert(canvas_records_problem(version.records) === null, 'migrated records can be served')
  return { ...version, scene: null, controls: [] }
}

function state_json(state: State): object {
  assert(state.revision >= 0, 'a revision is never negative')
  assert(state.history.length <= cleaned_history_count_max, 'history is bounded')
  const current = state.current === null ? null : version_json(state.current)
  return { format: state_format, ...state, current, history: state.history.map(version_json) }
}

// A scene revision is saved as its scene, with the strokes the board copied, and its records
// are made from that again when it is read. A revision from a retired format has no scene,
// and is saved as its records.
function version_json(version: Version): object {
  const { scene, records, controls, ...rest } = version
  assert(rest.revision > 0, 'a saved version has a revision')
  assert(records.length <= canvas_records_count_max, 'a saved version is bounded')

  if (scene === null) return { ...rest, records }

  // Controls are saved only when a scene has them: a scene without is saved as it always was.
  const elements = scene_elements_write(scene, 'with_ink')

  if (controls.length === 0) return { ...rest, scene: elements }

  return { ...rest, controls: scene_controls_write(controls), scene: elements }
}

// The saved file is untrusted like any input: each version is checked again with the same
// rules as a publish. Damage stops the server instead of silently dropping a canvas.
function state_read(json: Json): State {
  const revision = json.revision

  if (json.format !== state_format || !revision_valid(revision) || revision < 0) {
    throw damaged('unknown format or revision')
  }

  const current = json.current === null ? null : version_read(json.current)
  const history = history_input_read(json).map(version_read)

  if (!state_coherent(revision, current, history)) throw damaged('revisions do not agree')

  assert(current === null || current.revision === revision, 'current is the latest revision')
  assert(current !== null || history.length === 0, 'history follows a published canvas')
  return { revision, current, history }
}

function version_read(value: unknown): Version {
  const version = object_read(value)
  const provenance = version === null ? null : provenance_read(version, true)

  if (version === null || provenance === null) throw damaged('a version is malformed')

  const scened = version.scene !== undefined
  const recorded = version.records !== undefined

  if (scened === recorded) throw damaged('a version is malformed')

  if (recorded) {
    if (version.controls !== undefined) throw damaged('a version is malformed')

    return { ...provenance, scene: null, controls: [], records: records_read(version.records) }
  }

  const reader = new JsonReader()
  const controls = scene_controls_read(reader, version.controls)
  const scene = scene_elements_read(reader, version.scene, 'held', controls)

  if (reader.problem !== null) throw damaged('a version is malformed')

  assert(provenance.revision > 0, 'a read version has a revision')
  assert(scene.length <= canvas_records_count_max, 'a read scene is bounded')
  const records = view_records(scene, view_state_rest(controls))
  return { ...provenance, scene, controls, records }
}

function records_read(value: unknown): TLRecord[] {
  if (!Array.isArray(value) || value.length > canvas_records_count_max) {
    throw damaged('a version is malformed')
  }

  if (canvas_records_problem(value as CanvasRecord[]) !== null) {
    throw damaged('a version is malformed')
  }

  assert(value.length <= canvas_records_count_max, 'read records are bounded')
  return value as TLRecord[]
}
