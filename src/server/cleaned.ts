// The cleaned diagram: a separate document an external agent publishes whole. It never touches
// the sync room, so human ink stays exactly as drawn. A publish is accepted only when it was
// made from the sketch as it is now (the source hash) and from the cleaned revision as it is
// now (compare-and-swap). The new state is written to disk before it replaces the old one, so a
// failed write leaves the previous diagram in place, in memory and on disk.
//
// Prior revisions are kept, up to a bound, for an explicit restore. A restore is itself a new
// revision and goes through the same compare-and-swap, so it cannot clobber a newer publish.

import type { TLRecord } from '@tldraw/tlschema'
import type { Layer } from '../shared/whiteboard'
import {
  archive_manifest,
  archived_diagrams,
  archives_read,
  migration_state,
  type Archives,
} from './canvas_migration'
import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern } from '../shared/board_session'
import { cleaned_history_count_max, document_hash_pattern } from '../shared/constants'
import {
  proposal_format,
  proposal_format_styled,
  type CleanedDocument,
  type CleanedProvenance,
  type CleanedStatus,
  type Diagram,
  type ProposalShape,
  type ProposalStyle,
} from '../shared/cleanup_types'
import { proposal_parse, proposal_records } from './cleanup_proposal'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

// A published result carries the title the proposal offered, for the board's registry to apply
// to a board that is still unnamed. The cleaned diagram itself keeps no title.
export type PublishResult =
  | { kind: 'published'; revision: number; shapes_count: number; title: string | null }
  | { kind: 'invalid'; path: string; message: string }
  | { kind: 'session_mismatch'; session: string }
  | { kind: 'sketch_changed'; sketch_hash: string }
  | { kind: 'revision_conflict'; revision: number }

export type RestoreResult =
  | { kind: 'restored'; revision: number; restored_from: number }
  | { kind: 'revision_conflict'; revision: number }
  | { kind: 'not_found' }

// A version keeps the semantic diagram it was composed from, if any, so the next snapshot can
// offer it to the agent and a restore brings it back with the shapes. It keeps the style it was
// published in, so it renders the same way after a restart or a restore.
export type Version = Omit<CleanedProvenance, 'shapes_count'> & {
  shapes: ProposalShape[]
  style: ProposalStyle
  diagram: Diagram | null
  migrated?: boolean
  agent_style?: ProposalStyle
}
export type State = { revision: number; current: Version | null; history: Version[] }

const file_name = 'cleaned.state'
const legacy_format = 'tldraw-sync.cleaned.v1'
const state_format = 'tldraw-sync.canvas.v2'
const label = '-'

export class Cleaned {
  private records_current: TLRecord[]

  private constructor(
    private readonly disk: Disk,
    private state: State,
    private readonly archives: Archives,
  ) {
    this.records_current = state.current === null ? [] : proposal_records(state.current)
  }

  // A board saved before cleanup existed has no file: it opens with nothing published.
  static open(disk: Disk): Cleaned {
    const bytes = disk.read(file_name)
    const json = bytes && state_decode(bytes)
    const migrating = json?.format !== state_format
    const archives = archives_read(disk, migrating, (b) => state_read(state_decode(b)))
    const state = migrating ? migration_state(archives) : state_read(json!, archives)
    const cleaned = new Cleaned(disk, state, archives)

    if (migrating && Object.keys(archives).length) cleaned.persist(state)

    assert(cleaned.state.revision >= 0, 'a revision is never negative')
    assert(cleaned.state.history.length <= cleaned_history_count_max, 'history is bounded')
    return cleaned
  }

