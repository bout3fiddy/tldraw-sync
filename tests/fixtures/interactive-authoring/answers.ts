// Three synthetic questions put to an agent beside a linked board, and the answer form chosen
// for each. Two are processes a person follows step by step, so they are drawn with native
// shapes and one "steps" control whose views the stage renders. The third asks what a word
// means; a picture would add nothing, so it is answered in words and nothing is drawn.
//
// This is a test fixture for authoring acceptance. It is not guidance, a template or an
// example for agents. The scenes are built here from plain numbers so that the regions the
// acceptance checks probe in the rendered pictures and the shapes drawn share one source.

export type Json = Record<string, unknown>

// Page units, y downwards.
export type Box = { left: number; top: number; right: number; bottom: number }
type Point = readonly [number, number]

// What the stage's picture of one view must show in a region: something painted there, or
// nothing at all.
export type Probe = { name: string; box: Box; expect: 'painted' | 'clear' }

// One view of a drawn answer. The first view of each answer is its view at rest.
export type View = {
  name: string
  state: Record<string, string> | null
  probes: Probe[]

  // The one-line caption of this view, which has to come out at a legible size.
  caption: Box
}

export type DrawnAnswer = {
  form: 'drawing'
  name: string
  question: string
  reason: string
  frame: { w: number; h: number }
  controls: Json[]
  elements: Json[]
  views: View[]
  reply: string
}

export type WordsAnswer = {
  form: 'words'
  name: string
  question: string
  reason: string
  reply: string
}

export type Answer = DrawnAnswer | WordsAnswer

// Every drawing sits in one frame at the origin, so the stage's picture of any view has the
// same page bounds and its pixels map back to page units the same way.
const frame_w = 960
const frame_h = 600
const caption_box: Box = { left: 40, top: 544, right: 920, bottom: 584 }

type Style = Record<string, unknown>
type Shown = { visible_when?: Array<{ control: string; values: string[] }> }

function when(control: string, ...values: string[]): Shown {
  return { visible_when: [{ control, values }] }
}

function text(id: string, at: Point, w: number, words: string, style: Style = {}): Json {
  return { type: 'text', id, x: at[0], y: at[1], w, text: words, font: 'sans', size: 's', ...style }
}

function geo(id: string, box: Box, style: Style = {}): Json {
  const { left, top, right, bottom } = box
  return { type: 'geo', id, x: left, y: top, w: right - left, h: bottom - top, ...style }
}

function line(id: string, points: readonly Point[], style: Style = {}): Json {
  return { type: 'path', id, points: points.map(([x, y]) => [x, y]), ...style }
}

function outline(id: string, points: readonly Point[], style: Style = {}): Json {
  return { type: 'stroke', id, points: points.map(([x, y]) => [x, y]), closed: true, ...style }
}

function arrow(id: string, from: Point, to: Point, style: Style = {}): Json {
  return { type: 'arrow', id, from: [from[0], from[1]], to: [to[0], to[1]], ...style }
}

function box_around(x: number, y: number, half_w: number, half_h: number): Box {
  return { left: x - half_w, top: y - half_h, right: x + half_w, bottom: y + half_h }
}

const round = (value: number) => Math.round(value * 10) / 10

function frame_elements(title: string): Json[] {
  return [
    geo(
      'frame',
      { left: 0, top: 0, right: frame_w, bottom: frame_h },
      {
        color: 'grey',
        dash: 'solid',
        size: 's',
      },
    ),
    text('title', [32, 20], 896, title, { size: 'l', font: 'serif' }),
  ]
}

function captions(control: string, lines: ReadonlyArray<readonly [string, string]>): Json[] {
  return lines.map(([value, words]) =>
    text(
      `caption-${value}`,
      [caption_box.left, caption_box.top + 4],
      880,
      words,
      when(control, value),
    ),
  )
}

// ---------------------------------------------------------------------------------------------
// How a loom forms fabric: a side view of the shed beside a view from above of the weave.

const loom_steps = ['lift', 'pick', 'beat', 'swap'] as const
const raised_first = ['lift', 'pick', 'beat'] as const

// Side view. Warp runs from the warp beam on the left to the fell, where cloth begins.
const warp_back: Point = [100, 290]
const fell: Point = [330, 290]
const heddle_x = 210
const shed_up: Point = [heddle_x, 230]
const shed_down: Point = [heddle_x, 350]
const weft_end_on: Point = [292, 290]
const reed_rest_x = 250
const reed_beat_x = 320

