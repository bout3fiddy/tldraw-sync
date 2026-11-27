// The floating tools and the chat's room, in real browsers on a disposable linked board. The
// strip holds the pen, the eraser, Undo and Redo, and nothing else: no inks, no Delete. The pen
// and eraser are one choice, and pressing the one held puts it down, leaving the pointer,
// with a mouse and with the Pencil. New ink is black; a shape in another colour keeps it.
// Undo and Redo are offered only when there is a step to take, and choosing the print leaves
// no step and no dot. The chat lies beside the canvas, and takes the screen only when the
// window or a keyboard leaves too little room.
//
// Run: bun run build && npx playwright test tests/tools.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { at_rest, print_choose, print_fit } from './one_canvas'
import {
  action_ms,
  board_linked,
  chat_open,
  expect_revision,
  navigation_ms,
  print_shape,
  sketch_open,
  soon,
  step,
  stroke,
  surface,
  type Linked,
} from './whiteboard_board'

test.use({ trace: 'off' })

type Json = Record<string, any>
type Point = { x: number; y: number }

// The design's iPad Pro 11 in landscape; a Mac window of the same size draws the same layout.
const design_screen = { width: 1194, height: 834 }
const drawer_width_px = 440

// Long enough for a press that should have written nothing to have reached the Mac.
const settle_ms = 500

const strip = (page: Page) => page.getByRole('navigation', { name: 'Drawing tools' })
const tool = (page: Page, name: string) => strip(page).getByRole('button', { name, exact: true })

async function held(page: Page, pen: boolean, eraser: boolean) {
  await expect(tool(page, 'Pen')).toHaveAttribute('aria-pressed', String(pen))
  await expect(tool(page, 'Eraser')).toHaveAttribute('aria-pressed', String(eraser))
}

async function offered(page: Page, undo: boolean, redo: boolean) {
  await expect(tool(page, 'Undo')).toBeEnabled({ enabled: undo })
  await expect(tool(page, 'Redo')).toBeEnabled({ enabled: redo })
}

test('the floating tools: one pen in black, a pointer by pressing again, honest undo', async ({
  browser,
}) => {
  await board_linked(browser, async (board) => {
    const mac = await browser.newPage({ viewport: design_screen })
    mac.setDefaultTimeout(action_ms)
    mac.setDefaultNavigationTimeout(navigation_ms)

    try {
      await mac.goto(`${board.origin}/s/${board.session}/draw`)
      await expect(surface(mac)).toBeVisible()
      await step('the strip floats with only its four tools', () => strip_only(mac))
      await step('the agent publishes a coloured shape', async () => publish(board))
      await step('undo and redo are offered only with a step to take', () => history(board, mac))
      await step('pen and eraser toggle; the pointer writes nothing', () => toggles(board, mac))
      await step('a coloured shape keeps its colour; new ink is black', () => colours(board, mac))
      await step('the chat lies beside the canvas until there is no room', () => room(mac))
      await step('the Pencil writes, then points and chooses', () => pencil(board))
    } finally {
      await mac.close()
    }
  })
})

