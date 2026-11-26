// Interpret on a linked board, as it is drawn and seen: a small diagram and a landscape drawn
// with the pen on the iPad, read by an agent through the real command line, and looked at on
// the Mac stage and the iPad.
//
// The cleanup that escaped redrew the landscape as a system design of scattered boxes and ovals,
// and kept a boxed remark the agent had made about an earlier sketch. These journeys hold the
// rendered board to the repair: the diagram is typeset, the landscape is the person's own
// strokes in their own arrangement, a new Interpret shows only what the sketch shows now, a
// picture alone stays a picture, and an erased sketch empties the canvas. Each state is saved
// as a screenshot with the test results.
//
// The landscape is drawn to be recognised: a house with a roof and a door on top of a hill, a
// path running down from the door, the sun up to the right and a tree on the slope. A picture
// of unrelated dashes would pass every check on records and still say nothing about whether a
// person could tell what they had drawn, so the journeys also read where the ink of each part
// lies on screen, in the sketch and on the Agent canvas, and name what is out of place.
//
// Run: bun run build && npx playwright test tests/interpret.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  board_linked,
  composer_close,
  composer_open,
  interpret,
  note,
  notify,
  step,
  step_long_ms,
  type Linked,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots. Every screenshot
// here is taken after the iPad has paired, when no page shows a pairing code any more.
test.use({ trace: 'off' })

type Point = { x: number; y: number }
type Trace = readonly Point[]
type Part = 'hill' | 'walls' | 'roof' | 'door' | 'path' | 'sun' | 'tree'
type Box4 = readonly [number, number, number, number]
type Summary = { id: string; type: string; x: number; y: number; w: number; h: number }
type Frame = { x: number; y: number; width: number; height: number }
type Reading = {
  snapshot: string
  base_revision: number
  diagram_path: string
  records_path: string
  prompt: string
  strokes: Summary[]
}
type Graph = { nodes: unknown[]; edges?: unknown[] }

// Where some parts are on a page: the selectors of the diagram's items, upper then lower, and
// of each part of the landscape. Then the same, as the ink of each is found on screen.
type Scene = { diagram: readonly string[]; parts: ReadonlyMap<Part, string> }
type Seen = { diagram: Frame[]; parts: Map<Part, Frame> }

const trace_of = (pairs: ReadonlyArray<readonly [number, number]>): Trace =>
  pairs.map(([x, y]) => ({ x, y }))

// Two short pen lines on the left stand for the diagram's two items.
const diagram_marks: Trace[] = [
  trace_of([[300, 300], [325, 300], [350, 300], [375, 300]]),
  trace_of([[300, 420], [325, 420], [350, 420], [375, 420]]),
]

// The landscape on the right, one pen stroke for each part, in iPad screen pixels. The walls
// stand on the crest of the hill, the roof rests on them, the door is in them and reaches the
// ground, the path winds down the hill from under the door, the sun is a ring up to the
// right, and the tree, a trunk with a crown, stands on the right slope.
const sun_centre = { x: 690, y: 300 }
const sun_radius_px = 26
const sun_sides = 12
const landscape: Record<Part, Trace> = {
  hill: trace_of([
    [440, 540], [470, 512], [500, 490], [530, 476], [560, 470],
    [590, 476], [620, 490], [650, 512], [680, 540],
  ]),
  walls: trace_of([[535, 470], [535, 425], [585, 425], [585, 470], [535, 470]]),
  roof: trace_of([[527, 425], [560, 395], [593, 425]]),
  door: trace_of([[553, 470], [553, 448], [567, 448], [567, 470]]),
  path: trace_of([[560, 474], [552, 492], [566, 508], [548, 524], [560, 540], [540, 556]]),
  sun: Array.from({ length: sun_sides + 1 }, (_, side) => ({
    x: sun_centre.x + Math.round(sun_radius_px * Math.cos((side * 2 * Math.PI) / sun_sides)),
    y: sun_centre.y + Math.round(sun_radius_px * Math.sin((side * 2 * Math.PI) / sun_sides)),
  })),
  tree: trace_of([
    [655, 512], [655, 480], [640, 470], [645, 452], [665, 452], [670, 470], [655, 480],
  ]),
}