// View from above. Eight warp threads; three rows already woven, one being added.
const warp_xs = Array.from({ length: 8 }, (_, index) => 530 + index * 50)
const woven_ys = [490, 474, 458]
const packed_y = 442
const loose_y = 400

function warp_color(index: number): string {
  return index % 2 === 0 ? 'blue' : 'violet'
}

// A row of weft and, on top of it, the warp threads that pass over it in that row.
function weft_row(id: string, y: number, over_even: boolean, shown: Shown = {}): Json[] {
  const row = [
    line(
      id,
      [
        [515, y],
        [895, y],
      ],
      { color: 'orange', size: 'm', ...shown },
    ),
  ]

  for (const [index, x] of warp_xs.entries()) {
    if ((index % 2 === 0) !== over_even) continue

    const over = line(
      `${id}-over-${index}`,
      [
        [x, y - 7],
        [x, y + 7],
      ],
      {
        color: warp_color(index),
        size: 'l',
        ...shown,
      },
    )
    row.push(over)
  }

  return row
}

function loom_side(): Json[] {
  const shed = (id: string, middle: Point, color: string, shown: Shown) =>
    line(id, [warp_back, middle, fell], { color, size: 'm', ...shown })
  return [
    text('side-title', [40, 84], 400, 'Side view: the shed'),
    geo('warp-beam', box_around(76, 290, 24, 24), {
      geo: 'ellipse',
      color: 'orange',
      fill: 'pattern',
    }),
    text('warp-beam-label', [26, 324], 100, 'warp beam', { align: 'middle' }),
    geo('cloth-beam', box_around(408, 290, 24, 24), {
      geo: 'ellipse',
      color: 'green',
      fill: 'pattern',
    }),
    text('cloth-beam-label', [358, 324], 100, 'cloth', { align: 'middle' }),
    line(
      'heddle',
      [
        [heddle_x, 176],
        [heddle_x, 404],
      ],
      { color: 'grey', dash: 'dashed', size: 's' },
    ),
    text('heddle-label', [heddle_x - 60, 146], 120, 'heddles', { align: 'middle' }),
    shed('shed-blue-up', shed_up, 'blue', when('step', ...raised_first)),
    shed('shed-violet-down', shed_down, 'violet', when('step', ...raised_first)),
    shed('shed-blue-down', shed_down, 'blue', when('step', 'swap')),
    shed('shed-violet-up', shed_up, 'violet', when('step', 'swap')),
    line('cloth', [fell, [384, 290]], { color: 'green', size: 'xl' }),
    ...[0, 1, 2].map((index) =>
      geo(`woven-${index}`, box_around(342 + index * 14, 290, 6, 7), {
        geo: 'ellipse',
        color: 'orange',
        fill: 'solid',
      }),
    ),
    line(
      'reed-rest',
      [
        [reed_rest_x, 196],
        [reed_rest_x, 384],
      ],
      {
        size: 'l',
        ...when('step', 'lift', 'pick', 'swap'),
      },
    ),
    text('reed-rest-label', [reed_rest_x - 50, 392], 100, 'reed', {
      align: 'middle',
      ...when('step', 'lift', 'pick', 'swap'),
    }),
    line(
      'reed-beat',
      [
        [reed_beat_x, 196],
        [reed_beat_x, 384],
      ],
      { size: 'l', ...when('step', 'beat') },
    ),
    text('reed-beat-label', [reed_beat_x - 50, 392], 100, 'reed', {
      align: 'middle',
      ...when('step', 'beat'),
    }),
    arrow('beat-push', [reed_rest_x + 6, 186], [reed_beat_x - 6, 186], {
      color: 'red',
      size: 'm',
      ...when('step', 'beat'),
    }),
    geo('weft-end-on', box_around(weft_end_on[0], weft_end_on[1], 10, 10), {
      geo: 'ellipse',
      color: 'orange',
      fill: 'pattern',
      ...when('step', 'pick'),
    }),
    text('weft-end-on-label', [262, 146], 170, 'weft, seen end-on', when('step', 'pick')),
    arrow('weft-end-on-pointer', [320, 172], [298, 276], {
      color: 'orange',
      ...when('step', 'pick'),
    }),
    geo('weft-packed', box_around(328, 290, 6, 7), {
      geo: 'ellipse',
      color: 'orange',
      fill: 'solid',
      ...when('step', 'beat', 'swap'),
    }),
  ]
}

