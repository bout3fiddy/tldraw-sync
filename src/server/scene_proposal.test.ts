// A scene is the one input an agent controls, so most of these tests feed it mistakes and
// check that each is refused, with the path to it, before anything could change. The rest pin
// what a valid scene reads as, and that a scene written back out reads as the same scene.

import { expect, test } from 'bun:test'
import {
  ink_points_count_max,
  proposal_shapes_count_max,
  scene_depth_max,
  scene_path_points_count_max,
  scene_stroke_ids_count_max,
} from '../shared/constants'
import { JsonReader } from '../shared/json_reader'
import { scene_format } from '../shared/scene_types'
import { scene_elements_read, scene_elements_write, scene_parse } from './scene_proposal'

type Json = Record<string, any>

const hash = '0123456789abcdef'
const session = 'abcdabcdabcdabcd'

// One of every kind of element, as an agent would write them.
function scene(): Json {
  return {
    format: scene_format,
    session,
    snapshot: hash,
    base_revision: 2,
    elements: [
      { type: 'text', id: 'title', x: 0, y: -80, text: 'Checkout' },
      { type: 'geo', id: 'api', x: 0, y: 0, w: 160, h: 80, text: 'API' },
      { type: 'geo', id: 'db', geo: 'cloud', x: 300, y: 0, w: 120, h: 80 },
      { type: 'arrow', id: 'writes', from: 'api', to: 'db', text: 'writes' },
      { type: 'arrow', id: 'aside', from: [0, 200], to: 'title', to_anchor: [0.5, 1] },
      {
        type: 'path',
        id: 'rule',
        points: [
          [0, 120],
          [200, 120],
          [200, 160],
        ],
      },
      {
        type: 'stroke',
        id: 'squiggle',
        points: [
          [10, 10],
          [14, 18],
          [20, 11],
        ],
        parent: 'notes',
      },
      { type: 'sketch', id: 'pic', strokes: ['shape:hill', 'shape:sun'], parent: 'notes' },
      { type: 'group', id: 'notes' },
    ],
  }
}

function parsed(input: unknown) {
  const result = scene_parse(input)

  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)

  return result.proposal
}

test('a scene with one of every kind of element is read, with its defaults filled in', () => {
  const proposal = parsed(scene())
  expect(proposal).toMatchObject({
    session,
    snapshot: hash,
    base_revision: 2,
    basis: 'sketch',
    agent: 'external agent',
    summary: '',
    title: null,
  })
  const [title, api, db, writes, aside, rule, squiggle, pic, notes] = proposal.elements
  expect(title).toEqual({
    type: 'text',
    id: 'title',
    parent: null,
    rotation: 0,
    opacity: 1,
    visible_when: [],
    on_tap: null,
    x: 0,
    y: -80,
    text: 'Checkout',
    w: null,
    color: 'black',
    size: 'm',
    font: 'draw',
    align: 'start',
  })
  expect(api).toMatchObject({ geo: 'rectangle', fill: 'none', dash: 'draw', label_color: 'black' })
  expect(db).toMatchObject({ geo: 'cloud', text: '', align: 'middle', vertical_align: 'middle' })
  expect(writes).toMatchObject({
    from: { kind: 'element', id: 'api', anchor: null },
    to: { kind: 'element', id: 'db', anchor: null },
    route: 'arc',
    bend: 0,
    arrowhead_start: 'none',
    arrowhead_end: 'arrow',
  })
  expect(aside).toMatchObject({
    from: { kind: 'point', x: 0, y: 200 },
    to: { kind: 'element', id: 'title', anchor: { x: 0.5, y: 1 } },
  })
  expect(rule).toMatchObject({
    curved: false,
    points: [
      { x: 0, y: 120 },
      { x: 200, y: 120 },
      { x: 200, y: 160 },
    ],
  })
  expect(squiggle).toMatchObject({ closed: false, parent: 'notes', fill: 'none' })

  // On the way to the board a sketch element only names its strokes.
  expect(pic).toMatchObject({ x: null, y: null, w: null, h: null, source_hash: null, ink: null })
  expect(notes).toEqual({
    type: 'group',
    id: 'notes',
    parent: null,
    rotation: 0,
    opacity: 1,
    visible_when: [],
    on_tap: null,
  })
  expect(proposal.controls).toEqual([])
})

