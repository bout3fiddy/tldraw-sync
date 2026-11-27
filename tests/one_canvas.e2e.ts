// The one canvas with a mouse, on a Mac draw page with no touch, at the size the One canvas
// design draws: a click on the agent's print chooses its shape and leaves no dot of ink, a drag
// that starts on the print writes ink as on paper, a take lands where the print has it and one
// Undo takes it back, and the chat opens over the canvas without moving anything on it.
//
// Run: bun run build && npx playwright test tests/one_canvas.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { at_rest, painted, print_choose, print_fit, published } from './one_canvas'
import {
  action_ms,
  board_linked,
  chat_button,
  chat_open,
  expect_revision,
  navigation_ms,
  print_shape,
  sketch_open,
  step,
  surface,
  type Linked,
} from './whiteboard_board'

test.use({ trace: 'off' })

type Json = Record<string, any>

// The design's iPad Pro 11 in landscape; a Mac window of the same size draws the same layout.
const design_screen = { width: 1194, height: 834 }

test('a mouse chooses and takes the print, never leaving a dot, and chat overlays', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const mac = await browser.newPage({ viewport: design_screen })
    mac.setDefaultTimeout(action_ms)
    mac.setDefaultNavigationTimeout(navigation_ms)

    try {
      await mac.goto(`${board.origin}/s/${board.session}/draw`)
      await expect(surface(mac)).toBeVisible()
      await step('the agent publishes a scene', async () => publish(board))
      await step('a click chooses, a drag draws, a take is one undo', () => clicks(board, mac))
      const hash = board.cli('status', '--session', board.session).document_hash
      await step('the chat lies over the canvas and moves nothing on it', () =>
        overlay(mac, info.outputPath('mac-chat.png')),
      )
      expect(board.cli('status', '--session', board.session).document_hash).toBe(hash)
      await info.attach('mac-chat', { path: info.outputPath('mac-chat.png') })
    } finally {
      await mac.close()
    }
  })
})

function publish({ bound, root, session }: Linked) {
  const snap = bound('snapshot', '--out', path.join(root, 'mouse'))
  const scene = JSON.parse(fs.readFileSync(snap.scene_path, 'utf8')) as Json
  scene.elements = [
    { type: 'geo', id: 'a', x: 0, y: 0, w: 220, h: 90, text: 'Hold stock', font: 'sans' },
    { type: 'geo', id: 'b', x: 320, y: 0, w: 220, h: 90, text: 'Release', font: 'sans' },
  ]
  fs.writeFileSync(snap.scene_path, JSON.stringify(scene))
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({
    code: 'published',
    session,
    revision: 1,
    shapes_count: 2,
  })
}

async function clicks({ cli, session, origin }: Linked, mac: Page) {
  const status = () => cli('status', '--session', session)
  const before = status()
  await expect_revision(mac, 1)
  await print_fit(mac, 'a')
  expect((await painted(mac, 'a')).violet).toBeGreaterThan(50)

  // The print's lettering is shown, not carried over hidden from the engine that drew it.
  await expect(print_shape(mac, 'a').getByText('Hold stock', { exact: true })).toBeVisible()

  // A click is a choice: the card, and not one mark of ink.
  const card = await print_choose(mac, 'a', false)
  await expect(card).toContainText('Drawn by the agent · revision 1')
  await mac.waitForTimeout(500)
  expect(status().document_hash).toBe(before.document_hash)

  // Taken, the copy is where the print has it; one Undo, from the strip, takes it back.
  await card.getByRole('button', { name: 'Take into my sketch' }).click()
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await expect(print_shape(mac, 'a')).toHaveAttribute('data-state', 'taken')
  const source = (await published(mac, origin, session)).find((r) => r.id === 'shape:scene-a')!
  const response = await mac.request.get(`${origin}/api/drawing.json?session=${session}`)
  const copies = ((await response.json()) as Json[]).filter((r) => r.meta?.taken_from)
  expect(copies).toEqual([expect.objectContaining({ x: source.x, y: source.y })])
  await mac.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
  await expect(print_shape(mac, 'a')).toHaveAttribute('data-state', 'shown')

  // A drag that starts on the print is a stroke: the pen writes over the print as over paper.
  const box = (await print_shape(mac, 'b').boundingBox())!
  await mac.mouse.move(box.x + 30, box.y + box.height / 2)
  await mac.mouse.down()

  for (let step = 1; step <= 8; step += 1) {
    await mac.mouse.move(box.x + 30 + step * 15, box.y + box.height / 2 + (step % 2) * 6)
  }

  await mac.mouse.up()
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await expect(mac.getByRole('dialog', { name: 'Agent shape' })).toHaveCount(0)
  expect(status()).toMatchObject({ agent_revision: 1 })
  await mac.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
}

// The chat opens over the right of the canvas, as the design draws it: 440px of vellum under
// the Chat button, which is set in ink. The print and the ink stay exactly where they were.
async function overlay(mac: Page, picture: string) {
  const print = await at_rest(mac, '.print__shape[data-print-shape="shape:scene-a"]')
  await chat_open(mac)
  const aside = mac.getByRole('complementary', { name: 'Chat' })
  await expect
    .poll(async () => {
      const box = (await aside.boundingBox())!
      return [Math.round(box.width), Math.round(box.x + box.width)]
    })
    .toEqual([440, design_screen.width])
  const drawer = (await aside.boundingBox())!
  const button = (await chat_button(mac).boundingBox())!
  expect(button.x).toBeGreaterThan(drawer.x)
  const canvas = (await surface(mac).boundingBox())!
  expect(Math.round(canvas.width)).toBe(design_screen.width - 440)
  expect(await at_rest(mac, '.print__shape[data-print-shape="shape:scene-a"]')).toBe(print)
  const edge = mac.getByRole('separator', { name: 'Chat width' })
  await mac.mouse.move(drawer.x + 1, drawer.height / 2)
  await mac.mouse.down()
  await mac.mouse.move(drawer.x - 99, drawer.height / 2, { steps: 4 })
  await mac.mouse.up()
  await expect(edge).toHaveAttribute('aria-valuenow', '540')
  expect(Math.round((await surface(mac).boundingBox())!.width)).toBe(design_screen.width - 540)
  expect(await at_rest(mac, '.print__shape[data-print-shape="shape:scene-a"]')).toBe(print)
  await expect(surface(mac).locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(0)
  await mac.screenshot({ path: picture })
  await sketch_open(mac)
  expect(await at_rest(mac, '.print__shape[data-print-shape="shape:scene-a"]')).toBe(print)
}
