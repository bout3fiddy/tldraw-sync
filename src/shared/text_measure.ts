// Conservative text measurement for composed diagrams, without a browser. The composer sizes
// boxes with it and the board checks published diagrams with it, so both agree on whether a
// label fits. Widths are estimated per character, generously, for one of tldraw's two lettering
// faces at its small size; a real browser wraps the same words onto at most as many lines. Words
// are never changed: only where lines break is estimated.

import { assert } from './assert'
import type { ProposalStyle } from './cleanup_types'
import { proposal_text_length_max } from './constants'

// tldraw's small label: 18 units high, with 1.35 line spacing and 16 units of padding inside
// a shape. Composed diagrams use this one size for every label, in either face: tldraw gives
// both faces the same font size and line spacing.
export const label_font_size_units = 18
export const label_line_height_units = label_font_size_units * 1.35
export const label_padding_units = 16

// tldraw's sans face (IBM Plex Sans) and its handwritten draw face (Shantell Sans Informal).
export const label_fonts = ['sans', 'draw'] as const
export type LabelFont = (typeof label_fonts)[number]

// Bold headings are a little wider; every estimate gets a further safety margin.
const bold_factor_sans = 1.08
const safety_factor = 1.06

// The widest bold-to-regular advance ratio among the draw face's ASCII glyphs is 1.115.
const bold_factor_draw = 1.12

// Advance widths in ems of tldraw 4.2.3's bundled Shantell Sans Informal Regular, for U+0020
// space through U+007E tilde, read from the font's own metrics and rounded up to 0.01 em.
// prettier-ignore
const draw_widths_ascii_em = [
  0.35, 0.3, 0.5, 0.99, 0.7, 0.97, 0.67, 0.28, 0.48, 0.47, 0.51, 0.7, 0.29, 0.51, 0.31, 0.41,
  0.68, 0.42, 0.7, 0.7, 0.75, 0.63, 0.7, 0.7, 0.7, 0.7, 0.31, 0.3, 0.7, 0.7, 0.7, 0.51,
  0.9, 0.76, 0.63, 0.62, 0.67, 0.67, 0.59, 0.81, 0.73, 0.6, 0.63, 0.68, 0.54, 1, 0.8, 0.68,
  0.59, 0.77, 0.73, 0.56, 0.64, 0.67, 0.69, 0.95, 0.65, 0.63, 0.65, 0.52, 0.41, 0.51, 0.61, 0.7,
  0.36, 0.67, 0.59, 0.49, 0.68, 0.62, 0.48, 0.68, 0.68, 0.32, 0.3, 0.64, 0.38, 0.93, 0.66, 0.6,
  0.61, 0.63, 0.52, 0.53, 0.5, 0.62, 0.6, 0.97, 0.57, 0.6, 0.63, 0.54, 0.32, 0.54, 0.7,
] as const
const ascii_first_code = 0x20
const ascii_last_code = 0x7e

// Beyond ASCII the draw face's letters stay within 1 em, except these few wide glyphs (fractions,
// ligatures, per mille), which reach 1.42 em. Astral characters such as emoji come from a
// fallback font and are given more room than a CJK character.
const draw_wide_characters = '¼½¾ÆŒǄǅǆǇǊǋ‰№™⅓⅔⅛⅜⅝⅞↔ﬃﬄ'
const draw_wide_em = 1.42
const draw_other_em = 1
const astral_em = 1.3
const cjk_first_code = 0x2e80

assert(
  draw_widths_ascii_em.length === ascii_last_code - ascii_first_code + 1,
  'the draw face has one width per printable ASCII character',
)
assert(
  draw_widths_ascii_em.every((width) => width > 0 && width <= draw_wide_em),
  'draw widths are positive and no wider than the widest glyph',
)

export type TextBlock = { width_units: number; height_units: number; lines_count: number }

// The face every label of a proposal is drawn in: the renderer's style decides it.
export function style_font(style: ProposalStyle): LabelFont {
  const font: LabelFont = style === 'markerboard' ? 'draw' : 'sans'
  assert(label_fonts.includes(font), 'a style draws in a known face')
  assert((style === 'plain') === (font === 'sans'), 'only the plain style keeps the sans face')
  return font
}

// The width of one character, in ems, for a medium-weight sans-serif font, rounded up.
function character_width_sans_em(character: string): number {
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

// The width of one character, in ems, for the handwritten draw face, from its measured advances.
function character_width_draw_em(character: string): number {
  assert(character.length >= 1, 'a character is not empty')
  assert(character.length <= 2, 'a character is one code point')
  const code = character.codePointAt(0) as number

  if (code >= ascii_first_code && code <= ascii_last_code) {
    return draw_widths_ascii_em[code - ascii_first_code] as number
  }

  if (code > 0xffff) return astral_em

  if (code >= cjk_first_code) return draw_other_em

  return draw_wide_characters.includes(character) ? draw_wide_em : draw_other_em
}

export function word_width_units(word: string, bold: boolean, font: LabelFont): number {
  assert(word.length <= proposal_text_length_max, 'a word is bounded')
  assert(label_fonts.includes(font), 'a face is known')
  const draw = font === 'draw'
  let width_em = 0

  for (const character of word) {
    width_em += draw ? character_width_draw_em(character) : character_width_sans_em(character)
  }

  const bold_factor = bold ? (draw ? bold_factor_draw : bold_factor_sans) : 1
  const width_units = width_em * label_font_size_units * safety_factor * bold_factor
  assert(width_units >= 0, 'a width is never negative')
  return width_units
}

// Wraps words greedily onto lines of at most `wrap_units`, as a browser does. A word wider than
// a line is broken across as many lines as it needs, as tldraw's labels break long words.
export function text_block(
  text: string,
  wrap_units: number,
  bold: boolean,
  font: LabelFont,
): TextBlock {
  assert(wrap_units > 0, 'a wrap width is positive')
  assert(text.length <= proposal_text_length_max, 'text to measure is bounded')
  const space_units = word_width_units(' ', bold, font)
  let lines_count = 0
  let width_units = 0

  for (const paragraph of text.split('\n')) {
    let line_units = 0
    lines_count += 1

    for (const word of paragraph.split(' ')) {
      const word_units = word_width_units(word, bold, font)

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