test('an empty scene is a valid scene, and so is one that changes the canvas alone', () => {
  expect(parsed({ ...scene(), elements: [] }).elements).toEqual([])
  expect(parsed({ ...scene(), basis: 'canvas' }).basis).toBe('canvas')
  const named = parsed({
    ...scene(),
    agent: 'pih/agent-1',
    summary: 'Tidy.',
    title: ' Checkout  flow ',
  })
  expect(named).toMatchObject({ agent: 'pih/agent-1', summary: 'Tidy.', title: 'Checkout flow' })
})

test('what the board fills in for a sketch element may be sent back and is not read', () => {
  const input = scene()
  Object.assign(input.elements[7], { x: 40, y: 50, w: 9999, h: 1, source_hash: 'f'.repeat(16) })
  const pic = parsed(input).elements[7]
  expect(pic).toMatchObject({ x: 40, y: 50, w: null, h: null, source_hash: null, ink: null })
})

const element = (index: number, change: Json) => (input: Json) => {
  Object.assign(input.elements[index], change)
}
const added =
  (...elements: Json[]) =>
  (input: Json) => {
    input.elements.push(...elements)
  }
const stroke_ids = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `shape:${prefix}${index}`)

// Each row: what is wrong, how to make a valid scene wrong in that way, and where the reader
// must point.
const refusals: Array<[string, (input: Json) => void, string]> = [
  ['a format this board never read', (s) => (s.format = 'tldraw-sync.scene.v9'), 'proposal.format'],
  ['a retired semantic diagram', (s) => (s.format = 'tldraw-sync.diagram.v1'), 'proposal.format'],
  ['a retired shape proposal', (s) => (s.format = 'tldraw-sync.cleanup.v2'), 'proposal.format'],
  ['no session', (s) => delete s.session, 'proposal.session'],
  ['a session no board could have', (s) => (s.session = 'nope'), 'proposal.session'],
  ['no snapshot', (s) => delete s.snapshot, 'proposal.snapshot'],
  ['a malformed snapshot', (s) => (s.snapshot = 'XYZ'), 'proposal.snapshot'],
  ['a fractional revision', (s) => (s.base_revision = 1.5), 'proposal.base_revision'],
  ['a negative revision', (s) => (s.base_revision = -1), 'proposal.base_revision'],
  ['an unknown basis', (s) => (s.basis = 'memory'), 'proposal.basis'],
  ['an agent name with markup', (s) => (s.agent = '<script>'), 'proposal.agent'],
  ['a title on two lines', (s) => (s.title = 'a\nb'), 'proposal.title'],
  ['a field of the retired formats', (s) => (s.shapes = []), 'proposal.shapes'],
  ['a semantic diagram beside the scene', (s) => (s.diagram = { nodes: [] }), 'proposal.diagram'],
  ['a style for the board to apply', (s) => (s.style = 'markerboard'), 'proposal.style'],
  ['elements that are not a list', (s) => (s.elements = {}), 'proposal.elements'],
  [
    'more elements than a canvas holds',
    (s) => {
      s.elements = Array.from({ length: proposal_shapes_count_max + 1 }, (_, index) => {
        return { type: 'text', id: `t${index}`, x: 0, y: index, text: 'x' }
      })
    },
    'proposal.elements',
  ],
  ['an element that is not an object', (s) => (s.elements[0] = 'text'), 'elements[0].type'],
  ['an element without a type', element(0, { type: undefined }), 'elements[0].type'],
  ['an image', element(0, { type: 'image', src: 'http://e.example/a.png' }), 'elements[0].type'],
  ['an embed', element(0, { type: 'embed', url: 'http://e.example' }), 'elements[0].type'],
  ['a bookmark', element(0, { type: 'bookmark' }), 'elements[0].type'],
  ['a video', element(0, { type: 'video' }), 'elements[0].type'],
  ['a frame', element(0, { type: 'frame' }), 'elements[0].type'],
  ['a link on a shape', element(1, { url: 'http://e.example' }), 'elements[1].url'],
  ['an asset on a shape', element(1, { asset: 'asset:1' }), 'elements[1].asset'],
  ['a script field', element(1, { script: 'alert(1)' }), 'elements[1].script'],
  ['native props', element(1, { props: { url: 'http://e.example' } }), 'elements[1].props'],
  ['rich text', element(0, { richText: { type: 'doc', content: [] } }), 'elements[0].richText'],
  ['meta', element(0, { meta: { sketch_hash: hash } }), 'elements[0].meta'],
  ['a field of another kind', element(0, { h: 10 }), 'elements[0].h'],
  ['a missing id', element(0, { id: undefined }), 'elements[0].id'],
  ['an id with a dot', element(0, { id: 'a.b' }), 'elements[0].id'],
  ['an id that is too long', element(0, { id: 'a'.repeat(41) }), 'elements[0].id'],
  ['a repeated id', element(1, { id: 'title' }), 'elements[1].id'],
  ['an infinite x', element(0, { x: Infinity }), 'elements[0].x'],
  ['x as text', element(0, { x: '0' }), 'elements[0].x'],
  ['a place far off the page', element(0, { y: 1e9 }), 'elements[0].y'],
  ['a zero width', element(1, { w: 0 }), 'elements[1].w'],
  ['a missing height', element(1, { h: undefined }), 'elements[1].h'],
  ['an enormous shape', element(1, { w: 1e9 }), 'elements[1].w'],
  ['an unknown colour', element(1, { color: 'mauve' }), 'elements[1].color'],
  ['a colour as a number', element(1, { color: 0xff0000 }), 'elements[1].color'],
  ['an unknown geometry', element(1, { geo: 'blob' }), 'elements[1].geo'],
  ['an unknown size', element(0, { size: 'huge' }), 'elements[0].size'],
  ['an unknown font', element(0, { font: 'Comic Sans' }), 'elements[0].font'],
  ['an unknown fill', element(1, { fill: 'gradient' }), 'elements[1].fill'],
  ['an unknown dash', element(1, { dash: 'wavy' }), 'elements[1].dash'],
  ['an unknown alignment', element(1, { align: 'justify' }), 'elements[1].align'],
  ['empty text', element(0, { text: '  ' }), 'elements[0].text'],
  ['text as a list', element(0, { text: ['a'] }), 'elements[0].text'],
  ['text past its limit', element(0, { text: 'a'.repeat(2001) }), 'elements[0].text'],
  ['a turn past a full circle', element(0, { rotation: 100 }), 'elements[0].rotation'],
  ['an opacity above one', element(0, { opacity: 2 }), 'elements[0].opacity'],
  ['a path of one point', element(5, { points: [[0, 0]] }), 'elements[5].points'],
  [
    'a path of too many points',
    element(5, {
      points: Array.from({ length: scene_path_points_count_max + 1 }, (_, i) => [i, 0]),
    }),
    'elements[5].points',
  ],
  [
    'a point with three numbers',
    element(5, {
      points: [
        [0, 0],
        [1, 2, 3],
      ],
    }),
    'elements[5].points[1]',
  ],
  [
    'a point as an object',
    element(5, { points: [[0, 0], { x: 1, y: 2 }] }),
    'elements[5].points[1]',
  ],
  [
    'a point off the page',
    element(5, {
      points: [
        [0, 0],
        [1e9, 0],
      ],
    }),
    'elements[5].points[1]',
  ],
  ['curved as text', element(5, { curved: 'yes' }), 'elements[5].curved'],
  ['a stroke with no points', element(6, { points: [] }), 'elements[6].points'],
  [
    'pen pressure the agent made up',
    element(6, { points: [[0, 0, 0.5]] }),
    'elements[6].points[0]',
  ],
  ['an arrow to nothing', element(3, { to: 'missing' }), 'elements[3].to'],
  ['an arrow from nothing', element(3, { from: 'missing' }), 'elements[3].from'],
  ['an arrow to itself', element(3, { to: 'writes' }), 'elements[3].to'],
  ['an arrow to another arrow', element(3, { to: 'aside' }), 'elements[3].to'],
  ['an arrow to a group', element(3, { to: 'notes' }), 'elements[3].to'],
  ['an arrow to sketch strokes', element(3, { to: 'pic' }), 'elements[3].to'],
  ['an arrow from a shape to that shape', element(3, { to: 'api' }), 'elements[3].to'],
  [
    'an arrow between one point',
    element(4, { from: [5, 5], to: [5, 5], to_anchor: undefined }),
    'elements[4].to',
  ],
  ['an arrow end that is neither', element(3, { to: { id: 'db' } }), 'elements[3].to'],
  ['an anchor on a free end', element(4, { from_anchor: [0.5, 0.5] }), 'elements[4].from_anchor'],
  ['an anchor off its shape', element(4, { to_anchor: [1.5, 0] }), 'elements[4].to_anchor'],
  ['a bent elbow', element(3, { route: 'elbow', bend: 20 }), 'elements[3].bend'],
  ['an unknown route', element(3, { route: 'spline' }), 'elements[3].route'],
  ['an unknown arrowhead', element(3, { arrowhead_end: 'heart' }), 'elements[3].arrowhead_end'],
  ['a parent that is not there', element(0, { parent: 'nowhere' }), 'elements[0].parent'],
  ['a parent that is not a group', element(0, { parent: 'api' }), 'elements[0].parent'],
  ['a group that holds itself', element(8, { parent: 'notes' }), 'elements[6].parent'],
  ['a group of one', element(7, { parent: undefined, strokes: ['shape:x'] }), 'elements[8]'],
  ['a group of nothing', added({ type: 'group', id: 'hollow' }), 'elements[9]'],
  ['a turned group', element(8, { rotation: 1 }), 'elements[8].rotation'],
  [
    'groups nested past the limit',
    (s) => {
      for (let depth = 0; depth <= scene_depth_max; depth += 1) {
        const parent = depth === 0 ? {} : { parent: `g${depth - 1}` }
        s.elements.push({ type: 'group', id: `g${depth}`, ...parent })
        s.elements.push({
          type: 'text',
          id: `a${depth}`,
          x: 0,
          y: 0,
          text: 'a',
          parent: `g${depth}`,
        })
        s.elements.push({
          type: 'text',
          id: `b${depth}`,
          x: 0,
          y: 0,
          text: 'b',
          parent: `g${depth}`,
        })
      }
    },

    // The ninth group may be named, but nothing can be put inside it.
    `elements[${10 + scene_depth_max * 3}].parent`,
  ],
  ['a sketch element with no strokes', element(7, { strokes: [] }), 'elements[7].strokes'],
  ['a stroke id that is not one', element(7, { strokes: ['hill'] }), 'elements[7].strokes'],
  ['a stroke named twice', element(7, { strokes: ['shape:a', 'shape:a'] }), 'elements[7].strokes'],
  [
    'a stroke kept by two elements',
    added({ type: 'sketch', id: 'again', strokes: ['shape:sun'] }),
    'elements[9].strokes',
  ],
  [
    'more sketch strokes than a scene names',
    (s) => {
      s.elements[7].strokes = stroke_ids(scene_stroke_ids_count_max, 'a')
      s.elements.push({ type: 'sketch', id: 'more', strokes: ['shape:one-more'] })
    },
    'proposal.elements',
  ],
  ['a sketch element placed across but not down', element(7, { x: 5 }), 'elements[7].y'],
  ['a turned sketch element', element(7, { rotation: 0.5 }), 'elements[7].rotation'],
  ['a faded sketch element', element(7, { opacity: 0.5 }), 'elements[7].rotation'],
  ['pen samples sent as the sketch', element(7, { ink: [{ type: 'draw' }] }), 'elements[7].ink'],
  [
    'more pen samples than a canvas keeps',
    (s) => {
      const half = Array.from({ length: ink_points_count_max / 2 + 1 }, (_, i) => [i, 0])
      s.elements.push({ type: 'stroke', id: 'long-a', points: half })
      s.elements.push({ type: 'stroke', id: 'long-b', points: half })
    },
    'proposal.elements',
  ],
]

