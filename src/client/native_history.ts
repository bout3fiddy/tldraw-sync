// One Undo and one Redo on the iPad for the person's edits and the agent's revisions together,
// newest first. The person's edits stay in tldraw's own history. An agent revision arrives
// from the board, already saved, with a marker in the document's meta (`native_scene.ts`); it
// is placed in time by how many undo steps tldraw held when it arrived. Undo takes the newest:
// a step of tldraw's above that point, or else the revision, which the board reverts through
// this page's pairing. Redo is the same, the other way. The board checks every revert against
// the room as it is, so nothing here can overwrite work it has not seen.
//
// Where the order cannot be known, Undo and Redo stop rather than guess: a revision the board
// refuses to take back, one missed while offline, or one taken back elsewhere ends the history
// below it. A step of the person's that the agent's revision came after is then not undone.

import { atom, TLDOCUMENT_ID, type Atom, type Editor, type TLRecord } from 'tldraw'
import { assert } from '../shared/assert'
import { board_query } from '../shared/board_session'
import { native_marker_read, native_route_revert, type NativeMarker } from '../shared/native_scene'
import { credential_pattern, whiteboard_path } from '../shared/whiteboard'

// `at` is tldraw's undo count when a revision was applied, or its redo count when one was taken
// back: steps above it are newer.
export type NativeStep = { readonly sequence: number; readonly at: number }

export type NativeTimeline = {
  readonly undos: readonly NativeStep[]
  readonly redos: readonly NativeStep[]
  readonly undo_floor: number
  readonly redo_floor: number
  readonly seen: number
  readonly reverting: number | null
  readonly reverted: readonly number[]
}

export type Counts = { readonly undos: number; readonly redos: number }
export type Next = 'agent' | 'person' | 'none'

// The board retains eight revisions; an older one cannot be taken back, so it ends history.
export const native_steps_max = 8

export function timeline_create(seen: number): NativeTimeline {
  assert(Number.isSafeInteger(seen) && seen >= 0, 'a seen sequence is a count')

  const timeline = {
    undos: [],
    redos: [],
    undo_floor: 0,
    redo_floor: 0,
    seen,
    reverting: null,
    reverted: [],
  }
  assert(timeline.undos.length === 0 && timeline.redos.length === 0, 'history starts empty')
  return timeline
}

export function undo_next(timeline: NativeTimeline, undos: number): Next {
  const top = timeline.undos[timeline.undos.length - 1]
  assert(top === undefined || top.at >= timeline.undo_floor, 'a step lies above the floor')

  if (timeline.reverting !== null) return 'none'

  if (top !== undefined && undos <= top.at) return 'agent'

  return undos > timeline.undo_floor ? 'person' : 'none'
}

export function redo_next(timeline: NativeTimeline, redos: number): Next {
  const top = timeline.redos[timeline.redos.length - 1]
  assert(top === undefined || top.at >= timeline.redo_floor, 'a step lies above the floor')

  if (timeline.reverting !== null) return 'none'

  if (top !== undefined && redos <= top.at) return 'agent'

  return redos > timeline.redo_floor ? 'person' : 'none'
}

// A marker that arrived from the board. Only the next revision in order is placed: anything
// else was missed, or taken back somewhere other than here, and ends history at this point.
export function timeline_marker(
  timeline: NativeTimeline,
  marker: NativeMarker,
  counts: Counts,
): NativeTimeline {
  if (marker.sequence <= timeline.seen) return timeline

  const next = marker.sequence === timeline.seen + 1
  const own =
    marker.reverts !== null &&
    (marker.reverts === timeline.reverting || timeline.reverted.includes(marker.sequence))

  if (next && own) return { ...timeline, seen: marker.sequence }

  if (!next || marker.reverts !== null) return barrier(timeline, counts, marker.sequence)

  // A new agent revision, like a new edit, ends what could be redone before it.
  const step = { sequence: marker.sequence, at: counts.undos }
  const kept = timeline.undos.slice(Math.max(0, timeline.undos.length + 1 - native_steps_max))
  const dropped = timeline.undos[timeline.undos.length - kept.length - 1]
  const undo_floor = dropped === undefined ? timeline.undo_floor : dropped.at
  const placed = { ...timeline, undos: [...kept, step], undo_floor, seen: marker.sequence }
  assert(placed.undos.length <= native_steps_max, 'steps are bounded')
  return { ...placed, redos: [], redo_floor: counts.redos }
}

