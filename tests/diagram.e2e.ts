// The semantic diagram journey in a real browser against the real board: draw, snapshot as an
// agent would, publish the synthetic nested-groups fixture as a semantic diagram (the command
// line composes it), then measure the native tldraw shapes the Cleaned canvas actually renders.
//
// Meaning is checked first: every label, group and connector of the fixture is on the canvas.
// Then geometry, from real browser bounds: labels inside their shapes, items inside their groups
// below the heading, no overlapping items, connectors that do not run through items they do not
// join, everything inside the pane, and text large enough to read. Then the look, from the
// screen's own pixels: thin black ink on white, with no coloured pixel, white interiors, one fine
// outline per box and oval, open V heads and a white break for each connector label. Then a
// refused publish, a restart and restores, with a historical coloured revision as the negative
// control for the colour check. None of this measures whether an agent read a sketch correctly.
//
// Run: bun run build && npx playwright test   (Bun and a Playwright Chromium on the host)

import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { child_stop, contexts_close } from './board_child'

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli_entry = path.join(repo_root, 'src', 'cli', 'main.ts')
const fixture_path = path.join(repo_root, 'tests', 'fixtures', 'nested_groups.diagram.json')
const bun = process.env.BUN ?? 'bun'
const data_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-diagram-e2e-'))
const out_directory = path.join(data_directory, 'cleanup')
const ready_wait_ms = 20_000

type Fixture = {
  nodes: Array<{ id: string; kind: string; label: string; parent?: string }>
  edges: Array<{ id: string; from: string; to: string; label?: string; direction?: string }>
}
const fixture = JSON.parse(fs.readFileSync(fixture_path, 'utf8')) as Fixture

// Standalone text, ovals with long labels and an empty group, whose label fit is measured
// against the actual oval and text geometry rather than the shapes' bounding boxes.
const ovals_path = path.join(repo_root, 'tests', 'fixtures', 'text_and_ovals.diagram.json')
const fixture_ovals = JSON.parse(fs.readFileSync(ovals_path, 'utf8')) as Fixture

let port = 0
let server: ChildProcess | null = null

type CliResult = { exit_code: number; json: Record<string, unknown> }

function cli(...args: string[]): CliResult {
  const result = spawnSync(bun, [cli_entry, ...args, '--json'], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const json = JSON.parse(result.stdout) as Record<string, unknown>
  return { exit_code: result.status ?? -1, json }
}

async function port_free_pick(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      listener.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function server_start(): Promise<void> {
  server = spawn(bun, [cli_entry, 'serve', '--port', String(port)], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    stdio: 'ignore',
  })
  const deadline_ms = Date.now() + ready_wait_ms

  while (Date.now() < deadline_ms) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`)

      if (response.ok) return
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('the board did not start')
}

// Bounded: SIGTERM, then SIGKILL, and timed so a slow teardown shows where it was slow.
async function server_stop(): Promise<void> {
  const child = server
  server = null

  if (child === null) return

  const stop = await child_stop(child)
  console.log(`board stop: ${stop.outcome} after ${stop.elapsed_ms}ms`)
}

async function status(): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`)
  return (await response.json()) as Record<string, unknown>
}

async function stroke(page: Page): Promise<void> {
  const box = await page.locator('section[aria-label="Sketch"]').boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width * 0.4
  const y = box!.y + box!.height * 0.5
  await page.mouse.move(x, y)
  await page.mouse.down()

  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(x + step * 8, y + Math.sin(step) * 20, { steps: 2 })
  }

  await page.mouse.up()
}

function diagram_write(
  snapshot: string,
  base_revision: number,
  extra: object = {},
  source: Fixture = fixture,
): string {
  const file = path.join(out_directory, 'diagram.json')
  fs.mkdirSync(out_directory, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...source, snapshot, base_revision, ...extra }))
  return file
}

test.beforeAll(async () => {
  port = await port_free_pick()
  await server_start()
})

// Timed, so a slow teardown is placed: the board's stop is logged by `server_stop`, the data
// directory's removal here.
test.afterAll(async () => {
  try {
    await server_stop()
  } finally {
    const started_ms = Date.now()
    fs.rmSync(data_directory, { recursive: true, force: true })
    console.log(`data directory removed after ${Date.now() - started_ms}ms`)
  }
})

type Rect = { x: number; y: number; w: number; h: number }
type Measured = {
  pane: Rect
  shapes: Record<
    string,
    {
      type: string
      rect: Rect
      text: string
      text_rect: Rect | null
      line_rects: Rect[]
      line_height_px_min: number | null
      points: Array<{ x: number; y: number }>

      // What the browser actually drew: the label's face and ink, the colours of the shape's
      // paths, their geometry, and the shape's stacking depth.
      font_family: string | null
      text_color: string | null
      fills: string[]
      strokes: string[]
      paths_d: string
      z: number

      // The shape's scale on screen: CSS pixels per page unit, from its own drawing.
      unit_px: number
    }
  >

  // Any other drawn shape, such as decoration or a leak from somewhere else.
  others: string[]

  // The pane's details bar, which sits over the canvas and is not part of the drawing.
  bar: Rect | null

  // Whether tldraw's handwritten face really loaded, rather than a fallback standing in.
  draw_font_loaded: boolean
}

type Shape = Measured['shapes'][string]

// The drawn lines of words in an element, one rect per line, from the glyph boxes of its words
// alone. Whitespace is left out: under tldraw's `white-space: pre-wrap` the space at each soft
// wrap hangs past the end of its line, and Chromium reports it as a rect of its own that may
// reach beyond the wrap width, though nothing is painted there. Self-contained, as it runs in
// the page from its source text.
function word_lines(content: Element): Rect[] {
  const words: DOMRect[] = []
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue ?? ''
    const pattern = /\S+/g

    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
      const range = document.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const rects = Array.from(range.getClientRects())
      words.push(...rects.filter((rect) => rect.width > 0 && rect.height > 0))
    }
  }

  words.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: Rect[] = []

  // A word whose middle lies within the previous line's height is on that line.
  for (const word of words) {
    const line = lines[lines.length - 1]
    const middle = word.top + word.height / 2

    if (line === undefined || middle <= line.y || middle >= line.y + line.h) {
      lines.push({ x: word.left, y: word.top, w: word.width, h: word.height })
      continue
    }

    const right = Math.max(line.x + line.w, word.right)
    const bottom = Math.max(line.y + line.h, word.bottom)
    line.x = Math.min(line.x, word.left)
    line.y = Math.min(line.y, word.top)
    line.w = right - line.x
    line.h = bottom - line.y
  }

  return lines
}

// Rebuilds `word_lines` inside the page from its source, which Playwright has already compiled.
const word_lines_source = word_lines.toString()

// Real browser bounds of every cleaned shape, its label's text, and sampled connector paths.
async function cleaned_measure(page: Page): Promise<Measured> {
  return await page.evaluate(async (lines_source) => {
    await document.fonts.ready
    const lines_of = new Function(`return (${lines_source})`)() as typeof word_lines
    const to_rect = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height })
    const pane = document.querySelector('section[aria-label="Cleaned"]') as HTMLElement
    const shapes: Measured['shapes'] = {}
    const others: string[] = []
    const selector = '.tl-shape[data-shape-id]:not(.tl-shape-background)'
    const paths_of = (element: Element) =>
      Array.from(element.querySelectorAll('path')).filter(
        (path) => path.closest('defs, clipPath, mask') === null,
      )

    // Computed, so colours set on an enclosing group, as tldraw does for arrows, count. sRGB
    // colours read back as rgb() and are compared as hex; anything else is kept as written.
    const hex = (colour: string) => {
      const parts = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(colour)

      if (parts === null) return colour

      return `#${parts
        .slice(1)
        .map((part) => Number(part).toString(16).padStart(2, '0'))
        .join('')}`
    }
    const colours = (element: Element, name: 'fill' | 'stroke') =>
      paths_of(element)
        .map((path) => hex(getComputedStyle(path)[name]))
        .filter((colour) => colour !== '' && colour !== 'none' && !colour.startsWith('url('))

    for (const element of Array.from(pane.querySelectorAll<HTMLElement>(selector))) {
      const shape_id = element.dataset.shapeId ?? ''
      const z = Number(getComputedStyle(element).zIndex)
      const paths_d = paths_of(element)
        .map((path) => path.getAttribute('d') ?? '')
        .join('|')

      if (!shape_id.startsWith('shape:cleaned-')) {
        others.push(shape_id)
        continue
      }

      const id = shape_id.replace('shape:cleaned-', '')
      const content = element.querySelector('.tl-text-content')
      const text = content?.textContent ?? ''
      let text_rect: Rect | null = null
      let line_rects: Rect[] = []
      let line_height_px_min: number | null = null

      // The drawn words only, one rect per line. Selecting the whole content would also count
      // its paragraph and wrapper element boxes, which are layout, not words.
      if (content !== null && text.length > 0) {
        line_rects = lines_of(content)
        const left = Math.min(...line_rects.map((rect) => rect.x))
        const top = Math.min(...line_rects.map((rect) => rect.y))
        const right = Math.max(...line_rects.map((rect) => rect.x + rect.w))
        const bottom = Math.max(...line_rects.map((rect) => rect.y + rect.h))
        const found = line_rects.length > 0
        text_rect = found ? { x: left, y: top, w: right - left, h: bottom - top } : null
        line_height_px_min = found ? Math.min(...line_rects.map((rect) => rect.h)) : null
      }

      const points: Array<{ x: number; y: number }> = []

      if (element.dataset.shapeType === 'arrow') {
        for (const path of Array.from(element.querySelectorAll('path'))) {
          if (path.closest('defs, clipPath, mask') !== null) continue

          const matrix = path.getScreenCTM()
          const length = path.getTotalLength()

          if (matrix === null || !(length > 0)) continue

          for (let index = 0; index <= 48; index += 1) {
            const point = path.getPointAtLength((length * index) / 48)
            points.push({
              x: matrix.a * point.x + matrix.c * point.y + matrix.e,
              y: matrix.b * point.x + matrix.d * point.y + matrix.f,
            })
          }
        }
      }

      // An SVG shape's scale is its first path's; an HTML shape, such as text, has no path,
      // and its scale is its drawn width over its laid-out width in page units.
      const svg_unit_px = (paths_of(element)[0] as SVGPathElement | undefined)?.getScreenCTM()?.a
      const html_unit_px =
        element.offsetWidth > 0 ? element.getBoundingClientRect().width / element.offsetWidth : 1
      const style = content === null ? null : getComputedStyle(content)
      shapes[id] = {
        type: element.dataset.shapeType ?? '',
        rect: to_rect(element.getBoundingClientRect()),
        text,
        text_rect,
        line_rects,
        line_height_px_min,
        points,
        font_family: style === null ? null : style.fontFamily,
        text_color: style === null ? null : style.color,
        fills: colours(element, 'fill'),
        strokes: colours(element, 'stroke'),
        paths_d,
        z,
        unit_px: svg_unit_px ?? html_unit_px,
      }
    }

    const bar = pane.querySelector('.caption')
    const draw_font_loaded = Array.from(document.fonts).some(
      (face) => face.family.replace(/["']/g, '') === 'tldraw_draw' && face.status === 'loaded',
    )
    return {
      pane: to_rect(pane.getBoundingClientRect()),
      shapes,
      others,
      bar: bar === null ? null : to_rect(bar.getBoundingClientRect()),
      draw_font_loaded,
    }
  }, word_lines_source)
}