for (const [name, mutate, path] of refusals) {
  test(`refused: ${name}`, () => {
    const input = scene()
    mutate(input)
    const result = scene_parse(JSON.parse(JSON.stringify(input)))
    expect(result).toMatchObject({ ok: false, path })
    expect((result as { message: string }).message).toMatch(/\.$/)
  })
}

test('what is not a JSON object is refused without throwing', () => {
  for (const input of [null, undefined, 5, 'scene', [], [scene()], true]) {
    expect(scene_parse(input)).toMatchObject({ ok: false, path: 'proposal.format' })
  }
})

test('a scene written back out reads as the same scene', () => {
  const input = scene()
  Object.assign(input.elements[0], { w: 200, rotation: 0.5, opacity: 0.4, color: 'blue' })
  Object.assign(input.elements[3], { route: 'arc', bend: 30, arrowhead_start: 'dot' })
  const elements = parsed(input).elements
  const written = scene_elements_write(elements, 'without_ink')
  expect(parsed({ ...input, elements: JSON.parse(JSON.stringify(written)) }).elements).toEqual(
    elements,
  )

  // Written compactly: what an agent did not set and the board did not fill in is left out.
  expect(written[1]).not.toHaveProperty('parent')
  expect(written[1]).not.toHaveProperty('rotation')
  expect(written[3]).toMatchObject({ from: 'api', to: 'db' })
  expect(written[4]).toMatchObject({ from: [0, 200], to: 'title', to_anchor: [0.5, 1] })
  expect(written[5]).toMatchObject({
    points: [
      [0, 120],
      [200, 120],
      [200, 160],
    ],
  })
})