// In the order they are drawn. The tree is last, so one Undo takes it away again.
const parts_kept: readonly Part[] = ['hill', 'walls', 'roof', 'door', 'path', 'sun']
const parts_all: readonly Part[] = [...parts_kept, 'tree']
const traces = (parts: readonly Part[]) => parts.map((part) => landscape[part])

const remark = 'You are. I’m just the mirror with a polling loop.'

// Line breaks in the agent's instructions are layout: the wording is compared on one line.
const flat = (text: string) => text.replace(/\s+/g, ' ')
const pane = '.views__pane--cleaned'
const shape_in = (where: string, id: string) =>
  `${where} .tl-shape[data-shape-id="${id}"]:not(.tl-shape-background)`
const on_canvas = (id: string) => shape_in(pane, `shape:cleaned-${id}`)
const on_sketch = (id: string) => shape_in('.views__pane--sketch', id)

// One pen stroke through every point of a trace. Each point is given a frame to arrive in,
// so the stroke keeps all of its corners however fast the points are sent.
async function trace(ipad: Page, points: Trace) {
  expect(points.length).toBeGreaterThanOrEqual(2)
  const last = points.at(-1) as Point
  const pen_at = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', point: Point) => ({
    type,
    x: point.x,
    y: point.y,
    button: 'left' as const,
    buttons: type === 'mouseReleased' ? 0 : 1,
    pointerType: 'pen' as const,
    force: 0.5,
    clickCount: 1,
  })
  const cdp = await ipad.context().newCDPSession(ipad)

  try {
    for (const [index, point] of points.entries()) {
      const type = index === 0 ? 'mousePressed' : 'mouseMoved'
      await cdp.send('Input.dispatchMouseEvent', pen_at(type, point))
      await ipad.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    }

    await cdp.send('Input.dispatchMouseEvent', pen_at('mouseReleased', last))
  } finally {
    await cdp.detach()
  }
}

// Pen strokes on the iPad, each one counted on the Mac before the next is drawn.
async function pen(board: Linked, marks: readonly Trace[], count_before: number) {
  const { ipad, cli, session } = board

  for (const [index, points] of marks.entries()) {
    await trace(ipad, points)
    await expect
      .poll(() => cli('status', '--session', session).shapes_count)
      .toBe(count_before + index + 1)
  }
}

// What the agent is given: a snapshot through the bound command, and the summary of each
// stroke, from the leftmost to the rightmost.
function reading(board: Linked, name: string): Reading {
  const snap = board.bound('snapshot', '--out', path.join(board.root, name))
  expect(snap).toMatchObject({ status: 'success', layer: 'canvas', session: board.session })
  const { strokes } = JSON.parse(fs.readFileSync(snap.strokes_path, 'utf8')) as {
    strokes: Summary[]
  }
  strokes.sort((a, b) => a.x - b.x || a.y - b.y)
  return { ...snap, prompt: flat(String(snap.prompt)), strokes }
}

function publish(board: Linked, read: Reading, graph: Graph) {
  const diagram = {
    format: 'tldraw-sync.diagram.v1',
    session: board.session,
    snapshot: read.snapshot,
    base_revision: read.base_revision,
    nodes: graph.nodes,
    edges: graph.edges ?? [],
  }
  fs.writeFileSync(read.diagram_path, JSON.stringify(diagram))
  expect(board.bound('publish', '--file', read.diagram_path)).toMatchObject({
    status: 'success',
    layer: 'canvas',
    revision: read.base_revision + 1,
  })
}

