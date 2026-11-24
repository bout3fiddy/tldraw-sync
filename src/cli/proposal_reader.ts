// Reads a cleanup proposal from a file or from stdin without ever holding more than the limit.
// The bytes land in storage sized once, one byte past the limit: reaching that byte proves the
// source is too large, so reading stops there instead of at the end of the input. A writer that
// never closes its end, a file that grows while it is read, and a device that never ends are all
// refused after the same bounded amount of work.

import fs from 'node:fs'
import { assert } from '../shared/assert'

export type BoundedRead =
  { kind: 'read'; bytes: Uint8Array } | { kind: 'too_large' } | { kind: 'unreadable' }

// Fills `target` from `offset` on, and returns how many bytes it added: 0 at the end of input.
export type ChunkFill = (target: Uint8Array, offset: number) => number

export function chunks_read_bounded(chunk_fill: ChunkFill, bytes_max: number): BoundedRead {
  assert(Number.isSafeInteger(bytes_max) && bytes_max > 0, 'a read limit is a positive count')
  const storage = new Uint8Array(bytes_max + 1)
  let bytes_count = 0

  // Every pass adds at least one byte or returns, so there are at most bytes_max + 1 passes.
  while (bytes_count <= bytes_max) {
    const added = chunk_fill(storage, bytes_count)
    assert(Number.isInteger(added) && added >= 0, 'a fill reports a count')
    assert(added <= storage.byteLength - bytes_count, 'a fill stays inside the storage')

    if (added === 0) return { kind: 'read', bytes: storage.subarray(0, bytes_count) }

    bytes_count += added
  }

  assert(bytes_count === bytes_max + 1, 'reading stops at the first byte past the limit')
  return { kind: 'too_large' }
}

// Only a regular file is a proposal. A directory, a pipe or a device is refused before any read,
// and a file that grows after its size was checked is still cut off by the bounded read.
export function file_read_bounded(file: string, bytes_max: number): BoundedRead {
  assert(file.length > 0, 'a proposal file has a name')
  assert(bytes_max > 0, 'a read limit is a positive count')
  let descriptor: number

  try {

    // Non-blocking, so opening a pipe that nobody writes to returns instead of waiting.
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
  } catch {
    return { kind: 'unreadable' }
  }

  try {
    return descriptor_read_bounded(descriptor, bytes_max)
  } finally {
    fs.closeSync(descriptor)
  }
}

function descriptor_read_bounded(descriptor: number, bytes_max: number): BoundedRead {
  assert(Number.isInteger(descriptor) && descriptor >= 0, 'a descriptor is open')
  let stat: fs.Stats

  try {
    stat = fs.fstatSync(descriptor)
  } catch {
    return { kind: 'unreadable' }
  }

  if (!stat.isFile()) return { kind: 'unreadable' }

  if (stat.size > bytes_max) return { kind: 'too_large' }

  // A failed read ends the input, and the failure is reported in place of what was read.
  let failed = false
  const result = chunks_read_bounded((target, offset) => {
    try {
      return fs.readSync(descriptor, target, offset, target.byteLength - offset, null)
    } catch {
      failed = true
      return 0
    }
  }, bytes_max)
  assert(result.kind !== 'unreadable', 'a bounded read reads or stops at the limit')
  return failed ? { kind: 'unreadable' } : result
}

// Reads a stream chunk by chunk and cancels it at the first byte past the limit, without waiting
// for the writer to finish. Stdin is read this way.
export async function stream_read_bounded(
  stream: ReadableStream<Uint8Array>,
  bytes_max: number,
): Promise<BoundedRead> {
  assert(Number.isSafeInteger(bytes_max) && bytes_max > 0, 'a read limit is a positive count')
  const storage = new Uint8Array(bytes_max + 1)
  const reader = stream.getReader()
  let bytes_count = 0

  // A chunk that fits adds to the count, and the count is bounded. Only empty chunks add
  // nothing, so the pass limit is reached only by a stream that keeps sending those.
  for (let pass = 0; pass <= bytes_max + 1; pass += 1) {
    let chunk: Uint8Array | null

    try {
      const step = await reader.read()
      chunk = step.done ? null : step.value
    } catch {
      return { kind: 'unreadable' }
    }

    if (chunk === null) return { kind: 'read', bytes: storage.subarray(0, bytes_count) }

    if (chunk.byteLength > bytes_max - bytes_count) {
      stream_cancel(reader)
      return { kind: 'too_large' }
    }

    storage.set(chunk, bytes_count)
    bytes_count += chunk.byteLength
    assert(bytes_count <= bytes_max, 'kept bytes stay within the limit')
  }

  stream_cancel(reader)
  return { kind: 'unreadable' }
}

// The answer does not wait for the cancel: a writer that holds its end open may never settle
// it, and the limit is already decided. A failed cancel changes nothing, so it is discarded.
function stream_cancel(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch(() => undefined)
}
