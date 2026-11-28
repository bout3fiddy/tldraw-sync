// The iPad's one history on a real tldraw store and the editor's own `HistoryManager`: the
// person's steps through tldraw, the agent's revisions arriving as remote changes with their
// marker, and the board answering a revert the way `native_scene.ts` does. The journey is the
// one a person makes: a rough box, the agent tidies it, an arrow, Undo, Undo, Redo, Redo.

import { expect, test } from 'bun:test'
import {
  createTLSchema,
  createTLStore,
  HistoryManager,
  TLDOCUMENT_ID,
  type Editor,
  type TLRecord,
  type TLStore,
} from 'tldraw'
import { assert } from '../shared/assert'
import { native_marker_key, type NativeMarker } from '../shared/native_scene'
import {
  native_history_install,
  redo_next,
  timeline_create,
  timeline_marker,
  undo_next,
  type Revert,
  type RevertAnswer,
} from './native_history'

type Point = { x: number; y: number; z: number }

const rough_points: Point[] = [
  { x: 0, y: 0, z: 0.31 },
  { x: 98, y: 3, z: 0.47 },
  { x: 101, y: 77, z: 0.52 },
]
const tidy_points: Point[] = [
  { x: 0, y: 0, z: 0.5 },
  { x: 100, y: 0, z: 0.5 },
  { x: 100, y: 80, z: 0.5 },
]

class Pad {
  readonly store: TLStore
  readonly history: HistoryManager<TLRecord>
  readonly editor: Editor
  readonly notices: string[] = []
  readonly asked: number[] = []
  answers: RevertAnswer[] = []
  readonly uninstall: () => void

