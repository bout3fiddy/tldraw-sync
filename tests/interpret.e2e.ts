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
// Run: bun run build && npx playwright test tests/interpret.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  board_linked,
  composer_open,
  interpret,
  note,
  notify,
  step,
  step_long_ms,
  stroke,
  type Linked,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots. Every screenshot
// here is taken after the iPad has paired, when no page shows a pairing code any more.
test.use({ trace: 'off' })

type Point = { x: number; y: number }
type Mark = readonly [from: Point, by: Point]
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

// Two short pen lines on the left stand for the diagram's two items. The landscape is on the
// right: a hill, a house, the sun and a tree, in that order from left to right.
const diagram_marks: Mark[] = [
  [{ x: 300, y: 300 }, { x: 25, y: 0 }],
  [{ x: 300, y: 420 }, { x: 25, y: 0 }],
]
const hill: Mark = [{ x: 480, y: 520 }, { x: 60, y: -15 }]
const house: Mark = [{ x: 560, y: 430 }, { x: 15, y: 0 }]
const sun: Mark = [{ x: 600, y: 280 }, { x: 12, y: 12 }]
const tree: Mark = [{ x: 680, y: 400 }, { x: 0, y: 30 }]

const remark = 'You are. I’m just the mirror with a polling loop.'

// Line breaks in the agent's instructions are layout: the wording is compared on one line.
const flat = (text: string) => text.replace(/\s+/g, ' ')
const pane = '.views__pane--cleaned'
const shape_in = (where: string, id: string) =>
  `${where} .tl-shape[data-shape-id="${id}"]:not(.tl-shape-background)`
const on_canvas = (id: string) => shape_in(pane, `shape:cleaned-${id}`)
const on_sketch = (id: string) => shape_in('.views__pane--sketch', id)

// Pen strokes on the iPad, each one counted on the Mac before the next is drawn.
async function pen(board: Linked, marks: readonly Mark[], count_before: number) {
  const { ipad, cli, session } = board

  for (const [index, [from, by]] of marks.entries()) {
    await stroke(ipad, from, by)
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

// One Interpret request from the iPad, received by the agent. Returns its event id.
async function interpret_request(board: Linked): Promise<string> {
  const { ipad, bound } = board
  const before = bound('poll').events.length as number
  await composer_open(ipad)
  const toggle = interpret(ipad)
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await notify(ipad).tap()
  await expect.poll(() => bound('poll').events.length).toBe(before + 1)
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
      await pen(board, [hill, house, sun, tree], 2)
      const read = reading(board, 'mixed')
      expect(read.strokes).toHaveLength(6)
      const [upper, lower, ...scenery] = read.strokes as [Summary, Summary, ...Summary[]]
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

      // Typeset diagram, four native strokes, and no shape standing in for the scenery.
      await expect.poll(() => drawn(stage)).toEqual({ geo: 3, arrow: 2, draw: 4 })
      await expect_typeset(stage)
      await expect_picture(stage, scenery)
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
      await expect.poll(() => status().shapes_count).toBe(5)
      expect(status().document_hash).not.toBe(before)
      const event = await interpret_request(board)
      const read = reading(board, 'interpreted')
      expect(read.prompt).toContain('Rebuild the graph from the current sketch alone')
      expect(read.prompt).toContain('Leave out earlier agent-origin notes')
      expect(read.prompt).not.toContain('Keep obsolete attachments')
      const [upper, lower, ...left] = read.strokes as [Summary, Summary, ...Summary[]]
      expect(left).toHaveLength(3)
      publish(board, read, {
        ...diagram_graph(upper, lower),
        nodes: [...diagram_graph(upper, lower).nodes, scene_node(left)],
      })
      expect(bound('ack', '--event', event, '--state', 'updated').status).toBe('success')

      // The tree is gone with its stroke, and so is the remark, on both screens.
      await expect.poll(() => drawn(stage)).toEqual({ geo: 2, arrow: 1, draw: 3 })
      await expect_typeset(stage)
      await expect_picture(stage, left)
      await expect(stage.locator(pane).getByText(remark)).toHaveCount(0)
      await expect(stage.locator(on_canvas('remark'))).toHaveCount(0)
      await capture(stage, info, 'interpret-3-after-interpret')
      await ipad.getByRole('tab', { name: 'Agent canvas' }).tap()
      await expect.poll(() => drawn(ipad)).toEqual({ geo: 2, arrow: 1, draw: 3 })
      await expect_typeset(ipad)
      await expect(ipad.locator(pane).getByText(remark)).toHaveCount(0)
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
      await expect.poll(() => status().shapes_count).toBe(6)
      const read = bound('snapshot', '--out', path.join(root, 'replaced'))
      expect(read.status).toBe('success')
      const { records } = JSON.parse(fs.readFileSync(read.records_path, 'utf8')) as {
        records: Array<{ id: string; typeName: string; type: string }>
      }
      const shapes = records.filter((record) => record.typeName === 'shape')
      const types = shapes.map((shape) => shape.type).sort()
      expect(types).toEqual(['arrow', 'draw', 'draw', 'draw', 'geo', 'geo'])
      expect(records.every((record) => !record.id.includes(':cleaned-'))).toBe(true)
      expect(scenery).toHaveLength(3)
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
      await pen(board, [hill, house, sun], 0)
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

      await capture(stage, info, 'interpret-5-empty')
      await capture(ipad, info, 'interpret-5-empty-ipad')
      expect(status()).toMatchObject({ agent_revision: 2, cleaned_stale: false })
    }, step_long_ms)

    await step('a Notify note can still ask for a remark on the empty canvas', async () => {
      await ipad.getByRole('tab', { name: 'Sketchboard' }).tap()
      await pen(board, [sun], 0)
      await composer_open(ipad)
      await note(ipad).fill('What is this?')
      await notify(ipad).tap()
      await expect.poll(() => bound('poll').events.length).toBe(1)
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
    }, step_long_ms)
  })
})
