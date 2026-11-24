// Nobody can point an iPad at a test run, so the QR code is checked the way a camera would
// check it: rasterise it and hand the pixels to an independent decoder.

import { expect, test } from 'bun:test'
import jsQR from 'jsqr'
import { pairing_create, pairing_terminal, type Pairing } from './pairing'

const quiet_zone_modules = 4
const pixels_per_module = 4

function decode(pairing: Pairing): string | null {
  const size = (pairing.modules.length + quiet_zone_modules * 2) * pixels_per_module
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  pairing.modules.forEach((row, module_y) => {
    for (let module_x = 0; module_x < row.length; module_x += 1) {
      if (row[module_x] !== '1') continue
      for (let offset = 0; offset < pixels_per_module * pixels_per_module; offset += 1) {
        const x = (module_x + quiet_zone_modules) * pixels_per_module + (offset % pixels_per_module)
        const y = (module_y + quiet_zone_modules) * pixels_per_module
          + Math.floor(offset / pixels_per_module)
        pixels.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3)
      }
    }
  })
  return jsQR(pixels, size, size)?.data ?? null
}

test('the code scans to the draw page of the given host', () => {
  const pairing = pairing_create('Swadhins-Mac-mini.local', 5173)
  expect(pairing.url).toBe('http://Swadhins-Mac-mini.local:5173/draw')
  expect(decode(pairing)).toBe(pairing.url)
})

test('codes for many hosts and ports all scan', () => {
  const hosts = ['a.local', '192.168.1.20', 'localhost', `${'long-name-'.repeat(6)}mac.local`]
  for (const host of hosts) {
    for (const port of [1, 80, 5173, 65535]) {
      const pairing = pairing_create(host, port)
      expect(decode(pairing)).toBe(`http://${host}:${port}/draw`)
    }
  }
})

test('the code is square and holds only modules', () => {
  const { modules } = pairing_create('a.local', 5173)
  for (const row of modules) {
    expect(row).toHaveLength(modules.length)
    expect(row).toMatch(/^[01]+$/)
  }
})

test('the terminal rendering covers every module row, with a quiet zone', () => {
  const pairing = pairing_create('a.local', 5173)
  const lines = pairing_terminal(pairing).split('\n')
  const size = pairing.modules.length + quiet_zone_modules * 2
  expect(lines).toHaveLength(Math.ceil(size / 2))
  // The first two terminal lines are the top quiet zone: four blank module rows.
  expect(lines[0]).toBe(`  \x1b[30;47m${' '.repeat(size)}\x1b[0m`)
  expect(lines[1]).toBe(lines[0] as string)
})

test('an impossible port is a programmer error', () => {
  expect(() => pairing_create('a.local', 0)).toThrow('port is positive')
  expect(() => pairing_create('a.local', 70000)).toThrow('port fits sixteen bits')
  expect(() => pairing_create('', 5173)).toThrow('host is not empty')
})
