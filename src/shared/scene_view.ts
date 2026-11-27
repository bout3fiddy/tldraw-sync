// One view of a scene with controls: the elements shown in one view state, and nothing else.
// A projection is a pure function of the scene as published and the state. It never edits an
// element: it only leaves some out, and lifts some out of a group that no longer holds enough.
// So a shape keeps its id in every view, in a draft, in the publish and after a restore.
//
// The rules, in order:
//
// - An element is shown when its own conditions hold and every group around it is shown.
// - An arrow is shown only when each element it ends on is shown: a binding never dangles.
// - tldraw keeps no group of fewer than two shapes. A group left holding fewer is dissolved in
//   that view: whatever it still shows is lifted to the nearest group around it that is kept,
//   or to the page. Positions are page positions, so a lifted element stays where it was.
//
// Each shown element keeps its place in the scene's list, so its order among the others, and
// the index its records are given, are the same in every view.

import { assert } from './assert'
import { proposal_shapes_count_max, scene_depth_max } from './constants'
import { conditions_hold, type ViewState } from './scene_controls'
import type { SceneElement } from './scene_types'

export type SceneProjection = {

  // The shown elements, in scene order, each with the parent it has in this view.
  elements: SceneElement[]

  // For each shown element, its place in the scene's list.
  places: number[]
}

export function scene_project(
  elements: readonly SceneElement[],
  state: ViewState,
): SceneProjection {
  assert(elements.length <= proposal_shapes_count_max, 'a scene is bounded')
  const by_id = new Map(elements.map((element) => [element.id, element]))
  assert(by_id.size === elements.length, 'a valid scene has unique ids')
  const visible = visible_find(elements, by_id, state)
  const kept = groups_keep(elements, by_id, visible)
  const projection: SceneProjection = { elements: [], places: [] }

  for (const [place, element] of elements.entries()) {
    const shown = element.type === 'group' ? kept.has(element.id) : visible.has(element.id)

    if (!shown) continue

    const parent = parent_kept(element.parent, by_id, kept)
    projection.elements.push(parent === element.parent ? element : { ...element, parent })
    projection.places.push(place)
  }

  const shown_ids = new Set(projection.elements.map((element) => element.id))
  assert(projection.places.length === projection.elements.length, 'one place for each element')
  assert(projection.elements.length <= elements.length, 'a view is part of the scene')
  assert(
    projection.elements.every(
      (element) => element.parent === null || shown_ids.has(element.parent),
    ),
    'a shown element is on the page or in a shown group',
  )
  return projection
}

// Whether a scene has nothing to project: every element is shown in every state.
export function scene_static(elements: readonly SceneElement[]): boolean {
  assert(elements.length <= proposal_shapes_count_max, 'a scene is bounded')
  return elements.every((element) => element.visible_when.length === 0)
}

// The ids of the elements whose own conditions, and their groups', hold in this state, less
// any arrow that ends on an element that is not shown.
function visible_find(
  elements: readonly SceneElement[],
  by_id: ReadonlyMap<string, SceneElement>,
  state: ViewState,
): Set<string> {
  const visible = new Set<string>()

  for (const element of elements) {
    let shown = conditions_hold(element.visible_when, state)
    let parent = element.parent
    let depth = 0

    while (shown && parent !== null) {
      const group = by_id.get(parent)
      assert(group !== undefined && group.type === 'group', 'a valid parent is a group')
      assert(depth < scene_depth_max, 'a valid scene nests within the limit')
      shown = conditions_hold(group.visible_when, state)
      parent = group.parent
      depth += 1
    }

    if (shown) visible.add(element.id)
  }

  for (const element of elements) {
    if (element.type !== 'arrow') continue

    for (const end of [element.from, element.to]) {
      if (end.kind === 'element' && !visible.has(end.id)) visible.delete(element.id)
    }
  }

  assert(visible.size <= elements.length, 'the shown are some of the elements')
  return visible
}

// The groups kept in this view: shown, and still holding at least two shapes once the groups
// inside them have been kept or dissolved. Groups are settled from the innermost outward.
function groups_keep(
  elements: readonly SceneElement[],
  by_id: ReadonlyMap<string, SceneElement>,
  visible: ReadonlySet<string>,
): Set<string> {
  const depths = new Map<string, number>()
  const held = new Map<string, number>()
  const kept = new Set<string>()

  for (const element of elements) depths.set(element.id, depth_of(element, by_id))

  for (let depth = scene_depth_max; depth >= 0; depth -= 1) {
    for (const element of elements) {
      if (depths.get(element.id) !== depth || !visible.has(element.id)) continue

      if (element.parent === null) {
        if (element.type === 'group') group_settle(element.id, held, kept)

        continue
      }

      // What this element leaves its group holding: itself, or what a dissolved group lifts.
      const count =
        element.type === 'group' ? group_settle(element.id, held, kept) : weight(element)
      held.set(element.parent, (held.get(element.parent) ?? 0) + count)
    }
  }

  assert(kept.size <= elements.length, 'kept groups are some of the elements')
  assert(
    [...kept].every((id) => visible.has(id)),
    'a kept group is shown',
  )
  return kept
}

function group_settle(id: string, held: ReadonlyMap<string, number>, kept: Set<string>): number {
  const count = held.get(id) ?? 0
  assert(count >= 0, 'a group holds a whole number of shapes')

  if (count >= 2) {
    kept.add(id)
    return 1
  }

  assert(!kept.has(id), 'a dissolved group is not kept')
  return count
}

// How many shapes an element is in its group: a sketch element is one per stroke.
function weight(element: SceneElement): number {
  assert(element.type !== 'group', 'a group is settled, not weighed')
  const count = element.type === 'sketch' ? element.strokes.length : 1
  assert(count >= 1, 'a shown element is at least one shape')
  return count
}

function depth_of(element: SceneElement, by_id: ReadonlyMap<string, SceneElement>): number {
  let depth = 0
  let parent = element.parent

  while (parent !== null) {
    const group = by_id.get(parent)
    assert(group !== undefined && group.type === 'group', 'a valid parent is a group')
    assert(depth < scene_depth_max, 'a valid scene nests within the limit')
    parent = group.parent
    depth += 1
  }

  return depth
}

// The nearest group around an element that is kept in this view, or null for the page.
function parent_kept(
  parent: string | null,
  by_id: ReadonlyMap<string, SceneElement>,
  kept: ReadonlySet<string>,
): string | null {
  let candidate = parent
  let depth = 0

  while (candidate !== null && !kept.has(candidate)) {
    const group = by_id.get(candidate)
    assert(group !== undefined && group.type === 'group', 'a valid parent is a group')
    assert(depth < scene_depth_max, 'a valid scene nests within the limit')
    candidate = group.parent
    depth += 1
  }

  assert(candidate === null || kept.has(candidate), 'a shown element is in a kept group')
  return candidate
}