// The canvas refits with a short animation when its pane changes size: wait until two
// measurements a moment apart agree.
async function cleaned_measure_stable(page: Page): Promise<Measured> {
  let previous = ''

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const measured = await cleaned_measure(page)
    const key = JSON.stringify(Object.values(measured.shapes).map((shape) => shape.rect))

    if (key === previous && Object.keys(measured.shapes).length > 0) return measured

    previous = key
    await page.waitForTimeout(250)
  }

  throw new Error('the cleaned canvas did not settle')
}

const tolerance_px = 1.5

function inside(inner: Rect, outer: Rect, margin_px = 0): boolean {
  return (
    inner.x >= outer.x + margin_px - tolerance_px &&
    inner.y >= outer.y + margin_px - tolerance_px &&
    inner.x + inner.w <= outer.x + outer.w - margin_px + tolerance_px &&
    inner.y + inner.h <= outer.y + outer.h - margin_px + tolerance_px
  )
}

// A rect as a short, readable failure detail, in CSS pixels.
function rect_text(rect: Rect): string {
  const [x, y, w, h] = [rect.x, rect.y, rect.w, rect.h].map((value) => value.toFixed(1))
  return `${w}x${h}@${x},${y}`
}

// Everything needed to tell a layout bug from a measuring artifact when a label overflows: by
// how much on which side, every drawn line, the face, the scale and the width in page units.
function overflow_text(shape: Shape): string {
  const words = shape.text_rect as Rect
  const { rect } = shape
  const sides = {
    left: rect.x - words.x,
    top: rect.y - words.y,
    right: words.x + words.w - (rect.x + rect.w),
    bottom: words.y + words.h - (rect.y + rect.h),
  }
  const over = Object.entries(sides)
    .filter(([, px]) => px > tolerance_px)
    .map(([side, px]) => `${side} ${px.toFixed(1)}px`)
  return (
    `${over.join(' ')}; words ${rect_text(words)} in ${rect_text(rect)} ` +
    `(${(rect.w / shape.unit_px).toFixed(1)} units at ${shape.unit_px.toFixed(3)}px) ` +
    `over ${shape.line_rects.length} lines [${shape.line_rects.map(rect_text).join(' ')}] ` +
    `in ${shape.font_family}`
  )
}

function overlap(a: Rect, b: Rect, inset_px: number): boolean {
  return (
    a.x + a.w > b.x + inset_px &&
    b.x + b.w - inset_px > a.x &&
    a.y + a.h > b.y + inset_px &&
    b.y + b.h - inset_px > a.y
  )
}

function ancestors(id: string, source: Fixture): Set<string> {
  const found = new Set<string>()
  let parent = source.nodes.find((node) => node.id === id)?.parent

  while (parent !== undefined) {
    found.add(parent)
    parent = source.nodes.find((node) => node.id === parent)?.parent
  }

  return found
}

// Every corner of every drawn line of an oval's label lies inside the drawn ellipse.
function oval_overflow(shape: Measured['shapes'][string]): boolean {
  const a = shape.rect.w / 2
  const b = shape.rect.h / 2
  const cx = shape.rect.x + a
  const cy = shape.rect.y + b

  return shape.line_rects.some((line) =>
    [line.x, line.x + line.w].some((x) =>
      [line.y, line.y + line.h].some(
        (y) => ((x - cx) / (a + tolerance_px)) ** 2 + ((y - cy) / (b + tolerance_px)) ** 2 > 1,
      ),
    ),
  )
}

// Meaning first, then geometry, all from what the browser drew.
function diagram_check(
  measured: Measured,
  line_height_px_min: number,
  source: Fixture = fixture,
): string[] {
  const problems: string[] = []
  const { shapes } = measured
  const leaves = source.nodes.filter((node) => node.kind !== 'group')

  for (const node of source.nodes) {
    const shape = shapes[node.id]

    if (shape === undefined) {
      problems.push(`${node.id}: not drawn`)
      continue
    }

    if (shape.text !== node.label) problems.push(`${node.id}: shows "${shape.text}"`)

    if (shape.text_rect !== null && !inside(shape.text_rect, shape.rect)) {
      problems.push(`${node.id}: label overflows its shape, ${overflow_text(shape)}`)
    }

    if (node.kind === 'ellipse' && oval_overflow(shape)) {
      problems.push(`${node.id}: label reaches past its oval ${rect_text(shape.rect)}`)
    }

    if (node.kind === 'text' && (shape.type !== 'text' || shape.line_rects.length === 0)) {
      problems.push(`${node.id}: standalone text not drawn as text`)
    }

    if ((shape.line_height_px_min ?? Infinity) < line_height_px_min) {
      problems.push(`${node.id}: text lines ${shape.line_height_px_min}px high`)
    }

    if (!inside(shape.rect, measured.pane)) problems.push(`${node.id}: outside the pane`)

    const parent = node.parent === undefined ? undefined : shapes[node.parent]

    if (parent !== undefined) {
      if (!inside(shape.rect, parent.rect, 4)) problems.push(`${node.id}: outside its group`)

      const heading = parent.text_rect

      if (heading !== null && heading.y + heading.h > shape.rect.y + tolerance_px) {
        problems.push(`${node.id}: under its group's heading`)
      }
    }
  }

  for (const [index, a] of leaves.entries()) {
    for (const b of leaves.slice(index + 1)) {
      const [ra, rb] = [shapes[a.id]?.rect, shapes[b.id]?.rect]

      if (ra !== undefined && rb !== undefined && overlap(ra, rb, 0)) {
        problems.push(`${a.id} overlaps ${b.id}`)
      }
    }
  }

  return [...problems, ...connectors_check(measured, source)]
}

function connectors_check(measured: Measured, source: Fixture): string[] {
  const problems: string[] = []

  for (const edge of source.edges) {
    const arrow = measured.shapes[edge.id]

    if (arrow === undefined || arrow.points.length === 0) {
      problems.push(`${edge.id}: no connector drawn`)
      continue
    }

    if (arrow.text !== (edge.label ?? '')) problems.push(`${edge.id}: labelled "${arrow.text}"`)

    const holders = new Set([...ancestors(edge.from, source), ...ancestors(edge.to, source)])
    const unrelated = source.nodes.filter(
      (node) => node.id !== edge.from && node.id !== edge.to && !holders.has(node.id),
    )

    for (const node of unrelated) {
      const rect = measured.shapes[node.id]?.rect

      if (rect === undefined) continue

      const crossing = arrow.points.find(
        (point) =>
          point.x > rect.x + 2 &&
          point.x < rect.x + rect.w - 2 &&
          point.y > rect.y + 2 &&
          point.y < rect.y + rect.h - 2,
      )

      if (crossing !== undefined) problems.push(`${edge.id}: runs through ${node.id}`)

      if (arrow.text_rect !== null && overlap(arrow.text_rect, rect, 2)) {
        problems.push(`${edge.id}: its label covers ${node.id}`)
      }
    }
  }

  return problems
}

// tldraw 4.2.3's light theme, as the browser builds it: black ink (#1d1d1d) for every outline,
// connector and word, and its white surface (#fcfffe) inside boxes and ovals, on the pane's
// white board. Nothing else may be painted.
const ink_rgb = 'rgb(29, 29, 29)'
const ink = '#1d1d1d'
const white_fill = '#fcfffe'
const heads_by_direction: Record<string, number> = { forward: 1, both: 2, none: 0 }

// An open V arrowhead as tldraw draws it: one stroke from wing to tip to wing, never closed.
const open_head = /^M[^MLCQAZz]+L[^MLCQAZz]+L[^MLCQAZz]+$/

// The markerboard as the browser built it: the handwritten face really loaded and used for every
// label, black words, black outlines and connectors, white or open interiors, open V heads in
// the diagram's directions, and no shape that is not a diagram item.
function markerboard_check(measured: Measured, arrows: Arrows, source: Fixture): string[] {
  const problems: string[] = []

  if (!measured.draw_font_loaded) problems.push('the handwritten face did not load')

  if (measured.others.length > 0) problems.push(`unexpected shapes: ${measured.others}`)

  for (const item of [...source.nodes, ...source.edges]) {
    const shape = measured.shapes[item.id]
    const label = item.label ?? ''
    const kind = 'kind' in item ? item.kind : 'edge'

    if (shape === undefined) continue

    if (label !== '' && !(shape.font_family ?? '').includes('tldraw_draw')) {
      problems.push(`${item.id}: drawn in ${shape.font_family}`)
    }

    if (label !== '' && shape.text_color !== ink_rgb) {
      problems.push(`${item.id}: words in ${shape.text_color}`)
    }

    const stray = [...shape.fills, ...shape.strokes].filter((c) => c !== ink && c !== white_fill)

    if (stray.length > 0) problems.push(`${item.id}: painted ${stray}`)

    if (kind !== 'text' && !shape.strokes.includes(ink)) problems.push(`${item.id}: no ink line`)

    const white = kind === 'box' || kind === 'ellipse'

    if (white && !shape.fills.includes(white_fill)) problems.push(`${item.id}: not white inside`)

    if (!white && shape.fills.length > 0) problems.push(`${item.id}: filled ${shape.fills}`)
  }

  return [...problems, ...heads_check(arrows, source)]
}

// Every connector has the heads its direction asks for, each an open V.
function heads_check(arrows: Arrows, source: Fixture): string[] {
  const problems: string[] = []

  for (const edge of source.edges) {
    const heads = arrows[edge.id]?.heads ?? []
    const expected = heads_by_direction[edge.direction ?? 'forward']

    if (heads.length !== expected) problems.push(`${edge.id}: ${heads.length} heads`)

    for (const head of heads) {
      if (!open_head.test(head.replace(/\s+/g, ''))) problems.push(`${edge.id}: head ${head}`)
    }
  }

  return problems
}

