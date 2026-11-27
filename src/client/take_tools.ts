// tldraw's own ids, indices and arrow geometry for a take. Kept apart from `take_apply.ts` so
// that module can run against a stand-in editor with deterministic ids.

import {
  createBindingId,
  createShapeId,
  getArrowInfo,
  getIndicesAbove,
  type Editor,
  type IndexKey,
  type TLArrowShape,
  type TLShapeId,
} from 'tldraw'
import { assert } from '../shared/assert'
import type { ArrowEnds, TakeTools } from './take_apply'
import { arc_bend } from './take_plan'

export const take_tools: TakeTools = {
  id_make: (kind) => (kind === 'shape' ? createShapeId() : createBindingId()),
  indices_above: (below, count) => {
    const indices = getIndicesAbove(below as IndexKey, count)
    assert(indices.length === count, 'one index for each root')
    return indices
  },
  arrow_ends,
}

// Where an arrow is drawn, as the ends and bend of an arrow bound to nothing.
function arrow_ends(print: Editor, id: string): ArrowEnds | null {
  const shape = print.getShape(id as TLShapeId)

  if (shape === undefined || shape.type !== 'arrow') return null

  const info = getArrowInfo(print, shape as TLArrowShape)

  if (info === undefined || !info.isValid) return null

  const start = { x: info.start.point.x, y: info.start.point.y }
  const end = { x: info.end.point.x, y: info.end.point.y }

  if (info.type === 'straight') return { start, end, bend: 0 }

  if (info.type !== 'arc') return null

  const { center, radius } = info.bodyArc
  const bend = arc_bend(start, end, { x: center.x, y: center.y }, radius, info.middle)
  assert(Number.isFinite(bend), 'a bend is a number')
  return { start, end, bend }
}
