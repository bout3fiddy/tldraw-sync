// The box a print picture is placed in. A straight line drawn level or upright exports with a
// flat view box, which draws nothing: the arrow between two shapes side by side and a level
// ground line went missing from the print until the box was widened across them.

import { expect, test } from 'bun:test'
import { print_box_extent_min, print_box_widen } from './print_svg'

test('a box with area is placed as exported', () => {
  const box = { x: -12.5, y: 40, w: 260, h: 120 }
  expect(print_box_widen(box)).toEqual(box)
})

test('a level or upright line, or a point, is widened across itself about its centre', () => {
  const half = print_box_extent_min / 2

  // The arrow from a box to an ellipse beside it, centre to centre, and the night city's ground.
  expect(print_box_widen({ x: 200, y: 50, w: 160, h: 0 })).toEqual({
    x: 200,
    y: 50 - half,
    w: 160,
    h: print_box_extent_min,
  })
  expect(print_box_widen({ x: -60, y: 260, w: 640, h: 0 })!.h).toBe(print_box_extent_min)
  expect(print_box_widen({ x: 30, y: -5, w: 0, h: 90 })).toEqual({
    x: 30 - half,
    y: -5,
    w: print_box_extent_min,
    h: 90,
  })
  expect(print_box_widen({ x: 7, y: 9, w: 0, h: 0 })).toEqual({
    x: 7 - half,
    y: 9 - half,
    w: print_box_extent_min,
    h: print_box_extent_min,
  })
})

test('a box that is negative or not finite is refused', () => {
  for (const box of [
    { x: 0, y: 0, w: -1, h: 10 },
    { x: 0, y: 0, w: 10, h: -1 },
    { x: Number.NaN, y: 0, w: 10, h: 10 },
    { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 },
  ]) {
    expect(print_box_widen(box)).toBeNull()
  }
})