// What each connector drew beyond its shape record: its heads, which are the paths outside its
// clipped body, and for a labelled connector its body sampled densely along its length and the
// label box tldraw cut out of the body, on screen.
type Arrow = {
  heads: string[]
  body_points: Array<{ x: number; y: number }>
  label_box: Rect | null
}
type Arrows = Record<string, Arrow>

async function arrows_measure(page: Page): Promise<Arrows> {
  return await page.evaluate(() => {
    const pane = document.querySelector('section[aria-label="Cleaned"]') as HTMLElement
    const selector = '.tl-shape[data-shape-type="arrow"]:not(.tl-shape-background)'
    const clipped = (path: Element) => path.closest('g[style*="clip-path"]') !== null
    const arrows: Record<string, Arrow> = {}

    for (const element of Array.from(pane.querySelectorAll<HTMLElement>(selector))) {
      const paths = Array.from(element.querySelectorAll('path')).filter(
        (path) => path.closest('defs, clipPath, mask') === null,
      )
      const labelled = (element.querySelector('.tl-text-content')?.textContent ?? '') !== ''
      const body_points: Array<{ x: number; y: number }> = []
      let label_box: Rect | null = null

      // tldraw's clip path is the arrow's bounds, then the label's rounded box as the second
      // subpath, in the body's own coordinates. Its arcs are written as cubics whose control
      // points stay within the box, so the box is the bounds of that subpath's points.
      const clip_d = element.querySelector('clipPath path')?.getAttribute('d') ?? ''
      const label_start = clip_d.indexOf('M', 1)
      const label_end = clip_d.indexOf('M', label_start + 1)
      const body_matrix = paths.find(clipped)?.getScreenCTM() ?? null

      if (labelled && label_start > 0 && body_matrix !== null) {
        const subpath = clip_d.slice(label_start, label_end > 0 ? label_end : undefined)
        const numbers = (subpath.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []).map(Number)
        const xs = numbers.filter((_, index) => index % 2 === 0)
        const ys = numbers.filter((_, index) => index % 2 === 1)
        const corners = [
          [Math.min(...xs), Math.min(...ys)],
          [Math.max(...xs), Math.max(...ys)],
        ].map(([x, y]) => ({
          x: body_matrix.a * (x as number) + body_matrix.c * (y as number) + body_matrix.e,
          y: body_matrix.b * (x as number) + body_matrix.d * (y as number) + body_matrix.f,
        }))
        const [a, b] = corners as [{ x: number; y: number }, { x: number; y: number }]
        const left = Math.min(a.x, b.x)
        const top = Math.min(a.y, b.y)
        const found = numbers.length >= 8 && numbers.length % 2 === 0
        label_box = found
          ? { x: left, y: top, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
          : null
      }

      for (const path of labelled ? paths.filter(clipped) : []) {
        const matrix = path.getScreenCTM()
        const length = path.getTotalLength()

        if (matrix === null || !(length > 0)) continue

        // Four samples per screen pixel, so a band narrower than a pixel is still reached.
        const count = Math.min(16_000, Math.ceil(length * matrix.a * 4))

        for (let index = 0; index <= count; index += 1) {
          const point = path.getPointAtLength((length * index) / count)
          body_points.push({
            x: matrix.a * point.x + matrix.c * point.y + matrix.e,
            y: matrix.b * point.x + matrix.d * point.y + matrix.f,
          })
        }
      }

      const heads = paths.filter((path) => !clipped(path)).map((p) => p.getAttribute('d') ?? '')
      const id = (element.dataset.shapeId ?? '').replace('shape:cleaned-', '')
      arrows[id] = { heads, body_points, label_box }
    }

    return arrows
  })
}

// The pane as the screen shows it, pixel for pixel: a screenshot decoded to RGBA by the
// browser's own image decoder, so no image library is needed. The details bar is left out.
type Pixels = { width: number; height: number; data: Buffer; bar: Rect | null }
type Pixel = { r: number; g: number; b: number; light: number; chroma: number }

async function pixels_read(page: Page, measured: Measured): Promise<Pixels> {
  await page.mouse.move(0, 0)
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' })
  return { ...(await png_decode(page, png)), bar: measured.bar }
}

async function png_decode(page: Page, png: Buffer) {
  expect(png.length).toBeGreaterThan(0)
  const decoded = await page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context?.drawImage(image, 0, 0)
    const data = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? []
    let binary = ''

    for (let start = 0; start < data.length; start += 0x4000) {
      binary += String.fromCharCode(...data.slice(start, start + 0x4000))
    }

    return { width: canvas.width, height: canvas.height, rgba: btoa(binary) }
  }, png.toString('base64'))
  const data = Buffer.from(decoded.rgba, 'base64')
  expect(data.length).toBe(decoded.width * decoded.height * 4)
  return { width: decoded.width, height: decoded.height, data }
}

// How far round the details bar a pixel is left out, before the shared tolerance.
const bar_clear_px = 4

// Light is a pixel's luminance from 0 to 255; chroma is how far its channels spread.
function pixel_at(pixels: Pixels, x: number, y: number): Pixel | null {
  const px = Math.floor(x)
  const py = Math.floor(y)

  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return null

  const pixel_rect = { x: px, y: py, w: 1, h: 1 }

  if (pixels.bar !== null && inside(pixel_rect, pixels.bar, -bar_clear_px)) return null

  const index = (py * pixels.width + px) * 4
  const [r, g, b] = [0, 1, 2].map((channel) => pixels.data[index + channel] as number) as [
    number,
    number,
    number,
  ]
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  return { r, g, b, light: 0.299 * r + 0.587 * g + 0.114 * b, chroma }
}

// A pixel is coloured when its channels spread by 16 or more. tldraw's grey (#9fa8b2) spreads
// 19 and the old pastel oval fill (#ddedfa) 29; its white surface (#fcfffe) spreads 3 and its
// black ink 0, and black anti-aliased onto white stays neutral, so the ink never counts.
const chroma_coloured_min = 16
const coloured_share_max = 0.0001
const dark_light_max = 200

type Colours = {
  pixels_count: number
  coloured: number
  blue: number
  yellow: number
  first: string | null
}

// Every pixel of the drawing, with a margin, inside the pane.
function colours_count(pixels: Pixels, measured: Measured): Colours {
  const rects = Object.values(measured.shapes).map((shape) => shape.rect)
  const { pane } = measured
  const left = Math.max(pane.x, Math.min(...rects.map((rect) => rect.x)) - 8)
  const top = Math.max(pane.y, Math.min(...rects.map((rect) => rect.y)) - 8)
  const right = Math.min(pane.x + pane.w, Math.max(...rects.map((rect) => rect.x + rect.w)) + 8)
  const bottom = Math.min(pane.y + pane.h, Math.max(...rects.map((rect) => rect.y + rect.h)) + 8)
  const counts: Colours = { pixels_count: 0, coloured: 0, blue: 0, yellow: 0, first: null }

  for (let y = Math.ceil(top); y < bottom; y += 1) {
    for (let x = Math.ceil(left); x < right; x += 1) {
      const pixel = pixel_at(pixels, x, y)

      if (pixel === null) continue

      counts.pixels_count += 1

      if (pixel.chroma < chroma_coloured_min) continue

      counts.coloured += 1
      counts.first ??= `rgb(${pixel.r}, ${pixel.g}, ${pixel.b}) at ${x},${y}`

      if (pixel.b - Math.max(pixel.r, pixel.g) >= chroma_coloured_min) counts.blue += 1

      if (Math.min(pixel.r, pixel.g) - pixel.b >= chroma_coloured_min) counts.yellow += 1
    }
  }

  return counts
}

// Inside a box or oval, clear of its outline and its words, the board shows white: no tint,
// hatching or second line. Sampled every other pixel.
function interior_inked(pixels: Pixels, shape: Shape, oval: boolean) {
  const { rect } = shape
  const inset = shape.unit_px * 4 + 2
  const [a, b] = [rect.w / 2 - inset, rect.h / 2 - inset]
  const [cx, cy] = [rect.x + rect.w / 2, rect.y + rect.h / 2]
  let [samples, inked] = [0, 0]

  for (let y = rect.y + inset; y < rect.y + rect.h - inset; y += 2) {
    for (let x = rect.x + inset; x < rect.x + rect.w - inset; x += 2) {
      if (oval && ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 > 1) continue

      if (shape.line_rects.some((line) => inside({ x, y, w: 0, h: 0 }, line, -4))) continue

      const pixel = pixel_at(pixels, x, y)

      if (pixel === null) continue

      samples += 1

      if (pixel.light < dark_light_max || pixel.chroma >= chroma_coloured_min) inked += 1
    }
  }

  return { samples, inked }
}

// The outline crossed at several places by short scans across the edge. A single fine line
// crosses as one dark run a pixel or few wide; a doubled sketch as two runs; a thick marker as
// one wide run. A connector meeting the edge spoils its crossing, so the thinnest single run
// is the outline's width. Returns the widths of the crossings that are single runs.
function outline_widths_px(pixels: Pixels, shape: Shape, oval: boolean): number[] {
  const { rect } = shape
  const reach = Math.ceil(shape.unit_px * 2.5 + 1.5)
  const scans: Array<{ x: number; y: number; dx: number; dy: number }> = []

  for (const f of oval ? [0.5] : [0.3, 0.5, 0.7]) {
    scans.push({ x: rect.x, y: rect.y + rect.h * f, dx: 1, dy: 0 })
    scans.push({ x: rect.x + rect.w, y: rect.y + rect.h * f, dx: 1, dy: 0 })
    scans.push({ x: rect.x + rect.w * f, y: rect.y, dx: 0, dy: 1 })
    scans.push({ x: rect.x + rect.w * f, y: rect.y + rect.h, dx: 0, dy: 1 })
  }

  const widths: number[] = []

  for (const scan of scans) {
    const runs: number[] = []
    let run = 0

    for (let step = -reach; step <= reach + 1; step += 1) {
      const pixel = pixel_at(pixels, scan.x + scan.dx * step, scan.y + scan.dy * step)

      if (pixel !== null && pixel.light < dark_light_max && step <= reach) {
        run += 1
      } else if (run > 0) {
        runs.push(run)
        run = 0
      }
    }

    if (runs.length === 1) widths.push(runs[0] as number)
  }

  return widths
}

// Dark pixels within a shape's lines of words: the words are really painted.
function words_inked(pixels: Pixels, shape: Shape): number {
  let inked = 0

  for (const line of shape.line_rects) {
    for (let y = line.y; y < line.y + line.h; y += 1) {
      for (let x = line.x; x < line.x + line.w; x += 1) {
        if ((pixel_at(pixels, x, y)?.light ?? 255) < dark_light_max) inked += 1
      }
    }
  }

  return inked
}

