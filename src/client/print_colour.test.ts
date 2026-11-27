// The print's one ink. Every colour an agent might use comes out violet, a violet wash or
// paper, so nothing of the agent's can pass for the person's own ink.

import { expect, test } from 'bun:test'
import {
  print_paint,
  print_violet,
  print_wash_alpha,
  rgba_format,
  rgba_parse,
} from './print_colour'

const violet = { ...print_violet, a: 1 }

test('strokes and dark fills become violet; pale fills a wash; paper stays paper', () => {
  for (const ink of ['#1d1d1d', '#4465e9', '#e03131', '#099268', '#000000']) {
    expect(print_paint(rgba_parse(ink)!, 'stroke')).toEqual(violet)
    expect(print_paint(rgba_parse(ink)!, 'fill')).toEqual(violet)
  }

  // A tldraw semi fill is a pale tint: it becomes the wash, at its own alpha.
  const tint = rgba_parse('rgba(196, 210, 250, 0.5)')!
  expect(print_paint(tint, 'fill')).toEqual({ ...print_violet, a: print_wash_alpha * 0.5 })

  // A pale stroke is still a stroke the person must not mistake for their own.
  expect(print_paint(tint, 'stroke')).toEqual({ ...violet, a: 0.5 })

  // A label's ground and the halo round lettering keep the paper.
  for (const paper of ['#ffffff', '#f9fafb', '#fcfffe']) {
    expect(print_paint(rgba_parse(paper)!, 'fill')).toEqual(rgba_parse(paper)!)
    expect(print_paint(rgba_parse(paper)!, 'stroke')).toEqual(rgba_parse(paper)!)
  }

  const clear = { r: 10, g: 10, b: 10, a: 0 }
  expect(print_paint(clear, 'stroke')).toEqual(clear)
})

test('colours read in the forms a browser normalises to, and nothing else', () => {
  expect(rgba_parse('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
  expect(rgba_parse('#6A4FD0')).toEqual({ r: 106, g: 79, b: 208, a: 1 })
  expect(rgba_parse('#6a4fd080')).toEqual({ r: 106, g: 79, b: 208, a: 128 / 255 })
  expect(rgba_parse('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
  expect(rgba_parse('rgba(1, 2, 3, 0.25)')).toEqual({ r: 1, g: 2, b: 3, a: 0.25 })
  expect(rgba_parse('rgb(106 79 208 / 10%)')).toEqual({ r: 106, g: 79, b: 208, a: 0.1 })

  for (const other of ['url(#fill)', 'var(--x)', 'none', '#12', 'rgb(1, 2)', 'rgb(a, b, c)']) {
    expect(rgba_parse(other)).toBeNull()
  }

  expect(rgba_format({ r: 106, g: 79, b: 208, a: 0.1 })).toBe('rgba(106, 79, 208, 0.1)')
})
