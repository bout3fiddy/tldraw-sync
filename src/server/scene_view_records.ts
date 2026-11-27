// The records of one view of a scene, and the taps a page may act on in it. Both are made
// from the scene as published and a view state, and from nothing else, so the same scene and
// state give the same records in a draft, after the publish, and after a restore.

import type { TLRecord } from '@tldraw/tlschema'
import { assert } from '../shared/assert'
import { canvas_records_count_max, proposal_shapes_count_max } from '../shared/constants'
import type { ViewState, ViewTap } from '../shared/scene_controls'
import type { SceneElement } from '../shared/scene_types'
import { scene_project, scene_static } from '../shared/scene_view'
import { scene_records, scene_shape_id } from './scene_records'

export function view_records(scene: readonly SceneElement[], state: ViewState): TLRecord[] {
  assert(scene.length <= proposal_shapes_count_max, 'a scene is bounded')

  // A scene that hides nothing is the same in every view.
  if (scene_static(scene)) return scene_records(scene)

  const projection = scene_project(scene, state)
  const records = scene_records(projection.elements, projection.places)
  assert(records.length <= canvas_records_count_max, 'a view is bounded')
  return records
}

// The taps of the elements shown in this view, in scene order.
export function view_taps(scene: readonly SceneElement[], state: ViewState): ViewTap[] {
  assert(scene.length <= proposal_shapes_count_max, 'a scene is bounded')
  const taps: ViewTap[] = []

  for (const element of scene_project(scene, state).elements) {
    if (element.on_tap === null) continue

    const { control, value } = element.on_tap
    taps.push({ shape_id: scene_shape_id(element.id), control, value })
  }

  assert(taps.length <= scene.length, 'at most one tap for each element')
  return taps
}