function barrier(timeline: NativeTimeline, counts: Counts, seen: number): NativeTimeline {
  assert(seen > timeline.seen, 'a barrier follows a newer marker')

  const ended = { ...timeline, undos: [], redos: [], seen }
  assert(counts.undos >= 0 && counts.redos >= 0, 'counts are counts')
  return { ...ended, undo_floor: counts.undos, redo_floor: counts.redos }
}

// The person changed the scene: what was undone can no longer be redone, as in tldraw itself.
export function timeline_edited(timeline: NativeTimeline): NativeTimeline {
  if (timeline.redos.length === 0 && timeline.redo_floor === 0) return timeline

  return { ...timeline, redos: [], redo_floor: 0 }
}

export function timeline_reverting(timeline: NativeTimeline, sequence: number): NativeTimeline {
  assert(timeline.reverting === null, 'one revert at a time')
  assert(sequence >= 1, 'a revert names a revision')
  return { ...timeline, reverting: sequence }
}

// The board took `step` back as revision `sequence`. `counts` are tldraw's counts now.
export function timeline_reverted(
  timeline: NativeTimeline,
  direction: 'undo' | 'redo',
  sequence: number,
  counts: Counts,
): NativeTimeline {
  assert(timeline.reverting !== null, 'a revert was asked for')
  assert(sequence > timeline.reverting, 'a revert is a newer revision')

  const from = direction === 'undo' ? timeline.undos : timeline.redos
  const top = from[from.length - 1]
  const rest = from.slice(0, -1)
  const reverted = [...timeline.reverted, sequence].slice(-native_steps_max)
  const base = { ...timeline, reverting: null, reverted }

  // An agent revision landed while this one was being taken back: the order is no longer
  // known, so history ends here, both ways.
  if (top === undefined || top.sequence !== timeline.reverting) {
    const ended = { ...base, undos: [], redos: [] }
    return { ...ended, undo_floor: counts.undos, redo_floor: counts.redos }
  }

  if (direction === 'undo') {
    const redos = [...timeline.redos, { sequence, at: counts.redos }].slice(-native_steps_max)
    return { ...base, undos: rest, redos }
  }

  const undos = [...timeline.undos, { sequence, at: counts.undos }].slice(-native_steps_max)
  return { ...base, redos: rest, undos }
}

// The board will not take `step` back: history ends there, in that direction.
export function timeline_refused(
  timeline: NativeTimeline,
  direction: 'undo' | 'redo',
  counts: Counts,
): NativeTimeline {
  assert(timeline.reverting !== null, 'a refusal answers a revert')

  const base = { ...timeline, reverting: null }

  if (direction === 'undo') return { ...base, undos: [], undo_floor: counts.undos }

  return { ...base, redos: [], redo_floor: counts.redos }
}

export function timeline_failed(timeline: NativeTimeline): NativeTimeline {
  assert(timeline.reverting !== null, 'a failure answers a revert')
  return { ...timeline, reverting: null }
}

export type RevertAnswer =
  | { readonly kind: 'reverted'; readonly sequence: number }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }

export type Revert = (sequence: number) => Promise<RevertAnswer>

