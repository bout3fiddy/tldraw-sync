// What taking part of the agent's print into the sketch copies, worked out before anything is
// written. A take copies whole top-level shapes of the print: each with everything it holds,
// so a group or frame comes with its children and nothing outside it is reparented. Bindings
// are copied only between shapes that are both copied. An arrow bound to a shape left behind
// loses that binding, and the board pins its ends where they are drawn instead.
//
// Pure: records in, a plan out. The editor applies it in one undo step (`take_apply.ts`).

import { assert } from '../shared/assert'
import { canvas_records_count_max } from '../shared/constants'
import { document_hash } from '../shared/document_hash'

export type PrintRecord = { readonly id: string; readonly typeName: string } & Record<
  string,
  unknown
>

// The native shapes a sketch can hold as its own. Images, video, embeds and bookmarks need
// assets or the network, which this board does not keep, so they are never copied.
export const take_types: ReadonlySet<string> = new Set([
  'arrow',
  'draw',
  'frame',
  'geo',
  'group',
  'highlight',
  'line',
  'note',
  'text',
])

export type TakeRefusal = 'missing' | 'not_top_level' | 'unsupported' | 'too_many' | 'elbow_bound'

// Where a copy came from, kept on its top-level shape. The print fades beneath a copy whose
// source still hashes the same, and the sketch records which revision and sketch it came from.
export type TakenFrom = {
  revision: number
  sketch_hash: string
  shape_id: string
  print_hash: string
}

export type TakeRequest = {
  records: readonly PrintRecord[]
  roots: readonly string[]
  page_print: string
  page_sketch: string

  // A fresh index on the sketch page for each root, in the order of `roots`.
  root_indices: readonly string[]
  revision: number
  sketch_hash: string
  id_make: (kind: 'shape' | 'binding') => string
}

export type ShapeCopy = { source: string; record: Record<string, unknown> }

export type TakePlan =
  | {
      kind: 'ready'
      shapes: ShapeCopy[]
      bindings: Record<string, unknown>[]

      // Arrows that keep their place without a binding: copy id to print id.
      arrows_loose: Map<string, string>
    }
  | { kind: 'refused'; reason: TakeRefusal }

// The shapes and bindings a print editor holds: the published records, without the editor's
// own page, camera and instance records.
export function print_records(editor: {
  store: { allRecords: () => readonly { id: string; typeName: string }[] }
}): PrintRecord[] {
  const records = editor.store.allRecords().filter((record) => {
    return record.typeName === 'shape' || record.typeName === 'binding'
  })
  return records as PrintRecord[]
}

// The shapes of the print by parent, and the subtree under each top-level shape.
export type PrintTree = {
  shapes: Map<string, PrintRecord>
  children: Map<string, string[]>
  bindings: PrintRecord[]
}

export function print_tree(records: readonly PrintRecord[]): PrintTree {
  assert(records.length <= canvas_records_count_max, 'a print is bounded')
  const shapes = new Map<string, PrintRecord>()
  const children = new Map<string, string[]>()
  const bindings: PrintRecord[] = []

  for (const record of records) {
    if (record.typeName === 'binding') bindings.push(record)

    if (record.typeName !== 'shape') continue

    shapes.set(record.id, record)
    const parent = String(record.parentId)
    const siblings = children.get(parent) ?? []
    siblings.push(record.id)
    children.set(parent, siblings)
  }

  assert(shapes.size + bindings.length <= records.length, 'the tree holds only given records')
  return { shapes, children, bindings }
}

// A shape and everything under it, parents before children. An explicit stack, bounded by
// the number of shapes, walks the tree.
export function print_subtree(tree: PrintTree, root: string): PrintRecord[] {
  assert(tree.shapes.has(root), 'a subtree has a root')
  const found: PrintRecord[] = []
  const pending = [root]

  for (let next = 0; next < pending.length; next += 1) {
    assert(found.length < tree.shapes.size, 'a subtree never revisits a shape')
    const id = pending[next]!
    found.push(tree.shapes.get(id)!)

    for (const child of tree.children.get(id) ?? []) pending.push(child)
  }

  assert(found[0]?.id === root, 'the root comes first')
  return found
}

// The identity of one top-level shape as drawn: its subtree, hashed as records are.
export function print_subtree_hash(tree: PrintTree, root: string): string {
  return document_hash(print_subtree(tree, root))
}