// The box around some strokes, as the agent reports where an item sat in the sketch.
function at_of(strokes: readonly Summary[], margin = 0): [number, number, number, number] {
  const left = Math.min(...strokes.map((s) => s.x)) - margin
  const top = Math.min(...strokes.map((s) => s.y)) - margin
  const right = Math.max(...strokes.map((s) => s.x + s.w)) + margin
  const bottom = Math.max(...strokes.map((s) => s.y + s.h)) + margin
  return [left, top, right - left, bottom - top]
}

// The agent's reading of the two diagram strokes: a box above an oval, joined by an arrow.
function diagram_graph(upper: Summary, lower: Summary) {
  return {
    nodes: [
      { id: 'api', kind: 'box', label: 'API', at: at_of([upper], 20), strokes: [upper.id] },
      { id: 'db', kind: 'ellipse', label: 'Postgres', at: at_of([lower], 20) },
    ],
    edges: [{ id: 'writes', from: 'api', to: 'db', direction: 'forward' }],
  }
}

function scene_node(strokes: readonly Summary[]) {
  return { id: 'scene', kind: 'drawing', at: at_of(strokes), strokes: strokes.map((s) => s.id) }
}

// Boxes as fractions of the box around all of them, so that the same marks compare equal in
// screen pixels and in page units.
function fitted(boxes: readonly Box4[]): Box4[] {
  const left = Math.min(...boxes.map((box) => box[0]))
  const top = Math.min(...boxes.map((box) => box[1]))
  const width = Math.max(...boxes.map((box) => box[0] + box[2])) - left
  const height = Math.max(...boxes.map((box) => box[1] + box[3])) - top
  expect(width).toBeGreaterThan(0)
  expect(height).toBeGreaterThan(0)
  const fit = ([x, y, w, h]: Box4): Box4 => [
    (x - left) / width,
    (y - top) / height,
    w / width,
    h / height,
  ]
  return boxes.map(fit)
}

function trace_box(points: Trace): Box4 {
  const left = Math.min(...points.map((point) => point.x))
  const top = Math.min(...points.map((point) => point.y))
  const right = Math.max(...points.map((point) => point.x))
  const bottom = Math.max(...points.map((point) => point.y))
  return [left, top, right - left, bottom - top]
}

// Which stroke of a snapshot is which part of the landscape: the one that lies in the
// snapshot where the part was drawn. `strokes` are those of the landscape and nothing else.
// A stroke that lost its shape on the way to the board is found here, by its part's name.
function named(strokes: readonly Summary[], parts: readonly Part[]): Map<Part, Summary> {
  expect(strokes).toHaveLength(parts.length)
  const drawn_boxes = fitted(parts.map((part) => trace_box(landscape[part])))
  const seen_boxes = fitted(strokes.map((s): Box4 => [s.x, s.y, s.w, s.h]))
  const found = new Map<Part, Summary>()

  for (const [index, part] of parts.entries()) {
    const wanted = drawn_boxes[index] as Box4
    const gaps = seen_boxes.map((box) =>
      Math.max(...box.map((value, side) => Math.abs(value - (wanted[side] as number)))),
    )
    const nearest = gaps.indexOf(Math.min(...gaps))
    expect(gaps[nearest], `the ${part} is in the snapshot as it was drawn`).toBeLessThan(0.05)
    found.set(part, strokes[nearest] as Summary)
  }

  expect(new Set(found.values()).size).toBe(parts.length)
  return found
}

// The landscape and the diagram's two marks in the sketch, and the same on the Agent canvas,
// where the strokes of the drawing are numbered in the order the agent named them.
const scene_sketch = (diagram: readonly Summary[], parts: ReadonlyMap<Part, Summary>): Scene => ({
  diagram: diagram.map((s) => on_sketch(s.id)),
  parts: new Map([...parts].map(([part, s]) => [part, on_sketch(s.id)])),
})
const scene_canvas = (scenery: readonly Summary[], parts: ReadonlyMap<Part, Summary>): Scene => ({
  diagram: [on_canvas('api'), on_canvas('db')],
  parts: new Map(
    [...parts].map(([part, s]) => [part, on_canvas(`scene.${scenery.indexOf(s)}`)]),
  ),
})