function loom_top(): Json[] {
  const elements: Json[] = [text('top-title', [500, 84], 420, 'From above: the weave')]

  for (const [index, x] of warp_xs.entries()) {
    elements.push(
      line(
        `warp-${index}`,
        [
          [x, 140],
          [x, 500],
        ],
        { color: warp_color(index) },
      ),
    )

    // Which threads the heddles hold up while the weft passes under them.
    const raised = index % 2 === 0 ? when('step', ...raised_first) : when('step', 'swap')
    const marker = box_around(x, 124, 7, 9)
    elements.push(
      geo(`raised-${index}`, marker, {
        geo: 'arrow-up',
        color: warp_color(index),
        fill: 'solid',
        ...raised,
      }),
    )
  }

  // Rows alternate which half of the warp lies on top; the new row continues the pattern.
  for (const [row, y] of woven_ys.entries()) {
    elements.push(...weft_row(`woven-row-${row}`, y, row % 2 === 1))
  }

  // The pick in flight: loose and wavy until the reed beats it in.
  const wave = Array.from({ length: 21 }, (_, index): Point => [
    515 + index * 19,
    round(loose_y + 5 * Math.sin((index * Math.PI) / 2.6)),
  ])
  elements.push(
    line('weft-loose', wave, { color: 'orange', curved: true, ...when('step', 'pick') }),
  )
  elements.push(
    geo(
      'shuttle',
      { left: 886, top: 388, right: 940, bottom: 412 },
      {
        geo: 'oval',
        color: 'orange',
        fill: 'solid',
        ...when('step', 'pick'),
      },
    ),
    arrow('shuttle-path', [560, 372], [860, 372], {
      color: 'orange',
      text: 'shuttle',
      label_color: 'black',
      ...when('step', 'pick'),
    }),
  )
  elements.push(...weft_row('weft-new', packed_y, true, when('step', 'beat', 'swap')))
  elements.push(
    arrow('beat-down', [705, 404], [705, 432], { color: 'red', ...when('step', 'beat') }),
    arrow('next-pick', [880, 420], [540, 420], {
      color: 'orange',
      dash: 'dashed',
      text: 'next pick returns',
      label_color: 'black',
      ...when('step', 'swap'),
    }),
  )
  return elements
}

// Probes sit between warp threads and away from every line that is drawn in all views.
const loom_probes = {
  weft_end_on: box_around(weft_end_on[0], weft_end_on[1], 6, 6),
  loose_row: { left: 540, top: loose_y - 6, right: 570, bottom: loose_y + 6 },
  packed_row: { left: 540, top: packed_y - 4, right: 570, bottom: packed_y + 4 },
  reed_at_fell: { left: reed_beat_x - 4, top: 306, right: reed_beat_x + 4, bottom: 370 },
  next_pick: { left: 845, top: 416, right: 870, bottom: 424 },
}

function loom_view(step: (typeof loom_steps)[number]): View {
  const is = (...steps: string[]) => (steps.includes(step) ? 'painted' : 'clear')
  return {
    name: `loom-${loom_steps.indexOf(step) + 1}-${step}`,
    state: step === 'lift' ? null : { step },
    caption: caption_box,
    probes: [
      { name: 'weft end-on in the shed', box: loom_probes.weft_end_on, expect: is('pick') },
      { name: 'loose pick from above', box: loom_probes.loose_row, expect: is('pick') },
      { name: 'new row packed in', box: loom_probes.packed_row, expect: is('beat', 'swap') },
      { name: 'reed at the fell', box: loom_probes.reed_at_fell, expect: is('beat') },
      { name: 'next pick returns', box: loom_probes.next_pick, expect: is('swap') },
    ],
  }
}

const loom: DrawnAnswer = {
  form: 'drawing',
  name: 'loom',
  question: 'How does a loom actually turn threads into fabric?',
  reason: 'A repeating motion in four steps: each step is a view the person can step through.',
  frame: { w: frame_w, h: frame_h },
  controls: [
    {
      id: 'step',
      kind: 'steps',
      label: 'Weaving step',
      options: loom_steps.map((value, index) => ({
        value,
        label: `${index + 1} ${value[0]!.toUpperCase()}${value.slice(1)}`,
      })),
    },
  ],
  elements: [
    ...frame_elements('How a loom turns threads into cloth'),
    ...loom_side(),
    ...loom_top(),
    ...captions('step', [
      ['lift', '1 Lift: heddles raise every other warp thread, opening a gap called the shed.'],
      ['pick', '2 Pick: the shuttle carries the weft thread across, through the shed.'],
      ['beat', '3 Beat: the reed pushes the new weft tight against the cloth.'],
      ['swap', '4 Swap: the other threads rise, locking the weft in. The next pick returns.'],
    ]),
  ],
  views: loom_steps.map(loom_view),
  reply:
    'A loom holds lengthwise warp threads under tension and lifts every other one to open a ' +
    'gap, the shed. The shuttle carries a crosswise weft thread through it, the reed beats it ' +
    'tight, and the other half of the warp rises so the next pass locks it in. I drew the four ' +
    'steps on the Agent canvas: use Weaving step to go through them.',
}