  // `session` is the board this diagram belongs to. A proposal is bound to the session of its
  // snapshot: two boards can hold the same sketch at the same revision, so the hash and the
  // revision alone cannot tell a proposal for one from a replay against the other. Only the
  // default board accepts a proposal that names no session, as every proposal once did.
  publish(
    input: unknown,
    sketch_hash: string,
    session: string,
    now_ms: number,
    layer: Layer = 'interpretation',
  ): PublishResult {
    assert(document_hash_pattern.test(sketch_hash), 'the sketch hash is well formed')
    assert(board_id_pattern.test(session), 'the board session is well formed')
    assert(Number.isFinite(now_ms), 'time is a number')
    const parsed = proposal_parse(input)

    if (!parsed.ok) return { kind: 'invalid', path: parsed.path, message: parsed.message }

    const { proposal } = parsed

    if ((proposal.session ?? board_default_id) !== session) {
      return { kind: 'session_mismatch', session }
    }

    const current = this.state.current
    const diagram = proposal.diagram

    if (layer === 'ideas' || (layer === 'canvas' && !diagram)) {
      return { kind: 'invalid', path: 'layer', message: 'Publish a semantic graph to canvas.' }
    }

    if (layer === 'interpretation' && (has_agents(diagram) || has_agents(current?.diagram))) {
      return { kind: 'invalid', path: 'origin', message: 'Use canvas for mixed origins.' }
    }

    const source_edit =
      layer === 'interpretation' ||
      has_raw_shapes(current) ||
      sketch_graph(current?.diagram) !== sketch_graph(diagram)

    if (source_edit && proposal.snapshot !== sketch_hash)
      return { kind: 'sketch_changed', sketch_hash }

    if (proposal.base_revision !== this.state.revision) {
      return { kind: 'revision_conflict', revision: this.state.revision }
    }

    const version: Version = {
      revision: this.state.revision + 1,
      source_hash: source_edit ? proposal.snapshot : (current?.source_hash ?? null),
      agent: proposal.agent,
      summary: proposal.summary,
      published_at_ms: now_ms,
      restored_from: null,
      shapes: proposal.shapes,
      style: proposal.style,
      diagram: proposal.diagram,
    }
    assert(
      source_edit || version.source_hash === (current?.source_hash ?? null),
      'agent-only commits cannot mark the sketch as interpreted',
    )
    assert(!source_edit || version.source_hash === sketch_hash, 'source edits name the live ink')
    this.commit(version)
    assert(this.state.current === version, 'the published version is current')
    return {
      kind: 'published',
      revision: version.revision,
      shapes_count: version.shapes.length,
      title: proposal.title,
    }
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

  // The semantic diagram behind the current revision, stale or not: identities to reuse.
  diagram_current(): Diagram | null {
    const { current } = this.state
    const diagram = current === null ? null : current.diagram
    assert(diagram === null || current !== null, 'a diagram belongs to a published version')
    assert(diagram === null || diagram.nodes.length > 0, 'a kept diagram has nodes')
    return diagram
  }

  legacy_diagrams() {
    return archived_diagrams(this.archives)
  }

  document(sketch_hash: string): CleanedDocument {
    const status = this.status(sketch_hash)
    const records = this.records_current
    assert((status.current === null) === (records.length === 0), 'records match the current')
    return { ...status, records }
  }

  // Write first, then swap. A throwing disk leaves the state, and the file, as they were.
  private commit(version: Version): void {
    assert(version.revision === this.state.revision + 1, 'revisions grow one at a time')
    const records = proposal_records(version)
    const previous = this.state.current
    const history =
      previous === null
        ? this.state.history
        : [...this.state.history, previous].slice(-cleaned_history_count_max)
    const next: State = { revision: version.revision, current: version, history }

    this.persist(next)
    this.state = next
    this.records_current = records
  }

  private persist(next: State): void {
    const json = { ...state_json(next), archives: archive_manifest(this.archives) }
    const payload = new TextEncoder().encode(JSON.stringify(json))
    const file = file_name
    const encoded = envelope_encode({ kind: 'cleaned', label, payload })
    this.disk.write_atomic(file, encoded)

    // Pair assertion: the file now on disk reads back as the state about to be served.
    const written = this.disk.read(file)
    assert(written !== null, 'the cleaned state was written')
    assert(Buffer.from(written).equals(encoded), 'the durable state matches the prepared state')
  }
}

function provenance(version: Version): CleanedProvenance {
  const { shapes, diagram: _, style: _style, migrated: _m, agent_style: _a, ...rest } = version
  assert(shapes.length > 0, 'a published version has shapes')
  assert(rest.revision > 0, 'a published version has a revision')
  return { ...rest, shapes_count: shapes.length }
}

const has_agents = (diagram: Diagram | null | undefined) =>
  diagram?.nodes.some((node) => node.origin === 'agent') ||
  diagram?.edges.some((edge) => edge.origin === 'agent')

function state_json(state: State): object {
  assert(state.revision >= 0, 'a revision is never negative')
  assert(state.history.length <= cleaned_history_count_max, 'history is bounded')
  const current = state.current === null ? null : version_json(state.current)
  return { format: state_format, ...state, current, history: state.history.map(version_json) }
}

// Saved shapes carry every styling default, so each version is saved in the styled format,
// whichever format it was published in. A version saved before that has no format: v1. The
// style is saved only when it is not the default, so a plain version is saved byte for byte
// as before styles existed, and reads back as plain.
function version_json(version: Version): object {
  const { diagram, style, ...rest } = version
  assert(rest.shapes.length > 0, 'a saved version has shapes')
  assert(rest.revision > 0, 'a saved version has a revision')

  if (version.migrated) {
    const { revision, published_at_ms, restored_from } = version
    return { migrated: true, revision, published_at_ms, restored_from }
  }

  const styled = style === 'plain' ? {} : { style }
  return diagram === null
    ? { ...rest, format: proposal_format_styled, ...styled }
    : { ...rest, format: proposal_format_styled, ...styled, diagram }
}

// The saved file is untrusted like any input: each version is checked again with the same rules
// as a publish. Damage stops the server instead of silently dropping a diagram.
function state_decode(bytes: Uint8Array) {
  const decoded = envelope_decode(bytes, 'cleaned')

  if (!decoded.ok) throw new StorageError(`${file_name} is damaged: ${decoded.reason}`)

  let parsed: unknown

  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
  } catch {
    throw new StorageError(`${file_name} is damaged: it is not JSON`)
  }

  // Valid JSON need not be an object: null, a number, text or a list are refused here.

