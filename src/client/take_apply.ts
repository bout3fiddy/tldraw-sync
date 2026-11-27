// Taking the agent's print into the sketch: the one way agent shapes become the person's own.
// Only the person's editor does it, from a shape they chose, in one step that Undo takes back.
// Two guards keep it honest: the print revision they looked at must still be the one shown,
// and the sketch must still hash as it did when they chose. Either changing refuses the take
// and leaves everything as it was. No command or agent reaches this.

import type { Editor, TLShapeId } from 'tldraw'
import { AssertionError, assert } from '../shared/assert'
import { cleaned_page_id } from '../shared/canvas_types'
import { document_hash } from '../shared/document_hash'
import { print_records, take_plan, type TakeRefusal } from './take_plan'

export type TakeAsk = {
  roots: readonly string[]

  // Clear the sketch first: the old whole-sketch replace, now one take of every shape.
  replace: boolean
  revision_seen: number
  revision_now: number
  sketch_hash_seen: string
}

export type ArrowEnds = {
  start: { x: number; y: number }
  end: { x: number; y: number }
  bend: number
}

// The parts of tldraw a take needs, passed in so the plan and its rollback can be tested with
// a stand-in editor and deterministic ids.
export type TakeTools = {
  id_make: (kind: 'shape' | 'binding') => string
  indices_above: (below: string, count: number) => string[]
  arrow_ends: (print: Editor, arrow: string) => ArrowEnds | null
}

export type TakeOutcome =
  | { kind: 'taken'; shapes_count: number }
  | { kind: 'refused'; reason: TakeRefusal | 'revision_changed' | 'sketch_changed' | 'failed' }

// The hash of the sketch as this editor holds it: the same records the stage renders.
export function sketch_hash(editor: Editor): string {
  const types = editor.store.scopedTypes.document
  const records = editor.store.allRecords().filter((record) => types.has(record.typeName))
  return document_hash(records)
}

export function take_into_sketch(
  ink: Editor,
  print: Editor,
  ask: TakeAsk,
  tools: TakeTools,
): TakeOutcome {
  assert(ask.roots.length > 0, 'a take names what it takes')

  if (ask.revision_seen !== ask.revision_now) return { kind: 'refused', reason: 'revision_changed' }

  const hash = sketch_hash(ink)

  if (hash !== ask.sketch_hash_seen) return { kind: 'refused', reason: 'sketch_changed' }

  const page_sketch = ink.getCurrentPageId()
  const plan = take_plan({
    records: print_records(print),
    roots: ask.roots,
    page_print: cleaned_page_id,
    page_sketch,
    root_indices: tools.indices_above(ink.getHighestIndexForParent(page_sketch), ask.roots.length),
    revision: ask.revision_now,
    sketch_hash: hash,
    id_make: tools.id_make,
  })

  if (plan.kind === 'refused') return plan

  for (const [copy, source] of plan.arrows_loose) {
    const ends = tools.arrow_ends(print, source)

    if (ends === null) return { kind: 'refused', reason: 'failed' }

    const shape = plan.shapes.find((candidate) => candidate.record.id === copy)!
    const props = shape.record.props as Record<string, unknown>
    shape.record.props = { ...props, start: ends.start, end: ends.end, bend: ends.bend }
  }

  return take_write(ink, ask.replace, plan.shapes.map((shape) => shape.record), plan.bindings)
}

// One undo step. A write that fails, or that does not land as planned, is rolled back to the
// mark, so the sketch is never left half taken.
function take_write(
  ink: Editor,
  replace: boolean,
  shapes: Record<string, unknown>[],
  bindings: Record<string, unknown>[],
): TakeOutcome {
  assert(shapes.length > 0, 'a take writes shapes')
  const mark = ink.markHistoryStoppingPoint('take into sketch')

  try {
    ink.run(() => {
      if (replace) ink.selectNone().deleteShapes([...ink.getCurrentPageShapeIds()])

      ink.createShapes(shapes as Parameters<Editor['createShapes']>[0])

      if (bindings.length > 0) {
        ink.createBindings(bindings as Parameters<Editor['createBindings']>[0])
      }

      take_check(ink, shapes, bindings)
    })
    ink.markHistoryStoppingPoint('taken into sketch')
    return { kind: 'taken', shapes_count: shapes.length }
  } catch (error) {
    ink.bailToMark(mark)

    if (error instanceof AssertionError) throw error

    return { kind: 'refused', reason: 'failed' }
  }
}

// Every planned shape is on the sketch where it was meant to go, and every planned binding
// joins two of them. Anything else is an incomplete write.
function take_check(
  ink: Editor,
  shapes: Record<string, unknown>[],
  bindings: Record<string, unknown>[],
): void {
  for (const planned of shapes) {
    const shape = ink.getShape(planned.id as TLShapeId)

    if (shape === undefined || shape.parentId !== planned.parentId) throw Error('Incomplete take')
  }

  const ids = new Set(shapes.map((shape) => String(shape.id)))
  let joined = 0

  for (const id of ids) {
    for (const binding of ink.getBindingsFromShape(id as TLShapeId, 'arrow')) {
      if (!ids.has(binding.toId)) throw Error('A take joined a shape it did not copy')

      joined += 1
    }
  }

  if (joined !== bindings.length) throw Error('Incomplete bindings')
}
