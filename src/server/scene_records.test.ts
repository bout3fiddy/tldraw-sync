// The native records a scene becomes: each element where the agent put it, a grouped element
// placed relative to its group, an arrow bound to what it ends on, and sketch strokes marked
// with where they came from. Then the other direction: records a canvas must never hold are
// named as a problem, whatever made them.

import { expect, test } from 'bun:test'
import { canvas_records_count_max, ink_points_count_max } from '../shared/constants'
import type { CanvasRecord } from '../shared/canvas_types'
import { JsonReader } from '../shared/json_reader'
import type { SceneElement } from '../shared/scene_types'
import { canvas_records_problem, index_key, index_key_within } from './canvas_records'
import { scene_elements_read } from './scene_proposal'
import { scene_records } from './scene_records'
import night_city from '../../tests/fixtures/scenes/night_city.scene.json'

type Json = Record<string, any>

const hash = '0123456789abcdef'

function elements(input: Json[], mode: 'named' | 'held' = 'named'): SceneElement[] {
  const reader = new JsonReader()
  const read = scene_elements_read(reader, input, mode)

  if (reader.problem !== null) throw new Error(`${reader.problem.path}: ${reader.problem.message}`)

  return read
}

function records(input: Json[], mode: 'named' | 'held' = 'named'): Json[] {
  return scene_records(elements(input, mode)) as unknown as Json[]
}

const by_id = (list: Json[], id: string) => list.find((record) => record.id === id)!

test('text and shapes are native records where the agent put them, in the order given', () => {
  const made = records([
    { type: 'text', id: 'title', x: 10, y: -80, text: 'Checkout\nflow', size: 'l', color: 'blue' },
    {
      type: 'geo',
      id: 'api',
      x: 0,
      y: 0,
      w: 160,
      h: 80,
      text: 'API',
      fill: 'semi',
      rotation: 0.25,
    },
    { type: 'text', id: 'note', x: 5, y: 200, w: 120, text: 'wraps', align: 'end', opacity: 0.5 },
  ])
  expect(made.map((record) => [record.id, record.type, record.x, record.y, record.index])).toEqual([
    ['shape:scene-title', 'text', 10, -80, 'a0'],
    ['shape:scene-api', 'geo', 0, 0, 'a1'],
    ['shape:scene-note', 'text', 5, 200, 'a2'],
  ])
  expect(made.every((record) => record.parentId === 'page:page' && !record.isLocked)).toBe(true)
  expect(by_id(made, 'shape:scene-title').props).toMatchObject({
    autoSize: true,
    color: 'blue',
    size: 'l',
    font: 'draw',
    richText: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Checkout' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'flow' }] },
      ],
    },
  })
  expect(by_id(made, 'shape:scene-api')).toMatchObject({
    rotation: 0.25,
    props: { geo: 'rectangle', w: 160, h: 80, fill: 'semi', url: '', labelColor: 'black' },
  })
  expect(by_id(made, 'shape:scene-note')).toMatchObject({
    opacity: 0.5,
    props: { autoSize: false, w: 120, textAlign: 'end' },
  })
})

