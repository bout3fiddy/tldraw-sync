// Reads a scene's controls, and the conditions and taps of its elements, from untrusted JSON.
// Each is checked alone as it is read, and then against the others once the whole scene is
// in: every condition and tap names a control of this scene and values that control has. A
// scene that names anything else is refused before anything changes.

import { assert } from '../shared/assert'
import {
  scene_conditions_count_max,
  scene_control_label_length_max,
  scene_control_options_count_max,
  scene_controls_count_max,
} from '../shared/constants'
import type { JsonReader, Json } from '../shared/json_reader'
import {
  control_id_pattern,
  control_value_pattern,
  scene_control_kinds,
  toggle_options,
  type SceneCondition,
  type SceneControl,
  type SceneControlOption,
  type SceneTap,
} from '../shared/scene_controls'
import type { SceneElement, SceneElementType } from '../shared/scene_types'

const keys_control = ['id', 'kind', 'label', 'options'] as const
const keys_option = ['value', 'label'] as const
const keys_condition = ['control', 'values'] as const
const keys_tap = ['control', 'value'] as const

// What a tap may be on: an element that is one shape of its own.
const tappable_types: readonly SceneElementType[] = ['text', 'geo', 'path', 'stroke', 'arrow']

// The controls of a scene. Left out, a scene has none: one view, as before controls existed.
export function scene_controls_read(reader: JsonReader, value: unknown): SceneControl[] {
  if (value === undefined || value === null) return []

  const items = reader.list(value, 'proposal.controls', 0, scene_controls_count_max)
  const controls = items.map((item, index) => control_read(reader, item, `controls[${index}]`))
  const ids = new Set(controls.map((control) => control.id))

  if (ids.size !== controls.length) reader.fail('proposal.controls', 'Control ids must be unique.')

  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  assert(ids.size <= controls.length, 'ids are some of the controls')
  return controls
}

function control_read(reader: JsonReader, value: unknown, path: string): SceneControl {
  const source = reader.object(value, path, keys_control)
  const id = reader.text(source, 'id', path, 40, null)

  if (!control_id_pattern.test(id)) {
    reader.fail(`${path}.id`, 'Expected an id of a letter, then up to 39 letters, digits, _ or -.')
  }

  const kind = reader.choice(source, 'kind', path, scene_control_kinds, true)
  const label = label_read(reader, source, path)

  if (kind === 'toggle') {
    if (source.options !== undefined) {
      reader.fail(`${path}.options`, 'A toggle is off, then on: it takes no options.')
    }

    return { id, kind, label, options: toggle_options.map((option) => ({ ...option })) }
  }

  const options = options_read(reader, source.options, `${path}.options`)
  assert(options.length <= scene_control_options_count_max, 'options are bounded')
  assert(scene_control_kinds.includes(kind), 'a read kind is known')
  return { id, kind, label, options }
}

function label_read(reader: JsonReader, source: Json, path: string): string {
  const label = reader.text(source, 'label', path, scene_control_label_length_max, null)

  if (label.trim().length === 0 || /[\n\r]/.test(label)) {
    reader.fail(`${path}.label`, 'Expected a label of words on one line.')
  }

  assert(label.length <= scene_control_label_length_max, 'a read label is bounded')
  assert(!/[\n\r]/.test(label) || reader.problem !== null, 'a kept label is one line')
  return label
}

function options_read(reader: JsonReader, value: unknown, path: string): SceneControlOption[] {
  const count_max = scene_control_options_count_max
  const items = reader.list(value, path, 2, count_max)
  const options = items.map((item, index): SceneControlOption => {
    const place = `${path}[${index}]`
    const source = reader.object(item, place, keys_option)
    const option_value = reader.text(source, 'value', place, 40, null)

    if (!control_value_pattern.test(option_value)) {
      reader.fail(`${place}.value`, 'Expected a value of 1 to 40 letters, digits, _ or -.')
    }

    return { value: option_value, label: label_read(reader, source, place) }
  })

  if (new Set(options.map((option) => option.value)).size !== options.length) {
    reader.fail(path, 'Option values must be unique.')
  }

  assert(options.length <= count_max, 'options are bounded')
  assert(options.length >= 2 || reader.problem !== null, 'a control has two values or more')
  return options
}

// The conditions an element is shown under. Left out, it is always shown.
export function conditions_read(reader: JsonReader, source: Json, path: string): SceneCondition[] {
  const value = source.visible_when

  if (value === undefined || value === null) return []

  const place = `${path}.visible_when`
  const items = reader.list(value, place, 1, scene_conditions_count_max)
  const conditions = items.map((item, index): SceneCondition => {
    const at = `${place}[${index}]`
    const condition = reader.object(item, at, keys_condition)
    const control = reader.text(condition, 'control', at, 40, null)
    const list = reader.list(condition.values, `${at}.values`, 1, scene_control_options_count_max)
    const values = list.filter((entry): entry is string => typeof entry === 'string')

    if (values.length !== list.length || new Set(values).size !== values.length) {
      reader.fail(`${at}.values`, 'Expected different values of the control.')
    }

    return { control, values }
  })

  if (new Set(conditions.map((condition) => condition.control)).size !== conditions.length) {
    reader.fail(place, 'Name each control once: list every value it is shown for.')
  }

  assert(conditions.length <= scene_conditions_count_max, 'conditions are bounded')
  assert(
    conditions.every((condition) => condition.values.length <= scene_control_options_count_max),
    'the values of a condition are bounded',
  )
  return conditions
}

// What a tap on an element sets. Left out, a tap does nothing.
export function tap_read(reader: JsonReader, source: Json, path: string): SceneTap | null {
  const value = source.on_tap

  if (value === undefined || value === null) return null

  const place = `${path}.on_tap`
  const tap = reader.object(value, place, keys_tap)
  const control = reader.text(tap, 'control', place, 40, null)
  const chosen = reader.text(tap, 'value', place, 40, null)
  assert(control.length <= 40 && chosen.length <= 40, 'a read tap is bounded')
  return { control, value: chosen }
}

// Every condition and tap names a control of this scene, and values that control has.
export function references_check(
  reader: JsonReader,
  elements: readonly SceneElement[],
  controls: readonly SceneControl[],
): void {
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  const by_id = new Map(controls.map((control) => [control.id, control]))

  for (const [index, element] of elements.entries()) {
    const path = `elements[${index}]`

    for (const [place, condition] of element.visible_when.entries()) {
      const at = `${path}.visible_when[${place}]`
      values_check(reader, by_id.get(condition.control), condition.values, at)
    }

    if (element.on_tap === null) continue

    if (!tappable_types.includes(element.type)) {
      reader.fail(`${path}.on_tap`, 'A tap is on a text, geo, path, stroke or arrow element.')
    }

    values_check(
      reader,
      by_id.get(element.on_tap.control),
      [element.on_tap.value],
      `${path}.on_tap`,
    )
  }

  assert(by_id.size === controls.length || reader.problem !== null, 'control ids are unique')
}

function values_check(
  reader: JsonReader,
  control: SceneControl | undefined,
  values: readonly string[],
  path: string,
): void {
  assert(values.length <= scene_control_options_count_max, 'values are bounded')

  if (control === undefined) {
    reader.fail(`${path}.control`, 'Expected the id of a control of this scene.')
    return
  }

  const known = control.options.map((option) => option.value)
  assert(known.length <= scene_control_options_count_max, 'a control is bounded')

  if (!values.every((value) => known.includes(value))) {
    reader.fail(path, `Expected values of "${control.id}": ${known.join(', ')}.`)
  }

  assert(known.length >= 2, 'a control has at least two values')
}
