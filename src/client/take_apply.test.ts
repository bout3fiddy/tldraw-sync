// Taking into the sketch against a stand-in editor that records what is written: both guards
// refuse before anything is written, a complete take is one marked step, and a write that
// fails or lands incomplete is rolled back to its mark with the sketch as it was.

import { expect, test } from 'bun:test'
import type { Editor } from 'tldraw'
import { AssertionError } from '../shared/assert'
import { document_hash } from '../shared/document_hash'
import { sketch_hash, take_into_sketch, type TakeAsk, type TakeTools } from './take_apply'

type Rec = Record<string, unknown> & { id: string; typeName: string }

const top = { typeName: 'shape', parentId: 'page:page', props: {} }
const print_records: Rec[] = [
  { ...top, id: 'shape:box', type: 'geo', index: 'a1' },
  { ...top, id: 'shape:tip', type: 'arrow', index: 'a2' },
  { id: 'binding:tip', typeName: 'binding', type: 'arrow', fromId: 'shape:tip', toId: 'shape:box' },
]

type Fault = 'none' | 'throw' | 'drop_binding' | 'assert'

// The sketch as a list of records, with history as snapshots taken at each mark.
function ink_fake(fault: Fault) {
  let shapes: Rec[] = [{ id: 'shape:mine', typeName: 'shape', type: 'draw', parentId: 'page:s' }]
  let bindings: Rec[] = []
  const marks = new Map<string, { shapes: Rec[]; bindings: Rec[] }>()
  const log: string[] = []
  const editor = {
    store: {
      scopedTypes: { document: new Set(['shape', 'binding']) },
      allRecords: () => [...shapes, ...bindings],
    },
    getCurrentPageId: () => 'page:s',
    getHighestIndexForParent: () => 'a5',
    markHistoryStoppingPoint: (name: string) => {
      const id = `mark-${marks.size}`
      marks.set(id, { shapes: [...shapes], bindings: [...bindings] })
      log.push(`mark ${name}`)
      return id
    },
    bailToMark: (id: string) => {
      shapes = marks.get(id)!.shapes
      bindings = marks.get(id)!.bindings
      log.push('bail')
    },
    run: (fn: () => void) => fn(),
    getCurrentPageShapeIds: () => new Set(shapes.map((shape) => shape.id)),
    selectNone: () => ({
      deleteShapes: (ids: string[]) => {
        shapes = shapes.filter((shape) => !ids.includes(shape.id))
        log.push(`delete ${ids.length}`)
      },
    }),
    createShapes: (created: Rec[]) => {
      if (fault === 'throw') throw Error('the store refused a record')

      if (fault === 'assert') throw new AssertionError('a fault in the board')

      shapes = [...shapes, ...created.map((shape) => ({ ...shape, typeName: 'shape' }))]
      log.push(`create ${created.length}`)
    },
    createBindings: (created: Rec[]) => {
      const kept = fault === 'drop_binding' ? [] : created
      bindings = [...bindings, ...kept.map((binding) => ({ ...binding, typeName: 'binding' }))]
    },
    getShape: (id: string) => shapes.find((shape) => shape.id === id),
    getBindingsFromShape: (id: string) => bindings.filter((binding) => binding.fromId === id),
  }
  return { editor: editor as unknown as Editor, log, records: () => [...shapes, ...bindings] }
}

const print = { store: { allRecords: () => print_records } } as unknown as Editor

function tools(): TakeTools {
  let made = 0
  return {
    id_make: (kind) => `${kind}:copy-${(made += 1)}`,
    indices_above: (_below, count) => Array.from({ length: count }, (_, index) => `b${index}`),
    arrow_ends: () => ({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bend: 0 }),
  }
}

function ask(ink: Editor, roots: string[], extra: Partial<TakeAsk> = {}): TakeAsk {
  return {
    roots,
    replace: false,
    revision_seen: 5,
    revision_now: 5,
    sketch_hash_seen: sketch_hash(ink),
    ...extra,
  }
}

test('a stale revision or a changed sketch is refused before anything is written', () => {
  const ink = ink_fake('none')
  const before = document_hash(ink.records())
  const stale = take_into_sketch(ink.editor, print, ask(ink.editor, ['shape:box'], {
    revision_now: 6,
  }), tools())
  expect(stale).toEqual({ kind: 'refused', reason: 'revision_changed' })
  const moved = take_into_sketch(ink.editor, print, ask(ink.editor, ['shape:box'], {
    sketch_hash_seen: '0'.repeat(16),
  }), tools())
  expect(moved).toEqual({ kind: 'refused', reason: 'sketch_changed' })
  expect(document_hash(ink.records())).toBe(before)
  expect(ink.log).toEqual([])
})

test('a take is one marked step that adds copies and keeps the person’s ink', () => {
  const ink = ink_fake('none')
  const outcome = take_into_sketch(ink.editor, print, ask(ink.editor, ['shape:box']), tools())
  expect(outcome).toEqual({ kind: 'taken', shapes_count: 1 })
  expect(ink.log).toEqual(['mark take into sketch', 'create 1', 'mark taken into sketch'])
  const ids = ink.records().map((record) => record.id)
  expect(ids).toEqual(['shape:mine', 'shape:copy-1'])
  expect(ink.records().some((record) => String(record.id).startsWith('shape:box'))).toBe(false)
})

test('the whole print replaces the sketch in one step, its binding with it', () => {
  const ink = ink_fake('none')
  const roots = ['shape:box', 'shape:tip']
  const outcome = take_into_sketch(ink.editor, print, ask(ink.editor, roots, { replace: true }),
    tools())
  expect(outcome).toEqual({ kind: 'taken', shapes_count: 2 })
  expect(ink.log).toEqual(['mark take into sketch', 'delete 1', 'create 2',
    'mark taken into sketch'])
  const bindings = ink.records().filter((record) => record.typeName === 'binding')
  expect(bindings).toEqual([
    expect.objectContaining({ fromId: 'shape:copy-2', toId: 'shape:copy-1' }),
  ])
})

test('a failed or incomplete write is rolled back to the mark; a fault still stops', () => {
  for (const fault of ['throw', 'drop_binding'] as const) {
    const ink = ink_fake(fault)
    const before = document_hash(ink.records())
    const roots = ['shape:box', 'shape:tip']
    const outcome = take_into_sketch(ink.editor, print, ask(ink.editor, roots, { replace: true }),
      tools())
    expect(outcome).toEqual({ kind: 'refused', reason: 'failed' })
    expect(ink.log.at(-1)).toBe('bail')
    expect(document_hash(ink.records())).toBe(before)
  }

  const ink = ink_fake('assert')
  const before = document_hash(ink.records())
  expect(() => take_into_sketch(ink.editor, print, ask(ink.editor, ['shape:box']), tools()))
    .toThrow(AssertionError)
  expect(document_hash(ink.records())).toBe(before)
})

test('an arrow bound to a shape left behind is pinned where the print draws it', () => {
  const ink = ink_fake('none')
  const outcome = take_into_sketch(ink.editor, print, ask(ink.editor, ['shape:tip']), tools())
  expect(outcome).toEqual({ kind: 'taken', shapes_count: 1 })
  const arrow = ink.records().find((record) => record.id === 'shape:copy-1')!
  expect(arrow.props).toEqual({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bend: 0 })
  expect(ink.records().filter((record) => record.typeName === 'binding')).toEqual([])
})
