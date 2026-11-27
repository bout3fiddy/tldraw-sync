// One shape of the agent's print as the board shows it: tldraw's own SVG export of the shape,
// repainted in the print's violet, with nothing in it that could act. The records it was drawn
// from are untouched; only this picture of them changes.

import { assert } from '../shared/assert'
import { print_paint, rgba_format, rgba_parse, type PaintRole, type Rgba } from './print_colour'

export type PrintBox = { x: number; y: number; w: number; h: number }

// Elements in one exported shape: a guard against a picture too large to repaint.
const print_svg_elements_max = 20_000

const paint_attributes: ReadonlyArray<[string, PaintRole]> = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['stop-color', 'fill'],
  ['color', 'stroke'],
]

const paint_styles: ReadonlyArray<[string, PaintRole]> = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['color', 'stroke'],
  ['background-color', 'fill'],
  ['border-color', 'stroke'],
  ['-webkit-text-stroke-color', 'stroke'],
  ['text-decoration-color', 'stroke'],
]

// A level or upright straight line, such as an arrow between two shapes side by side, is
// exported with no height or no width, and a view box with a zero side draws nothing. Such a
// box is widened across the line to this many page units, centred on it. Its stroke overflows
// the box, as every shape's edge stroke does.
export const print_box_extent_min = 1

// A box with no side below the minimum, about the same centre. Null for an invalid box.
export function print_box_widen(box: PrintBox): PrintBox | null {
  if (!Object.values(box).every(Number.isFinite) || box.w < 0 || box.h < 0) return null

  const w = Math.max(box.w, print_box_extent_min)
  const h = Math.max(box.h, print_box_extent_min)
  const widened = { x: box.x - (w - box.w) / 2, y: box.y - (h - box.h) / 2, w, h }
  assert(widened.w > 0 && widened.h > 0, 'a widened box has area')
  assert(widened.x <= box.x && widened.y <= box.y, 'a widened box holds the box')
  return widened
}

// The page box an export covers, read from its view box, which is widened in place where a
// straight line left it flat. Null for a picture without a valid view box.
export function print_svg_box(svg: SVGSVGElement): PrintBox | null {
  const view = svg.viewBox.baseVal

  if (view === null || !svg.hasAttribute('viewBox')) return null

  const box = print_box_widen({ x: view.x, y: view.y, w: view.width, h: view.height })

  if (box === null) return null

  if (box.w !== view.width || box.h !== view.height) {
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`)
  }

  return box
}

// Repaints and defuses an export in place, then returns it as markup.
export function print_svg_markup(svg: SVGSVGElement): string | null {
  const elements = [svg, ...svg.querySelectorAll('*')]

  if (elements.length > print_svg_elements_max) return null

  for (const element of elements) {
    element_defuse(element)
    element_paint(element)
    element_rename(element)
  }

  for (const style of svg.querySelectorAll('style')) {

    // The page already has tldraw's fonts. Embedded copies would only weigh down the page.
    style.textContent = (style.textContent ?? '').replace(/@font-face\s*\{[^}]*\}/g, '')
  }

  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const markup = new XMLSerializer().serializeToString(svg)
  assert(markup.startsWith('<svg'), 'an export serialises as SVG')
  return markup
}

// Nothing in the print acts: no scripts, no handlers, no links out of the picture.
function element_defuse(element: Element): void {
  const name = element.localName

  if (name === 'script' || name === 'iframe' || name === 'object' || name === 'embed') {
    element.remove()
    return
  }

  for (const attribute of [...element.attributes]) {
    const key = attribute.name.toLowerCase()
    const internal = attribute.value.trim().startsWith('#')

    if (key.startsWith('on')) element.removeAttribute(attribute.name)

    if ((key === 'href' || key === 'xlink:href' || key === 'src') && !internal) {
      element.removeAttribute(attribute.name)
    }
  }
}

// tldraw's class names stay tldraw's: a picture of the print is never taken for one of the
// canvas's own shapes, by its styles or by anything that looks for them. The picture's own
// styles are already inlined by the export.
function element_rename(element: Element): void {
  const classes = element.getAttribute('class')

  if (classes === null) return

  const renamed = classes
    .split(/\s+/)
    .filter((name) => name !== '')
    .map((name) => (name.startsWith('tl-') ? `print-${name}` : name))
  element.setAttribute('class', renamed.join(' '))

  if (element.hasAttribute('data-shape-type')) {
    element.setAttribute('data-print-type', element.getAttribute('data-shape-type')!)
    element.removeAttribute('data-shape-type')
  }
}

function element_paint(element: Element): void {
  for (const [name, role] of paint_attributes) {
    const value = element.getAttribute(name)

    if (value === null) continue

    const painted = paint(value, role)

    if (painted !== null) element.setAttribute(name, painted)
  }

  const style = (element as HTMLElement | SVGElement).style

  if (style === undefined) return

  for (const [name, role] of paint_styles) {
    const value = style.getPropertyValue(name)

    if (value === '') continue

    const painted = paint(value, role)

    if (painted !== null) style.setProperty(name, painted, style.getPropertyPriority(name))
  }
}

// The violet for one paint value, or null to leave it as it is: patterns, variables and
// keywords keep their meaning, and their own contents are repainted where they are defined.
function paint(value: string, role: PaintRole): string | null {
  const colour = colour_read(value)

  if (colour === null) return null

  return rgba_format(print_paint(colour, role))
}

let reader: CanvasRenderingContext2D | null = null
const sentinel = '#010203'

// The browser's own colour parser: any CSS colour, read back as hex or rgba().
function colour_read(value: string): Rgba | null {
  const text = value.trim().toLowerCase()

  if (text === '' || text === 'none' || text === 'transparent' || text === 'currentcolor') {
    return null
  }

  if (/^(url|var|inherit|initial|unset|context-)/.test(text)) return null

  reader ??= document.createElement('canvas').getContext('2d')

  if (reader === null) return rgba_parse(text)

  reader.fillStyle = sentinel
  reader.fillStyle = text
  const normal = String(reader.fillStyle)

  if (normal === sentinel && text !== sentinel) return null

  return rgba_parse(normal)
}
