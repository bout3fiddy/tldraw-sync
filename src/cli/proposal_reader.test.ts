// The proposal reader against inputs that are too large, never end, grow while they are read,
// or are not files at all. Each must be refused after a bounded amount of reading, which the
// tests measure by counting what the reader asked its source for.

import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proposal_size_bytes_max } from '../shared/constants'
import { chunks_read_bounded, file_read_bounded, stream_read_bounded } from './proposal_reader'

const directories: string[] = []
const limit = proposal_size_bytes_max

function directory_create(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-proposal-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// A source of `total` bytes, handed out at most `chunk` at a time, that counts what was taken.
function source_counting(total: number, chunk: number) {
  const taken = { bytes_count: 0, calls_count: 0 }
  const fill = (target: Uint8Array, offset: number): number => {
    taken.calls_count += 1
    const added = Math.min(chunk, total - taken.bytes_count, target.byteLength - offset)
    target.fill(0x20, offset, offset + added)
    taken.bytes_count += added
    return added
  }
  return { taken, fill }
}

test('a source at the limit is read whole, and one byte more is refused', () => {
  const exact = source_counting(64, 10)
  const read = chunks_read_bounded(exact.fill, 64)
  expect(read.kind).toBe('read')
  expect(read.kind === 'read' ? read.bytes.byteLength : -1).toBe(64)

  const over = source_counting(65, 10)
  expect(chunks_read_bounded(over.fill, 64)).toEqual({ kind: 'too_large' })
  expect(over.taken.bytes_count).toBe(65)

  const empty = source_counting(0, 10)
  const nothing = chunks_read_bounded(empty.fill, 64)
  expect(nothing.kind === 'read' ? nothing.bytes.byteLength : -1).toBe(0)
})

test('a source that never ends, like a growing file, is cut off one byte past the limit', () => {
  const endless = source_counting(Number.MAX_SAFE_INTEGER, 4096)
  expect(chunks_read_bounded(endless.fill, limit)).toEqual({ kind: 'too_large' })
  expect(endless.taken.bytes_count).toBe(limit + 1)
  expect(endless.taken.calls_count).toBe(Math.ceil((limit + 1) / 4096))

  // Even a source that trickles one byte at a time ends after limit + 1 reads.
  const trickle = source_counting(Number.MAX_SAFE_INTEGER, 1)
  expect(chunks_read_bounded(trickle.fill, 1000)).toEqual({ kind: 'too_large' })
  expect(trickle.taken.calls_count).toBe(1001)
})

test('a file is read up to the limit, and a larger one is refused by its size alone', () => {
  const directory = directory_create()
  const small = path.join(directory, 'small.json')
  fs.writeFileSync(small, '{"a":1}')
  const read = file_read_bounded(small, limit)
  expect(read.kind === 'read' ? new TextDecoder().decode(read.bytes) : null).toBe('{"a":1}')

  const exact = path.join(directory, 'exact.json')
  fs.writeFileSync(exact, new Uint8Array(limit).fill(0x20))
  const whole = file_read_bounded(exact, limit)
  expect(whole.kind === 'read' ? whole.bytes.byteLength : -1).toBe(limit)

  const over = path.join(directory, 'over.json')
  fs.writeFileSync(over, new Uint8Array(limit + 1).fill(0x20))
  expect(file_read_bounded(over, limit)).toEqual({ kind: 'too_large' })

  // A sparse gigabyte: refused at once, with nothing of that size read or allocated.
  const huge = path.join(directory, 'huge.json')
  fs.writeFileSync(huge, '')
  fs.truncateSync(huge, 1024 * 1024 * 1024)
  const started_ms = performance.now()
  expect(file_read_bounded(huge, limit)).toEqual({ kind: 'too_large' })
  expect(performance.now() - started_ms).toBeLessThan(1000)
})

test('what is not a regular file is refused without being read', () => {
  const directory = directory_create()
  expect(file_read_bounded(path.join(directory, 'missing.json'), limit)).toEqual({
    kind: 'unreadable',
  })
  expect(file_read_bounded(directory, limit)).toEqual({ kind: 'unreadable' })

  // A device that never ends. Reading it to the end would never return.
  if (fs.existsSync('/dev/zero')) {
    expect(file_read_bounded('/dev/zero', limit)).toEqual({ kind: 'unreadable' })
  }

  // A named pipe with no writer. Opening it the ordinary way would wait for one forever.
  const pipe = path.join(directory, 'pipe')
  const made = Bun.spawnSync(['mkfifo', pipe])

  if (made.exitCode === 0) {
    const started_ms = performance.now()
    expect(file_read_bounded(pipe, limit)).toEqual({ kind: 'unreadable' })
    expect(performance.now() - started_ms).toBeLessThan(1000)
  }
})

// A stream that keeps its end open and sends `chunk` bytes whenever it is asked.
function stream_endless(chunk: number) {
  const sent = { bytes_count: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        sent.bytes_count += chunk
        controller.enqueue(new Uint8Array(chunk).fill(0x20))
      },
      cancel() {
        sent.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { sent, stream }
}

test('a stream left open is refused and cancelled as soon as it passes the limit', async () => {
  const chunk = 64 * 1024
  const { sent, stream } = stream_endless(chunk)
  expect(await stream_read_bounded(stream, limit)).toEqual({ kind: 'too_large' })
  expect(sent.cancelled).toBe(true)

  // No more was pulled than the chunk that crossed the limit.
  expect(sent.bytes_count).toBeGreaterThan(limit)
  expect(sent.bytes_count).toBeLessThanOrEqual(limit + chunk)

  // One chunk larger than the whole limit is refused without being copied.
  const big = stream_endless(3 * 1024 * 1024)
  expect(await stream_read_bounded(big.stream, limit)).toEqual({ kind: 'too_large' })
  expect(big.sent.bytes_count).toBe(3 * 1024 * 1024)
  expect(big.sent.cancelled).toBe(true)
})

test('a stream within the limit is read whole, in order', async () => {
  const parts = ['{"shapes"', ':', '[]}']
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part))

      controller.close()
    },
  })
  const read = await stream_read_bounded(stream, limit)
  expect(read.kind === 'read' ? new TextDecoder().decode(read.bytes) : null).toBe(parts.join(''))

  const exact = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(100))
      controller.close()
    },
  })
  const whole = await stream_read_bounded(exact, 100)
  expect(whole.kind === 'read' ? whole.bytes.byteLength : -1).toBe(100)
})

test('a stream that fails, or sends nothing forever, is unreadable in bounded work', async () => {
  const failing = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('the pipe broke'))
    },
  })
  expect(await stream_read_bounded(failing, limit)).toEqual({ kind: 'unreadable' })

  const pulls = { count: 0, cancelled: false }
  const idle = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls.count += 1
        controller.enqueue(new Uint8Array(0))
      },
      cancel() {
        pulls.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  expect(await stream_read_bounded(idle, 16)).toEqual({ kind: 'unreadable' })
  expect(pulls.cancelled).toBe(true)
  expect(pulls.count).toBeLessThanOrEqual(16 + 3)
})
