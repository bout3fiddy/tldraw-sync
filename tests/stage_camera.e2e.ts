// Camera ownership on the real read-only route. Only the paired fixture iPad writes ink.
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { expect_framed } from './one_canvas'
import {
  board_linked,
  chat_open,
  draw,
  expect_marks_clear,
  print_region,
  print_shape,
  sketch_open,
  stroke,
  surface,
  type Linked,
} from './whiteboard_board'

// Pairing material must not enter a trace.
test.use({ trace: 'off' })

const camera = (page: Page) =>
  surface(page)
    .locator('.tl-shapes')
    .evaluate((layer) => getComputedStyle(layer).transform)
const zoom = (page: Page) =>
  surface(page)
    .locator('.tl-container')
    .evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--tl-zoom')))
const fit = (page: Page) => page.getByRole('button', { name: 'Fit board', exact: true })

async function publish({ root, bound, stage }: Linked, revision: number, x: number) {
  const snap = bound('snapshot', '--out', path.join(root, `print-${revision}`))
  const scene = JSON.parse(fs.readFileSync(snap.scene_path, 'utf8'))
  scene.agent = 'fixture'
  scene.summary = 'A distant marker.'
  scene.elements = [{ type: 'geo', id: 'marker', x, y: 200, w: 120, h: 80 }]
  fs.writeFileSync(snap.scene_path, JSON.stringify(scene))
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({ code: 'published', revision })
  await expect(print_region(stage)).toHaveAttribute('data-view', String(revision))
}

async function capture({ stage, origin, session }: Linked) {
  const response = await stage.request.get(`${origin}/api/drawing.png?session=${session}`)
  expect(response.headers()['content-type']).toBe('image/png')
  expect(response.ok()).toBe(true)
  const hash = response.headers()['x-document-hash']
  expect(hash).toBeTruthy()
  return { hash, bytes: await response.body() }
}

test('only navigating content releases the Mac camera; Fit board returns it to follow', async ({
  browser,
}) => {
  await board_linked(browser, async (board) => {
    const { stage, ipad } = board
    const pen_camera = await camera(ipad)
    const marker = print_shape(stage, 'marker')
    await stage.mouse.click(420, 320)
    await stage.mouse.wheel(160, 200)
    await expect(fit(stage)).toHaveCount(0)
    await publish(board, 1, 6000)
    await expect_framed(marker)
    await expect.poll(() => zoom(stage)).toBe(2)

    // Print alone is navigable. Ordinary scrolling pans without zooming or changing the pen.
    await stage.mouse.move(420, 320)
    const centered = await camera(stage)
    await stage.mouse.wheel(100, 150)
    await expect(fit(stage)).toBeVisible()
    expect(await camera(stage)).not.toBe(centered)
    expect(await zoom(stage)).toBe(2)
    await fit(stage).click()
    await expect.poll(() => camera(stage)).toBe(centered)

    await zoom_limits(stage)
    await expect.poll(() => camera(stage)).toBe(centered)

    // A passive viewer sees the distant first stroke and print together.
    await draw(ipad)
    await expect.poll(() => zoom(stage)).toBeLessThan(1)
    await expect_framed(marker)
    await expect(fit(stage)).toHaveCount(0)
    await detached_updates(board)
    expect(await camera(ipad)).toBe(pen_camera)
  })
})

async function zoom_limits(stage: Page) {
  await stage.mouse.move(420, 320)
  await stage.keyboard.down('Control')

  try {

    // The SDK normalizes each wheel event to at most ten percent of current zoom.
    for (let i = 0; i < 20; i++) await stage.mouse.wheel(0, -200)

    await expect.poll(() => zoom(stage)).toBe(8)

    for (let i = 0; i < 85; i++) await stage.mouse.wheel(0, 200)

    await expect.poll(() => zoom(stage)).toBe(0.005)
  } finally {
    await stage.keyboard.up('Control')
  }

  await fit(stage).click()
}

async function detached_updates(board: Linked) {
  const { stage, ipad, cli, session } = board
  const marker = print_shape(stage, 'marker')
  const before = await capture(board)
  const fitted = await camera(stage)
  await stage.mouse.dblclick(420, 320)
  await expect(fit(stage)).toBeVisible()
  await expect.poll(() => camera(stage)).not.toBe(fitted)

  // A discrete zoom uses the ladder, not a jump from a distant fit straight to 8x.
  await expect.poll(async () => [0.25, 0.5].includes(await zoom(stage))).toBe(true)
  expect(await capture(board)).toEqual(before)
  const held = await camera(stage)
  await chat_open(stage)
  const edge = stage.getByRole('separator', { name: 'Chat width' })
  await edge.press('Home')
  await expect(edge).toHaveAttribute('aria-valuenow', '320')
  await stage.setViewportSize({ width: 1260, height: 820 })
  await expect_marks_clear(stage, 1)
  await sketch_open(stage)
  await publish(board, 2, -18000)
  await expect(marker).not.toBeInViewport()
  expect(await camera(stage)).toBe(held)
  await stroke(ipad, { x: 450, y: 650 }, { x: 25, y: -12 })
  await expect.poll(() => cli('status', '--session', session).shapes_count).toBe(2)
  const detached = await capture(board)
  expect(detached.hash).not.toBe(before.hash)
  expect(await camera(stage)).toBe(held)
  await fit(stage).press('Enter')
  await expect(fit(stage)).toHaveCount(0)
  await expect_framed(marker)
  await publish(board, 3, 30000)
  await expect_framed(marker)
  await expect(fit(stage)).toHaveCount(0)

  // A fresh mount renders the same records again, this time while fitted. Compare actual
  // uploaded PNG bytes, not just two reads of a cached image.
  const uploaded = stage.waitForResponse(
    (r) => r.url().includes('/api/drawing.png?') && r.request().method() === 'PUT' && r.ok(),
  )
  await stage.reload()
  await uploaded
  expect(await capture(board)).toEqual(detached)
  expect(cli('status', '--session', session).document_hash).toBe(detached.hash)
}
