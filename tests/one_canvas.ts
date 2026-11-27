// What the one-canvas journeys share: bringing the agent's print into view, choosing one of its
// shapes the way a person does, reading what the board copied, and telling the print's violet
// from the person's ink in the pixels actually painted. Nothing here calls an editor API: every
// action goes through the screen.

import { expect, type Locator, type Page } from '@playwright/test'
import { pixels_read, type Box, type Pixels } from './screen_pixels'
import { action_ms, key_agent, print_shape, soon } from './whiteboard_board'

type Json = Record<string, any>

// A fit leaves space on all four sides. Measure the edges, not a transformed element's
// IntersectionObserver area ratio: Chromium can round that below 1 even without clipping.
export async function expect_framed(shape: Locator) {
  await expect(shape).toBeInViewport()
  await expect
    .poll(() =>
      shape.evaluate((element) => {
        const canvas = element.closest('.tl-canvas')!.getBoundingClientRect()
        const box = element.getBoundingClientRect()
        return Math.min(
          box.left - canvas.left,
          box.top - canvas.top,
          canvas.right - box.right,
          canvas.bottom - box.bottom,
        )
      }),
    )
    .toBeGreaterThan(0)
}

// Where something is on the screen, rounded, so two readings a frame apart compare equal.
export async function box_of(page: Page, selector: string): Promise<string> {
  return soon(
    page.locator(selector).first().evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [box.left, box.top, box.width, box.height].map((value) => Math.round(value)).join(' ')
    }),
  )
}

// Waits until `selector` stops moving: a camera at rest.
export async function at_rest(page: Page, selector: string): Promise<string> {
  let last = ''
  await expect
    .poll(async () => {
      const now = await box_of(page, selector)
      const still = now === last
      last = now
      return still
    })
    .toBe(true)
  return last
}

// The key's name for the agent's print brings it into view, as a person asks for it.
export async function print_fit(page: Page, id: string) {
  await key_agent(page).click()
  await at_rest(page, `.print__shape[data-print-shape="shape:scene-${id}"]`)
}

// A finger on the middle of one print shape, or a mouse click where there is no touch.
export async function print_choose(page: Page, id: string, touch: boolean) {
  const box = (await print_shape(page, id).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  if (touch) await soon(page.touchscreen.tap(x, y))
  else await soon(page.mouse.click(x, y))

  const card = page.getByRole('dialog', { name: 'Agent shape' })
  await expect(card).toBeVisible()
  return card
}

// The agent's published records for a board, as any page on the network can read them.
export async function published(page: Page, origin: string, session: string): Promise<Json[]> {
  const response = await page.request.get(`${origin}/api/cleaned.json?session=${session}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as Json).records as Json[]
}

// Pixels of the print's violet in a box: blue well above red and green, as #6a4fd0 and its
// wash are, and as none of the person's inks is.
export function violet_count(pixels: Pixels, box: Box): number {
  let count = 0

  for (let y = Math.max(0, Math.ceil(box.top)); y < Math.min(pixels.height, box.bottom); y += 1) {
    for (let x = Math.max(0, Math.ceil(box.left)); x < Math.min(pixels.width, box.right); x += 1) {
      const index = (y * pixels.width + x) * 4
      const [r, g, b] = [0, 1, 2].map((channel) => pixels.data[index + channel] as number)

      if (b! > r! + 40 && b! > g! + 60) count += 1
    }
  }

  return count
}

// Pixels that are dark and neutral, as the agent's own black would be if it were not printed
// in violet.
export function black_count(pixels: Pixels, box: Box): number {
  let count = 0

  for (let y = Math.max(0, Math.ceil(box.top)); y < Math.min(pixels.height, box.bottom); y += 1) {
    for (let x = Math.max(0, Math.ceil(box.left)); x < Math.min(pixels.width, box.right); x += 1) {
      const index = (y * pixels.width + x) * 4
      const [r, g, b] = [0, 1, 2].map((channel) => pixels.data[index + channel] as number)
      const neutral = Math.max(r!, g!, b!) - Math.min(r!, g!, b!) < 24

      if (neutral && r! < 96) count += 1
    }
  }

  return count
}

export async function painted(page: Page, id: string) {
  const box = (await print_shape(page, id).boundingBox())!
  const pixels = await pixels_read(page, action_ms)
  const area = { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }
  return { violet: violet_count(pixels, area), black: black_count(pixels, area) }
}

// Runs one action from the board's own menu: the ⋮ beside the board on screen.
export async function board_menu(page: Page, item: string | RegExp) {
  await page.getByRole('button', { name: 'Boards', exact: true }).click()
  const rail = page.getByRole('complementary', { name: 'Boards' })
  const active = rail.locator('li', { has: page.locator('[aria-current="page"]') })
  await active.getByRole('button', { name: /^Actions for / }).click()
  await active.getByRole('menuitem', { name: item }).click()
  await expect(rail).toBeHidden()
}