// Four tools in a frame at the left, over the canvas, which keeps the whole screen: no band
// across the top, no ink wells and no Delete beside them.
async function strip_only(mac: Page) {
  const labels = await strip(mac)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  expect(labels).toEqual(['Pen', 'Eraser', 'Undo', 'Redo'])
  await expect(mac.getByRole('group', { name: 'Inks' })).toHaveCount(0)
  await expect(mac.getByRole('button', { name: / ink$/ })).toHaveCount(0)
  await expect(mac.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
  await expect(mac.locator('header, footer')).toHaveCount(0)

  const frame = (await strip(mac).boundingBox())!
  const canvas = (await surface(mac).boundingBox())!
  expect(frame.x).toBeLessThan(32)
  expect(frame.width).toBeLessThan(80)
  expect(canvas).toEqual({ x: 0, y: 0, ...design_screen })
  await held(mac, true, false)
  await offered(mac, false, false)
}

function publish({ bound, root, session }: Linked) {
  const snap = bound('snapshot', '--out', path.join(root, 'tools'))
  const scene = JSON.parse(fs.readFileSync(snap.scene_path, 'utf8')) as Json
  const box = { type: 'geo', y: 0, w: 220, h: 90, font: 'sans' }
  scene.elements = [
    { ...box, id: 'a', x: 0, text: 'Keep', color: 'green' },
    { ...box, id: 'b', x: 320, text: 'Release' },
  ]
  fs.writeFileSync(snap.scene_path, JSON.stringify(scene))
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({
    code: 'published',
    session,
    revision: 1,
    shapes_count: 2,
  })
}

// A mouse stroke from `from`, eight steps to the right.
async function mouse_stroke(page: Page, from: Point) {
  await soon(page.mouse.move(from.x, from.y))
  await soon(page.mouse.down())

  for (let n = 1; n <= 8; n += 1) {
    await soon(page.mouse.move(from.x + n * 12, from.y + (n % 2) * 6))
  }

  await soon(page.mouse.up())
}

// A point well clear of the print, the strip and the key: under the agent's second box.
async function beside_print(page: Page): Promise<Point> {
  const box = (await print_shape(page, 'b').boundingBox())!
  return { x: box.x + 20, y: box.y + box.height + 120 }
}

async function drawing(page: Page, { origin, session }: Linked): Promise<Json[]> {
  const response = await page.request.get(`${origin}/api/drawing.json?session=${session}`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as Json[]
}

// Each stroke is one step. Undo is offered while there is one; once the last is taken back it
// is not, and Redo is. A click that chooses the print is no step at all. When every mouse
// press of the pen was marked, Undo stayed offered with nothing left to undo.
async function history(board: Linked, mac: Page) {
  const status = () => board.cli('status', '--session', board.session)
  const before = status()
  await expect_revision(mac, 1)
  await print_fit(mac, 'a')
  await mouse_stroke(mac, await beside_print(mac))
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await offered(mac, true, false)

  await tool(mac, 'Undo').click()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
  await offered(mac, false, true)
  await tool(mac, 'Redo').click()
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await offered(mac, true, false)
  await tool(mac, 'Undo').click()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
  await offered(mac, false, true)

  // A stroke that begins on the print is ink, and one step, like any other.
  const box = (await print_shape(mac, 'b').boundingBox())!
  await mouse_stroke(mac, { x: box.x + 30, y: box.y + box.height / 2 })
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await offered(mac, true, false)
  await tool(mac, 'Undo').click()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
  await offered(mac, false, true)

  // A click on the print chooses it, and leaves no dot and no step to undo. The pen wrote
  // the dot before taking it back, so, as after any writing, there is nothing left to redo.
  const card = await print_choose(mac, 'a', false)
  await mac.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await mac.waitForTimeout(settle_ms)
  expect(status().document_hash).toBe(before.document_hash)
  await offered(mac, false, false)

  // Escape put the card away, and only the card: the pen is still held. When tldraw heard it
  // too, it cancelled the pen and left the pointer.
  await held(mac, true, false)
}

// The held tool, pressed again, is put down: the pointer writes and erases nothing, and still
// chooses the print. Pressing the other tool swaps them.
async function toggles(board: Linked, mac: Page) {
  const status = () => board.cli('status', '--session', board.session)
  const before = status()
  await held(mac, true, false)
  await tool(mac, 'Pen').click()
  await held(mac, false, false)
  await expect(strip(mac)).toHaveAttribute('data-tool', 'select')

  await mouse_stroke(mac, await beside_print(mac))
  const card = await print_choose(mac, 'b', false)
  await mac.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await mac.waitForTimeout(settle_ms)
  expect(status().document_hash).toBe(before.document_hash)

  await tool(mac, 'Eraser').click()
  await held(mac, false, true)
  await tool(mac, 'Pen').click()
  await held(mac, true, false)
  await tool(mac, 'Eraser').click()
  await held(mac, false, true)
  await tool(mac, 'Eraser').click()
  await held(mac, false, false)
  await tool(mac, 'Pen').click()
  await held(mac, true, false)
}

// A shape taken from the print keeps the agent's green; ink written after it is black.
async function colours(board: Linked, mac: Page) {
  const status = () => board.cli('status', '--session', board.session)
  const before = status()
  const card = await print_choose(mac, 'a', false)
  await card.getByRole('button', { name: 'Take into my sketch' }).click()
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)

  await mouse_stroke(mac, await beside_print(mac))
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 2)
  const shapes = await drawing(mac, board)
  const taken = shapes.filter((shape) => shape.meta?.taken_from)
  const ink = shapes.filter((shape) => shape.type === 'draw')
  expect(taken.map((shape) => shape.props.color)).toEqual(['green'])
  expect(ink.map((shape) => shape.props.color)).toEqual(['black'])

  for (const count of [1, 0]) {
    await tool(mac, 'Undo').click()
    await expect.poll(() => status().shapes_count).toBe(before.shapes_count + count)
  }

  expect(status().document_hash).toBe(before.document_hash)
  await offered(mac, false, true)
}