// tldraw leaves a white break in a connector's line for its label: it clips the body to outside
// the label's box. Along the body, between the words and the edge of that box, the board shows
// white; well away from the label the line itself shows ink, so a blank screenshot cannot pass.
// Each screen pixel the body crosses is judged once, by its centre. A band pixel lies wholly
// inside the box and wholly beyond the words, so neither the clipped line's anti-aliased end
// nor the words' own edges can reach it. The band is anchored to the box tldraw actually cut,
// not to the words plus the nominal padding: on the iPad's split pane the padding is about two
// pixels, and a band placed from the padding alone reached the clip edge's anti-aliasing. The
// pixels are the screen's, or a magnified view's when the screen holds no band pixel; see
// `label_view`.
//
// `clear_px` is how far a band pixel's centre keeps from the words and from the box's edge,
// in the pixels being read. Half a screen pixel does two things: the pixel is whole, and the
// measured words and box may be that far from where the browser painted them. The second is a
// distance on the screen, so a view of finer pixels keeps the same half screen pixel, which is
// several of its own.
const band_clear_px = 0.5

type Point = { x: number; y: number }
type Label = { words: Rect; box: Rect; unit_px: number; clear_px: number; points: Point[] }
type Gap = { band: number; band_inked: number; body: number; body_inked: number }
type BandPixel = { x: number; y: number; light: number }

function label_gap(pixels: Pixels, label: Label) {
  const { words, box, unit_px, clear_px, points } = label
  expect(unit_px).toBeGreaterThan(0)
  expect(box.w).toBeGreaterThan(0)
  expect(clear_px).toBeGreaterThanOrEqual(band_clear_px)
  const gap: Gap = { band: 0, band_inked: 0, body: 0, body_inked: 0 }
  const band_dark: BandPixel[] = []
  const seen = new Set<number>()

  for (const point of points) {
    const [px, py] = [Math.floor(point.x), Math.floor(point.y)]
    const key = py * pixels.width + px

    if (seen.has(key)) continue

    seen.add(key)
    const [cx, cy] = [px + 0.5, py + 0.5]
    const dx = Math.max(words.x - cx, cx - (words.x + words.w), 0)
    const dy = Math.max(words.y - cy, cy - (words.y + words.h), 0)
    const pixel = pixel_at(pixels, px, py)

    // The label's rounded corners are left alone.
    if (pixel === null || (dx > 0 && dy > 0)) continue

    const words_px = Math.max(dx, dy)
    const inside_box_px = Math.min(cx - box.x, box.x + box.w - cx, cy - box.y, box.y + box.h - cy)
    const dark = pixel.light < dark_light_max

    if (words_px >= clear_px && inside_box_px >= clear_px) {
      gap.band += 1
      gap.band_inked += dark ? 1 : 0

      if (dark) band_dark.push({ x: px, y: py, light: Math.round(pixel.light) })
    } else if (words_px >= unit_px * 8 && inside_box_px <= -clear_px) {
      gap.body += 1
      gap.body_inked += dark ? 1 : 0
    }
  }

  expect(band_dark.length).toBe(gap.band_inked)
  return { gap, band_dark }
}

// Whose ink a dark band pixel is, from the same view painted again with parts of the connector
// taken away: its clipped line, then also its words, then the whole connector. A pixel that
// turns white once the line is hidden is the line painted through the break. One that turns
// white only once the words go is the words' own glyph ink reaching past their measured box,
// which is the label, not a missing break. One left dark until the whole connector goes is its
// own arrowhead inside the label, and one dark even then is another shape's ink crossing it:
// both visibly occlude the label. Each pixel keeps its light in every layer, for the record.
type Layers = { no_body: Pixels; no_words: Pixels; no_arrow: Pixels }
type Attributed = { x: number; y: number; lights: number[] }
type Attribution = {
  body: Attributed[]
  words: Attributed[]
  head: Attributed[]
  other: Attributed[]
}

function band_attribute(band_dark: BandPixel[], layers: Layers | null): Attribution {
  const attribution: Attribution = { body: [], words: [], head: [], other: [] }

  if (band_dark.length === 0) return attribution

  expect(layers).not.toBeNull()
  const order = [layers!.no_body, layers!.no_words, layers!.no_arrow]

  for (const pixel of band_dark) {
    const lights = order.map((layer) => Math.round(pixel_at(layer, pixel.x, pixel.y)?.light ?? 255))
    const entry = { x: pixel.x, y: pixel.y, lights: [pixel.light, ...lights] }
    const gone = lights.findIndex((light) => light >= dark_light_max)
    const owner = (['body', 'words', 'head'] as const)[gone] ?? 'other'
    attribution[owner].push(entry)
  }

  const count = Object.values(attribution).reduce((sum, list) => sum + list.length, 0)
  expect(count).toBe(band_dark.length)
  return attribution
}

// The words sit inside the box tldraw cut from the line, within half a pixel.
function label_box_problems(id: string, words: Rect, box: Rect | null): string[] {
  if (box === null) return [`${id}: no label box cut from its line`]

  // `inside` allows the shared tolerance less the margin.
  if (!inside(words, box, tolerance_px - 0.5)) {
    return [`${id}: words ${rect_text(words)} outside the white break ${rect_text(box)}`]
  }

  return []
}

// Whether a label's break shows. The body beyond the box is inked. The band between words and
// box is where the line runs: with the mask removed, as the negative control, the same band
// gains ink. As painted, line ink in the band stays within the long-standing tenth, and no
// arrowhead or other shape's ink lies in it. Problems carry the measurements behind them.
function label_gap_judge(
  id: string,
  painted: Gap,
  unclipped: Gap,
  attribution: Attribution,
  detail: object,
): string[] {
  expect(unclipped.band).toBe(painted.band)
  const record = JSON.stringify({
    ...painted,
    unclipped_band_inked: unclipped.band_inked,
    attribution,
    ...detail,
  })

  if (painted.band === 0) return [`${id}: label gap not sampled ${record}`]

  const problems: string[] = []

  if (painted.body_inked < painted.body * 0.6) {
    problems.push(`${id}: label gap with the line not inked beyond it ${record}`)
  }

  if (unclipped.band_inked <= painted.band_inked) {
    problems.push(`${id}: label gap band gains no ink without the mask ${record}`)
  }

  if (attribution.body.length > painted.band * 0.1) {
    problems.push(`${id}: label gap with the line painted through it ${record}`)
  }

  if (attribution.head.length + attribution.other.length > 0) {
    problems.push(`${id}: label gap crossed by other ink ${record}`)
  }

  return problems
}

// A label's break can be finer than the screen. tldraw cuts the box 4.25 units beyond the words:
// 1.65 pixels on the iPad's split pane at 0.389 pixels to the unit. A band pixel lies wholly
// between words and box, half a pixel clear of each, and a strip under two pixels wide need not
// hold one: the `ovals-split-1180x820` run found none where the body crossed, so the break went
// unjudged. Only such a label is read from a view instead: the same page, with nothing in it
// changed, painted again by Chromium at four image pixels to the CSS pixel round the label. The
// measured rects still hold and are only mapped into the view's pixels. Four is also how often
// the body is sampled per CSS pixel, so every view pixel along it is still reached.
//
// The screen is always read first, and a label it samples is judged from it, however narrow
// its band: the view is for the break the screen cannot judge, not a second opinion on one it
// can. A view pixel keeps the screen's half pixel clear of words and box, two pixels of its
// own. Kept only half a view pixel clear, the `split-1180x820` run judged the line painted
// through two labels the screen shows clean: two dark pixels of 18 and of 14, each the clip
// edge within a quarter of a screen pixel of where the box was measured. A strip of one and
// a quarter screen pixels or more still holds a view pixel that far clear of both. A label
// whose band is two screen pixels or more always holds a whole screen pixel on each side, so
// it is never given a view: unsampled, it is reported.
const band_screen_px_min = 2
const view_scale = 4

// A view reaches this far past where the body beyond the box is judged, in CSS pixels.
const view_margin_px = 8

// One view's image pixels at most: four megabytes decoded, far above any label's.
const view_pixels_max = 1_000_000

type View = { clip: Rect; scale: number }

// The view a label may be read from, or null when its band always holds a whole screen pixel.
// The view is whole CSS pixels within the pane, so each CSS pixel is exactly `scale` by `scale`
// of its own.
function label_view(label: Label, pane: Rect): View | null {
  const { words, box } = label
  expect(label.unit_px).toBeGreaterThan(0)
  const band_px = Math.min(
    words.x - box.x,
    words.y - box.y,
    box.x + box.w - (words.x + words.w),
    box.y + box.h - (words.y + words.h),
  )

  if (band_px >= band_screen_px_min) return null

  const reach_px = label.unit_px * 8 + view_margin_px
  const left = Math.max(Math.ceil(pane.x), Math.floor(box.x - reach_px))
  const top = Math.max(Math.ceil(pane.y), Math.floor(box.y - reach_px))
  const right = Math.min(Math.floor(pane.x + pane.w), Math.ceil(box.x + box.w + reach_px))
  const bottom = Math.min(Math.floor(pane.y + pane.h), Math.ceil(box.y + box.h + reach_px))
  expect(right).toBeGreaterThan(left)
  expect(bottom).toBeGreaterThan(top)
  return { clip: { x: left, y: top, w: right - left, h: bottom - top }, scale: view_scale }
}

function rect_in_view(rect: Rect, view: View): Rect {
  return {
    x: (rect.x - view.clip.x) * view.scale,
    y: (rect.y - view.clip.y) * view.scale,
    w: rect.w * view.scale,
    h: rect.h * view.scale,
  }
}

// A label's measurements in a view's image pixels, where `label_gap` judges it unchanged.
function label_in_view(label: Label, view: View): Label {
  expect(view.scale).toBeGreaterThanOrEqual(1)
  return {
    words: rect_in_view(label.words, view),
    box: rect_in_view(label.box, view),
    unit_px: label.unit_px * view.scale,
    clear_px: label.clear_px * view.scale,
    points: label.points.map((point) => ({
      x: (point.x - view.clip.x) * view.scale,
      y: (point.y - view.clip.y) * view.scale,
    })),
  }
}

// Chromium paints a clip of the page at a scale through DevTools, which is how Playwright takes
// every clipped screenshot; Playwright only never asks for a scale above one. The call needs a
// session of its own. Chromium keeps device emulation per session and, after a capture, puts
// back what the capturing session had set, so a session that had set nothing would switch
// Playwright's viewport emulation off behind its back. Each page's session therefore first sets
// the same metrics Playwright set, and is kept until the page closes, as detaching would also
// switch them off. Kept per page, so at most one session for each of the journey's pages.
const view_sessions = new WeakMap<Page, CDPSession>()

