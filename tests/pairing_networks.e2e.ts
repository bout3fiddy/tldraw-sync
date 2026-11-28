import { expect, test, type Page } from '@playwright/test'
import jsQR from 'jsqr'
import { pairing_board, pairing_create } from '../src/server/pairing'
import { pixels_read } from './screen_pixels'
import { action_ms, board_linked, chat_button } from './whiteboard_board'

test.use({ trace: 'off' })

// Compare in memory: a failed scan must not print an address or attach a screenshot.
async function expect_code(stage: Page, expected: string) {
  const sheet = stage.getByRole('complementary', { name: 'Pair iPad' })
  await expect(sheet.getByRole('img', { name: 'QR code for the draw page' })).toBeVisible()
  await expect(sheet.locator(':scope > *')).toHaveCount(1)
  expect(await sheet.innerText()).toBe('')

  const { data, width, height } = await pixels_read(stage, action_ms)
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
  expect(jsQR(rgba, width, height)?.data === expected).toBe(true)
}

test('the sheet shows only the recommended QR, including after a retry or local fallback', async ({
  browser,
}) => {
  await board_linked(browser, async ({ stage, session }) => {
    const path = `/s/${session}/draw#pair=fixture-only`
    const recommended = pairing_board(pairing_create('100.64.0.2', 4000), path)
    const local = pairing_board(pairing_create('fixture.local', 4000), path)
    const pair = stage.getByRole('button', { name: 'Pair iPad' })
    const sheet = stage.getByRole('complementary', { name: 'Pair iPad' })
    let requests = 0

    await stage.route('**/api/pairing?*', async (route) => {
      expect(new URL(route.request().url()).searchParams.get('session')).toBe(session)
      expect(route.request().headers()['x-board-stage']).toBe('qr')
      requests += 1

      if (requests === 1) {
        await expect(sheet.getByText('Loading pairing code…')).toBeVisible()
        await route.fulfill({ status: 503 })
      } else {
        await route.fulfill({ json: requests === 2 ? { ...recommended, local } : local })
      }
    })

    await pair.press('Enter')
    await expect(sheet).toHaveText('Could not load the code. Close and reopen to retry.')
    await pair.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(pair).toBeFocused()

    await pair.press('Enter')
    await expect_code(stage, recommended.url)
    await pair.press('Tab')
    await expect(chat_button(stage)).toBeFocused()
    await expect(sheet).toHaveCount(0)

    await pair.click()
    await expect_code(stage, local.url)
    await chat_button(stage).click()
    await expect(pair).toHaveAttribute('aria-expanded', 'false')
    expect(requests).toBe(3)
  })
})