  const json = object_read(parsed)

  if (json === null) throw new StorageError(`${file_name} is damaged: it is not a JSON object`)

  return json
}

function state_read(json: Record<string, unknown>, archives?: Archives): State {
  if (archives && JSON.stringify(json.archives) !== JSON.stringify(archive_manifest(archives))) {
    throw new StorageError('The active canvas does not match its archives.')
  }

  const revision = json.revision

  const expected = archives ? state_format : legacy_format

  if (json.format !== expected || !revision_valid(revision) || revision < 0) {
    throw new StorageError(`${file_name} is damaged: unknown format or revision`)
  }

  const history_input = Array.isArray(json.history) ? (json.history as unknown[]) : null

  if (history_input === null || history_input.length > cleaned_history_count_max) {
    throw new StorageError(`${file_name} is damaged: history is malformed`)
  }

  const read = (value: unknown) => {
    const v = object_read(value)

    if (!archives || v?.migrated !== true) return version_read(value, !!archives)

    const base = migration_state(archives).current
    const { revision, restored_from, published_at_ms } = v

    if (
      !base ||
      !revision_valid(revision) ||
      revision < base.revision ||
      typeof published_at_ms !== 'number' ||
      !Number.isFinite(published_at_ms) ||
      (restored_from !== null &&
        (!revision_valid(restored_from) || restored_from <= 0 || restored_from >= revision))
    )
      throw new StorageError('Damaged migration reference.')

    return { ...base, revision, published_at_ms, restored_from }
  }
  const current = json.current === null ? null : read(json.current)
  const history = history_input.map(read)

  if (!state_coherent(revision, current, history)) {
    throw new StorageError(`${file_name} is damaged: revisions do not agree`)
  }

  assert(current === null || current.revision === revision, 'current is the latest revision')
  assert(current !== null || history.length === 0, 'history follows a published diagram')
  return { revision, current, history }
}

// Whether the three parts describe a state a publish or a restore can leave behind. Nothing
// published means revision 0 and no history. Otherwise the current version is the revision, and
// the history holds strictly older versions, oldest first.
function state_coherent(revision: number, current: Version | null, history: Version[]): boolean {
  assert(revision >= 0, 'a revision is never negative')
  assert(history.length <= cleaned_history_count_max, 'history is bounded')

  if (current === null) return revision === 0 && history.length === 0

  if (current.revision !== revision) return false

  let newer = current.revision

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const older = (history[index] as Version).revision

    if (older >= newer) return false

    newer = older
  }

  return true
}

function version_read(value: unknown, unified: boolean): Version {
  const version = object_read(value)

  if (version === null) throw new StorageError(`${file_name} is damaged: a version is malformed`)

  const format = version.format ?? proposal_format
  const parsed = proposal_parse({
    format,
    snapshot: unified && version.source_hash === null ? '0'.repeat(16) : version.source_hash,
    base_revision: 0,
    agent: version.agent,
    summary: version.summary,
    shapes: version.shapes,
    ...(version.style === undefined ? {} : { style: version.style }),
    ...(version.diagram === undefined ? {} : { diagram: version.diagram }),
  })
  const { revision, published_at_ms, restored_from } = version

  // A restore copies a strictly older revision, so it can only name one below its own.
  const valid =
    parsed.ok &&
    (version.source_hash !== null ||
      (unified &&
        parsed.proposal.diagram !== null &&
        sketch_graph(parsed.proposal.diagram) === '')) &&
    revision_valid(revision) &&
    revision > 0 &&
    typeof published_at_ms === 'number' &&
    Number.isFinite(published_at_ms) &&
    (restored_from === null ||
      (revision_valid(restored_from) && restored_from > 0 && restored_from < revision))

  if (!valid) throw new StorageError(`${file_name} is damaged: a version is malformed`)

  assert(parsed.proposal.shapes.length > 0, 'a saved version has shapes')
  assert(restored_from === null || restored_from < revision, 'a restore names an older revision')
  return {
    revision,
    source_hash: version.source_hash === null ? null : parsed.proposal.snapshot,
    agent: parsed.proposal.agent,
    summary: parsed.proposal.summary,
    published_at_ms,
    restored_from,
    shapes: parsed.proposal.shapes,
    style: parsed.proposal.style,
    diagram: parsed.proposal.diagram,
  }
}

function has_raw_shapes(current: Version | null): boolean {
  if (!current) return false

  const d = current.diagram
  return !d || d.nodes.length + d.edges.length !== current.shapes.length
}

function sketch_graph(d: Diagram | null | undefined): string {
  if (!d) return ''

  const items = [...d.nodes, ...d.edges].filter((item) => item.origin !== 'agent')

  if (!items.length) return ''

  items.sort((a, b) => (a.id < b.id ? -1 : Number(a.id !== b.id)))
  return JSON.stringify([d.flow, items.map(({ origin: _, ...item }) => item)])
}

function revision_valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

// A JSON object with named fields, or null for null, a list or any other JSON value.
function object_read(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  return value as Record<string, unknown>
}