async function view_session(page: Page): Promise<CDPSession> {
  const kept = view_sessions.get(page)

  if (kept !== undefined) return kept

  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', {
    mobile: false,
    width: viewport!.width,
    height: viewport!.height,
    screenWidth: viewport!.width,
    screenHeight: viewport!.height,
    deviceScaleFactor: 1,
    screenOrientation: { angle: 0, type: 'landscapePrimary' },
  })
  view_sessions.set(page, session)
  return session
}

// What a label is read from: null for the screen, whenever the screen's own pixels hold its
// band where the body crosses, and otherwise the view it may be given. `screen` and `label`
// are in the same pixels.
function label_reading_view(screen: Pixels, label: Label, pane: Rect): View | null {
  expect(label.clear_px).toBe(band_clear_px)

  if (label_gap(screen, label).gap.band > 0) return null

  return label_view(label, pane)
}

// A view as a PNG. The clip is in document coordinates, as DevTools takes it.
async function view_png(page: Page, view: View): Promise<Buffer> {
  const { clip, scale } = view
  expect([clip.x, clip.y, clip.w, clip.h, scale].every(Number.isInteger)).toBe(true)
  expect(clip.w * clip.h * scale ** 2).toBeGreaterThan(0)
  expect(clip.w * clip.h * scale ** 2).toBeLessThanOrEqual(view_pixels_max)
  await page.mouse.move(0, 0)
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  const session = await view_session(page)
  const shot = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: scroll.x + clip.x, y: scroll.y + clip.y, width: clip.w, height: clip.h, scale },
    captureBeyondViewport: false,
  })
  return Buffer.from(shot.data, 'base64')
}

// A view's pixels. `pixel_at` keeps clear of the details bar by a margin counted in its own
// pixels; the bar is grown first, so that the margin stays the same distance on the screen.
async function view_pixels(page: Page, measured: Measured, view: View): Promise<Pixels> {
  const decoded = await png_decode(page, await view_png(page, view))
  expect(decoded.width).toBe(view.clip.w * view.scale)
  expect(decoded.height).toBe(view.clip.h * view.scale)
  const { bar } = measured

  if (bar === null) return { ...decoded, bar: null }

  const grow_px = (bar_clear_px + tolerance_px) * (1 - 1 / view.scale)
  const grown = {
    x: bar.x - grow_px,
    y: bar.y - grow_px,
    w: bar.w + grow_px * 2,
    h: bar.h + grow_px * 2,
  }
  return { ...decoded, bar: rect_in_view(grown, view) }
}

// Whether a view really holds detail finer than the screen, and is not the screen's own pixels
// enlarged, which would judge nothing new. Ink painted at the view's scale meets white within a
// pixel or two, so somewhere two neighbouring pixels differ by half the contrast or more: 113
// at the worst alignment of a slanted edge. Screen pixels enlarged four times and blended can
// step by a quarter of the contrast, 57, or about 71 with a cubic blend; 96 lies between.
// Screen pixels merely repeated do step sharply, but only between CSS pixels, never within
// one, so some CSS pixel's own image pixels must also spread that far.
const view_step_min = 96

type Detail = { step_max: number; cells_mixed: number }

function view_detail(pixels: Pixels, scale: number): Detail {
  expect(pixels.width % scale).toBe(0)
  expect(pixels.height % scale).toBe(0)
  const detail: Detail = { step_max: 0, cells_mixed: 0 }
  const light = (x: number, y: number) => {
    const index = (y * pixels.width + x) * 4
    const [r, g, b] = [0, 1, 2].map((channel) => pixels.data[index + channel] as number)
    return 0.299 * (r as number) + 0.587 * (g as number) + 0.114 * (b as number)
  }

  // Every image pixel once, by the CSS pixel that holds it.
  for (let cell = 0; cell < (pixels.width * pixels.height) / scale ** 2; cell += 1) {
    const left = (cell % (pixels.width / scale)) * scale
    const top = Math.floor(cell / (pixels.width / scale)) * scale
    let [low, high] = [255, 0]

    for (let inner = 0; inner < scale ** 2; inner += 1) {
      const [x, y] = [left + (inner % scale), top + Math.floor(inner / scale)]
      const here = light(x, y)
      const right = x + 1 < pixels.width ? light(x + 1, y) : here
      const below = y + 1 < pixels.height ? light(x, y + 1) : here
      const step = Math.max(Math.abs(right - here), Math.abs(below - here))
      detail.step_max = Math.max(detail.step_max, Math.round(step))
      low = Math.min(low, here)
      high = Math.max(high, here)
    }

    if (high - low >= view_step_min) detail.cells_mixed += 1
  }

  return detail
}

function view_detail_problems(id: string, pixels: Pixels, view: View): string[] {
  const detail = view_detail(pixels, view.scale)

  if (detail.step_max >= view_step_min && detail.cells_mixed > 0) return []

  const record = JSON.stringify({ ...detail, view })
  return [`${id}: label gap view no finer than the screen ${record}`]
}

// The pane painted with labelled connectors altered in place, then put back exactly: each
// element's own style attribute is saved and restored. `unclipped` removes the label's mask
// from the line; the others hide the line, then also the words, then the whole connector.
// Read from the screen, or from `view` when one is given.
type Layer = 'unclipped' | 'no_body' | 'no_words' | 'no_arrow'

