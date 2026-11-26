// Measuring the strokes a drawing keeps. The command line and the board both use this one
// measure, so these tests pin what it promises: the box holds every pen sample with room for
// the line, each stroke keeps its place among the others, and nothing about a stroke changes.

import { expect, test } from 'bun:test'
import { sketch_square, sketch_stroke } from '../simulation/test_sketch'
import { ink_measure, strokes_equal } from './ink'

type Json = Record<string, unknown>

function records(...shapes: unknown[]): Map<string, Json> {
  return new Map(shapes.map((shape) => [(shape as { id: string }).id, shape as Json]))
}

function measured(ids: string[], sketch: Map<string, Json>, points_count_max = 1000) {
  const result = ink_measure(ids, sketch, points_count_max)

  if ('index' in result) throw new Error(`strokes[${result.index}]: ${result.message}`)

  return result
}

test('the box holds every pen sample, with room for the width of the pen', () => {
  const sun = sketch_stroke('shape:sun', 400, 20, [[0, 0], [30, 0], [30, 30], [0, 30]], 'red')
  const hill = sketch_stroke('shape:hill', 300, 200, [[0, 0], [60, -40], [140, 0]])
  const { w, h, ink, points_count } = measured(['shape:sun', 'shape:hill'], records(sun, hill))

  // A medium pen reaches 4.5 units past its samples: 295.5 to 444.5 across, 15.5 to 204.5 down.
  expect({ w, h, points_count }).toEqual({ w: 150, h: 190, points_count: 7 })

  // Each stroke sits where it did, measured from the corner of the box at (295, 15).
  expect(ink.map((stroke) => [stroke.x, stroke.y])).toEqual([
    [105, 5],
    [5, 185],
  ])
  expect(ink[1]!.x - ink[0]!.x).toBe(300 - 400)
  expect(ink[1]!.y - ink[0]!.y).toBe(200 - 20)
})

test('a kept stroke is the stroke as drawn: its samples, colour, weight, turn and opacity', () => {
  const sun = sketch_stroke('shape:sun', 400, 20, [[0, 0], [30, 30]], 'red') as unknown as Json
  const turned = { ...sun, rotation: Math.PI / 2, opacity: 0.5 }
  const [stroke] = measured(['shape:sun'], records(turned)).ink
  expect(stroke).toMatchObject({ type: 'draw', rotation: Math.PI / 2, opacity: 0.5 })
  expect(stroke!.props).toBe(sun.props as Json)
  expect(JSON.stringify(stroke!.props)).toBe(JSON.stringify(sun.props))
})

test('a turned stroke is measured where it lies on the page', () => {
  const line = sketch_stroke('shape:line', 100, 100, [[0, 0], [50, 0]]) as unknown as Json
  const flat = measured(['shape:line'], records(line))
  expect({ w: flat.w, h: flat.h }).toEqual({ w: 60, h: 10 })

  // A quarter turn about its own origin, as tldraw turns it: now it runs down the page.
  const upright = measured(['shape:line'], records({ ...line, rotation: Math.PI / 2 }))
  expect({ w: upright.w, h: upright.h }).toEqual({ w: 10, h: 60 })
})

test('a heavier or scaled pen takes more room; a stroke without samples is still a mark', () => {
  const dot = sketch_stroke('shape:dot', 10, 10, [[0, 0]]) as unknown as Json
  const props = dot.props as Json
  expect(measured(['shape:dot'], records(dot)).w).toBe(10)
  expect(measured(['shape:dot'], records({ ...dot, props: { ...props, size: 'xl' } })).w).toBe(22)
  expect(measured(['shape:dot'], records({ ...dot, props: { ...props, scale: 2 } })).w).toBe(18)

  const bare = { ...dot, props: { ...props, segments: [] } }
  expect(measured(['shape:dot'], records(bare))).toMatchObject({ w: 10, h: 10, points_count: 0 })
})

test('only a pen stroke lying on the page can be kept, and each refusal names the stroke', () => {
  const stroke = sketch_stroke('shape:s', 0, 0, [[0, 0], [10, 10]]) as unknown as Json
  const sketch = records(
    stroke,
    sketch_square('shape:box', 0),
    { ...stroke, id: 'shape:nested', parentId: 'shape:frame' },
    { ...stroke, id: 'shape:bare', props: null },
  )
  const refused = (id: string) => ink_measure(['shape:s', id], sketch, 1000)
  const saying = (words: string) => ({ index: 1, message: expect.stringContaining(words) })
  expect(refused('shape:gone')).toEqual(saying('not on the sketch'))
  expect(refused('shape:box')).toEqual(saying('Only pen and highlighter'))
  expect(refused('shape:nested')).toEqual(saying('inside another shape'))
  expect(refused('shape:bare')).toEqual(saying('no pen samples'))
})

test('reading stops at the limit on pen samples', () => {
  const long = sketch_stroke(
    'shape:long',
    0,
    0,
    Array.from({ length: 11 }, (_, index) => [index, 0] as const),
  )
  const sketch = records(long)
  expect(measured(['shape:long'], sketch, 11).points_count).toBe(11)
  expect(ink_measure(['shape:long'], sketch, 10)).toEqual({
    index: 0,
    message: expect.stringContaining('more pen samples'),
  })
})

test('stroke lists are equal only with the same ids in the same order', () => {
  expect(strokes_equal(['shape:a', 'shape:b'], ['shape:a', 'shape:b'])).toBe(true)
  expect(strokes_equal(['shape:a', 'shape:b'], ['shape:b', 'shape:a'])).toBe(false)
  expect(strokes_equal(['shape:a'], ['shape:a', 'shape:b'])).toBe(false)
  expect(strokes_equal([], [])).toBe(true)
})