  constructor() {
    this.store = createTLStore({ schema: createTLSchema() })
    ;(this.store as unknown as { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
    this.history = new HistoryManager<TLRecord>({ store: this.store })
    const history = this.history
    const fake = {
      store: this.store,
      history,
      undo: () => (history.undo(), fake),
      redo: () => (history.redo(), fake),
      getCanUndo: () => history.getNumUndos() > 0,
      getCanRedo: () => history.getNumRedos() > 0,
    }
    this.editor = fake as unknown as Editor
    const revert: Revert = async (sequence) => {
      this.asked.push(sequence)
      const answer = this.answers.shift()
      assert(answer !== undefined, 'the test says how the board answers')
      return answer
    }
    this.uninstall = native_history_install(this.editor, revert, (text) => this.notices.push(text))
  }

  page(): string {
    const page = this.store.allRecords().find((record) => record.typeName === 'page')
    assert(page !== undefined, 'a usable store has a page')
    return page.id
  }

  // A gesture: one stopping point, then local writes, as the editor's tools make them.
  person(name: string, change: () => void): void {
    ;(this.history as unknown as { _mark(id: string): void })._mark(name)
    change()
  }

  // What the board's push looks like here: records and the marker in one remote change.
  remote(records: TLRecord[], marker: NativeMarker): void {
    const document = this.store.get(TLDOCUMENT_ID)
    assert(document !== undefined, 'the store has its document')
    const meta = { ...document.meta, [native_marker_key]: marker }
    this.store.mergeRemoteChanges(() => this.store.put([...records, { ...document, meta }]))
  }

  points(id: string): Point[] | null {
    const shape = this.store.get(id as TLRecord['id']) as { props: { segments: any[] } } | undefined
    return shape === undefined ? null : shape.props.segments[0].points
  }

  // Undo or Redo pressed, and the board's answer awaited.
  async press(direction: 'undo' | 'redo'): Promise<void> {
    if (direction === 'undo') this.editor.undo()
    else this.editor.redo()

    await Promise.resolve()
    await Promise.resolve()
  }
}

function stroke(pad: Pad, id: string, points: Point[], x = 100): TLRecord {
  return {
    id,
    typeName: 'shape',
    type: 'draw',
    x,
    y: 100,
    rotation: 0,
    index: 'a1',
    parentId: pad.page(),
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      segments: [{ type: 'free', points }],
      isComplete: true,
      isClosed: false,
      isPen: true,
      scale: 1,
    },
  } as unknown as TLRecord
}

test('one Undo and Redo walk the person and the agent back and forth in time', async () => {
  const pad = new Pad()
  const rough = stroke(pad, 'shape:rough', rough_points)
  const tidied = stroke(pad, 'shape:rough', tidy_points)
  const arrow = stroke(pad, 'shape:arrow', rough_points, 400)
  pad.person('box', () => pad.store.put([rough]))
  pad.remote([tidied], { sequence: 1, reverts: null })
  pad.person('arrow', () => pad.store.put([arrow]))

  // Undo: the arrow, which tldraw takes back.
  await pad.press('undo')
  expect(pad.points('shape:arrow')).toBe(null)
  expect(pad.asked).toEqual([])

  // Undo: the agent's tidy, which the board takes back; this page sees it arrive.
  pad.answers = [{ kind: 'reverted', sequence: 2 }]
  await pad.press('undo')
  expect(pad.asked).toEqual([1])
  pad.remote([rough], { sequence: 2, reverts: 1 })
  expect(pad.points('shape:rough')).toEqual(rough_points)

  // Undo: the box itself. Then Redo brings the three back in order.
  await pad.press('undo')
  expect(pad.points('shape:rough')).toBe(null)
  await pad.press('redo')
  expect(pad.points('shape:rough')).toEqual(rough_points)
  pad.answers = [{ kind: 'reverted', sequence: 3 }]
  await pad.press('redo')
  expect(pad.asked).toEqual([1, 2])
  pad.remote([tidied], { sequence: 3, reverts: 2 })
  await pad.press('redo')
  expect(pad.points('shape:arrow')).toEqual(rough_points)
  expect(pad.points('shape:rough')).toEqual(tidy_points)
  expect(pad.editor.getCanRedo()).toBe(false)

  // And back again: the arrow, then the redone tidy, which is reverted as revision 3.
  await pad.press('undo')
  pad.answers = [{ kind: 'reverted', sequence: 4 }]
  await pad.press('undo')
  expect(pad.asked).toEqual([1, 2, 3])
  pad.uninstall()
})

test('a revision the board will not take back ends Undo there; a lost one just waits', async () => {
  const pad = new Pad()
  pad.person('box', () => pad.store.put([stroke(pad, 'shape:rough', rough_points)]))
  pad.remote([stroke(pad, 'shape:rough', tidy_points)], { sequence: 1, reverts: null })

  // The Mac did not answer: nothing changes, and Undo still means the agent's revision.
  pad.answers = [{ kind: 'failed', message: 'The Mac did not answer. Try again.' }]
  await pad.press('undo')
  expect(pad.notices).toEqual(['The Mac did not answer. Try again.'])
  expect(pad.editor.getCanUndo()).toBe(true)

  // Refused: the person's box under it is not undone, since that would drop the agent's work.
  pad.answers = [{ kind: 'refused', message: 'It stays.' }]
  await pad.press('undo')
  expect(pad.asked).toEqual([1, 1])
  expect(pad.editor.getCanUndo()).toBe(false)
  await pad.press('undo')
  expect(pad.points('shape:rough')).toEqual(tidy_points)
  pad.uninstall()
})

test('a new edit ends Redo, and a revision arriving out of order ends Undo below it', async () => {
  const pad = new Pad()
  pad.person('box', () => pad.store.put([stroke(pad, 'shape:rough', rough_points)]))
  pad.remote([stroke(pad, 'shape:rough', tidy_points)], { sequence: 1, reverts: null })
  pad.answers = [{ kind: 'reverted', sequence: 2 }]
  await pad.press('undo')
  pad.remote([stroke(pad, 'shape:rough', rough_points)], { sequence: 2, reverts: 1 })
  expect(pad.editor.getCanRedo()).toBe(true)
  pad.person('note', () => pad.store.put([stroke(pad, 'shape:note', rough_points, 700)]))
  expect(pad.editor.getCanRedo()).toBe(false)

  // Revision 4 arrives, but 3 was never seen: the order below it is unknown.
  pad.remote([stroke(pad, 'shape:other', tidy_points, 900)], { sequence: 4, reverts: null })
  expect(pad.editor.getCanUndo()).toBe(false)
  pad.uninstall()
})

test('placing a revision follows only the next marker, and stays bounded', () => {
  let timeline = timeline_create(0)

  for (let sequence = 1; sequence <= 20; sequence += 1) {
    timeline = timeline_marker(timeline, { sequence, reverts: null }, { undos: sequence, redos: 0 })
  }

  expect(timeline.undos.map((step) => step.sequence)).toEqual([13, 14, 15, 16, 17, 18, 19, 20])
  expect(timeline.undo_floor).toBe(12)
  expect(undo_next(timeline, 20)).toBe('agent')
  expect(undo_next(timeline, 21)).toBe('person')
  expect(redo_next(timeline, 0)).toBe('none')

  // A repeated or older marker changes nothing; a foreign revert ends history.
  expect(timeline_marker(timeline, { sequence: 20, reverts: null }, { undos: 0, redos: 0 })).toBe(
    timeline,
  )
  const ended = timeline_marker(timeline, { sequence: 21, reverts: 20 }, { undos: 30, redos: 2 })
  expect([ended.undos, ended.undo_floor, ended.redo_floor]).toEqual([[], 30, 2])
})