test('an arrow is bound to the elements it names and free where it gives a point', () => {
  const made = records([
    { type: 'geo', id: 'a', x: 0, y: 0, w: 100, h: 60 },
    { type: 'geo', id: 'b', x: 300, y: 100, w: 100, h: 60 },
    { type: 'arrow', id: 'ab', from: 'a', to: 'b', to_anchor: [0, 0.5], text: 'calls' },
    { type: 'arrow', id: 'free', from: [10, 400], to: [210, 350], route: 'arc', bend: 40 },
    { type: 'arrow', id: 'half', from: [0, 500], to: 'a', arrowhead_start: 'dot', route: 'elbow' },
  ])
  expect(by_id(made, 'shape:scene-ab')).toMatchObject({
    type: 'arrow',
    x: 50,
    y: 30,
    props: { start: { x: 0, y: 0 }, end: { x: 300, y: 100 }, kind: 'arc', arrowheadEnd: 'arrow' },
  })
  expect(by_id(made, 'binding:scene-ab-start')).toMatchObject({
    type: 'arrow',
    fromId: 'shape:scene-ab',
    toId: 'shape:scene-a',
    props: { terminal: 'start', isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
  })
  expect(by_id(made, 'binding:scene-ab-end')).toMatchObject({
    toId: 'shape:scene-b',
    props: { terminal: 'end', isPrecise: true, normalizedAnchor: { x: 0, y: 0.5 } },
  })
  expect(by_id(made, 'shape:scene-free')).toMatchObject({
    x: 10,
    y: 400,
    props: { end: { x: 200, y: -50 }, bend: 40 },
  })
  expect(by_id(made, 'shape:scene-half').props).toMatchObject({
    kind: 'elbow',
    arrowheadStart: 'dot',
    end: { x: 50, y: -470 },
  })

  // One binding for each end that lies on an element, and none for a free end.
  expect(made.filter((record) => record.typeName === 'binding').map((record) => record.id)).toEqual(
    ['binding:scene-ab-start', 'binding:scene-ab-end', 'binding:scene-half-end'],
  )
})

// Points written compactly, as "x,y x,y".
const points = (text: string) => text.split(' ').map((pair) => pair.split(',').map(Number))
const lines_drawn = [
  { type: 'path', id: 'rule', points: points('100,50 300,50 300,90'), dash: 'dashed' },
  { type: 'path', id: 'wave', points: points('0,0 50,40 100,0'), curved: true },
  { type: 'stroke', id: 'tick', points: points('20,30 26,38 40,18'), color: 'green' },
  { type: 'stroke', id: 'blob', points: points('0,0 10,0 5,9'), closed: true, fill: 'solid' },
  { type: 'arrow', id: 'to-rule', from: 'tick', to: 'rule' },
]

test('a path keeps its points, measured from the first, straight or curved', () => {
  const made = records(lines_drawn)
  const rule = by_id(made, 'shape:scene-rule')
  expect(rule).toMatchObject({
    type: 'line',
    x: 100,
    y: 50,
    props: { spline: 'line', dash: 'dashed' },
  })
  expect(Object.values(rule.props.points)).toEqual([
    { id: 'a0', index: 'a0', x: 0, y: 0 },
    { id: 'a1', index: 'a1', x: 200, y: 0 },
    { id: 'a2', index: 'a2', x: 200, y: 40 },
  ])
  expect(by_id(made, 'shape:scene-wave').props.spline).toBe('cubic')
})

test("the agent's own strokes are freehand lines of an even weight, open or closed", () => {
  const made = records(lines_drawn)
  expect(by_id(made, 'shape:scene-tick')).toMatchObject({
    type: 'draw',
    x: 20,
    y: 30,
    props: {
      color: 'green',
      isComplete: true,
      isClosed: false,
      isPen: false,
      segments: [
        {
          type: 'free',
          points: [
            { x: 0, y: 0, z: 0.5 },
            { x: 6, y: 8, z: 0.5 },
            { x: 20, y: -12, z: 0.5 },
          ],
        },
      ],
    },
  })
  expect(by_id(made, 'shape:scene-blob').props).toMatchObject({ isClosed: true, fill: 'solid' })

  // An arrow between a stroke and a path starts from the middle of each one's points.
  expect(by_id(made, 'shape:scene-to-rule')).toMatchObject({
    x: 30,
    y: 28,
    props: { end: { x: 170, y: 42 } },
  })
})

test('a grouped element is placed relative to its group, however deep, and stays put', () => {
  const made = records([
    { type: 'group', id: 'outer' },
    { type: 'geo', id: 'frame', x: 100, y: 200, w: 300, h: 200, parent: 'outer' },
    { type: 'group', id: 'inner', parent: 'outer' },
    { type: 'text', id: 'one', x: 150, y: 260, text: 'one', parent: 'inner' },
    { type: 'text', id: 'two', x: 140, y: 300, text: 'two', parent: 'inner' },
    { type: 'arrow', id: 'link', from: 'one', to: [400, 500], parent: 'outer' },
    { type: 'text', id: 'apart', x: -50, y: -50, text: 'apart' },
  ])
  const placed = made
    .filter((record) => record.typeName === 'shape')
    .map((record) => [record.id.slice(12), record.parentId, record.x, record.y])
  expect(placed).toEqual([
    ['outer', 'page:page', 100, 200],
    ['frame', 'shape:scene-outer', 0, 0],
    ['inner', 'shape:scene-outer', 40, 60],
    ['one', 'shape:scene-inner', 10, 0],
    ['two', 'shape:scene-inner', 0, 40],
    ['link', 'shape:scene-outer', 50, 60],
    ['apart', 'page:page', -50, -50],
  ])
  expect(by_id(made, 'shape:scene-outer')).toMatchObject({ type: 'group', props: {}, rotation: 0 })

  // The page position of every element is the one the agent gave: parents added back up.
  const page_position = (record: Json): [number, number] => {
    const parent = made.find((candidate) => candidate.id === record.parentId)
    const [x, y] = parent === undefined ? [0, 0] : page_position(parent)
    return [x + record.x, y + record.y]
  }
  expect(page_position(by_id(made, 'shape:scene-two'))).toEqual([140, 300])
  expect(page_position(by_id(made, 'shape:scene-link'))).toEqual([150, 260])
})

const pen = (points: number[][], color = 'black') => ({
  color,
  fill: 'none',
  dash: 'draw',
  size: 'm',
  isComplete: true,
  isClosed: false,
  isPen: true,
  scale: 1,
  segments: [{ type: 'free', points: points.map(([x, y]) => ({ x, y, z: 0.5 })) }],
})

function held_sketch(change: Json = {}): Json {
  return {
    type: 'sketch',
    id: 'pic',
    strokes: ['shape:hill', 'shape:sun'],
    x: 500,
    y: 100,
    w: 150,
    h: 190,
    source_hash: hash,
    ink: [
      {
        type: 'draw',
        x: 5,
        y: 185,
        rotation: 0,
        opacity: 1,
        props: pen([
          [0, 0],
          [60, -40],
        ]),
      },
      {
        type: 'highlight',
        x: 105,
        y: 5,
        rotation: 0.5,
        opacity: 0.7,
        props: {
          color: 'yellow',
          size: 'l',
          isComplete: true,
          isPen: true,
          scale: 1,
          segments: [{ type: 'free', points: [{ x: 0, y: 0, z: 0.5 }] }],
        },
      },
    ],
    ...change,
  }
}

test("sketch strokes become the person's own pen strokes, each marked with its source", () => {
  const made = records(
    [
      { type: 'text', id: 'before', x: 0, y: 0, text: 'before' },
      held_sketch(),
      { type: 'text', id: 'after', x: 0, y: 50, text: 'after' },
    ],
    'held',
  )
  const strokes = made.filter((record) => record.id.startsWith('shape:scene-pic'))
  expect(strokes.map((s) => [s.id, s.type, s.x, s.y, s.rotation, s.opacity])).toEqual([
    ['shape:scene-pic.0', 'draw', 505, 285, 0, 1],
    ['shape:scene-pic.1', 'highlight', 605, 105, 0.5, 0.7],
  ])
  expect(strokes.map((stroke) => stroke.meta)).toEqual([
    { sketch_stroke: 'shape:hill', sketch_hash: hash },
    { sketch_stroke: 'shape:sun', sketch_hash: hash },
  ])
  expect(strokes[0]!.props).toEqual(
    pen([
      [0, 0],
      [60, -40],
    ]),
  )

  // Nothing else on a canvas claims to come from the sketch.
  const others = made.filter((record) => !record.id.startsWith('shape:scene-pic'))
  expect(others.every((record) => Object.keys(record.meta).length === 0)).toBe(true)

  // The strokes lie between their neighbours, in the order they were named.
  const order = made.map((record) => record.index)
  expect(order).toEqual([...order].sort())
  expect(order).toEqual(['a0', index_key_within('a1', 0), index_key_within('a1', 1), 'a2'])
})

test('sketch strokes inside a group move with it, and count as what the group holds', () => {
  const made = records([{ type: 'group', id: 'g' }, held_sketch({ parent: 'g' })], 'held')
  expect(made.map((record) => [record.id, record.parentId, record.x, record.y])).toEqual([
    ['shape:scene-g', 'page:page', 500, 100],
    ['shape:scene-pic.0', 'shape:scene-g', 5, 185],
    ['shape:scene-pic.1', 'shape:scene-g', 105, 5],
  ])
})

// The free variation the browser journey publishes, with every kind of element an agent places
// itself. It is checked here too, so a scene the journey sends is known to be one the board
// takes whole: a shape for each element, nothing left out and nothing the canvas refuses.
test('the scene the browser journey draws is a valid canvas of native shapes', () => {
  const made = records(night_city as Json[])
  expect(canvas_records_problem(made as CanvasRecord[])).toBeNull()
  const shapes = made.filter((record) => record.typeName === 'shape')
  expect(shapes).toHaveLength(night_city.length)
  expect(new Set(shapes.map((shape) => shape.type))).toEqual(
    new Set(['text', 'geo', 'draw', 'group', 'line', 'arrow']),
  )
  expect(shapes.map((shape) => shape.id)).toEqual(
    night_city.map((element) => `shape:scene-${element.id}`),
  )

  // The group holds what names it, and each arrow is bound where it names an element.
  const held = shapes.filter((shape) => shape.parentId === 'shape:scene-sky')
  expect(held.map((shape) => shape.id)).toEqual(['shape:scene-cloud', 'shape:scene-smoke'])
  const bindings = made.filter((record) => record.typeName === 'binding')
  expect(bindings.map((binding) => [binding.fromId, binding.toId])).toEqual([
    ['shape:scene-to-hall', 'shape:scene-tower'],
    ['shape:scene-to-hall', 'shape:scene-hall'],
    ['shape:scene-to-moon', 'shape:scene-moon'],
  ])
  expect(shapes.every((shape) => Object.keys(shape.meta).length === 0)).toBe(true)
})

test('index keys stay in order across the whole element limit', () => {
  const keys = Array.from({ length: 800 }, (_, index) => index_key(index))
  expect(keys).toEqual([...keys].sort())
  expect(new Set(keys).size).toBe(keys.length)
  const within = [index_key(61), index_key_within(index_key(61), 0), index_key(62)]
  expect(within).toEqual([...within].sort())
})

// A canvas read back from disk, or handed over by a migration, is only served if it is one
// this board could have made. Each row damages a valid canvas in one way.
test('records a canvas must never hold are named, whatever made them', () => {
  const valid = records([
    { type: 'geo', id: 'a', x: 0, y: 0, w: 100, h: 60, text: 'A' },
    { type: 'geo', id: 'b', x: 300, y: 0, w: 100, h: 60 },
    { type: 'arrow', id: 'ab', from: 'a', to: 'b' },
    {
      type: 'stroke',
      id: 's',
      points: [
        [0, 0],
        [5, 5],
      ],
    },
  ])
  expect(canvas_records_problem(valid as CanvasRecord[])).toBeNull()
  expect(canvas_records_problem([])).toBeNull()
  const href = 'http://e.example'
  const link = { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }
  const linked_text = { type: 'doc', content: [{ type: 'paragraph', content: [link] }] }
  const page = { id: 'page:other', typeName: 'page', name: 'x', index: 'a1', meta: {} }
  const asset = { id: 'asset:1', typeName: 'asset', type: 'image', props: {}, meta: {} }
  const end = 'binding:scene-ab-end'

  // `a` and `b` are the two shapes; `list` is the whole canvas.
  const damages: Array<[string, (a: Json, b: Json, list: Json[]) => void]> = [
    ['an image', (a) => (a.type = 'image')],
    ['an embed', (a) => Object.assign(a, { type: 'embed', props: { url: href, w: 1, h: 1 } })],
    ['a note', (a) => (a.type = 'note')],
    ['a link', (a) => (a.props.url = href)],
    ['a link in the words', (a) => (a.props.richText = linked_text)],
    ['words that are not rich text', (a) => (a.props.richText = { type: 'doc', content: [5] })],
    ['an unknown prop', (a) => (a.props.onclick = 'alert(1)')],
    ['an unknown colour', (a) => (a.props.color = 'mauve')],
    ['a page record', (_a, _b, list) => list.push(page)],
    ['an asset record', (_a, _b, list) => list.push(asset)],
    ['a repeated id', (a, _b, list) => list.push(structuredClone(a))],
    ['a repeated binding', (_a, _b, list) => list.push(structuredClone(by_id(list, end)))],
    ['a record that is not an object', (_a, _b, list) => list.push(null as never)],
    ['a parent that is not there', (_a, b) => (b.parentId = 'shape:gone')],
    ['a parent that is not a group', (_a, b) => (b.parentId = 'shape:scene-a')],
    ['another page', (_a, b) => (b.parentId = 'page:other')],
    ['a binding to nothing', (_a, _b, list) => (by_id(list, end).toId = 'shape:gone')],
    ['a binding from no arrow', (_a, _b, list) => (by_id(list, end).fromId = 'shape:scene-a')],
    ['an arrow bound to itself', (_a, _b, list) => (by_id(list, end).toId = 'shape:scene-ab')],
    [
      'more pen samples than a canvas keeps',
      (_a, _b, list) => {
        const sample = { x: 0, y: 0, z: 0.5 }
        const points = Array.from({ length: ink_points_count_max + 1 }, () => sample)
        by_id(list, 'shape:scene-s').props.segments = [{ type: 'free', points }]
      },
    ],
    [
      'more records than a canvas holds',
      (_a, b, list) => {
        for (let count = list.length; count <= canvas_records_count_max; count += 1) {
          list.push({ ...structuredClone(b), id: `shape:extra-${count}` })
        }
      },
    ],
  ]

  for (const [name, damage] of damages) {
    const list = structuredClone(valid)
    damage(list[0] as Json, list[1] as Json, list)
    const problem = canvas_records_problem(list as CanvasRecord[])
    expect(problem, name).not.toBeNull()
    expect(problem!.message, name).toMatch(/\.$/)
  }
})
