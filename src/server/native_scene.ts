// The native shared scene of one board: the sync room's own records, which the person and the
// agent both edit, and the journal of the agent's revisions (`native_edit_revision.ts`). A
// board is native exactly when its directory holds `native.journal`, written when the board was
// created; a board made before is left as it was, with its Agent canvas.
//
// The host edits with its binding; the iPad's Undo and Redo revert one revision through its
// pairing. Each runs alone, in order, and is acknowledged only once the room and the journal
// are both on disk. The push that applies a revision also records it in the document's meta
// (`native_marker_key`), so the iPad orders it among the person's own edits.
//
// A retried request names the same request id. It is answered from the journal while the
// revision is retained. Once it may have expired, it is refused rather than applied twice: the
// request names the journal's `base_sequence` it read, and any revision it made is no older.

import type { TLSocketRoom } from '@tldraw/sync-core'
import { TLDOCUMENT_ID, type TLRecord } from '@tldraw/tlschema'
import { assert, AssertionError } from '../shared/assert'
import { native_marker_key, type NativeMarker } from '../shared/native_scene'
import {
  revision_journal_create,
  revision_journal_decode,
  revision_journal_encode,
  revision_marker,
  revision_settle,
  revision_write,
  type RevisionAction,
  type RevisionConflict,
  type RevisionEntry,
  type RevisionJournal,
  type RevisionMarker,
  type RevisionMinted,
  type RevisionWriteResult,
} from './native_edit_revision'
import { record_hash, room_view_create, type SceneRecord } from './native_scene_ledger'
import type { SceneRequest, SceneStore } from './native_scene_plan'
import { envelope_decode, envelope_encode, StorageError, type Disk } from './storage'

export type NativeEdit = {
  readonly request_id: string
  readonly base_sequence: number
  readonly request: SceneRequest
}

