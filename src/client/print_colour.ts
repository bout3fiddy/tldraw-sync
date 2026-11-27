// The agent's print is shown in one ink, violet, which none of the person's inks use. Its
// records keep the agent's own colours: only the picture of them on this board is repainted.
// A stroke or a dark fill becomes violet, a pale fill becomes a violet wash, and paper stays
// paper, so a label keeps its ground and lettering keeps its halo.

import { assert } from '../shared/assert'

export type Rgba = { r: number; g: number; b: number; a: number }
export type PaintRole = 'stroke' | 'fill'

export const print_violet: Rgba = { r: 106, g: 79, b: 208, a: 1 }

// The design's wash for a filled shape: a tenth of the violet on paper.
export const print_wash_alpha = 0.1

// Paler than this is paper: a label's ground, a halo, the page itself.
const sheet_luminance_min = 0.92

// Paler than this, and not paper, is a fill tint, which becomes the wash.
const wash_luminance_min = 0.55

assert(wash_luminance_min < sheet_luminance_min, 'a wash is darker than paper')

// Relative brightness of a colour, from 0 for black to 1 for white.
export function luminance(colour: Rgba): number {
  assert(channel_valid(colour.r) && channel_valid(colour.g), 'channels are bytes')
  assert(channel_valid(colour.b), 'channels are bytes')
  return (0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b) / 255
}

// The paint a colour of the agent's becomes in the print. Transparent stays transparent.
export function print_paint(colour: Rgba, role: PaintRole): Rgba {
  assert(colour.a >= 0 && colour.a <= 1, 'alpha is a fraction')

  if (colour.a === 0) return colour

  const light = luminance(colour)

  if (light >= sheet_luminance_min) return colour

  if (role === 'fill' && light >= wash_luminance_min) {
    return { ...print_violet, a: print_wash_alpha * colour.a }
  }

  const painted = { ...print_violet, a: colour.a }
  assert(painted.a > 0, 'a painted colour is visible')
  return painted
}

export function rgba_format(colour: Rgba): string {
  assert(colour.a >= 0 && colour.a <= 1, 'alpha is a fraction')
  const alpha = Math.round(colour.a * 1000) / 1000
  return `rgba(${colour.r}, ${colour.g}, ${colour.b}, ${alpha})`
}

// Reads the colour forms a browser hands back once it has normalised a colour: hex in three,
// four, six or eight digits, and rgb() or rgba() with commas or spaces. Null for anything else.
export function rgba_parse(text: string): Rgba | null {
  const value = text.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)

  if (hex !== null) return hex_parse(hex[1]!)

  const functional = /^rgba?\(([^)]*)\)$/.exec(value)

  if (functional === null) return null

  const parts = functional[1]!.split(/[\s,/]+/).filter((part) => part !== '')

  if (parts.length !== 3 && parts.length !== 4) return null

  const [r, g, b] = parts.slice(0, 3).map(channel_parse)
  const a = parts.length === 4 ? alpha_parse(parts[3]!) : 1

  if (r === null || g === null || b === null || a === null) return null

  return { r: r!, g: g!, b: b!, a }
}

function hex_parse(digits: string): Rgba {
  assert(/^[0-9a-f]+$/.test(digits), 'hex digits only')
  const long = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits
  assert(long.length === 6 || long.length === 8, 'a long hex colour has six or eight digits')
  const byte = (index: number) => Number.parseInt(long.slice(index, index + 2), 16)
  const a = long.length === 8 ? byte(6) / 255 : 1
  return { r: byte(0), g: byte(2), b: byte(4), a }
}

function channel_parse(part: string): number | null {
  const value = part.endsWith('%') ? (Number(part.slice(0, -1)) * 255) / 100 : Number(part)

  if (!Number.isFinite(value)) return null

  return Math.min(255, Math.max(0, Math.round(value)))
}

function alpha_parse(part: string): number | null {
  const value = part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part)

  if (!Number.isFinite(value)) return null

  return Math.min(1, Math.max(0, value))
}

function channel_valid(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255
}
