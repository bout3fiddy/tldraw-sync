// What a scene may hold, as data an agent can read: the format, every element type, style and
// limit, and the controls a scene may give its views. It is made from the shared definitions
// the board checks a scene with, so it never says more or less than the board accepts.
//
// It names no meaning and no layout: what to draw, and whether a scene has controls at all, is
// the agent's choice. A scene without controls is one view, as it always was.

import { assert } from '../shared/assert'
import {
  ink_points_count_max,
  proposal_shapes_count_max,
  proposal_size_bytes_max,
  proposal_summary_length_max,
  proposal_text_length_max,
  scene_conditions_count_max,
  scene_control_label_length_max,
  scene_control_options_count_max,
  scene_controls_count_max,
  scene_depth_max,
  scene_path_points_count_max,
  scene_stroke_ids_count_max,
  view_state_size_bytes_max,
} from '../shared/constants'
import {
  control_id_pattern,
  control_value_pattern,
  scene_control_kinds,
  toggle_options,
  view_states_count,
  type SceneControl,
  type SceneControlJson,
} from '../shared/scene_controls'
import {
  scene_arrowheads,
  scene_bases,
  scene_colors,
  scene_dashes,
  scene_element_types,
  scene_fills,
  scene_fonts,
  scene_format,
  scene_geos,
  scene_label_aligns,
  scene_routes,
  scene_sizes,
  scene_text_aligns,
} from '../shared/scene_types'

// The version is part of the name: a later list with other meanings gets another name.
export const scene_capabilities_format = 'tldraw-sync.scene-capabilities.v1'

// A control has at least two values: a choice between one is not a choice.
const control_options_count_min = 2

export const scene_capabilities = Object.freeze({
  format: scene_capabilities_format,
  scene_format,
  bases: [...scene_bases],
  element_types: [...scene_element_types],
  styles: {
    color: [...scene_colors],
    size: [...scene_sizes],
    font: [...scene_fonts],
    fill: [...scene_fills],
    dash: [...scene_dashes],
    geo: [...scene_geos],
    arrowhead: [...scene_arrowheads],
    route: [...scene_routes],
    text_align: [...scene_text_aligns],
    label_align: [...scene_label_aligns],
  },
  limits: {
    scene_size_bytes_max: proposal_size_bytes_max,
    elements_count_max: proposal_shapes_count_max,
    text_length_max: proposal_text_length_max,
    summary_length_max: proposal_summary_length_max,
    path_points_count_max: scene_path_points_count_max,
    group_depth_max: scene_depth_max,
    sketch_stroke_ids_count_max: scene_stroke_ids_count_max,
    ink_points_count_max,
  },
  controls: {
    optional: true,
    kinds: [...scene_control_kinds],
    count_max: scene_controls_count_max,
    options_count_min: control_options_count_min,
    options_count_max: scene_control_options_count_max,
    label_length_max: scene_control_label_length_max,
    conditions_count_max: scene_conditions_count_max,
    id_pattern: control_id_pattern.source,
    value_pattern: control_value_pattern.source,
    toggle_options: toggle_options.map((option) => ({ ...option })),
    element_fields: ['visible_when', 'on_tap'],
  },
  view_state: {
    preview_flag: '--state',
    size_bytes_max: view_state_size_bytes_max,
    rest: 'first_option_of_each_control',
    published: 'rest',
  },
})

assert(scene_capabilities.controls.options_count_max >= control_options_count_min, 'choices')
assert(scene_capabilities.element_types.length > 0, 'a scene has element types')

// The controls a board hands back, as the board would read them: a toggle's options are
// implied. Null when the answer is not a bounded list of controls.
export function scene_controls_from_json(value: unknown): SceneControl[] | null {
  if (value === undefined) return []

  if (!Array.isArray(value) || value.length > scene_controls_count_max) return null

  const controls: SceneControl[] = []

  for (const item of value as unknown[]) {
    const control = control_from_json(item)

    if (control === null) return null

    controls.push(control)
  }

  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  return controls
}

function control_from_json(item: unknown): SceneControl | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null

  const { id, kind, label, options } = item as Partial<SceneControlJson>

  if (typeof id !== 'string' || !control_id_pattern.test(id) || typeof label !== 'string') {
    return null
  }

  if (!scene_control_kinds.includes(kind as SceneControl['kind'])) return null

  if (kind === 'toggle') {
    return { id, kind, label, options: toggle_options.map((option) => ({ ...option })) }
  }

  const bounded =
    Array.isArray(options) &&
    options.length >= control_options_count_min &&
    options.length <= scene_control_options_count_max

  if (!bounded) return null

  const valid = options.every(
    (option) => typeof option?.value === 'string' && typeof option.label === 'string',
  )

  if (!valid) return null

  assert(kind === 'choice' || kind === 'steps', 'a control with options lists them')
  const copied = options.map((option) => ({ value: option.value, label: option.label }))
  return { id, kind, label, options: copied }
}

// The view `--state` names: absent for the view a publish saves, or a small JSON object of
// control ids and values. Its shape is checked here, before any request; whether the scene has
// those controls and values is the board's to say, as it says for a page.
export type ViewStateFlag =
  | { kind: 'rest' }
  | { kind: 'selected'; text: string; state: Readonly<Record<string, string>> }
  | { kind: 'invalid'; message: string }

export function view_state_flag_read(text: string | undefined): ViewStateFlag {
  if (text === undefined) return { kind: 'rest' }

  if (new TextEncoder().encode(text).byteLength > view_state_size_bytes_max) {
    return { kind: 'invalid', message: `--state is over ${view_state_size_bytes_max} bytes.` }
  }

  let value: unknown = null

  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { kind: 'invalid', message: '--state is not JSON.' }
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', message: '--state must be a JSON object of control values.' }
  }

  const entries = Object.entries(value as Record<string, unknown>)

  if (entries.length > scene_controls_count_max) {
    const message = `--state names at most ${scene_controls_count_max} controls.`
    return { kind: 'invalid', message }
  }

  const state: Record<string, string> = {}

  for (const [control, chosen] of entries) {
    if (!control_id_pattern.test(control)) {
      return { kind: 'invalid', message: '--state names a control id that cannot exist.' }
    }

    if (typeof chosen !== 'string' || !control_value_pattern.test(chosen)) {
      const message = `--state gives control "${control}" a value that cannot exist.`
      return { kind: 'invalid', message }
    }

    state[control] = chosen
  }

  assert(Object.keys(state).length === entries.length, 'one value for each control named')
  assert(text.length <= view_state_size_bytes_max, 'a read state is bounded')
  return { kind: 'selected', text, state }
}

// How many views a scene's controls choose between. Counted, never listed.
export function scene_states_count(controls: readonly SceneControl[]): number {
  const count = view_states_count(controls)
  assert(count >= 1, 'a scene has at least one view')
  return count
}