// ---------------------------------------------------------------------------------------------
// Why a shadow changes over a day: one person, the sun at three heights, the ray from the sun
// past the top of their head to the tip of their shadow.

const times = ['morning', 'noon', 'evening'] as const
const feet_x = 480
const ground_y = 470
const head_top_y = 300
const person_height = ground_y - head_top_y
const sun_radius = 30

type Sun = { time: (typeof times)[number]; center: Point }

// The sun is placed along the ray through the top of the head, so the shadow drawn is the
// one that light would cast: length = height * run / rise.
const suns: Sun[] = [
  { time: 'morning', center: [208, 173] },
  { time: 'noon', center: [440, 98] },
  { time: 'evening', center: [752, 173] },
]

function shadow_tip_x(sun: Sun): number {
  const [sun_x, sun_y] = sun.center
  const run = feet_x - sun_x
  const rise = head_top_y - sun_y
  return round(feet_x + (person_height * run) / rise)
}

function elevation_degrees(sun: Sun): number {
  const [sun_x, sun_y] = sun.center
  return Math.round((Math.atan2(head_top_y - sun_y, Math.abs(feet_x - sun_x)) * 180) / Math.PI)
}

function sun_elements(sun: Sun): Json[] {
  const [x, y] = sun.center
  const shown = when('time', sun.time)
  const elements = [
    geo(`sun-${sun.time}`, box_around(x, y, sun_radius, sun_radius), {
      geo: 'ellipse',
      color: 'orange',
      fill: 'solid',
      ...shown,
    }),
  ]

  for (let index = 0; index < 8; index += 1) {
    const angle = (index * Math.PI) / 4 + Math.PI / 8
    const [dx, dy] = [Math.cos(angle), Math.sin(angle)]
    const ray = line(
      `sun-${sun.time}-ray-${index}`,
      [
        [round(x + dx * 38), round(y + dy * 38)],
        [round(x + dx * 48), round(y + dy * 48)],
      ],
      { color: 'orange', ...shown },
    )
    elements.push(ray)
  }

  return elements
}

function shadow_elements(sun: Sun): Json[] {
  const tip = shadow_tip_x(sun)
  const [x, y] = sun.center
  const toward = Math.sign(tip - feet_x)
  const shown = when('time', sun.time)
  const reach = Math.hypot(feet_x - x, head_top_y - y)
  const start: Point = [
    round(x + ((feet_x - x) / reach) * 40),
    round(y + ((head_top_y - y) / reach) * 40),
  ]
  const ratio = (Math.abs(tip - feet_x) / person_height).toFixed(1)
  const label_x = toward > 0 ? Math.min(tip - 250, 600) : Math.max(tip, 60)
  return [
    outline(
      `shadow-${sun.time}`,
      [
        [feet_x - 10 * toward, ground_y + 2],
        [tip, ground_y + 6],
        [tip, ground_y + 14],
        [feet_x - 10 * toward, ground_y + 18],
      ],
      { color: 'black', fill: 'pattern', dash: 'solid', size: 's', ...shown },
    ),
    arrow(`light-${sun.time}`, start, [tip, ground_y], {
      color: 'orange',
      dash: 'dashed',
      ...shown,
    }),
    text(`shadow-${sun.time}-label`, [label_x, 496], 250, `shadow ${ratio} × your height`, shown),
  ]
}

function sun_label(sun: Sun): Json {
  const [x, y] = sun.center
  const at: Point = sun.time === 'noon' ? [x + 56, y - 12] : [x - 60, y - 76]
  const words = `sun ${elevation_degrees(sun)}° up`
  return text(`sun-${sun.time}-label`, at, 120, words, {
    align: 'middle',
    ...when('time', sun.time),
  })
}