async function layer_pixels(
  page: Page,
  measured: Measured,
  ids: string[],
  layer: Layer,
  view: View | null,
): Promise<Pixels> {
  expect(ids.length).toBeGreaterThan(0)
  const changed = await page.evaluate(
    async ({ ids, layer }) => {
      const pane = document.querySelector('section[aria-label="Cleaned"]') as HTMLElement
      const saved: Array<[Element, string | null]> = []
      const save = (element: HTMLElement | SVGElement, name: string, value: string) => {
        saved.push([element, element.getAttribute('style')])
        element.style.setProperty(name, value)
      }

      for (const id of ids) {
        const selector = `.tl-shape[data-shape-id="shape:cleaned-${id}"]:not(.tl-shape-background)`
        const element = pane.querySelector<HTMLElement>(selector)
        const body = element?.querySelector<SVGGElement>('g[style*="clip-path"]')
        const words = element?.querySelector<HTMLElement>('.tl-text-content')

        if (!element || !body || !words) continue

        if (layer === 'unclipped') save(body, 'clip-path', 'none')
        else save(body, 'visibility', 'hidden')

        if (layer === 'no_words') save(words, 'visibility', 'hidden')

        if (layer === 'no_arrow') save(element, 'visibility', 'hidden')
      }

      const holder = window as unknown as { layer_saved?: Array<[Element, string | null]> }
      holder.layer_saved = saved
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return new Set(saved.map(([element]) => element.closest('.tl-shape'))).size
    },
    { ids, layer },
  )
  let pixels: Pixels | null = null
  let restored = -1

  try {
    expect(changed).toBe(ids.length)
    pixels =
      view === null ? await pixels_read(page, measured) : await view_pixels(page, measured, view)
  } finally {
    restored = await page.evaluate(async () => {
      const holder = window as unknown as { layer_saved?: Array<[Element, string | null]> }
      const saved = holder.layer_saved ?? []
      delete holder.layer_saved

      // In reverse, so an element altered twice gets its first saved style back.
      for (const [element, style] of [...saved].reverse()) {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return saved.length
    })
  }

  expect(restored).toBeGreaterThan(0)
  return pixels as Pixels
}

// Every labelled connector's break, judged as above. A label the screen samples is read from
// the pane's pixels, and the unmasked control is one extra paint for all such labels; one it
// cannot sample is read from its own view, as painted and unmasked.
type Reading = { view: View | null; painted: Pixels; unclipped: Pixels }

async function label_gaps_check(
  page: Page,
  info: TestInfo,
  name: string,
  measured: Measured,
  arrows: Arrows,
  pixels: Pixels,
  source: Fixture,
): Promise<string[]> {
  const problems: string[] = []
  const ids = source.edges
    .map((edge) => edge.id)
    .filter((id) => measured.shapes[id]?.text_rect != null)
  let unclipped_screen: Pixels | null = null

  for (const id of ids) {
    const shape = measured.shapes[id] as Shape
    const words = shape.text_rect as Rect
    const box = arrows[id]?.label_box ?? null
    const box_problems = label_box_problems(id, words, box)
    problems.push(...box_problems)

    if (box_problems.length > 0 || box === null) continue

    const points = arrows[id]?.body_points ?? []
    const label: Label = { words, box, unit_px: shape.unit_px, clear_px: band_clear_px, points }
    const view = label_reading_view(pixels, label, measured.pane)
    let reading: Reading

    if (view === null) {
      unclipped_screen ??= await layer_pixels(page, measured, ids, 'unclipped', null)
      reading = { view, painted: pixels, unclipped: unclipped_screen }
    } else {
      const painted = await view_pixels(page, measured, view)
      const unclipped = await layer_pixels(page, measured, [id], 'unclipped', view)
      reading = { view, painted, unclipped }
    }

    problems.push(...(await label_gap_check(page, info, name, measured, id, label, reading)))
  }

  return problems
}

// One label's break from its reading. The three attribution layers are painted only when its
// band shows ink, and a close view of that label is attached for review. A view must first
// prove finer than the screen, and is attached, as it was judged, with any problem it shows.
async function label_gap_check(
  page: Page,
  info: TestInfo,
  name: string,
  measured: Measured,
  id: string,
  label: Label,
  reading: Reading,
): Promise<string[]> {
  const { view } = reading
  const seen = view === null ? label : label_in_view(label, view)
  const painted = label_gap(reading.painted, seen)
  const unclipped = label_gap(reading.unclipped, seen)
  let layers: Layers | null = null

  if (painted.band_dark.length > 0) {
    layers = {
      no_body: await layer_pixels(page, measured, [id], 'no_body', view),
      no_words: await layer_pixels(page, measured, [id], 'no_words', view),
      no_arrow: await layer_pixels(page, measured, [id], 'no_arrow', view),
    }
    await heading_evidence(page, info, `${name}-${id}-label`, label.box)
  }

  const attribution = band_attribute(painted.band_dark, layers)
  const line_rects = measured.shapes[id]?.line_rects ?? []
  const detail = { words: label.words, box: label.box, unit_px: label.unit_px, line_rects, view }
  const problems = label_gap_judge(id, painted.gap, unclipped.gap, attribution, detail)

  if (view === null) return problems

  problems.unshift(...view_detail_problems(id, reading.painted, view))

  if (problems.length > 0) {
    const body = await view_png(page, view)
    await info.attach(`${name}-${id}-label-view`, { body, contentType: 'image/png' })
  }

  return problems
}

// The markerboard as it was painted, from the screen's own pixels: no coloured pixel anywhere
// in the drawing, white interiors, one fine outline round each box and oval, and painted words.
// Connector labels' white breaks are judged by `label_gaps_check`.
function painted_check(measured: Measured, pixels: Pixels, source: Fixture) {
  const problems: string[] = []
  const colours = colours_count(pixels, measured)

  if (colours.coloured > Math.floor(colours.pixels_count * coloured_share_max)) {
    problems.push(`${colours.coloured} coloured pixels, first ${colours.first}`)
  }

  for (const item of [...source.nodes, ...source.edges]) {
    const shape = measured.shapes[item.id]
    const kind = 'kind' in item ? item.kind : 'edge'

    if (shape === undefined) continue

    if (shape.line_rects.length > 0 && words_inked(pixels, shape) === 0) {
      problems.push(`${item.id}: words not painted`)
    }

    if (kind === 'box' || kind === 'ellipse') {
      const interior = interior_inked(pixels, shape, kind === 'ellipse')

      if (interior.samples === 0 || interior.inked > 0) {
        problems.push(`${item.id}: interior ${interior.inked} of ${interior.samples} inked`)
      }

      const widths = outline_widths_px(pixels, shape, kind === 'ellipse')

      if (!(Math.min(...widths) <= shape.unit_px * 3 + 1.5)) {
        problems.push(`${item.id}: no single fine outline (${widths})`)
      }
    }
  }

  return problems
}

// A revision published before styles existed, as the browser drew it: the sans face, and no
// decoration or other stray shape.
function plain_check(measured: Measured): string[] {
  const problems: string[] = []

  for (const [id, shape] of Object.entries(measured.shapes)) {
    if (shape.text !== '' && !(shape.font_family ?? '').includes('tldraw_sans')) {
      problems.push(`${id}: drawn in ${shape.font_family}`)
    }
  }

  if (measured.others.length > 0) problems.push(`unexpected shapes: ${measured.others}`)

  return problems
}

// The same revision drawn twice is drawn identically: tldraw seeds every hand-drawn line from
// its shape's id, so nothing moves or wobbles differently between renders.
function drawn_identically(a: Measured, b: Measured): string[] {
  const problems: string[] = []

  for (const [id, shape] of Object.entries(a.shapes)) {
    if (b.shapes[id]?.paths_d !== shape.paths_d) problems.push(`${id}: drawn differently`)
  }

  if (Object.keys(b.shapes).length !== Object.keys(a.shapes).length) problems.push('shapes')

  return problems
}

// Everything the monochrome markerboard promises, from the browser's shapes and its pixels. Any
// problem is recorded with the measurements behind it before the caller asserts.
async function monochrome_check(
  page: Page,
  info: TestInfo,
  name: string,
  source: Fixture,
  line_height_px_min: number,
) {
  const measured = await cleaned_measure_stable(page)
  const arrows = await arrows_measure(page)
  const pixels = await pixels_read(page, measured)
  const problems = [
    ...diagram_check(measured, line_height_px_min, source),
    ...markerboard_check(measured, arrows, source),
    ...painted_check(measured, pixels, source),
    ...(await label_gaps_check(page, info, name, measured, arrows, pixels, source)),
  ]
  await problems_record(info, name, measured, problems)
  return { measured, problems }
}

// The shapes' measurements, without sampled paths, attached when a check finds a problem.
async function problems_record(
  info: TestInfo,
  name: string,
  measured: Measured,
  problems: string[],
): Promise<void> {
  if (problems.length === 0) return

  const shapes = Object.fromEntries(
    Object.entries(measured.shapes).map(([id, { points, paths_d, ...shape }]) => [
      id,
      { ...shape, points_count: points.length, paths_d_length: paths_d.length },
    ]),
  )
  const body = JSON.stringify({ problems, pane: measured.pane, shapes }, null, 1)
  await info.attach(`${name}-problems`, { body, contentType: 'application/json' })
}

// The same revision as updated live and as freshly loaded lays out every label identically:
// the same lines, at the same places, within the pixel and a half every bound check allows.
function layout_differences(live: Measured, fresh: Measured): string[] {
  const problems: string[] = []

  for (const [id, shape] of Object.entries(live.shapes)) {
    const other = fresh.shapes[id]

    if (other === undefined) {
      problems.push(`${id}: missing after a reload`)
      continue
    }

    const [a, b] = [shape.line_rects, other.line_rects]
    const moved = a.some((line, index) => {
      const peer = b[index]
      return peer === undefined || !inside(line, peer) || !inside(peer, line)
    })

    if (a.length !== b.length || moved) {
      problems.push(
        `${id}: live lines [${a.map(rect_text).join(' ')}] fresh [${b.map(rect_text).join(' ')}]`,
      )
    }
  }

  return problems
}

// A close view of one group, at the canvas's own scale, for visual acceptance.
async function heading_evidence(page: Page, info: TestInfo, name: string, rect: Rect) {
  const file = info.outputPath(`${name}.png`)
  const clip = { x: rect.x - 8, y: rect.y - 8, width: rect.w + 16, height: rect.h + 16 }
  await page.screenshot({ path: file, clip })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

async function evidence(page: Page, info: TestInfo, name: string, measured: Measured) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
  const heights = Object.values(measured.shapes)
    .map((shape) => shape.line_height_px_min)
    .filter((height): height is number => height !== null)
  info.annotations.push({
    type: name,
    description: `smallest text line ${Math.min(...heights).toFixed(1)}px; pane ${Math.round(
      measured.pane.w,
    )}x${Math.round(measured.pane.h)}px`,
  })
}

// The measuring artifact behind a false overflow, on a bare page: centred words in tldraw's
// `pre-wrap`, each line one word just narrower than its box. The space at each soft wrap hangs
// past its line, so a whole text node's rects reach beyond the box though nothing is painted
// there; that is the negative control. The word lines stay inside and count the real lines,
// yet still see a word that truly overflows a narrower box.
test('words are measured without the spaces that hang at soft wraps', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 400, height: 300 } })

  try {
    const page = await context.newPage()
    const font = 'font: 36px/1.35 sans-serif; white-space: pre-wrap'
    await page.setContent(
      `<div id="box" style="${font}; text-align: center"><span id="word">mmmmmm</span></div>` +
        `<div id="narrow" style="${font}; overflow-wrap: normal; width: 20px">mmmmmm</div>`,
    )
    const result = await page.evaluate((lines_source) => {
      const lines_of = new Function(`return (${lines_source})`)() as typeof word_lines
      const box = document.getElementById('box') as HTMLElement
      const narrow = document.getElementById('narrow') as HTMLElement
      const word_px = (document.getElementById('word') as HTMLElement).offsetWidth
      box.style.width = `${word_px + 2}px`
      box.textContent = 'mmmmmm mmmmmm mmmmmm'
      const range = document.createRange()
      range.selectNodeContents(box.firstChild as Text)
      const whole = Array.from(range.getClientRects()).filter((rect) => rect.height > 0)
      const to_rect = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height })
      return {
        box: to_rect(box.getBoundingClientRect()),
        narrow: to_rect(narrow.getBoundingClientRect()),
        whole_right_px: Math.max(...whole.map((rect) => rect.right)),
        lines: lines_of(box),
        narrow_lines: lines_of(narrow),
        line_px: parseFloat(getComputedStyle(box).lineHeight),
      }
    }, word_lines_source)

    expect(Math.round(result.box.h / result.line_px)).toBe(3)
    expect(result.whole_right_px).toBeGreaterThan(result.box.x + result.box.w + tolerance_px)
    expect(result.lines).toHaveLength(3)
    expect(result.lines.filter((line) => !inside(line, result.box))).toEqual([])
    expect(result.narrow_lines).toHaveLength(1)
    expect(inside(result.narrow_lines[0]!, result.narrow)).toBe(false)
  } finally {
    await contexts_close([context])
  }
})

// A connector's label as the iPad's split pane paints it, built pixel by pixel: half a pixel to
// the unit, the body a horizontal line clipped to outside the label box, its ends anti-aliased
// by how much of each pixel the line covers. The box sits 1.7 pixels beyond the words, a little
// short of the nominal padding, as the failing split-pane run showed. A band placed from the
// padding alone, up to 1.56 pixels beyond the words, judged the clip edge's anti-aliased pixel
// dark there. The band from the cut box sees white; a line painted through the break is the
// negative control, and words reaching past the box are refused. `blank` paints no line, as a
// layer with the line hidden; `dark` adds one dark pixel, such as a glyph's overhang or another
// shape's ink.
function label_pixels_paint(
  box: Rect,
  line: 'clipped' | 'through' | 'blank',
  dark: { x: number; y: number } | null,
): Pixels {
  const [width, height] = [200, 100]
  const data = Buffer.alloc(width * height * 4, 255)

  for (let x = 60; x < 180 && line !== 'blank'; x += 1) {
    const covered_px = Math.max(0, Math.min(x + 1, box.x) - x)
    const beyond_px = Math.max(0, x + 1 - Math.max(x, box.x + box.w))
    const coverage = line === 'through' ? 1 : Math.min(1, covered_px + beyond_px)
    const light = Math.round(255 * (1 - coverage))
    data.fill(light, (50 * width + x) * 4, (50 * width + x) * 4 + 3)
  }

  if (dark !== null) data.fill(40, (dark.y * width + dark.x) * 4, (dark.y * width + dark.x) * 4 + 3)

  return { width, height, data, bar: null }
}

