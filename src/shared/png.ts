// The little this app needs to know about a PNG without decoding one: whether bytes begin as
// a PNG does, how large the picture says it is, and a blank page for a canvas with nothing on
// it. The board never decodes or redraws an image; a browser does all rendering.

import { assert } from './assert'

const png_signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// A blank page: 64 by 64 white pixels.
const png_blank_base64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAAKUlEQVR42u3MQREAAAwCIPuX1hD77SAA6VEEAoFA' +
  'IBAIBAKBQCAQfA8Gpwvw4qrwDDIAAAAASUVORK5CYII='

export function png_signed(bytes: Uint8Array): boolean {
  const signed = png_signature.every((byte, index) => bytes[index] === byte)
  assert(!signed || bytes.byteLength >= png_signature.length, 'a signed PNG has its signature')
  return signed
}

// What a sketch or a canvas with nothing on it looks like.
export function png_blank(): Uint8Array {
  const bytes = Uint8Array.from(atob(png_blank_base64), (character) => character.charCodeAt(0))
  assert(png_signed(bytes), 'the blank page is a PNG')
  assert(png_size(bytes) !== null, 'the blank page has a size')
  return bytes
}

// Width and height from the PNG header, or null for anything that is not a full header.
export function png_size(png: Uint8Array): { width_px: number; height_px: number } | null {
  if (png.byteLength < 24 || !png_signed(png)) return null

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunk = String.fromCharCode(...png.subarray(12, 16))

  if (chunk !== 'IHDR') return null

  const size = { width_px: view.getUint32(16), height_px: view.getUint32(20) }
  assert(Number.isInteger(size.width_px) && Number.isInteger(size.height_px), 'whole pixels')
  assert(size.width_px >= 0 && size.height_px >= 0, 'a size is never negative')
  return size.width_px > 0 && size.height_px > 0 ? size : null
}
