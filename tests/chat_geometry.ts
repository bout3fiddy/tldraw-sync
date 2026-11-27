// Rendered geometry, on the disposable board that the chat journey has already paired.
import { expect, type Locator, type Page } from '@playwright/test'
import {
  add_sketch,
  chat_open,
  field,
  ipad_narrow,
  ipad_portrait,
  sketch_open,
  type Linked,
} from './whiteboard_board'

const edge = (page: Page) => page.getByRole('separator', { name: 'Chat width' })
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Chat' })
const camera = (page: Page) =>
  page.locator('.surface .tl-shapes').evaluate((layer) => getComputedStyle(layer).transform)

async function split(page: Page, width: number) {
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(width))
  const chat = (await drawer(page).boundingBox())!
  const canvas = (await page.locator('.surface .tl-container').boundingBox())!
  const grip = (await edge(page).boundingBox())!

  // No part of the resize target may intercept a press meant for the drawing or its notice.
  expect(grip.x).toBeGreaterThanOrEqual(chat.x)
  expect(grip.x - chat.x).toBeLessThanOrEqual(1)
  expect(chat.width).toBe(width)
  expect(canvas.x + canvas.width).toBe(chat.x)
  expect(canvas.width).toBeGreaterThanOrEqual(360)
}

export async function compact_chat(page: Page, chip: Locator, screenshot: string) {
  await edge(page).press('Home')
  await split(page, 320)
  const add = add_sketch(page)
  await expect(add).toHaveAttribute('title', 'Add sketch')
  await expect(add).toHaveText('')
  await expect(add.locator('svg')).toBeVisible()
  const button = (await add.boundingBox())!
  expect([button.width, button.height]).toEqual([44, 44])
  await expect(chip).toHaveText('Sketch')
  expect((await chip.boundingBox())!.height).toBeLessThanOrEqual(32)
  await expect(chip.locator('svg')).toBeVisible()

  const input = field(page)
  const single = (await input.boundingBox())!
  const plate = (await page.locator('.chat__plate').boundingBox())!
  expect(single.width).toBeGreaterThan(plate.width * 0.6)
  await add.click()
  await input.fill('Which step comes first?\nAnd which one can wait?')
  const multi = (await input.boundingBox())!
  expect(multi.width).toBe(single.width)
  expect(multi.height).toBeGreaterThan(single.height)
  await page.screenshot({ path: screenshot })
  await input.fill('')
  await add.click()
  await expect(page.locator('.chat__attached, .chat__standing, .chat__caption')).toHaveCount(0)
}

async function mouse_drag(page: Page, to_x: number) {
  const box = (await edge(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, 300)
  await page.mouse.down()
  await page.mouse.move(to_x, 300, { steps: 4 })
  await page.mouse.up()
}

async function touch_drag(page: Page, cancel: boolean) {
  const client = await page.context().newCDPSession(page)
  const box = (await edge(page).boundingBox())!
  const x = box.x + box.width / 2
  const y = 340
  const before = Number(await edge(page).getAttribute('aria-valuenow'))

  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 64, y }],
    })
    await split(page, before + 64)
    await client.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    })
    await split(page, cancel ? before : before + 64)
  } finally {
    await client.detach()
  }
}

export async function resize_chat({ ipad, cli, session }: Linked) {
  const status = () => cli('status', '--session', session).document_hash
  const hash = status()
  const landscape = { width: 1200, height: 820 }
  await ipad.setViewportSize(landscape)
  const view = await camera(ipad)
  await mouse_drag(ipad, 10)
  await split(ipad, 720)
  await expect(edge(ipad)).toBeFocused()
  await expect(ipad.locator('.key')).toBeHidden()
  await mouse_drag(ipad, 1190)
  await split(ipad, 320)
  const key = (await ipad.locator('.key').boundingBox())!
  expect(Math.round(key.x + key.width / 2)).toBe(440)
  await edge(ipad).press('ArrowLeft')
  await split(ipad, 344)
  await edge(ipad).press('ArrowRight')
  await split(ipad, 320)
  await touch_drag(ipad, true)
  await touch_drag(ipad, false)
  expect(await camera(ipad)).toBe(view)
  expect(status()).toBe(hash)
  await ipad.reload()
  await chat_open(ipad)
  await split(ipad, 384)
  await edge(ipad).press('End')
  await split(ipad, 720)

  // Docking the rail changes the available board, without changing the window size.
  await ipad.getByRole('button', { name: 'Boards', exact: true }).click()
  await ipad.getByRole('button', { name: 'Keep the list open' }).click()
  await split(ipad, 552)
  await ipad.setViewportSize(ipad_portrait)
  await split(ipad, 460)
  await ipad.setViewportSize(ipad_narrow)
  await expect(edge(ipad)).toHaveCount(0)
  expect((await drawer(ipad).boundingBox())!.width).toBe(ipad_narrow.width)
  await ipad.setViewportSize(landscape)
  await split(ipad, 552)
  await ipad.getByRole('button', { name: 'Close the list of boards' }).click()
  await split(ipad, 720)
  await ipad.setViewportSize(ipad_portrait)
  await sketch_open(ipad)
  await chat_open(ipad)
  await split(ipad, 460)
}