test('a label gap is judged within the box tldraw cut, not the nominal padding', () => {
  const words: Rect = { x: 100, y: 46, w: 40, h: 8 }
  const box: Rect = { x: 98.3, y: 43.875, w: 43.4, h: 12.25 }
  const points = Array.from({ length: 480 }, (_, index) => ({ x: 60 + index / 4, y: 50.5 }))
  const label: Label = { words, box, unit_px: 0.5, clear_px: band_clear_px, points }
  const judge = (painted: Pixels, unclipped: Pixels, layers: Layers | null) => {
    const { gap, band_dark } = label_gap(painted, label)
    const control = label_gap(unclipped, label).gap
    return label_gap_judge('reports', gap, control, band_attribute(band_dark, layers), {})
  }

  const clean = label_pixels_paint(box, 'clipped', null)
  const through = label_pixels_paint(box, 'through', null)
  const blank = label_pixels_paint(box, 'blank', null)
  expect(label_gap(clean, label).gap).toEqual({
    band: 2,
    band_inked: 0,
    body: 72,
    body_inked: 72,
  })
  expect(judge(clean, through, null)).toEqual([])

  // Its band is under two pixels, so it could be given a view; the screen samples it, so it
  // is read from the screen, as the split pane's labels were before any view existed.
  const pane: Rect = { x: 0, y: 0, w: 200, h: 100 }
  expect(label_view(label, pane)).not.toBeNull()
  expect(label_reading_view(clean, label, pane)).toBeNull()

  // The negative controls: the line painted through the break is the line's own ink, and a
  // mask that was not really removed leaves the band without the line's ink.
  const layers_blank = { no_body: blank, no_words: blank, no_arrow: blank }
  const [first, second] = judge(through, through, layers_blank)
  expect(first).toContain('reports: label gap band gains no ink without the mask {"band":2,')
  expect(second).toContain('reports: label gap with the line painted through it')
  expect(second).toContain('"body":[{"x":99,"y":50,"lights":[0,255,255,255]}')
  expect(judge(clean, clean, null)[0]).toContain('band gains no ink without the mask')

  // A glyph's ink just past the measured words is the label, not a missing break; ink that
  // stays when the whole connector is hidden is another shape crossing the label.
  const glyph = { x: 140, y: 50 }
  const overhang = label_pixels_paint(box, 'clipped', glyph)
  const words_only = label_pixels_paint(box, 'blank', glyph)
  const words_layers = { no_body: words_only, no_words: blank, no_arrow: blank }
  expect(judge(overhang, through, words_layers)).toEqual([])
  const crossing_layers = { no_body: words_only, no_words: words_only, no_arrow: words_only }
  const [crossed] = judge(overhang, through, crossing_layers)
  expect(crossed).toContain('reports: label gap crossed by other ink')
  expect(crossed).toContain('"other":[{"x":140,"y":50,"lights":[40,40,40,40]}]')
  const head_layers = { no_body: words_only, no_words: words_only, no_arrow: blank }
  expect(judge(overhang, through, head_layers)[0]).toContain('"head":[{"x":140,')

  const narrow: Rect = { x: 101, y: 43.875, w: 38, h: 12.25 }
  expect(label_box_problems('reports', words, narrow)).toEqual([
    'reports: words 40.0x8.0@100.0,46.0 outside the white break 38.0x12.3@101.0,43.9',
  ])
  expect(label_box_problems('reports', words, null)).toEqual([
    'reports: no label box cut from its line',
  ])
  expect(label_box_problems('reports', words, box)).toEqual([])
})

// A straight connector as a view would capture it: each image pixel's ink is the share of its
// four by four sample points that the line covers. The line is `width_px` wide and cut to
// outside `cut`, as tldraw's clip path cuts it; a null line paints a blank view.
type Line = { from: Point; to: Point; width_px: number }

function label_view_paint(view: View, line: Line | null, cut: Rect | null): Pixels {
  const [width, height] = [view.clip.w * view.scale, view.clip.h * view.scale]
  const data = Buffer.alloc(width * height * 4, 255)

  for (let index = 0; index < width * height && line !== null; index += 1) {
    const [run_x, run_y] = [line.to.x - line.from.x, line.to.y - line.from.y]
    let covered = 0

    for (let sample = 0; sample < 16; sample += 1) {
      const [sub_x, sub_y] = [((sample % 4) + 0.5) / 4, (Math.floor(sample / 4) + 0.5) / 4]
      const x = view.clip.x + ((index % width) + sub_x) / view.scale
      const y = view.clip.y + (Math.floor(index / width) + sub_y) / view.scale
      const cross = (x - line.from.x) * run_y - (y - line.from.y) * run_x
      const away_px = Math.abs(cross) / Math.hypot(run_x, run_y)
      const within_x = cut !== null && x > cut.x && x < cut.x + cut.w
      const within_y = cut !== null && y > cut.y && y < cut.y + cut.h

      if (away_px <= line.width_px / 2 && !(within_x && within_y)) covered += 1
    }

    data.fill(Math.round(255 * (1 - covered / 16)), index * 4, index * 4 + 3)
  }

  return { width, height, data, bar: null }
}

// The screen's pixels enlarged, as a capture that painted nothing finer would be: each pixel
// repeated, or blended linearly between its neighbours. Grey pixels only.
function pixels_enlarge(pixels: Pixels, scale: number, blend: boolean): Pixels {
  const [width, height] = [pixels.width * scale, pixels.height * scale]
  const data = Buffer.alloc(width * height * 4, 255)
  const light = (x: number, y: number) => {
    const column = Math.min(pixels.width - 1, Math.max(0, x))
    const row = Math.min(pixels.height - 1, Math.max(0, y))
    return pixels.data[(row * pixels.width + column) * 4] as number
  }

  for (let index = 0; index < width * height; index += 1) {
    const at_x = ((index % width) + 0.5) / scale - 0.5
    const at_y = (Math.floor(index / width) + 0.5) / scale - 0.5
    const [x, y] = blend
      ? [Math.floor(at_x), Math.floor(at_y)]
      : [Math.round(at_x), Math.round(at_y)]
    const [far_x, far_y] = [at_x - x, at_y - y]
    const upper = light(x, y) * (1 - far_x) + light(x + 1, y) * far_x
    const lower = light(x, y + 1) * (1 - far_x) + light(x + 1, y + 1) * far_x
    const blended = upper * (1 - far_y) + lower * far_y
    data.fill(Math.round(blend ? blended : light(x, y)), index * 4, index * 4 + 3)
  }

  return { width, height, data, bar: null }
}

// The regression for the `ovals-split-1180x820` failure, from its recorded measurements: the
// "reports" label at 0.389 pixels to the unit, its box 1.65 pixels beyond the words. A straight
// body stands in for the elbow and crosses the left and top sides, where no whole screen pixel
// lies between words and box. From the screen the band holds no pixel and the break goes
// unjudged; the view the label is then given holds the band, sees the break white, and still
// refuses the line painted through it. The view is judged half a screen pixel clear of words
// and box, as the screen is: the later `split-1180x820` failure is kept here too. Enlarged
// screen pixels are refused as a view, and the same label with a box two pixels beyond its
// words keeps to the screen.
test('a label gap finer than the screen is judged from a magnified view', () => {
  const words: Rect = { x: 734.8034057617188, y: 473.8984375, w: 26.60394287109375, h: 9.336 }
  const box: Rect = { x: 733.1532199462592, y: 472.24215625281334, w: 29.91044329000715, h: 12.758 }
  const unit_px = 0.3889999985694885
  const pane: Rect = { x: 590, y: 0, w: 590, h: 820 }
  const line: Line = { from: { x: 718, y: 485.2 }, to: { x: 767, y: 462.8 }, width_px: unit_px * 2 }
  const points = Array.from({ length: 217 }, (_, index) => ({
    x: line.from.x + ((line.to.x - line.from.x) * index) / 216,
    y: line.from.y + ((line.to.y - line.from.y) * index) / 216,
  }))
  const label: Label = { words, box, unit_px, clear_px: band_clear_px, points }
  const judge = (seen: Label, painted: Pixels, unclipped: Pixels, layers: Layers | null) => {
    const { gap, band_dark } = label_gap(painted, seen)
    const control = label_gap(unclipped, seen).gap
    return label_gap_judge('reports', gap, control, band_attribute(band_dark, layers), {})
  }

  const view = label_view(label, pane) as View
  expect(view).toEqual({ clip: { x: 722, y: 461, w: 53, h: 36 }, scale: 4 })
  const screen: View = { clip: view.clip, scale: 1 }
  const on_screen = label_in_view(label, screen)
  const seen = label_in_view(label, view)
  expect([on_screen.clear_px, seen.clear_px]).toEqual([0.5, 2])

  // As the failing run read it: the screen's pixels, with the break left unjudged. Only for
  // that is the label given its view.
  const screen_clean = label_view_paint(screen, line, box)
  const screen_through = label_view_paint(screen, line, null)
  const [unsampled] = judge(on_screen, screen_clean, screen_through, null)
  expect(unsampled).toContain('reports: label gap not sampled {"band":0,"band_inked":0,')
  const pane_on_screen = rect_in_view(pane, screen)
  expect(label_reading_view(screen_clean, on_screen, pane_on_screen)).toEqual({
    clip: { x: 0, y: 0, w: view.clip.w, h: view.clip.h },
    scale: 4,
  })

  // The view holds the band on both sides the body crosses, and the break is white in it.
  const clean = label_view_paint(view, line, box)
  const through = label_view_paint(view, line, null)
  expect(label_gap(clean, seen).gap).toEqual({
    band: 9,
    band_inked: 0,
    body: 88,
    body_inked: 88,
  })
  expect(judge(seen, clean, through, null)).toEqual([])
  expect(view_detail_problems('reports', clean, view)).toEqual([])

  // The negative controls: a line really painted through the break still fails, as does a mask
  // that was not really removed.
  const blank = label_view_paint(view, null, null)
  const layers_blank = { no_body: blank, no_words: blank, no_arrow: blank }
  const [first, second] = judge(seen, through, through, layers_blank)
  expect(first).toContain('reports: label gap band gains no ink without the mask')
  expect(second).toContain('reports: label gap with the line painted through it')
  expect(judge(seen, clean, clean, null)[0]).toContain('band gains no ink without the mask')

  // The regression for the `split-1180x820` failure: the browser cut the line a quarter of a
  // screen pixel inside the measured box, which the screen's half pixel allows for. Kept only
  // half a view pixel clear, the band reaches the cut's edge and a clean break is refused as
  // the line painted through it. Half a screen pixel clear, the same view is white.
  const cut: Rect = { x: box.x + 0.25, y: box.y + 0.25, w: box.w - 0.5, h: box.h - 0.5 }
  const cut_inside = label_view_paint(view, line, cut)
  const half_view_pixel: Label = { ...seen, clear_px: band_clear_px }
  const refused = judge(half_view_pixel, cut_inside, through, layers_blank)
  expect(refused).toHaveLength(1)
  expect(refused[0]).toContain(
    'reports: label gap with the line painted through it {"band":19,"band_inked":3,',
  )
  expect(judge(seen, cut_inside, through, null)).toEqual([])

  // Screen pixels enlarged are no view, whether repeated or blended, and nor is a blank one.
  const [repeated] = view_detail_problems('reports', pixels_enlarge(screen_clean, 4, false), view)
  expect(repeated).toContain(
    'reports: label gap view no finer than the screen {"step_max":207,"cells_mixed":0,',
  )
  const [blended] = view_detail_problems('reports', pixels_enlarge(screen_clean, 4, true), view)
  expect(blended).toContain('reports: label gap view no finer than the screen {"step_max":49,')
  expect(view_detail_problems('reports', blank, view)).toHaveLength(1)

  // The neighbouring valid case: two pixels between words and box hold a whole screen pixel.
  const roomy: Rect = { x: words.x - 2, y: words.y - 2, w: words.w + 4, h: words.h + 4 }
  expect(label_view({ ...label, box: roomy }, pane)).toBeNull()
  const tight: Rect = { x: words.x - 1.99, y: words.y - 2, w: words.w + 4, h: words.h + 4 }
  expect(label_view({ ...label, box: tight }, pane)).not.toBeNull()
})