// What is drawn on the Agent canvas of a page, by tldraw's own shape type.
function drawn(page: Page): Promise<Record<string, number>> {
  return page.locator(`${pane} .tl-shape:not(.tl-shape-background)`).evaluateAll((shapes) => {
    const counts: Record<string, number> = {}

    for (const shape of shapes) {
      const type = shape.getAttribute('data-shape-type') ?? 'unknown'
      counts[type] = (counts[type] ?? 0) + 1
    }

    return counts
  })
}

async function frames(page: Page, selectors: readonly string[]): Promise<Frame[] | null> {
  const found: Frame[] = []

  for (const selector of selectors) {
    const shape = page.locator(selector)

    if ((await shape.count()) !== 1) return null

    const box = await shape.boundingBox()

    if (box === null || box.width <= 0 || box.height <= 0) return null

    found.push(box)
  }

  return found
}

// How some marks are arranged on screen, whatever the zoom: the proportions of the box around
// all of them, then where each lies in that box and how large it is, as fractions of the box.
function arrangement(marks: readonly Frame[]): number[] {
  const left = Math.min(...marks.map((mark) => mark.x))
  const top = Math.min(...marks.map((mark) => mark.y))
  const width = Math.max(...marks.map((mark) => mark.x + mark.width)) - left
  const height = Math.max(...marks.map((mark) => mark.y + mark.height)) - top
  const placed = marks.flatMap((mark) => [
    (mark.x - left) / width,
    (mark.y - top) / height,
    mark.width / width,
    mark.height / height,
  ])
  return [Math.log(width / height), ...placed]
}

// The largest difference between how the person's strokes lie in their sketch and how the
// same strokes lie on the Agent canvas, on one screen. Zero is the same picture.
async function arrangement_gap(page: Page, strokes: readonly Summary[]): Promise<number> {
  const sketched = await frames(page, strokes.map((s) => on_sketch(s.id)))
  const kept = await frames(page, strokes.map((_, place) => on_canvas(`scene.${place}`)))

  if (sketched === null || kept === null) return Infinity

  const a = arrangement(sketched)
  const b = arrangement(kept)
  return Math.max(...a.map((value, index) => Math.abs(value - (b[index] as number))))
}

// Polled: a page loads a new revision on its next poll and then fits it to its pane.
async function expect_picture(page: Page, strokes: readonly Summary[]) {
  expect(strokes.length).toBeGreaterThanOrEqual(2)
  await expect.poll(() => arrangement_gap(page, strokes)).toBeLessThan(0.03)

  for (const place of strokes.keys()) {
    await expect(page.locator(on_canvas(`scene.${place}`))).toHaveAttribute(
      'data-shape-type',
      'draw',
    )
  }
}

// Where the ink of each shape is on screen, all read in one go so that they belong to one
// frame: the box around what the shape draws, which for a pen stroke is the stroke itself,
// wherever it began. Null for a shape that is not there exactly once or shows nothing.
function inks(page: Page, selectors: readonly string[]): Promise<Array<Frame | null>> {
  return page.evaluate((list) => {
    return list.map((selector) => {
      const shapes = document.querySelectorAll(selector)
      const shape = shapes[0]

      if (shapes.length !== 1 || shape === undefined) return null

      const drawn = [...shape.querySelectorAll('path')]
      const rects = (drawn.length > 0 ? drawn : [shape])
        .map((mark) => mark.getBoundingClientRect())
        .filter((rect) => rect.width > 0 || rect.height > 0)

      if (rects.length === 0) return null

      const x = Math.min(...rects.map((rect) => rect.left))
      const y = Math.min(...rects.map((rect) => rect.top))
      const width = Math.max(...rects.map((rect) => rect.right)) - x
      const height = Math.max(...rects.map((rect) => rect.bottom)) - y
      return { x, y, width, height }
    })
  }, [...selectors])
}