const held_stroke = {
  type: 'draw',
  x: 5,
  y: 5,
  rotation: 0,
  opacity: 1,
  props: {
    color: 'black',
    fill: 'none',
    dash: 'draw',
    size: 'm',
    isComplete: true,
    isClosed: false,
    isPen: true,
    scale: 1,
    segments: [{ type: 'free', points: [{ x: 0, y: 0, z: 0.5 }] }],
  },
}

function held(change: Json = {}): unknown[] {
  const sketch = {
    type: 'sketch',
    id: 'pic',
    strokes: ['shape:dot'],
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    source_hash: hash,
    ink: [held_stroke],
    ...change,
  }
  return [sketch]
}

test('a saved scene is read with the strokes the board copied, each a real pen stroke', () => {
  const reader = new JsonReader()
  const [pic] = scene_elements_read(reader, held(), 'held')
  expect(reader.problem).toBeNull()
  expect(pic).toMatchObject({ x: 0, y: 0, w: 10, h: 10, source_hash: hash, ink: [held_stroke] })
  const again = new JsonReader()
  const written = JSON.parse(JSON.stringify(scene_elements_write([pic!], 'with_ink')))
  expect(scene_elements_read(again, written, 'held')).toEqual([pic!])
  expect(again.problem).toBeNull()
  expect(scene_elements_write([pic!], 'without_ink')[0]).not.toHaveProperty('ink')

  for (const [change, path] of [
    [{ ink: undefined }, 'elements[0].ink'],
    [{ ink: [] }, 'elements[0].ink'],
    [{ ink: [{ ...held_stroke, type: 'image' }] }, 'elements[0].ink[0].type'],
    [{ ink: [{ ...held_stroke, props: { url: 'http://e.example' } }] }, 'elements[0].ink[0].props'],
    [{ ink: [{ ...held_stroke, script: 1 }] }, 'elements[0].ink[0].script'],
    [{ source_hash: undefined }, 'elements[0].source_hash'],
    [{ w: undefined }, 'elements[0].w'],
    [{ x: undefined, y: undefined }, 'elements[0].x'],
  ] as const) {
    const refusing = new JsonReader()
    scene_elements_read(refusing, held(change), 'held')
    expect(refusing.problem).toMatchObject({ path })
  }
})