test('a semantic diagram is composed, rendered legibly, refused when invalid, and kept', async ({
  browser,
}, info) => {
  const contexts = [
    await browser.newContext({ viewport: { width: 1280, height: 800 } }),
    await browser.newContext({ viewport: { width: 1180, height: 820 } }),
  ]

  try {
    await diagram_journey(await contexts[0]!.newPage(), await contexts[1]!.newPage(), info)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})

async function diagram_journey(stage: Page, ipad: Page, info: TestInfo): Promise<void> {
  const origin = `http://127.0.0.1:${port}`
  await stage.goto(origin)
  await ipad.goto(`${origin}/draw`)

  // An agent's turn: snapshot, write the diagram, publish. The ink is left exactly as drawn.
  await stroke(ipad)
  await expect.poll(async () => (await status()).shapes_count).toBe(1)
  const snapshot = cli('cleanup-snapshot', '--no-open', '--out', out_directory)
  expect(snapshot.json).toMatchObject({ code: 'snapshot_saved', previous_diagram_path: null })
  const ink_before = await status()
  const published = cli(
    'cleanup-publish',
    '--file',
    diagram_write(String(snapshot.json.snapshot), 0),
  )
  expect(published.json).toMatchObject({ code: 'published', revision: 1, shapes_count: 20 })
  const ink_after = await status()
  expect(ink_after.document_hash).toBe(ink_before.document_hash)
  expect(ink_after.shapes_count).toBe(1)

  // The Cleaned tab at a laptop size: everything drawn, legible and clear.
  await stage.getByRole('tab', { name: 'Cleaned' }).click()
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Release review board'),
  ).toBeVisible()
  const { measured: cleaned, problems } = await monochrome_check(
    stage,
    info,
    'cleaned-1280x800',
    fixture,
    16,
  )
  await evidence(stage, info, 'cleaned-1280x800', cleaned)
  expect(problems).toEqual([])
  await heading_evidence(stage, info, 'heading-review-1280x800', cleaned.shapes.review!.rect)

  // Side by side on the iPad: the same diagram fits its half and stays clear, at a smaller size.
  await ipad.getByRole('tab', { name: 'Side by side' }).click()
  await expect(ipad.locator('section[aria-label="Sketch"]')).toBeVisible()
  const split = await monochrome_check(ipad, info, 'split-1180x820', fixture, 8)
  await evidence(ipad, info, 'split-1180x820', split.measured)
  expect(split.problems).toEqual([])

  // No decoration anywhere: no highlighter and no stray record on either pane of either page.
  for (const page of [stage, ipad]) {
    await expect(page.locator('.tl-shape[data-shape-type="highlight"]')).toHaveCount(0)
    await expect(page.locator('.tl-shape[data-shape-id^="shape:accent-"]')).toHaveCount(0)
  }

  // An invalid diagram is refused with its path, and the published one stays.
  const broken = cli(
    'cleanup-publish',
    '--file',
    diagram_write(String(snapshot.json.snapshot), 1, { flow: 'sideways' }),
  )
  expect(broken.exit_code).toBe(1)
  expect(broken.json).toMatchObject({ code: 'invalid_diagram' })
  expect(String(broken.json.message)).toContain('diagram.flow')
  expect(await status()).toMatchObject({ cleaned_revision: 1 })
  expect(diagram_check(await cleaned_measure_stable(ipad), 8)).toEqual([])

  // A restart keeps the styled diagram and the interpretation behind it.
  await server_stop()
  await server_start()
  await stage.reload()
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Release review board'),
  ).toBeVisible()
  const { measured: restarted, problems: restarted_problems } = await monochrome_check(
    stage,
    info,
    'restarted-1280x800',
    fixture,
    16,
  )
  expect(restarted_problems).toEqual([])
  expect(drawn_identically(cleaned, restarted)).toEqual([])
  expect(Object.keys(restarted.shapes).sort()).toEqual(Object.keys(cleaned.shapes).sort())
  const again = cli('cleanup-snapshot', '--no-open', '--out', out_directory)
  const previous = JSON.parse(fs.readFileSync(String(again.json.previous_diagram_path), 'utf8'))
  expect(previous.nodes.map((node: { id: string }) => node.id)).toEqual(
    fixture.nodes.map((node) => node.id),
  )
  expect(await status()).toMatchObject({ shapes_count: 1, cleaned_revision: 1 })

  // Standalone text, long oval labels and an empty group, measured against the drawn text and
  // the drawn ellipses, at both sizes.
  const ovals_published = cli(
    'cleanup-publish',
    '--file',
    diagram_write(String(again.json.snapshot), 1, {}, fixture_ovals),
  )
  expect(ovals_published.json).toMatchObject({ code: 'published', revision: 2, shapes_count: 13 })
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Plain lines join peers'),
  ).toBeVisible()
  const ovals = await monochrome_check(stage, info, 'ovals-cleaned-1280x800', fixture_ovals, 16)
  const ovals_cleaned = ovals.measured
  await evidence(stage, info, 'ovals-cleaned-1280x800', ovals_cleaned)

  // The same revision freshly loaded: its labels are laid out as they were when it arrived
  // live, so neither late font loading nor the live update shapes the result. Measured before
  // either assertion, so a failure carries both.
  await stage.reload()
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Plain lines join peers'),
  ).toBeVisible()
  const ovals_fresh = await monochrome_check(stage, info, 'ovals-fresh-1280x800', fixture_ovals, 16)
  const live_fresh = layout_differences(ovals_cleaned, ovals_fresh.measured)
  expect(ovals.problems).toEqual([])
  expect(ovals_fresh.problems).toEqual([])
  expect(live_fresh).toEqual([])
  expect(Object.keys(ovals_cleaned.shapes).sort()).toEqual(
    [...fixture_ovals.nodes, ...fixture_ovals.edges].map((item) => item.id).sort(),
  )

  // The iPad page outlived the restart; reload it so it shows the board as it is now.
  await ipad.reload()
  await ipad.getByRole('tab', { name: 'Side by side' }).click()
  await expect(
    ipad.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Plain lines join peers'),
  ).toBeVisible()
  const ovals_split = await monochrome_check(ipad, info, 'ovals-split-1180x820', fixture_ovals, 8)
  await evidence(ipad, info, 'ovals-split-1180x820', ovals_split.measured)
  expect(ovals_split.problems).toEqual([])
  expect(await status()).toMatchObject({ shapes_count: 1, cleaned_revision: 2 })

  await legacy_and_restores(stage, info, String(again.json.snapshot), ovals_cleaned)
}

// A revision in the format agents wrote before styles existed renders plain, beside the new
// look: restoring back and forth brings each revision back in its own look. The historical
// revision keeps its blue and yellow, which the markerboard's colour check must see, and the
// markerboard comes back from a restore as black ink on white.
async function legacy_and_restores(
  stage: Page,
  info: TestInfo,
  snapshot: string,
  ovals_cleaned: Measured,
): Promise<void> {
  const cleaned_pane = stage.locator('section[aria-label="Cleaned"]')
  const legacy_file = path.join(out_directory, 'legacy.json')
  fs.writeFileSync(
    legacy_file,
    JSON.stringify({
      format: 'tldraw-sync.cleanup.v1',
      snapshot,
      base_revision: 2,
      agent: 'legacy-agent',
      summary: 'Published before styles existed.',
      shapes: [
        { kind: 'text', id: 'title', x: 0, y: -80, text: 'Legacy checkout', size: 'l' },
        { kind: 'rectangle', id: 'api', x: 0, y: 0, w: 160, h: 80, text: 'API', color: 'yellow' },
        { kind: 'ellipse', id: 'db', x: 300, y: 0, w: 120, h: 80, text: 'DB', color: 'blue' },
        { kind: 'arrow', id: 'writes', from: 'api', to: 'db', text: 'writes' },
      ],
    }),
  )
  const legacy = cli('cleanup-publish', '--file', legacy_file)
  expect(legacy.json).toMatchObject({ code: 'published', revision: 3, shapes_count: 4 })
  await expect(cleaned_pane.locator('.tl-shape').getByText('Legacy checkout')).toBeVisible()
  const plain = await cleaned_measure_stable(stage)
  expect(plain_check(plain)).toEqual([])
  await evidence(stage, info, 'legacy-plain-1280x800', plain)

  // Negative control: the historical revision keeps its blue and yellow, and the same pixel
  // count that passes the markerboard sees them, so a coloured markerboard could not pass.
  expect(plain.shapes.db?.strokes).toContain('#4465e9')
  expect(plain.shapes.api?.strokes).toContain('#f1ac4b')
  const colours = colours_count(await pixels_read(stage, plain), plain)
  expect(colours.blue).toBeGreaterThan(100)
  expect(colours.yellow).toBeGreaterThan(100)
  expect(colours.coloured).toBeGreaterThan(colours.pixels_count * coloured_share_max)

  const restored_2 = cli('cleanup-restore', '--base-revision', '3', '--revision', '2')
  expect(restored_2.json).toMatchObject({ revision: 4, restored_from: 2 })
  await expect(cleaned_pane.locator('.tl-shape').getByText('Plain lines join peers')).toBeVisible()
  const restored = await monochrome_check(stage, info, 'restored-1280x800', fixture_ovals, 16)
  expect(restored.problems).toEqual([])
  expect(drawn_identically(ovals_cleaned, restored.measured)).toEqual([])

  const restored_3 = cli('cleanup-restore', '--base-revision', '4', '--revision', '3')
  expect(restored_3.json).toMatchObject({ revision: 5, restored_from: 3 })
  await expect(cleaned_pane.locator('.tl-shape').getByText('Legacy checkout')).toBeVisible()
  const plain_again = await cleaned_measure_stable(stage)
  expect(plain_check(plain_again)).toEqual([])
  expect(drawn_identically(plain, plain_again)).toEqual([])
  const colours_again = colours_count(await pixels_read(stage, plain_again), plain_again)
  expect([colours_again.blue > 100, colours_again.yellow > 100]).toEqual([true, true])
  expect(await status()).toMatchObject({ shapes_count: 1, cleaned_revision: 5 })
}