async function scene_seen(page: Page, scene: Scene): Promise<Seen | null> {
  const parts = [...scene.parts]
  const found = await inks(page, [...scene.diagram, ...parts.map(([, selector]) => selector)])

  if (found.some((frame) => frame === null)) return null

  const frames = found as Frame[]
  const seen: Seen = { diagram: frames.slice(0, scene.diagram.length), parts: new Map() }

  for (const [index, [part]] of parts.entries()) {
    seen.parts.set(part, frames[scene.diagram.length + index] as Frame)
  }

  return seen
}

// Everything that keeps a landscape beside a diagram from reading as one, in words. Lengths
// are judged against the width of the house, so the zoom of a pane does not matter. Pure, so
// that it says the same of a sketch, of a canvas and of a made-up arrangement.
function scene_problems({ diagram, parts }: Seen): string[] {
  const [hill, walls, roof] = [parts.get('hill'), parts.get('walls'), parts.get('roof')]
  const [door, trail, sun] = [parts.get('door'), parts.get('path'), parts.get('sun')]
  const tree = parts.get('tree')
  const [upper, lower] = diagram

  if (!hill || !walls || !roof || !door || !trail || !sun) return ['a part of it is missing']

  if (!upper || !lower || diagram.length !== 2) return ['the diagram is not its two items']

  // Room for the width of the pen, and for a hand that does not close a corner exactly.
  const slack = walls.width * 0.3
  const right = (frame: Frame) => frame.x + frame.width
  const bottom = (frame: Frame) => frame.y + frame.height
  const middle = (frame: Frame) => frame.x + frame.width / 2
  const near = (a: number, b: number) => Math.abs(a - b) <= slack
  const across = (inner: Frame, outer: Frame) =>
    inner.x >= outer.x - slack && right(inner) <= right(outer) + slack
  const within = (inner: Frame, outer: Frame) =>
    across(inner, outer) && inner.y >= outer.y - slack && bottom(inner) <= bottom(outer) + slack
  const under_house = middle(trail) > walls.x && middle(trail) < right(walls)
  const rules: Array<[holds: boolean, otherwise: string]> = [
    [near(bottom(roof), walls.y), 'the roof does not rest on the walls'],
    [across(walls, roof) && roof.y < walls.y - slack, 'the roof does not cover the walls'],
    [within(door, walls), 'the door is not in the walls'],
    [near(bottom(door), bottom(walls)), 'the door does not reach the ground'],
    [across(walls, hill) && near(bottom(walls), hill.y), 'the house is not on top of the hill'],
    [bottom(sun) < roof.y && sun.x > right(walls), 'the sun is not up to the right of the house'],
    [trail.y >= bottom(walls) - slack, 'the path does not start at the foot of the house'],
    [under_house && across(trail, hill), 'the path does not lead from the door'],
    [bottom(trail) > hill.y + slack, 'the path does not run down the hill'],
    [bottom(upper) <= lower.y, 'the diagram is not one item above the other'],
    [diagram.every((item) => right(item) < hill.x), 'the diagram is not left of the landscape'],
  ]

  if (tree) {
    const on_slope = tree.x > right(walls) && across(tree, hill) && tree.y > bottom(sun)
    rules.push([on_slope, 'the tree is not on the slope to the right of the house'])
  }

  return rules.filter(([holds]) => !holds).map(([, otherwise]) => otherwise)
}

// The house is on its hill with the sun, the path and the diagram where they were drawn.
// Polled: a page loads a new revision on its next poll and then fits it to its pane.
async function expect_scene(page: Page, scene: Scene) {
  await expect
    .poll(async () => {
      const seen = await scene_seen(page, scene)
      return seen === null ? ['not all of it is on screen'] : scene_problems(seen)
    })
    .toEqual([])
}

