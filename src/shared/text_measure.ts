// Conservative text measurement for composed diagrams, without a browser. The composer sizes
// boxes with it and the board checks published diagrams with it, so both agree on whether a
// label fits. Widths are estimated per character, generously, for tldraw's sans font at its
// small size; a real browser wraps the same words onto at most as many lines. Words are never
// changed: only where lines break is estimated.

import { assert } from './assert'
import { proposal_text_length_max } from './constants'

// tldraw's small label: 18 units high, with 1.35 line spacing and 16 units of padding inside
// a shape. Composed diagrams use this one size for every label.
export const label_font_size_units = 18
export const label_line_height_units = label_font_size_units * 1.35
export const label_padding_units = 16

// Bold headings are a little wider; every estimate gets a further safety margin.
const bold_factor = 1.08
const safety_factor = 1.06

export type TextBlock = { width_units: number; height_units: number; lines_count: number }

// The width of one character, in ems, for a medium-weight sans-serif font, rounded up.
function character_width_em(character: string): number {
  assert(character.length >= 1, 'a character is not empty')
  assert(character.length <= 2, 'a character is one code point')
  const code = character.codePointAt(0) as number

  if (code > 0x2e7f) return 1.0

  if (character === ' ') return 0.3

  if ('mwMW@%&'.includes(character)) return 0.95

  if ("iljI!.,:;'|`".includes(character)) return 0.34

  if ('ftr()[]{}/\\-"'.includes(character)) return 0.45

  if (/[0-9]/.test(character)) return 0.62

  if (/[A-Z]/.test(character)) return 0.74

  if (/[a-z]/.test(character)) return 0.6

  return 0.8
}

export function word_width_units(word: string, bold: boolean): number {
  assert(word.length <= proposal_text_length_max, 'a word is bounded')
  let width_em = 0

  for (const character of word) width_em += character_width_em(character)

  const width_units = width_em * label_font_size_units * safety_factor * (bold ? bold_factor : 1)
  assert(width_units >= 0, 'a width is never negative')
  return width_units
}

// Wraps words greedily onto lines of at most `wrap_units`, as a browser does. A word wider than
// a line is broken across as many lines as it needs, as tldraw's labels break long words.
export function text_block(text: string, wrap_units: number, bold: boolean): TextBlock {
  assert(wrap_units > 0, 'a wrap width is positive')
  assert(text.length <= proposal_text_length_max, 'text to measure is bounded')
  const space_units = word_width_units(' ', bold)
  let lines_count = 0
  let width_units = 0

  for (const paragraph of text.split('\n')) {
    let line_units = 0
    lines_count += 1

    for (const word of paragraph.split(' ')) {
      const word_units = word_width_units(word, bold)

      if (word_units > wrap_units) {
        const lines_extra = Math.ceil(word_units / wrap_units) - 1
        lines_count += line_units > 0 ? lines_extra + 1 : lines_extra
        width_units = wrap_units
        line_units = word_units - lines_extra * wrap_units
      } else if (line_units === 0) {
        line_units = word_units
      } else if (line_units + space_units + word_units <= wrap_units) {
        line_units += space_units + word_units
      } else {
        lines_count += 1
        line_units = word_units
      }

      width_units = Math.max(width_units, line_units)
    }
  }

  assert(lines_count >= 1, 'text takes at least one line')
  assert(width_units <= wrap_units, 'wrapped text is no wider than its lines')
  return { width_units, height_units: lines_count * label_line_height_units, lines_count }
}