function person(): Json[] {
  return [
    geo('head', box_around(feet_x, head_top_y + 14, 14, 14), { geo: 'ellipse', size: 'm' }),
    line('body', [
      [feet_x, 328],
      [feet_x, 400],
    ]),
    line('legs', [
      [feet_x - 18, ground_y],
      [feet_x, 400],
      [feet_x + 18, ground_y],
    ]),
    line('arms', [
      [feet_x - 24, 372],
      [feet_x, 346],
      [feet_x + 24, 372],
    ]),
  ]
}

// Shadow probes lie on the ground between the feet and each tip. Sun probes lie inside each
// sun, below the dotted path that runs through its centre.
const shadow_probes = {
  west: { left: 620, top: ground_y + 6, right: 680, bottom: ground_y + 12 },
  east: { left: 280, top: ground_y + 6, right: 340, bottom: ground_y + 12 },
  noon_sun: { left: 432, top: 110, right: 448, bottom: 124 },
  morning_sun: { left: 218, top: 184, right: 234, bottom: 198 },
  evening_sun: { left: 726, top: 184, right: 742, bottom: 198 },
}

function shadow_view(time: (typeof times)[number]): View {
  const is = (...shown: string[]) => (shown.includes(time) ? 'painted' : 'clear')
  return {
    name: `shadow-${times.indexOf(time) + 1}-${time}`,
    state: time === 'morning' ? null : { time },
    caption: caption_box,
    probes: [
      { name: 'shadow stretches west', box: shadow_probes.west, expect: is('morning') },
      { name: 'shadow stretches east', box: shadow_probes.east, expect: is('evening') },
      { name: 'sun low in the east', box: shadow_probes.morning_sun, expect: is('morning') },
      { name: 'sun high at noon', box: shadow_probes.noon_sun, expect: is('noon') },
      { name: 'sun low in the west', box: shadow_probes.evening_sun, expect: is('evening') },
    ],
  }
}

const shadows: DrawnAnswer = {
  form: 'drawing',
  name: 'shadows',
  question: 'Why is my shadow long in the morning but tiny at lunchtime?',
  reason: 'The cause is an angle that changes with time: one drawing, one view per time of day.',
  frame: { w: frame_w, h: frame_h },
  controls: [
    {
      id: 'time',
      kind: 'steps',
      label: 'Time of day',
      options: times.map((value) => ({
        value,
        label: `${value[0]!.toUpperCase()}${value.slice(1)}`,
      })),
    },
  ],
  elements: [
    ...frame_elements('Why a shadow changes through the day'),
    line('sun-path', [[110, 300], ...suns.map((sun) => sun.center), [850, 300]], {
      color: 'grey',
      dash: 'dotted',
      curved: true,
    }),
    line(
      'ground',
      [
        [40, ground_y],
        [920, ground_y],
      ],
      { color: 'green', size: 'l' },
    ),
    text('east', [40, 436], 80, 'East'),
    text('west', [860, 436], 80, 'West', { align: 'end' }),
    text(
      'same-person',
      [620, 280],
      300,
      'Same person, same height. Only the angle of the sun changes.',
    ),
    ...person(),
    ...suns.flatMap((sun) => [...sun_elements(sun), sun_label(sun), ...shadow_elements(sun)]),
    ...captions('time', [
      ['morning', 'Morning: the sun is low in the east, so the shadow stretches far to the west.'],
      ['noon', 'Noon: the sun is at its highest, light falls steeply, the shadow is shortest.'],
      ['evening', 'Evening: the sun sinks in the west and the shadow grows long again, eastward.'],
    ]),
  ],
  views: times.map(shadow_view),
  reply:
    'Your shadow is where your body blocks sunlight. A low morning sun sends light in at a ' +
    'shallow angle, so the blocked patch reaches far along the ground; at midday light comes ' +
    'steeply down and the patch shrinks to almost your footprint. I drew one person under the ' +
    'sun at three times of day on the Agent canvas: use Time of day to compare them.',
}

// ---------------------------------------------------------------------------------------------
// A word's meaning: answered in words. A drawing would only restate the sentence.

const term: WordsAnswer = {
  form: 'words',
  name: 'term',
  question: 'Quick one: what does "equinox" mean?',
  reason: 'A definition is one sentence; a drawing would only restate it, so nothing is drawn.',
  reply:
    'An equinox is one of the two days a year, around 20 March and 22 September, when the sun ' +
    'is directly over the equator, so day and night are about equal everywhere.',
}

export const answers: readonly Answer[] = [term, loom, shadows]

export const frame_size = { w: frame_w, h: frame_h }
