// The scene of an interactive revision on the page: read once, checked as the board checks a
// saved revision, and projected into one view at a time on this device. Projecting needs no
// network, so a choice of view keeps working offline once the scene has loaded, and it is
// sent nowhere: it changes no canvas, revision, sketch or camera.
//
// Browser safety. The reader and the projector are the board's own: `scene_proposal.ts` and
// `scene_control_reader.ts` read the scene exactly as a saved revision is read on start, and
// `scene_view_records.ts` makes the records exactly as the board makes a served view, so the
// page and the board cannot disagree about a view. Those modules, and everything they import,
// are pure: they reach only `src/shared`, `src/server/canvas_records.ts`,
// `src/server/scene_records.ts`, `src/server/scene_ink.ts` and `@tldraw/tlschema`, with no
// Node, Bun, disk, network or credential. `interactive_scene.test.ts` walks that import graph
// and fails if any of them reaches further.

import { assert } from '../shared/assert'
import {
  interactive_scene_format,
  type CanvasRecord,
  type InteractiveScene,
} from '../shared/canvas_types'
import {
  interactive_view_size_bytes_max,
  proposal_shapes_count_max,
  scene_controls_count_max,
} from '../shared/constants'
import { JsonReader } from '../shared/json_reader'
import {
  view_state_read,
  view_state_rest,
  view_states_count,
  type SceneControl,
  type ViewState,
  type ViewTap,
} from '../shared/scene_controls'
import type { SceneElement } from '../shared/scene_types'
import { scene_controls_read } from '../server/scene_control_reader'
import { scene_elements_read } from '../server/scene_proposal'
import { view_records, view_taps } from '../server/scene_view_records'

// A revision's scene as this page holds it: everything a view is projected from.
export type LocalScene = {
  revision: number
  controls: SceneControl[]
  elements: SceneElement[]
  rest: ViewState
  states_count: number
}

export type LocalView = { records: CanvasRecord[]; taps: ViewTap[] }

// Why a scene was not taken, for the page to fall back to the view at rest.
export type SceneRefusal = 'too_large' | 'not_json' | 'format' | 'revision' | 'invalid'

export type SceneRead = { ok: true; scene: LocalScene } | { ok: false; reason: SceneRefusal }

// Reads the body of `view.json?interactive=1` for the revision the page shows. Anything other
// than this format, for this revision, within the bounds, is refused whole: the page then
// shows the revision at rest, as a page that knows nothing of controls does.
export function interactive_scene_read(text: string, revision: number): SceneRead {
  assert(Number.isSafeInteger(revision) && revision > 0, 'a scene belongs to a revision')

  // A character is at most three bytes of UTF-8, so the length bounds the bytes cheaply.
  if (text.length > interactive_view_size_bytes_max) return { ok: false, reason: 'too_large' }

  let body: unknown

  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not_json' }
  }

  const scene = object_field(body, 'interactive') as Partial<InteractiveScene> | undefined

  if (object_field(scene, 'format') !== interactive_scene_format) {
    return { ok: false, reason: 'format' }
  }

  if (scene?.revision !== revision || object_field(body, 'revision') !== revision) {
    return { ok: false, reason: 'revision' }
  }

  const read = scene_parts_read(scene.controls, scene.elements)
  assert(!read.ok || read.scene.elements.length <= proposal_shapes_count_max, 'scene bounded')
  return read.ok ? { ok: true, scene: { ...read.scene, revision } } : read
}

function scene_parts_read(controls_value: unknown, elements_value: unknown): SceneRead {
  const reader = new JsonReader()

  if (!Array.isArray(controls_value) || controls_value.length === 0) {
    return { ok: false, reason: 'invalid' }
  }

  const controls = scene_controls_read(reader, controls_value)
  const elements = scene_elements_read(reader, elements_value, 'held', controls)

  if (reader.problem !== null) return { ok: false, reason: 'invalid' }

  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  const scene: LocalScene = {
    revision: 0,
    controls,
    elements,
    rest: view_state_rest(controls),
    states_count: view_states_count(controls),
  }
  assert(scene.states_count >= 2, 'a read scene has views to choose between')
  return { ok: true, scene }
}

// One view of the scene: the records the board would serve for this state, and the taps of
// the shapes it shows. Projected on demand, one state at a time; never every state.
export function interactive_view(scene: LocalScene, state: ViewState): LocalView {
  const checked = view_state_read(scene.controls, state)
  assert(checked.ok, 'a view is projected only for a state of its scene')
  const records: CanvasRecord[] = view_records(scene.elements, checked.state)
  const taps = view_taps(scene.elements, checked.state)
  assert(taps.length <= scene.elements.length, 'at most one tap for each element')
  return { records, taps }
}

// The state with one control set to one value, or null when the scene has no such control or
// value: a stale or forged choice never becomes a view.
export function view_state_with(
  scene: LocalScene,
  state: ViewState,
  control: string,
  value: string,
): ViewState | null {
  const read = view_state_read(scene.controls, { ...state, [control]: value })

  if (!read.ok) return null

  assert(read.state[control] === value, 'the chosen value is set')
  assert(Object.keys(read.state).length === scene.controls.length, 'one value per control')
  return read.state
}

// Whether two states choose the same view. Both name every control of one scene.
export function view_state_same(a: ViewState, b: ViewState): boolean {
  const keys = Object.keys(a)
  assert(keys.length <= scene_controls_count_max, 'a state is bounded')
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

// A short, stable name for a state: the values in the order of the controls.
export function view_state_key(scene: LocalScene, state: ViewState): string {
  const values = scene.controls.map((control) => state[control.id] ?? '')
  assert(
    values.every((value) => value.length > 0),
    'a state names every control',
  )
  return values.join('/')
}

export type SceneEnvelope = { x: number; y: number; w: number; h: number }

// Where the scene lies on the page in every view: the box round every element's own
// geometry, whether or not a view shows it. The switch rests on its top edge, so it stays put
// while the views change what is drawn under it. Null for a scene with nothing placed.
export function scene_envelope(elements: readonly SceneElement[]): SceneEnvelope | null {
  assert(elements.length <= proposal_shapes_count_max, 'a scene is bounded')
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }

  for (const element of elements) {
    if (element.type === 'geo') {
      add(element.x, element.y)
      add(element.x + element.w, element.y + element.h)
    } else if (element.type === 'text') {
      add(element.x, element.y)
      add(element.x + (element.w ?? 0), element.y)
    } else if (element.type === 'path' || element.type === 'stroke') {
      for (const point of element.points) add(point.x, point.y)
    } else if (element.type === 'sketch') {
      add(element.x ?? 0, element.y ?? 0)
      add((element.x ?? 0) + (element.w ?? 0), (element.y ?? 0) + (element.h ?? 0))
    } else if (element.type === 'arrow') {
      for (const end of [element.from, element.to]) if (end.kind === 'point') add(end.x, end.y)
    }
  }

  if (!Number.isFinite(x0) || !Number.isFinite(y1)) return null

  assert(x1 >= x0 && y1 >= y0, 'an envelope has no negative extent')
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function object_field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined

  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}