export type NativeOutcome =
  | {
      readonly kind: 'written' | 'replayed'
      readonly sequence: number
      readonly reverts: number | null
      readonly minted: readonly RevisionMinted[]
    }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'refused'
      readonly conflicts: readonly RevisionConflict[]
      readonly conflicts_count: number
    }
  | { readonly kind: 'already_reverted'; readonly sequence: number }
  | {
      readonly kind:
        | 'expired'
        | 'unknown'
        | 'replay_expired'
        | 'base_unknown'
        | 'request_id_reused'
        | 'too_large'
        | 'diverged'
        | 'rejected'
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

export type NativeSceneRead = {
  readonly base_sequence: number
  readonly records: readonly SceneRecord[]
  readonly hashes: Readonly<Record<string, string>>
}

const journal_file = 'native.journal'
const journal_label = '-'
const scene_type_names = ['page', 'shape', 'binding']

// One host and one iPad write a scene; a deeper queue is a stuck or flooding client.
const writes_queued_max = 16

type Room = TLSocketRoom<TLRecord>

export class NativeScene {
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private recovery_needed = false

  private constructor(
    private readonly disk: Disk,
    private readonly room: Room,
    private journal: RevisionJournal,
    private readonly room_save: () => void,
  ) {}

  // A new native board's journal, written before the board is listed, so no listed board is
  // ever half native. Ids are random per board: one board's minted ids never name another's.
  static create_file(disk: Disk, ids: { room_epoch: string; id_namespace: string }): void {
    assert(disk.read(journal_file) === null, 'a board becomes native only when it is new')

    const journal = revision_journal_create({ ...ids, document_clock: 0 })
    journal_save(disk, journal)
    assert(disk.read(journal_file) !== null, 'the native journal was saved')
  }

  // Null for a board without a journal. A pending revision left by a crash is settled from the
  // room as it was saved, before anyone can connect.
  static open(disk: Disk, room: Room, room_save: () => void): NativeScene | null {
    const journal = journal_read(disk)

    if (journal === null) return null

    const scene = new NativeScene(disk, room, journal, room_save)
    const problem = journal.pending === null ? null : scene.recover()

    if (problem !== null) throw new StorageError(`native.journal cannot be settled: ${problem}`)

    assert(scene.journal.pending === null, 'an opened native scene has nothing pending')
    return scene
  }

  scene_read(): NativeSceneRead {
    const records: SceneRecord[] = []
    const hashes: Record<string, string> = {}

    for (const document of this.room.getCurrentSnapshot().documents) {
      const record = document.state as unknown as SceneRecord

      if (!scene_type_names.includes(record.typeName)) continue

      records.push(record)
      hashes[record.id] = record_hash(record)
    }

    assert(records.length === Object.keys(hashes).length, 'every record has one hash')
    return { base_sequence: this.journal.sequence_next, records, hashes }
  }

  edit(edit: NativeEdit): Promise<NativeOutcome> {
    assert(edit.base_sequence >= 1, 'a base sequence was validated')

    return this.serialized(async () => {
      const window = replay_window(this.journal, edit)

      if (window !== null) return { kind: window }

      const action: RevisionAction = {
        kind: 'edit',
        request_id: edit.request_id,
        request: edit.request,
      }
      const result = await this.write(action)

      if (result.kind !== 'replayed') return outcome(result)

      const entry = this.journal.entries.find((candidate) => candidate.sequence === result.sequence)
      assert(entry !== undefined, 'a replayed revision is retained')
      return { ...outcome(result), minted: minted_replayed(entry, edit.request) }
    })
  }

  revert(sequence: number): Promise<NativeOutcome> {
    assert(Number.isSafeInteger(sequence) && sequence >= 1, 'a sequence was validated')

    return this.serialized(async () => outcome(await this.write({ kind: 'revert', sequence })))
  }

  // Writes run one at a time, in arrival order. A full queue is refused, never grown.
  private serialized(work: () => Promise<NativeOutcome>): Promise<NativeOutcome> {
    if (this.queued === writes_queued_max) {
      return Promise.resolve({ kind: 'unavailable', reason: 'busy' })
    }

    this.queued += 1
    assert(this.queued <= writes_queued_max, 'queued writes are bounded')
    const run = this.tail.then(async (): Promise<NativeOutcome> => {
      if (this.recovery_needed) {
        const problem = this.recover()

        if (problem !== null) return { kind: 'unavailable', reason: problem }
      }

      try {
        return await work()
      } catch (error) {
        if (error instanceof AssertionError) throw error

        assert(this.recovery_needed, 'a failed save leaves the scene to recover')
        return { kind: 'unavailable', reason: 'storage_failure' }
      }
    })
    this.tail = run
      .catch(() => undefined)
      .finally(() => {
        this.queued -= 1
      })
    return run
  }

  private async write(action: RevisionAction): Promise<RevisionWriteResult> {
    assert(!this.recovery_needed, 'a write starts from a settled journal')
    assert(this.journal.pending === null, 'a write starts with nothing pending')

    try {
      const result = await revision_write({
        room: this.room,
        room_epoch: this.journal.room_epoch,
        journal: this.journal,
        action,
        saver: { save: (journal) => journal_save(this.disk, journal) },
        annotate: (store, entry) => marker_put(store, this.journal.room_epoch, entry),
        room_save: this.room_save,
      })
      this.journal = result.journal
      this.recovery_needed = result.journal.pending !== null
      return result
    } catch (error) {
      if (error instanceof AssertionError) throw error

      // A save failed somewhere: what is on disk, not what is in memory, decides what happened.
      this.recovery_needed = true
      throw error
    }
  }

  // Reads the journal back from disk, saves the room, then settles any pending revision from
  // the room. Returns why it cannot, and stays in need of recovery.
  private recover(): string | null {
    try {
      const journal = journal_read(this.disk)

      if (journal === null) return 'native.journal is missing'

      if (journal.pending !== null) this.room_save()

      const view = room_view_create(this.room.getCurrentSnapshot(), journal.room_epoch)

      if (!view.ok) return view.reason

      const settled = revision_settle(journal, view.view, 'observe')

      if (!settled.ok) return settled.problem

      if (journal.pending !== null) journal_save(this.disk, settled.journal)

      this.journal = journal.pending === null ? journal : settled.journal
      this.recovery_needed = false
      assert(this.journal.pending === null, 'recovery settles what was pending')
      return null
    } catch (error) {
      if (error instanceof AssertionError) throw error

      // Said in a word: the message may name a path, and a paired pad hears the reason.
      this.recovery_needed = true
      return error instanceof StorageError ? 'storage_damaged' : 'storage_failure'
    }
  }
}

// A request the journal no longer remembers is answered only when it provably never ran: every
// revision it could have made is at or after its base, and all of those are still retained.
function replay_window(
  journal: RevisionJournal,
  edit: NativeEdit,
): 'replay_expired' | 'base_unknown' | null {
  assert(journal.pending === null, 'the window is read from a settled journal')

  if (edit.base_sequence > journal.sequence_next) return 'base_unknown'

  if (journal.entries.some((entry) => entry.request_id === edit.request_id)) return null

  const oldest = journal.entries[0]?.sequence ?? journal.sequence_next
  assert(oldest <= journal.sequence_next, 'retained revisions are in the past')
  return edit.base_sequence < oldest ? 'replay_expired' : null
}

// The adds of an edit are its first changes, in request order, so a replay names the same ids.
function minted_replayed(entry: RevisionEntry, request: SceneRequest): RevisionMinted[] {
  const added = entry.changes.filter((change) => change.before === null)
  assert(added.length === request.adds.length, 'a replayed edit added what the request asks')

  const minted = request.adds.map((record, index) => {
    const change = added[index]
    assert(change !== undefined, 'every add has its change')
    return { placeholder: record.id, id: change.id }
  })
  assert(minted.length === request.adds.length, 'every placeholder is named')
  return minted
}

function outcome(result: RevisionWriteResult): NativeOutcome {
  const plan = result.plan

  if (result.kind === 'written') {
    assert(plan !== null && plan.kind === 'planned', 'a written revision was planned')
    assert(result.sequence === plan.plan.entry.sequence, 'the sequence is the planned one')
    const { sequence, reverts } = plan.plan.entry
    return { kind: 'written', sequence, reverts, minted: plan.plan.minted }
  }

  if (result.kind === 'replayed') {
    assert(result.sequence !== null, 'a replay names its revision')
    return { kind: 'replayed', sequence: result.sequence, reverts: null, minted: [] }
  }

  if (result.kind === 'refused') {
    assert(plan !== null && plan.kind === 'refused', 'a refusal has its conflicts')
    return { kind: 'refused', conflicts: plan.conflicts, conflicts_count: plan.conflicts_count }
  }

  if (result.kind === 'already_reverted') {
    assert(result.sequence !== null, 'an earlier revert is named')
    return { kind: 'already_reverted', sequence: result.sequence }
  }

  if (result.kind === 'unavailable') return unavailable(result)

  return { kind: result.kind }
}

function unavailable(result: RevisionWriteResult): NativeOutcome {
  assert(result.kind === 'unavailable', 'only an unavailable result is described here')

  const plan = result.plan
  const problem = plan !== null && plan.kind === 'unavailable' ? plan.problem : null

  if (problem === 'request_id_reused') return { kind: 'request_id_reused' }

  if (problem === 'revision_too_large') return { kind: 'too_large' }

  return { kind: 'unavailable', reason: problem ?? result.room_problem ?? 'the room is unreadable' }
}

// Runs inside the revision's own push: the marker lands at the same clock as its records, and
// recovery reads it back as evidence the push was applied.
function marker_put(store: SceneStore<TLRecord>, room_epoch: string, entry: RevisionEntry): void {
  const document = store.get(TLDOCUMENT_ID)
  assert(document !== null && document.typeName === 'document', 'a board has its document')

  const marker: NativeMarker & RevisionMarker = revision_marker(room_epoch, entry)
  store.put({ ...document, meta: { ...document.meta, [native_marker_key]: marker } })
}

// Null for a board without a journal; a whole-root stage reads it to find a pending revision.
export function journal_read(disk: Disk): RevisionJournal | null {
  const bytes = disk.read(journal_file)

  if (bytes === null) return null

  const decoded = envelope_decode(bytes, 'native')

  if (!decoded.ok) throw new StorageError(`native.journal is damaged: ${decoded.reason}`)

  let text: string

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded.envelope.payload)
  } catch {
    throw new StorageError('native.journal is damaged: it is not UTF-8')
  }

  const journal = revision_journal_decode(text)

  if (!journal.ok) throw new StorageError(`native.journal is damaged: ${journal.reason}`)

  return journal.journal
}

function journal_save(disk: Disk, journal: RevisionJournal): void {
  const payload = new TextEncoder().encode(revision_journal_encode(journal))
  disk.write_atomic(
    journal_file,
    envelope_encode({ kind: 'native', label: journal_label, payload }),
  )
  assert(payload.byteLength > 0, 'a journal is never empty')
}
