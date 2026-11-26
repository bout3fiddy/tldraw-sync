// The screen's own pixels, for journeys that have to judge what was painted and not only what
// was laid out: a screenshot at one image pixel to a CSS pixel, decoded to RGBA by the browser's
// own image decoder, so no image library is needed. The same bytes are kept for attaching.

import { expect, type Page } from '@playwright/test'

export type Box = { left: number; top: number; right: number; bottom: number }
export type Pixels = { width: number; height: number; data: Buffer; png: Buffer }

// What a region holds: how many of its pixels are at least as dark as asked, the box those
// dark pixels span, and the lightest and darkest light in it. Light is luminance, 0 to 255.
export type Ink = {
  pixels_count: number
  dark_count: number
  dark_width: number
  dark_height: number
  light_min: number
  light_max: number
}

// One screenshot is bounded like every other wait in these journeys.
export async function pixels_read(page: Page, timeout_ms: number): Promise<Pixels> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled', timeout: timeout_ms })
  const decoded = await page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context?.drawImage(image, 0, 0)
    const data = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? []
    let binary = ''

    for (let start = 0; start < data.length; start += 0x4000) {
      binary += String.fromCharCode(...data.slice(start, start + 0x4000))
    }

    return { width: canvas.width, height: canvas.height, rgba: btoa(binary) }
  }, png.toString('base64'))
  const data = Buffer.from(decoded.rgba, 'base64')
  expect(data.length).toBe(decoded.width * decoded.height * 4)
  expect(decoded.width).toBe(page.viewportSize()!.width)
  expect(decoded.height).toBe(page.viewportSize()!.height)
  return { width: decoded.width, height: decoded.height, data, png }
}

export function light_at(pixels: Pixels, x: number, y: number): number {
  const px = Math.floor(x)
  const py = Math.floor(y)
  expect(px >= 0 && py >= 0 && px < pixels.width && py < pixels.height).toBe(true)
  const index = (py * pixels.width + px) * 4
  const [r, g, b] = [0, 1, 2].map((channel) => pixels.data[index + channel] as number)
  return 0.299 * (r as number) + 0.587 * (g as number) + 0.114 * (b as number)
}

// Every whole pixel inside the box is judged once. A pixel is dark at or under `dark_max`.
export function ink_in(pixels: Pixels, box: Box, dark_max: number): Ink {
  const found = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  const ink = { pixels_count: 0, dark_count: 0, light_min: 255, light_max: 0 }

  for (let y = Math.ceil(box.top); y < Math.floor(box.bottom); y += 1) {
    for (let x = Math.ceil(box.left); x < Math.floor(box.right); x += 1) {
      const light = light_at(pixels, x, y)
      ink.pixels_count += 1
      ink.light_min = Math.min(ink.light_min, light)
      ink.light_max = Math.max(ink.light_max, light)

      if (light > dark_max) continue

      ink.dark_count += 1
      found.left = Math.min(found.left, x)
      found.right = Math.max(found.right, x + 1)
      found.top = Math.min(found.top, y)
      found.bottom = Math.max(found.bottom, y + 1)
    }
  }

  const some = ink.dark_count > 0
  return {
    ...ink,
    dark_width: some ? found.right - found.left : 0,
    dark_height: some ? found.bottom - found.top : 0,
  }
}

// The box drawn in by `px` on every side, or out when `px` is negative.
export function inset(box: Box, px: number): Box {
  return {
    left: box.left + px,
    top: box.top + px,
    right: box.right - px,
    bottom: box.bottom - px,
  }
}