const drawer_width = async (page: Page) => {
  const box = await page.getByRole('complementary', { name: 'Chat' }).boundingBox()
  return Math.round(box!.width)
}

// Beside the canvas at the design's size, the canvas giving up only the chat's width and its
// print where it was. A keyboard that leaves too little height, or a window too short to share,
// gives the chat the screen; the canvas keeps its camera underneath.
async function room(mac: Page) {
  const print = '.print__shape[data-print-shape="shape:scene-a"]'
  const rested = await at_rest(mac, print)
  await chat_open(mac)
  expect(await drawer_width(mac)).toBe(drawer_width_px)
  expect(Math.round((await surface(mac).boundingBox())!.width)).toBe(
    design_screen.width - drawer_width_px,
  )
  expect(await at_rest(mac, print)).toBe(rested)

  await soon(
    mac.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', {
        configurable: true,
        value: innerHeight - 500,
      })
      visualViewport!.dispatchEvent(new Event('resize'))
    }),
  )
  await expect.poll(() => drawer_width(mac)).toBe(design_screen.width)
  await expect(mac.getByRole('separator', { name: 'Chat width' })).toHaveCount(0)
  await expect(mac.locator('.surface')).toBeHidden()
  await soon(
    mac.evaluate(() => {
      Reflect.deleteProperty(visualViewport!, 'height')
      visualViewport!.dispatchEvent(new Event('resize'))
    }),
  )
  await expect.poll(() => drawer_width(mac)).toBe(drawer_width_px)
  await sketch_open(mac)
  expect(await at_rest(mac, print)).toBe(rested)

  const short = { width: design_screen.width, height: 460 }
  await soon(mac.setViewportSize(short))
  const short_rested = await at_rest(mac, print)
  await chat_open(mac)
  expect(await drawer_width(mac)).toBe(short.width)
  await expect(mac.getByRole('separator', { name: 'Chat width' })).toHaveCount(0)
  await sketch_open(mac)
  expect(await at_rest(mac, print)).toBe(short_rested)
  await soon(mac.setViewportSize(design_screen))
}

// On the iPad, where only the Pencil draws: it writes in black; with the pen put down it points,
// writing nothing and choosing the print as a finger does.
async function pencil(board: Linked) {
  const { ipad } = board
  const status = () => board.cli('status', '--session', board.session)
  const before = status()
  await held(ipad, true, false)
  await print_fit(ipad, 'a')
  const from = await beside_print(ipad)
  await stroke(ipad, from, { x: 20, y: 10 })
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  const ink = (await drawing(ipad, board)).filter((shape) => shape.type === 'draw')
  expect(ink.map((shape) => shape.props.color)).toEqual(['black'])
  const written = status().document_hash

  await tool(ipad, 'Pen').tap()
  await held(ipad, false, false)
  await stroke(ipad, { x: from.x, y: from.y + 60 }, { x: 20, y: 10 })
  const box = (await print_shape(ipad, 'b').boundingBox())!
  await stroke(ipad, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: 0, y: 0 })
  const card = ipad.getByRole('dialog', { name: 'Agent shape' })
  await expect(card).toContainText('Drawn by the agent · revision 1')
  await ipad.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await ipad.waitForTimeout(settle_ms)
  expect(status().document_hash).toBe(written)

  await tool(ipad, 'Pen').tap()
  await held(ipad, true, false)
  await tool(ipad, 'Undo').tap()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
}