export function take_plan(request: TakeRequest): TakePlan {
  assert(request.roots.length === request.root_indices.length, 'one index for each root')
  assert(new Set(request.roots).size === request.roots.length, 'roots are distinct')
  const tree = print_tree(request.records)
  const units: PrintRecord[][] = []

  for (const root of request.roots) {
    const shape = tree.shapes.get(root)

    if (shape === undefined) return { kind: 'refused', reason: 'missing' }

    if (shape.parentId !== request.page_print) return { kind: 'refused', reason: 'not_top_level' }

    const unit = print_subtree(tree, root)

    if (!unit.every((record) => take_types.has(String(record.type)))) {
      return { kind: 'refused', reason: 'unsupported' }
    }

    units.push(unit)
  }

  const copied = units.flat()

  if (copied.length === 0) return { kind: 'refused', reason: 'missing' }

  if (copied.length > canvas_records_count_max) return { kind: 'refused', reason: 'too_many' }

  return plan_assemble(request, tree, units)
}

function plan_assemble(request: TakeRequest, tree: PrintTree, units: PrintRecord[][]): TakePlan {
  const ids = new Map<string, string>()

  for (const record of units.flat()) ids.set(record.id, request.id_make('shape'))

  const bindings: Record<string, unknown>[] = []
  const arrows_loose = new Map<string, string>()

  for (const binding of tree.bindings) {
    const from = ids.get(String(binding.fromId))
    const to = ids.get(String(binding.toId))

    if (from === undefined) continue

    if (to === undefined) {
      const arrow = tree.shapes.get(String(binding.fromId))!
      const props = arrow.props as Record<string, unknown> | undefined

      if (props?.kind === 'elbow') return { kind: 'refused', reason: 'elbow_bound' }

      arrows_loose.set(from, arrow.id)
      continue
    }

    const { typeName: _binding_type, ...rest } = binding
    bindings.push({ ...rest, id: request.id_make('binding'), fromId: from, toId: to })
  }

  const shapes = units.flatMap((unit, index) =>
    unit.map((record) => shape_copy(request, tree, record, ids, request.root_indices[index]!)),
  )
  assert(shapes.length === ids.size, 'every shape is copied once')
  assert(bindings.length <= tree.bindings.length, 'no binding is invented')
  return { kind: 'ready', shapes, bindings, arrows_loose }
}

function shape_copy(
  request: TakeRequest,
  tree: PrintTree,
  record: PrintRecord,
  ids: Map<string, string>,
  root_index: string,
): ShapeCopy {
  const root = record.parentId === request.page_print
  const parent = root ? request.page_sketch : ids.get(String(record.parentId))
  assert(parent !== undefined, 'a copied child has a copied parent')
  const { typeName: _shape_type, ...rest } = record
  const meta = (record.meta ?? {}) as Record<string, unknown>
  const taken_from: TakenFrom = {
    revision: request.revision,
    sketch_hash: request.sketch_hash,
    shape_id: record.id,
    print_hash: root ? print_subtree_hash(tree, record.id) : '',
  }
  const copy = {
    ...rest,
    id: ids.get(record.id)!,
    parentId: parent,
    index: root ? root_index : record.index,
    isLocked: false,
    meta: root ? { ...meta, taken_from } : meta,
  }
  return { source: record.id, record: copy }
}

// The fade key of a sketch shape taken from the print, or null for the person's own ink.
export function taken_key(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null

  const taken = (meta as { taken_from?: unknown }).taken_from

  if (typeof taken !== 'object' || taken === null) return null

  const { shape_id, print_hash } = taken as Partial<TakenFrom>

  if (typeof shape_id !== 'string' || typeof print_hash !== 'string') return null

  return `${shape_id} ${print_hash}`
}

// The bend that keeps an arc arrow on the same circle once its ends are pinned where they are
// drawn. tldraw puts an arc's middle at `med + per(u) * -bend` and draws the circle through
// both ends and that middle. The new middle is where the chord's perpendicular bisector meets
// the circle, on the side the drawn arc bulges to.
export type Point = { x: number; y: number }

export function arc_bend(
  start: Point,
  end: Point,
  centre: Point,
  radius: number,
  middle: Point,
): number {
  assert(Number.isFinite(radius) && radius > 0, 'an arc has a radius')
  const length = Math.hypot(end.x - start.x, end.y - start.y)

  if (length === 0) return 0

  const unit = { x: (end.x - start.x) / length, y: (end.y - start.y) / length }
  const normal = { x: unit.y, y: -unit.x }
  const med = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const along = (point: Point) => (point.x - med.x) * normal.x + (point.y - med.y) * normal.y
  const offset = along(centre)
  const side = along(middle)
  const apex = side >= 0 ? offset + radius : offset - radius
  assert(Number.isFinite(apex), 'the apex is a number')
  return -apex
}
