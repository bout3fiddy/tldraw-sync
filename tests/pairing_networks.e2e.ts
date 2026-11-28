import { expect, test, type Page } from '@playwright/test'
import jsQR from 'jsqr'
import { pairing_board, pairing_create } from '../src/server/pairing'
import { pixels_read } from './screen_pixels'
import { action_ms, board_linked, chat_button } from './whiteboard_board'

test.use({ trace: 'off' })

// Compare in memory: a failed scan must not print an address or attach a screenshot.
async function expect_code(stage: Page, expected: string) {
  await expect(stage.locator('.guide__code')).toBeVisible()
  const { data, width, height } = await pixels_read(stage, action_ms)
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
  expect(jsQR(rgba, width, height)?.data === expected).toBe(true)
}

test('the selected board opens with the recommended QR and offers Wi-Fi only if supplied', async ({
  browser,
}) => {
  await board_linked(browser, async ({ stage, session }) => {
    const path = `/s/${session}/draw#pair=fixture-only`
    const recommended = pairing_board(pairing_create('100.64.0.2', 4000), path)
    const local = pairing_board(pairing_create('fixture.local', 4000), path)
    let requests = 0

    await stage.route('**/api/pairing?*', async (route) => {
      expect(new URL(route.request().url()).searchParams.get('session')).toBe(session)
      requests += 1
      await route.fulfill({ json: requests < 3 ? { ...recommended, local } : local })
    })
    const pair = stage.getByRole('button', { name: 'Pair iPad' })
    const wifi = stage.getByRole('checkbox', { name: 'Local Wi-Fi' })
    await pair.press('Enter')
    await expect_code(stage, recommended.url)
    await pair.press('Tab')
    await expect(wifi).toBeFocused()
    await wifi.press('Space')
    await expect(wifi).toBeChecked()
    await expect_code(stage, local.url)
    await wifi.press('Escape')
    await expect(pair).toBeFocused()
    await expect(wifi).toHaveCount(0)

    await pair.click()
    await expect(wifi).not.toBeChecked()
    await expect_code(stage, recommended.url)
    await stage.getByText('Local Wi-Fi', { exact: true }).click()
    await expect(wifi).toBeChecked()
    await chat_button(stage).click()
    await expect(pair).toHaveAttribute('aria-expanded', 'false')
    await expect(chat_button(stage)).toBeFocused()
    await chat_button(stage).click()

    await pair.click()
    await expect_code(stage, local.url)
    await expect(wifi).toHaveCount(0)
    expect(requests).toBe(3)
  })
})
