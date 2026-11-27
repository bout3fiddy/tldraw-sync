// The scene an agent publishes as the whole Agent canvas: a flat list of positioned elements
// in page units. There is no vocabulary of meanings and no layout step. An element is drawn
// where the agent put it, as a native tldraw shape a person can edit after copying the canvas
// into the sketch.
//
// Seven kinds of element exist: text, a geometric shape, a path of straight or curved runs, a
// freehand stroke of the agent's own, an arrow, a group, and strokes of the sketch. The last
// is the only way anything of the sketch reaches the canvas: the agent names the strokes and
// the board copies them, sample for sample, and records where they came from.

import type { SceneCondition, SceneControl, SceneTap } from './scene_controls'

// The version is part of the name, so a future format can be told apart, not misread. A scene
// without controls is the same in this format as before controls existed.
export const scene_format = 'tldraw-sync.scene.v1'

// What a publish was made from. 'sketch': from the sketch its snapshot names, accepted only
// while the sketch is still that one. 'canvas': a change to the Agent canvas alone, accepted
// after the sketch has moved on. The first is the default.
export const scene_bases = ['sketch', 'canvas'] as const
export type SceneBasis = (typeof scene_bases)[number]

export const scene_element_types = [
  'text',
  'geo',
  'path',
  'stroke',
  'arrow',
  'group',
  'sketch',
] as const
export type SceneElementType = (typeof scene_element_types)[number]

// tldraw's own style names. In each list the first option is the default. The server checks
// at start that every name here is one tldraw draws.
export const scene_colors = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white',
] as const
export type SceneColor = (typeof scene_colors)[number]
export const scene_sizes = ['m', 's', 'l', 'xl'] as const
export type SceneSize = (typeof scene_sizes)[number]
export const scene_fonts = ['draw', 'sans', 'serif', 'mono'] as const
export type SceneFont = (typeof scene_fonts)[number]
export const scene_fills = ['none', 'semi', 'solid', 'pattern'] as const
export type SceneFill = (typeof scene_fills)[number]
export const scene_dashes = ['draw', 'solid', 'dashed', 'dotted'] as const
export type SceneDash = (typeof scene_dashes)[number]
export const scene_text_aligns = ['start', 'middle', 'end'] as const
export type SceneTextAlign = (typeof scene_text_aligns)[number]
export const scene_label_aligns = ['middle', 'start', 'end'] as const
export type SceneLabelAlign = (typeof scene_label_aligns)[number]
export const scene_geos = [
  'rectangle',
  'ellipse',
  'oval',
  'diamond',
  'triangle',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'rhombus',
  'rhombus-2',
  'trapezoid',
  'cloud',
  'heart',
  'x-box',
  'check-box',
  'arrow-right',
  'arrow-left',
  'arrow-up',
  'arrow-down',
] as const
export type SceneGeo = (typeof scene_geos)[number]
export const scene_arrowheads = [
  'arrow',
  'none',
  'triangle',
  'square',
  'dot',
  'pipe',
  'diamond',
  'inverted',
  'bar',
] as const
export type SceneArrowhead = (typeof scene_arrowheads)[number]

// An arc is straight unless it bends; an elbow runs in right angles.
export const scene_routes = ['arc', 'elbow'] as const
export type SceneRoute = (typeof scene_routes)[number]

export type ScenePoint = { x: number; y: number }

// The sketch shapes that can be kept as they were drawn: pen and highlighter strokes.
export const ink_stroke_types = ['draw', 'highlight'] as const
export type InkStrokeType = (typeof ink_stroke_types)[number]

// One pen stroke of the sketch, as tldraw holds it: its type, turn and opacity, and its own
// props, which are the pen samples, colour and weight, unchanged. `x` and `y` place the
// stroke's origin relative to the corner of the box around the strokes it was measured with.
export type InkStroke = {
  type: InkStrokeType
  x: number
  y: number
  rotation: number
  opacity: number
  props: Record<string, unknown>
}

// Where an arrow ends: at a point on the page, or on another element. An anchor says where on
// that element, from (0, 0) at its top left to (1, 1) at its bottom right; without one the
// arrow aims at the middle and stops at the outline.
export type SceneEnd =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'element'; id: string; anchor: ScenePoint | null }

// What every element has. `parent` is the group that holds it, or null on the page. Positions
// are page positions whether or not the element is in a group. `rotation` is in radians about
// the element's own top left corner, as in tldraw. `visible_when` and `on_tap` refer to the
// scene's controls (see `scene_controls.ts`): no conditions means always shown, and null means
// a tap does nothing.
type Common = {
  id: string
  parent: string | null
  rotation: number
  opacity: number
  visible_when: SceneCondition[]
  on_tap: SceneTap | null
}

export type SceneText = Common & {
  type: 'text'
  x: number
  y: number
  text: string

  // Null lets the text take the width of its words.
  w: number | null
  color: SceneColor
  size: SceneSize
  font: SceneFont
  align: SceneTextAlign
}

export type SceneGeoShape = Common & {
  type: 'geo'
  geo: SceneGeo
  x: number
  y: number
  w: number
  h: number
  text: string
  color: SceneColor
  label_color: SceneColor
  fill: SceneFill
  dash: SceneDash
  size: SceneSize
  font: SceneFont
  align: SceneLabelAlign
  vertical_align: SceneLabelAlign
}

export type ScenePath = Common & {
  type: 'path'
  points: ScenePoint[]

  // False joins the points with straight runs; true draws one smooth curve through them.
  curved: boolean
  color: SceneColor
  dash: SceneDash
  size: SceneSize
}

export type SceneStroke = Common & {
  type: 'stroke'
  points: ScenePoint[]
  closed: boolean
  color: SceneColor
  fill: SceneFill
  dash: SceneDash
  size: SceneSize
}

export type SceneArrow = Common & {
  type: 'arrow'
  from: SceneEnd
  to: SceneEnd
  text: string
  color: SceneColor
  label_color: SceneColor
  dash: SceneDash
  size: SceneSize
  font: SceneFont
  route: SceneRoute

  // How far an arc's middle stands off the straight line, in page units.
  bend: number
  arrowhead_start: SceneArrowhead
  arrowhead_end: SceneArrowhead
}

// A group has no geometry of its own: it is the elements that name it as their parent.
export type SceneGroup = Common & { type: 'group' }

// Strokes of the sketch, kept as they were drawn. The agent names them and may say where the
// top left of their box goes. The board fills in everything else when it copies them: the box,
// the hash of the sketch they were copied from, and the strokes themselves.
export type SceneSketch = Common & {
  type: 'sketch'
  strokes: string[]

  // Null on the way to the board when the strokes stay where they are in the sketch.
  x: number | null
  y: number | null

  // Null on the way to the board; never null in a published scene.
  w: number | null
  h: number | null
  source_hash: string | null

  // The copied strokes, one for each id, placed relative to the corner of the box.
  ink: InkStroke[] | null
}

export type SceneElement =
  SceneText | SceneGeoShape | ScenePath | SceneStroke | SceneArrow | SceneGroup | SceneSketch

// A validated proposal: the scene an agent asked to publish, tied to what it was made from.
export type SceneProposal = {
  snapshot: string
  base_revision: number
  agent: string
  summary: string
  session: string
  title: string | null
  basis: SceneBasis

  // Empty for a scene with a single view.
  controls: SceneControl[]
  elements: SceneElement[]
}
