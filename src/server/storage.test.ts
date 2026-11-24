// The envelope is what stands between a damaged file and a silently wrong board, so most of
// these tests feed it damage.

import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disk_open, envelope_decode, envelope_encode } from './storage'

const payload = new TextEncoder().encode('{"documents":[]}')
const encoded = envelope_encode({ kind: 'board', label: '-', payload })

test('an envelope decodes to what was encoded', () => {
  const decoded = envelope_decode(encoded, 'board')
  expect(decoded.ok).toBe(true)
  if (decoded.ok) {
    expect(decoded.envelope.label).toBe('-')
    expect([...decoded.envelope.payload]).toEqual([...payload])
  }
})

test('an empty payload is a valid envelope', () => {
  const empty = envelope_encode({ kind: 'image', label: 'abc', payload: new Uint8Array(0) })
  expect(envelope_decode(empty, 'image').ok).toBe(true)
})

test('every single flipped bit is detected', () => {
  for (let index = 0; index < encoded.byteLength; index += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const damaged = encoded.slice()
      damaged[index] = (damaged[index] as number) ^ (1 << bit)
      expect(envelope_decode(damaged, 'board').ok).toBe(false)
    }
  }
})

test('every truncation is detected', () => {
  for (let size = 0; size < encoded.byteLength; size += 1) {
    expect(envelope_decode(encoded.subarray(0, size), 'board').ok).toBe(false)
  }
})

test('trailing bytes are detected', () => {
  const padded = new Uint8Array([...encoded, 0])
  expect(envelope_decode(padded, 'board')).toEqual({
    ok: false, reason: 'payload is truncated or padded',
  })
})

test('a file of the wrong kind is refused', () => {
  expect(envelope_decode(encoded, 'image')).toEqual({ ok: false, reason: 'expected a image file' })
})

test('garbage is refused without throwing', () => {
  expect(envelope_decode(new Uint8Array(0), 'board').ok).toBe(false)
  expect(envelope_decode(new Uint8Array(1000).fill(0x41), 'board').ok).toBe(false)
})

test('the real disk replaces a file whole and leaves no temporary file behind', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-disk-'))
  try {
    const disk = disk_open(directory)
    expect(disk.read('board.snapshot')).toBeNull()

    disk.write_atomic('board.snapshot', new Uint8Array([1, 2, 3]))
    disk.write_atomic('board.snapshot', new Uint8Array([4, 5]))
    expect([...(disk.read('board.snapshot') as Uint8Array)]).toEqual([4, 5])
    expect(fs.readdirSync(directory)).toEqual(['board.snapshot'])
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
