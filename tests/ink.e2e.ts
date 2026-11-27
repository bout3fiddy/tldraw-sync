// Ink stays legible however far out it is written or shown. The board that escaped was written
// at tldraw's furthest zoom with a nib three page units wide: a seventh of a pixel on the iPad,
// and cropped on a Mac window too small to show it at a twentieth. Here a stroke is written at
// full size and another zoomed all the way out, and both pages are measured as rendered.
//
// Run: bun run build && npx playwright test tests/ink.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { child_stop, contexts_close } from './board_child'

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli_entry = path.join(repo_root, 'src', 'cli', 'main.ts')
const bun = process.env.BUN ?? 'bun'
const data_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ink-e2e-'))
const ready_wait_ms = 20_000
// The narrowest ink either page may show, in CSS pixels, with room for rounding.
const ink_width_min_px = 1.4
const zoom_floor_tldraw = 0.05

let port = 0
let server: ChildProcess | null = null

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

test.beforeAll(async () => {
  port = await port_free_pick()
  server = spawn(bun, [cli_entry, 'serve', '--port', String(port)], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    stdio: 'ignore',
  })
  const deadline_ms = Date.now() + ready_wait_ms

  while (Date.now() < deadline_ms) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('the board did not start')
})

test.afterAll(async () => {
  try {
    if (server !== null) await child_stop(server)
  } finally {
    fs.rmSync(data_directory, { recursive: true, force: true })
  }
})

type Stroke = { props: { scale: number } }

async function strokes(): Promise<Stroke[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/drawing.json`)
  return (await response.json()) as Stroke[]
}

async function stroke_draw(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y)
  await page.mouse.down()

  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(x + step * 8, y + Math.sin(step) * 20, { steps: 2 })
  }

  await page.mouse.up()
}

const zoom_read = async (page: Page): Promise<number> =>
  Number(
    await page
      .locator('section[aria-label="Canvas"] .tl-container')
      .evaluate((container) => getComputedStyle(container).getPropertyValue('--tl-zoom')),
  )

// The width on the screen of the thinnest stroke drawn as a line, or null when every stroke
// is a filled shape, which is as wide as its outline.
async function line_width_min_px(page: Page): Promise<number | null> {
  const zoom = await zoom_read(page)
  const widths = await page
    .locator('section[aria-label="Canvas"] .tl-shape[data-shape-type="draw"] path[stroke]')
    .evaluateAll((paths) => paths.map((path) => parseFloat(getComputedStyle(path).strokeWidth)))
  return widths.length === 0 ? null : Math.min(...widths) * zoom
}

test('ink written and shown far zoomed out is never a hairline', async ({ browser }) => {
  const origin = `http://127.0.0.1:${port}`
  const contexts = [
    await browser.newContext({ viewport: { width: 640, height: 480 } }),
    await browser.newContext({ viewport: { width: 1180, height: 820 } }),
  ]

  try {
    const stage = await contexts[0]!.newPage()
    const ipad = await contexts[1]!.newPage()
    await stage.goto(origin)
    await ipad.goto(`${origin}/draw`)
    await expect(ipad.getByRole('region', { name: 'Canvas' })).toBeVisible()
    await expect(ipad.getByRole('tab')).toHaveCount(0)

    // At full size the nib is the nib.
    await stroke_draw(ipad, 500, 400)
    const scales = async () => (await strokes()).map((stroke) => Math.round(stroke.props.scale))
    await expect.poll(scales).toEqual([1])

    // Zoomed all the way out, the stroke written at full size is still a line one can see.
    await ipad.mouse.move(500, 400)
    await ipad.keyboard.down('Control')
    for (let step = 0; step < 60; step += 1) await ipad.mouse.wheel(0, 200)
    await ipad.keyboard.up('Control')
    await expect.poll(() => zoom_read(ipad)).toBeCloseTo(zoom_floor_tldraw, 5)
    await expect.poll(() => line_width_min_px(ipad)).toBeGreaterThanOrEqual(ink_width_min_px)

    // A stroke written out here is stored as wide as it looked: the nib follows the zoom.
    await stroke_draw(ipad, 150, 150)
    await stroke_draw(ipad, 950, 700)
    await expect.poll(scales).toEqual([1, 1 / zoom_floor_tldraw, 1 / zoom_floor_tldraw])

    // The stage shows the whole board, past tldraw's own zoom floor, and no hairlines either.
    await expect.poll(() => zoom_read(stage)).toBeLessThan(zoom_floor_tldraw)
    expect(await zoom_read(stage)).toBeGreaterThan(0)
    await expect.poll(() => line_width_min_px(stage)).toBeGreaterThanOrEqual(ink_width_min_px)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})
