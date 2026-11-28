// The views of a drawing on a native board, read from its records (`src/shared/native_views.ts`).
// Meta is writable by any page, so everything here is read as untrusted, and checked as the board
// checks a scene: controls that do not read whole are no controls, and a shape whose marks do
// not read whole, or name a control or value the controls lack, is shown in every view. A bad
// mark can only ever show more, never hide a shape.
//
// Pure, like the projection a legacy page runs (`interactive_scene.ts`): it reaches only
// `src/shared` and the board's own readers, with no Node, network or credential.

import { assert } from '../shared/assert'
import { scene_conditions_count_max, scene_controls_count_max } from '../shared/constants'
import { JsonReader, type Json } from '../shared/json_reader'
import { view_controls_key, view_shape_key } from '../shared/native_views'
import {
  conditions_hold,
  view_state_read,
  view_state_rest,
  type SceneCondition,
  type SceneControl,
  type SceneTap,
  type ViewState,
} from '../shared/scene_controls'
import { conditions_read, scene_controls_read, tap_read } from '../server/scene_control_reader'

export type ShapeView = { readonly when: readonly SceneCondition[]; readonly tap: SceneTap | null }

// The controls and the view one device shows. `state` names a value for every control.
export type ViewInEffect = { readonly controls: readonly SceneControl[]; readonly state: ViewState }

const shape_view_none: ShapeView = { when: [], tap: null }
const shape_view_keys = ['visible_when', 'on_tap'] as const

// Read once for each meta object: a record's meta is replaced, never changed, when it is edited.
const controls_read_cache = new WeakMap<object, readonly SceneControl[] | null>()
const shape_view_cache = new WeakMap<object, { controls: object; view: ShapeView }>()

// The controls kept on a document's meta, or null for a board whose drawing has no views.
export function views_controls_read(meta: unknown): readonly SceneControl[] | null {
  if (meta === null || typeof meta !== 'object' || !Object.hasOwn(meta, view_controls_key)) {
    return null
  }

  const cached = controls_read_cache.get(meta)

  if (cached !== undefined) return cached

  const value = (meta as Json)[view_controls_key]
  const reader = new JsonReader()
  const read = Array.isArray(value) && value.length > 0 ? scene_controls_read(reader, value) : []
  const controls = reader.problem === null && read.length > 0 ? read : null
  controls_read_cache.set(meta, controls)
  assert(controls === null || controls.length <= scene_controls_count_max, 'controls bounded')
  return controls
}

// When a shape is shown and what a tap on it chooses, under these controls.
export function shape_view_read(meta: unknown, controls: readonly SceneControl[]): ShapeView {
  if (meta === null || typeof meta !== 'object' || !Object.hasOwn(meta, view_shape_key)) {
    return shape_view_none
  }

  const cached = shape_view_cache.get(meta)

  if (cached !== undefined && cached.controls === controls) return cached.view

  const reader = new JsonReader()
  const source = reader.object((meta as Json)[view_shape_key], 'view', shape_view_keys)
  const when = conditions_read(reader, source, 'view')
  const tap = tap_read(reader, source, 'view')
  const named = (control: string, values: readonly string[]) => {
    const found = controls.find((candidate) => candidate.id === control)
    return values.every((value) => found?.options.some((option) => option.value === value))
  }
  const known =
    when.every((condition) => named(condition.control, condition.values)) &&
    (tap === null || named(tap.control, [tap.value]))
  const view = reader.problem === null && known ? { when, tap } : shape_view_none
  shape_view_cache.set(meta, { controls, view })
  assert(view.when.length <= scene_conditions_count_max, 'conditions are bounded')
  return view
}

export function shape_view_marked(view: ShapeView): boolean {
  return view.when.length > 0 || view.tap !== null
}

// Whether a shape's own conditions hold in this view. Its groups and an arrow's ends are
// judged by the canvas, which hides what a hidden group holds.
export function shape_view_shown(view: ShapeView, effect: ViewInEffect): boolean {
  assert(Object.keys(effect.state).length === effect.controls.length, 'a value per control')
  return conditions_hold(view.when, effect.state)
}

// The view a device shows: what it chose, or the view at rest where it chose nothing, or
// chose under controls the drawing no longer has.
export function view_in_effect(
  controls: readonly SceneControl[],
  chosen: ViewState,
  at_rest: boolean,
): ViewInEffect {
  assert(controls.length > 0, 'a drawing with views has controls')
  const rest = view_state_rest(controls)

  if (at_rest) return { controls, state: rest }

  const read = view_state_read(controls, chosen)
  return { controls, state: read.ok ? read.state : rest }
}

// The view after one control is set to one value, or null when the drawing has no such
// control or value: a stale or forged choice never becomes a view.
export function view_after_choice(
  effect: ViewInEffect,
  control: string,
  value: string,
): ViewState | null {
  const read = view_state_read(effect.controls, { ...effect.state, [control]: value })

  if (!read.ok) return null

  assert(read.state[control] === value, 'the chosen value is set')
  return read.state
}