async function expect_typeset(page: Page) {
  for (const [id, label] of [['api', 'API'], ['db', 'Postgres']] as const) {
    const shape = page.locator(on_canvas(id))
    await expect(shape).toHaveAttribute('data-shape-type', 'geo')
    await expect(shape.getByText(label, { exact: true })).toBeVisible()
  }

  await expect(page.locator(on_canvas('writes'))).toHaveAttribute('data-shape-type', 'arrow')
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

// One Interpret request from the iPad, received by the agent. Returns its event id. The note
// is a modal dialog: while it is open nothing behind it, the view tabs included, can be
// pressed. So the note is put away once the Mac has the request, as a person would before
// turning to the Agent canvas, and every step after starts on a board that can be pressed.
async function interpret_request(board: Linked): Promise<string> {
  const { ipad, bound } = board
  const before = bound('poll').events.length as number
  await composer_open(ipad)
  const toggle = interpret(ipad)
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await notify(ipad).tap()
  await expect.poll(() => bound('poll').events.length).toBe(before + 1)
  await composer_close(ipad)
  const event = bound('poll').events.at(-1) as { id: string; kind: string }
  expect(event.kind).toBe('interpret_request')

  for (const state of ['received', 'working']) {
    expect(bound('ack', '--event', event.id, '--state', state).status).toBe('success')
  }

  return event.id
}

test('a diagram is typeset, a picture stays as drawn, an Interpret keeps only the sketch', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad, stage, cli, bound, session, root } = board
    const status = () => cli('status', '--session', session)
    await stage.getByRole('tab', { name: 'Side by side' }).click()

    await step('a diagram alone is typeset, with nothing left as ink', async () => {
      await pen(board, diagram_marks, 0)
      const read = reading(board, 'diagram')
      expect(read.strokes).toHaveLength(2)
      expect(read.prompt).toContain('A picture is kept exactly as it was drawn')
      const [upper, lower] = read.strokes as [Summary, Summary]
      publish(board, read, diagram_graph(upper, lower))
      await expect.poll(() => drawn(stage)).toEqual({ geo: 2, arrow: 1 })
      await expect_typeset(stage)
      await capture(stage, info, 'interpret-1-diagram-alone')
    }, step_long_ms)

    const before = await step('a landscape beside it is kept as its own strokes', async () => {
      await pen(board, traces(parts_all), 2)
      await capture(ipad, info, 'interpret-2-sketch-ipad')
      const read = reading(board, 'mixed')
      expect(read.strokes).toHaveLength(2 + parts_all.length)
      const [upper, lower, ...scenery] = read.strokes as [Summary, Summary, ...Summary[]]
      const parts = named(scenery, parts_all)

      // What was drawn reads as a house on a hill before anything is made of it.
      await expect_scene(stage, scene_sketch([upper, lower], parts))
      const graph = diagram_graph(upper, lower)
      const [left, top] = at_of([lower], 20)
      const below = [left, top + 160, 260, 60]

      // The agent also leaves a remark of its own, joined to the diagram, as it once did.
      publish(board, read, {
        nodes: [
          ...graph.nodes,
          scene_node(scenery),
          { id: 'remark', kind: 'box', label: remark, origin: 'agent', at: below },
        ],
        edges: [
          ...graph.edges,
          { id: 'about', from: 'remark', to: 'db', direction: 'none', origin: 'agent' },
        ],
      })

      // Typeset diagram, seven native strokes, and no shape standing in for the scenery.
      await expect.poll(() => drawn(stage)).toEqual({ geo: 3, arrow: 2, draw: parts_all.length })
      await expect_typeset(stage)
      await expect_picture(stage, scenery)
      await expect_scene(stage, scene_canvas(scenery, parts))
      await expect(stage.locator(on_canvas('remark')).getByText(remark)).toBeVisible()
      await capture(stage, info, 'interpret-2-mixed-with-earlier-remark')

      // The published strokes are the sketch's own, sample for sample.
      const sketch = JSON.parse(fs.readFileSync(read.records_path, 'utf8')) as {
        records: Array<{ id: string; props: unknown }>
      }
      const url = `${board.origin}/api/cleaned.json?session=${session}&layer=canvas`
      const canvas = (await (await stage.request.get(url)).json()) as {
        records: Array<{ id: string; props: unknown }>
      }

      for (const [place, summary] of scenery.entries()) {
        const kept = canvas.records.find((r) => r.id === `shape:cleaned-scene.${place}`)
        const original = sketch.records.find((r) => r.id === summary.id)
        expect(kept?.props).toEqual(original?.props)
      }

      return status().document_hash as string
    }, step_long_ms)

    const scenery = await step('an Interpret after a change shows only the sketch', async () => {
      await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
      await expect.poll(() => status().shapes_count).toBe(2 + parts_kept.length)
      expect(status().document_hash).not.toBe(before)
      await capture(ipad, info, 'interpret-3-before-interpret-ipad')
      const event = await interpret_request(board)
      const read = reading(board, 'interpreted')
      expect(read.prompt).toContain('Rebuild the graph from the current sketch alone')
      expect(read.prompt).toContain('Leave out earlier agent-origin notes')
      expect(read.prompt).not.toContain('Keep obsolete attachments')
      const [upper, lower, ...left] = read.strokes as [Summary, Summary, ...Summary[]]
      const parts = named(left, parts_kept)
      await expect_scene(stage, scene_sketch([upper, lower], parts))
      publish(board, read, {
        ...diagram_graph(upper, lower),
        nodes: [...diagram_graph(upper, lower).nodes, scene_node(left)],
      })
      expect(bound('ack', '--event', event, '--state', 'updated').status).toBe('success')

      // The tree is gone with its stroke, and so is the remark, on both screens.
      const shown = { geo: 2, arrow: 1, draw: parts_kept.length }
      await expect.poll(() => drawn(stage)).toEqual(shown)
      await expect_typeset(stage)
      await expect_picture(stage, left)
      await expect_scene(stage, scene_canvas(left, parts))
      await expect(stage.locator(pane).getByText(remark)).toHaveCount(0)
      await expect(stage.locator(on_canvas('remark'))).toHaveCount(0)
      await capture(stage, info, 'interpret-3-after-interpret')
      await ipad.getByRole('tab', { name: 'Agent canvas' }).tap()
      await expect.poll(() => drawn(ipad)).toEqual(shown)
      await expect_typeset(ipad)
      await expect_scene(ipad, scene_canvas(left, parts))
      await expect(ipad.locator(pane).getByText(remark)).toHaveCount(0)
      await expect(ipad.locator(on_canvas('remark'))).toHaveCount(0)
      await capture(ipad, info, 'interpret-3-after-interpret-ipad')
      expect(status()).toMatchObject({ agent_revision: 3, cleaned_stale: false })
      return left
    }, step_long_ms)

    await step('the canvas copies into the sketch as shapes; Undo takes it back', async () => {
      const hash = status().document_hash as string
      const replace = ipad.getByRole('button', { name: 'Replace sketchboard' })
      await expect(replace).toBeEnabled()
      await replace.tap()
      await expect(ipad.getByText('Sketch replaced. Undo restores your ink.')).toBeVisible()
      await expect.poll(() => status().shapes_count).toBe(3 + parts_kept.length)
      const read = bound('snapshot', '--out', path.join(root, 'replaced'))
      expect(read.status).toBe('success')
      const { records } = JSON.parse(fs.readFileSync(read.records_path, 'utf8')) as {
        records: Array<{ id: string; typeName: string; type: string }>
      }
      const shapes = records.filter((record) => record.typeName === 'shape')
      const types = shapes.map((shape) => shape.type).sort()
      const strokes = scenery.map(() => 'draw')
      expect(strokes).toHaveLength(parts_kept.length)
      expect(types).toEqual(['arrow', ...strokes, 'geo', 'geo'])
      expect(records.every((record) => !record.id.includes(':cleaned-'))).toBe(true)
      await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
      await expect.poll(() => status().document_hash).toBe(hash)
      expect(status()).toMatchObject({ agent_revision: 3 })
    }, step_long_ms)
  })
})

