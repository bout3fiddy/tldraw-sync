// How a native board keeps the views of a drawing that had them on its Agent canvas. Every
// element of every view is one ordinary record of the shared scene, with the id it had: a view
// leaves records out of what a device shows, never out of the scene. The controls are on the
// document record's meta, under `view_controls_key`, as a scene gives them. A shape shown only
// in some views, or answering a tap, says so on its own meta under `view_shape_key`, in the
// words of the scene it came from.
//
// The view a device shows is that device's alone (`src/client/native_views.ts`): it is never
// sent, saved or published, so choosing one writes nothing, and an edit made in one view is the
// same edit in every other. The board reads none of this: it has no meaning to the board.

import { assert } from './assert'
import { scene_conditions_count_max } from './constants'
import type { SceneCondition, SceneTap } from './scene_controls'

export const view_controls_key = 'view_controls'
export const view_shape_key = 'view'

export type ShapeViewJson = { visible_when?: SceneCondition[]; on_tap?: SceneTap }

// What a shape made from this element keeps of its views, or null when it has nothing to keep.
export function shape_view_json(element: {
  readonly visible_when: readonly SceneCondition[]
  readonly on_tap: SceneTap | null
}): ShapeViewJson | null {
  assert(element.visible_when.length <= scene_conditions_count_max, 'conditions are bounded')
  const view: ShapeViewJson = {}

  if (element.visible_when.length > 0) {
    view.visible_when = element.visible_when.map((condition) => ({
      control: condition.control,
      values: [...condition.values],
    }))
  }

  if (element.on_tap !== null) view.on_tap = { ...element.on_tap }

  const kept = Object.keys(view).length
  assert(kept <= 2, 'a shape keeps its conditions and its tap')
  return kept === 0 ? null : view
}
