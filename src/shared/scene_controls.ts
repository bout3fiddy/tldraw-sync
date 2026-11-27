// Controls an agent may give a scene, so one canvas can show a few views of the same thing:
// a choice between labelled values, steps in order, or a toggle. A control has no meaning to
// the board. An element may name the values it is shown for, and a tap on an element may set
// one control to one value. That is all a control does: there is no expression, script, link
// or template, and nothing is fetched.
//
// A view state is one value for each control. It belongs to whoever is looking: the board
// keeps none, so choosing a view never changes the canvas, its revision or the sketch. The
// rest state, the first value of every control, is what a page that knows nothing of
// controls is shown, and what a publish saves as the canvas's records.
//
// The command line, the pages and the board all read these definitions from here.

import { assert } from './assert'
import {
  scene_conditions_count_max,
  scene_control_label_length_max,
  scene_control_options_count_max,
  scene_controls_count_max,
} from './constants'

// A choice is shown as a set of buttons, steps in order with back and next, a toggle as a
// switch. The kind is a hint for the page: every kind is a list of values.
export const scene_control_kinds = ['choice', 'steps', 'toggle'] as const
export type SceneControlKind = (typeof scene_control_kinds)[number]

// A toggle has these two values, off first. Its options are never written: they are implied.
export const toggle_options: readonly SceneControlOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
]

// Option values are short words, as element ids are. A control id begins with a letter, so it
// is never a name such as `__proto__` that a plain object treats specially.
export const control_value_pattern = /^[A-Za-z0-9_-]{1,40}$/
export const control_id_pattern = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

export type SceneControlOption = { value: string; label: string }

// The first option is the control's value at rest.
export type SceneControl = {
  id: string
  kind: SceneControlKind
  label: string
  options: SceneControlOption[]
}

// An element is shown when every condition holds; a condition holds when its control has one
// of the values named. An element with no conditions is always shown.
export type SceneCondition = { control: string; values: string[] }

// A tap on the element sets one control to one value.
export type SceneTap = { control: string; value: string }

export type ViewState = Readonly<Record<string, string>>

// A tap a page may act on: tapping this shape sets the control to the value.
export type ViewTap = { shape_id: string; control: string; value: string }

export type ViewStateRead =
  { ok: true; state: ViewState } | { ok: false; path: string; message: string }

// The controls as JSON, in the form a scene gives them. A toggle's options are implied.
export type SceneControlJson = {
  id: string
  kind: SceneControlKind
  label: string
  options?: SceneControlOption[]
}

export function view_state_rest(controls: readonly SceneControl[]): ViewState {
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  const state: Record<string, string> = {}

  for (const control of controls) {
    const first = control.options[0]
    assert(first !== undefined, 'a control has a value at rest')
    state[control.id] = first.value
  }

  assert(Object.keys(state).length === controls.length, 'one value for each control')
  return state
}

// How many views the controls choose between. Counted, never listed.
export function view_states_count(controls: readonly SceneControl[]): number {
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  let count = 1

  for (const control of controls) {
    assert(control.options.length <= scene_control_options_count_max, 'options are bounded')
    count *= control.options.length
  }

  assert(Number.isSafeInteger(count) && count >= 1, 'the count is exact')
  return count
}

export function conditions_hold(conditions: readonly SceneCondition[], state: ViewState): boolean {
  assert(conditions.length <= scene_conditions_count_max, 'conditions are bounded')

  for (const condition of conditions) {
    const value = state[condition.control]
    assert(value !== undefined, 'a valid condition names a control of the state')

    if (!condition.values.includes(value)) return false
  }

  return true
}

// A view state from untrusted input: an object of control ids and values. A control left out
// keeps its value at rest; null or nothing is the rest state. An unknown control or value is
// refused, never ignored, so a page never shows a view other than the one it asked for.
export function view_state_read(controls: readonly SceneControl[], value: unknown): ViewStateRead {
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  const state: Record<string, string> = { ...view_state_rest(controls) }

  if (value === null || value === undefined) return { ok: true, state }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, path: 'state', message: 'Expected an object of control values.' }
  }

  for (const [key, chosen] of Object.entries(value as Record<string, unknown>)) {
    const control = controls.find((candidate) => candidate.id === key)

    if (control === undefined) {
      return { ok: false, path: `state.${key.slice(0, 40)}`, message: 'Unknown control.' }
    }

    if (!control.options.some((option) => option.value === chosen)) {
      const values = control.options.map((option) => option.value).join(', ')
      return { ok: false, path: `state.${key}`, message: `Expected one of: ${values}.` }
    }

    state[key] = chosen as string
  }

  assert(Object.keys(state).length === controls.length, 'one value for each control')
  return { ok: true, state }
}

// The controls as a scene gives them, so a saved or offered scene reads back the same.
export function scene_controls_write(controls: readonly SceneControl[]): SceneControlJson[] {
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  const written = controls.map((control): SceneControlJson => {
    const { id, kind, label } = control

    if (kind === 'toggle') return { id, kind, label }

    return { id, kind, label, options: control.options.map((option) => ({ ...option })) }
  })
  assert(written.length === controls.length, 'every control is written')
  assert(
    controls.every((control) => control.label.length <= scene_control_label_length_max),
    'labels are bounded',
  )
  return written
}