// Asks the board to take one revision back. A refusal is final; anything else may be retried.
export function revert_request(session: string, token: () => string | null): Revert {
  return async (sequence) => {
    const credential = token()

    if (credential === null || !credential_pattern.test(credential)) {
      return { kind: 'failed', message: 'Scan the Mac stage QR to undo the agent’s changes.' }
    }

    let response: Response

    try {
      response = await fetch(`${whiteboard_path}${native_route_revert}?${board_query(session)}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({ sequence }),
      })
    } catch {
      return { kind: 'failed', message: 'The Mac did not answer. Try again.' }
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const reverted = body.sequence

    const valid = typeof reverted === 'number' && Number.isSafeInteger(reverted)

    if (response.ok && valid && reverted > sequence) {
      return { kind: 'reverted', sequence: reverted }
    }

    if (response.status === 409 || response.status === 404) {
      return { kind: 'refused', message: 'The agent’s change has changed since. It stays.' }
    }

    return { kind: 'failed', message: 'The Mac could not undo that just now. Try again.' }
  }
}

type Interceptable = {
  addHistoryInterceptor(
    fn: (entry: { changes: Changes }, source: 'user' | 'remote') => void,
  ): () => void
}
type HistoryCounts = { getNumUndos(): number; getNumRedos(): number }
type Changes = {
  added: Record<string, TLRecord>
  updated: Record<string, [TLRecord, TLRecord]>
  removed: Record<string, TLRecord>
}

const scene_type_names = new Set(['shape', 'binding', 'page', 'asset'])

type Direction = 'undo' | 'redo'
type Methods = Pick<Editor, 'undo' | 'redo' | 'getCanUndo' | 'getCanRedo'>

// Replaces the editor's Undo and Redo, which every button and shortcut calls, with the shared
// history. Returns the uninstall.
export function native_history_install(
  editor: Editor,
  revert: Revert,
  notice: (text: string) => void,
): () => void {
  const history = new NativeHistory(editor, revert, notice)
  const original: Methods = {
    undo: editor.undo,
    redo: editor.redo,
    getCanUndo: editor.getCanUndo,
    getCanRedo: editor.getCanRedo,
  }
  const uninstall_interceptor = history.store.addHistoryInterceptor((entry, source) =>
    history.intercept(entry.changes, source),
  )
  const replaced: Methods = {
    undo: () => history.step('undo', original.undo),
    redo: () => history.step('redo', original.redo),
    getCanUndo: () => history.next('undo') !== 'none',
    getCanRedo: () => history.next('redo') !== 'none',
  }
  Object.assign(editor, replaced)
  assert(editor.undo === replaced.undo, 'Undo now runs the shared history')

  return () => {
    uninstall_interceptor()
    Object.assign(editor, original)
    assert(editor.undo === original.undo, 'the editor has its own Undo again')
  }
}

class NativeHistory {
  readonly store: Interceptable
  readonly timeline: Atom<NativeTimeline>
  private readonly history: HistoryCounts
  private applying = false

  constructor(
    private readonly editor: Editor,
    private readonly revert: Revert,
    private readonly notice: (text: string) => void,
  ) {
    this.store = editor.store as unknown as Interceptable
    assert(typeof this.store.addHistoryInterceptor === 'function', 'the store has interceptors')

    // The editor's own history, which its Undo runs; the editor keeps the field protected.
    this.history = (editor as unknown as { history: HistoryCounts }).history
    assert(typeof this.history.getNumUndos === 'function', 'the editor exposes its history')

    const seen = seen_read(editor.store.get(TLDOCUMENT_ID)?.meta)
    this.timeline = atom('native history', timeline_create(seen))
  }

  counts(): Counts {
    return { undos: this.history.getNumUndos(), redos: this.history.getNumRedos() }
  }

  next(direction: Direction): Next {
    const timeline = this.timeline.get()
    const counts = this.counts()
    return direction === 'undo'
      ? undo_next(timeline, counts.undos)
      : redo_next(timeline, counts.redos)
  }

  step(direction: Direction, person: () => unknown): Editor {
    const next = this.next(direction)

    if (next === 'agent') void this.agent(direction)

    if (next !== 'person') return this.editor

    this.applying = true

    try {
      person.call(this.editor)
    } finally {
      this.applying = false
    }

    return this.editor
  }

  // The board takes the revision back; this page then sees it arrive like any other change.
  private async agent(direction: Direction): Promise<void> {
    const steps = direction === 'undo' ? this.timeline.get().undos : this.timeline.get().redos
    const top = steps[steps.length - 1]
    assert(top !== undefined, 'an agent step is on top')
    this.timeline.set(timeline_reverting(this.timeline.get(), top.sequence))
    const answer = await this.revert(top.sequence)
    const timeline = this.timeline.get()

    if (answer.kind === 'reverted') {
      this.timeline.set(timeline_reverted(timeline, direction, answer.sequence, this.counts()))
      return
    }

    this.notice(answer.message)
    const refused = answer.kind === 'refused'
    this.timeline.set(
      refused ? timeline_refused(timeline, direction, this.counts()) : timeline_failed(timeline),
    )
  }

  // Runs inside every store change, before anyone else sees it, in the order changes happen.
  intercept(changes: Changes, source: 'user' | 'remote'): void {
    if (source === 'remote') {
      const change = changes.updated[TLDOCUMENT_ID]
      const marker = change === undefined ? null : native_marker_read(change[1].meta)

      if (marker !== null) {
        this.timeline.set(timeline_marker(this.timeline.get(), marker, this.counts()))
      }

      return
    }

    if (!this.applying && scene_changed(changes)) {
      this.timeline.set(timeline_edited(this.timeline.get()))
    }
  }
}

function seen_read(meta: unknown): number {
  const marker = native_marker_read(meta)
  return marker === null ? 0 : marker.sequence
}

function scene_changed(changes: Changes): boolean {
  for (const group of [changes.added, changes.updated, changes.removed]) {
    for (const id of Object.keys(group)) {
      if (scene_type_names.has(id.slice(0, id.indexOf(':')))) return true
    }
  }

  return false
}