test('a picture alone stays a picture, and an erased sketch empties the canvas', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad, stage, cli, bound, session } = board
    const status = () => cli('status', '--session', session)
    await stage.getByRole('tab', { name: 'Side by side' }).click()

    await step('a picture alone is published as its strokes and nothing else', async () => {
      await pen(board, traces(['hill', 'walls', 'sun']), 0)
      const read = reading(board, 'picture')
      expect(read.strokes).toHaveLength(3)
      publish(board, read, { nodes: [scene_node(read.strokes)] })
      await expect.poll(() => drawn(stage)).toEqual({ draw: 3 })
      await expect_picture(stage, read.strokes)
      await capture(stage, info, 'interpret-4-picture-alone')
    }, step_long_ms)

    await step('the board is cleared, and an Interpret empties the canvas', async () => {
      await ipad.getByRole('button', { name: 'Clear the board', exact: true }).tap()
      await ipad.getByRole('button', { name: 'Clear the board now' }).tap()
      await expect.poll(() => status().shapes_count).toBe(0)
      const event = await interpret_request(board)

      // An empty sketch is still a snapshot: the agent is told to publish an empty canvas.
      const read = reading(board, 'erased')
      expect(read.strokes).toEqual([])
      expect(read.prompt).toContain('The sketch is empty')
      expect(read.prompt).toContain('"nodes": [], "edges": []')
      publish(board, read, { nodes: [] })
      expect(bound('ack', '--event', event, '--state', 'updated').status).toBe('success')

      for (const page of [stage, ipad]) {
        if (page === ipad) await ipad.getByRole('tab', { name: 'Agent canvas' }).tap()

        await expect(page.locator(pane).getByText('The agent canvas is empty.')).toBeVisible()
        await expect(page.locator(`${pane} .tl-shape`)).toHaveCount(0)
      }

      // Nothing to copy: replacing the sketch could only fail, so it is not offered. The
      // empty canvas is loaded by now, which is what its words on the pane say.
      await expect(ipad.getByRole('button', { name: 'Replace sketchboard' })).toBeDisabled()
      await capture(stage, info, 'interpret-5-empty')
      await capture(ipad, info, 'interpret-5-empty-ipad')
      expect(status()).toMatchObject({ agent_revision: 2, cleaned_stale: false })
    }, step_long_ms)

    await step('a Notify note can still ask for a remark on the empty canvas', async () => {
      await ipad.getByRole('tab', { name: 'Sketchboard' }).tap()
      await pen(board, traces(['sun']), 0)
      await composer_open(ipad)
      await note(ipad).fill('What is this?')
      await notify(ipad).tap()
      await expect.poll(() => bound('poll').events.length).toBe(1)
      await composer_close(ipad)
      const [event] = bound('poll').events as [{ id: string; kind: string; text: string }]
      expect(event).toMatchObject({ kind: 'sketch_notify', text: 'What is this?' })
      const read = reading(board, 'noted')
      expect(read.prompt).toContain('add, change or remove agent-origin notes')
      publish(board, read, {
        nodes: [{ id: 'answer', kind: 'text', label: 'A sun, I think.', origin: 'agent' }],
      })
      const answer = stage.locator(on_canvas('answer'))
      await expect(answer.getByText('A sun, I think.', { exact: true })).toBeVisible()
      await expect.poll(() => drawn(stage)).toEqual({ text: 1 })
      await capture(stage, info, 'interpret-6-requested-remark')
      expect(status()).toMatchObject({ agent_revision: 3, shapes_count: 1 })

      // With something on the canvas again, it can be copied into the sketch again.
      await ipad.getByRole('tab', { name: 'Agent canvas' }).tap()
      await expect(ipad.locator(on_canvas('answer'))).toHaveCount(1)
      await expect(ipad.getByRole('button', { name: 'Replace sketchboard' })).toBeEnabled()
    }, step_long_ms)
  })
})
