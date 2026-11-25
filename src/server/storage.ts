// Files on disk are envelopes: one header line, then the payload. The header carries the
// payload's size and checksum, so a file is verified on every read and again straight after
// every write. A file is replaced atomically, so a crash leaves the old one or the new one.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'

export type Disk = {
  read(name: FileName): Uint8Array | null
  write_atomic(name: FileName, bytes: Uint8Array): void
}

// A board's four files live in one directory: the data directory itself for the default board,
// and a directory of its own for every other board session. The registry of sessions lives
// only in the data directory.
export const file_names = [
  'board.snapshot', 'drawing.image', 'drawing.frame', 'cleaned.state', 'sessions.registry',
] as const
export type FileName = (typeof file_names)[number]

export type EnvelopeKind = 'board' | 'image' | 'frame' | 'cleaned' | 'registry'

// A saved file cannot be trusted. This is an operating error: the caller reports it and
// refuses to start, because starting empty would silently discard someone's work.
export class StorageError extends Error {}
export type Envelope = { kind: EnvelopeKind; label: string; payload: Uint8Array }
export type Decoded = { ok: true; envelope: Envelope } | { ok: false; reason: string }

const magic = 'tldraw-sync'
const version = 1
const header_size_bytes_max = 256
const payload_size_bytes_max = 1024 * 1024 * 1024
const newline = 0x0a
const label_pattern = /^[0-9a-f-]{1,64}$/

export function envelope_encode(envelope: Envelope): Uint8Array {
  assert(label_pattern.test(envelope.label), 'label is a short hex token')

  const size = envelope.payload.byteLength
  assert(size <= payload_size_bytes_max, 'payload is bounded')
  const checksum = checksum_hex(envelope.payload)
  const header = `${magic} ${version} ${envelope.kind} ${envelope.label} ${size} ${checksum}\n`
  const header_bytes = new TextEncoder().encode(header)
  assert(header_bytes.byteLength <= header_size_bytes_max, 'header fits its bound')

  const bytes = new Uint8Array(header_bytes.byteLength + size)
  bytes.set(header_bytes, 0)
  bytes.set(envelope.payload, header_bytes.byteLength)
  assert(bytes[header_bytes.byteLength - 1] === newline, 'header ends its line')
  return bytes
}

// Decoding never throws: a damaged file is an operating condition, not a programmer error.
export function envelope_decode(bytes: Uint8Array, kind: EnvelopeKind): Decoded {
  const header_end = bytes.subarray(0, header_size_bytes_max).indexOf(newline)
  if (header_end < 0) return { ok: false, reason: 'header line is missing' }

  const header = new TextDecoder().decode(bytes.subarray(0, header_end))
  const fields = header.split(' ')
  if (fields.length !== 6) return { ok: false, reason: 'header has the wrong field count' }

  const [magic_found, version_found, kind_found, label, size_text, checksum] = fields as [
    string, string, string, string, string, string,
  ]
  if (magic_found !== magic) return { ok: false, reason: 'not a tldraw-sync file' }
  if (version_found !== String(version)) return { ok: false, reason: 'unknown file version' }
  if (kind_found !== kind) return { ok: false, reason: `expected a ${kind} file` }
  if (!label_pattern.test(label)) return { ok: false, reason: 'label is malformed' }
  if (!/^[0-9]{1,12}$/.test(size_text)) return { ok: false, reason: 'size is malformed' }

  const payload = bytes.subarray(header_end + 1)
  if (payload.byteLength !== Number(size_text)) {
    return { ok: false, reason: 'payload is truncated or padded' }
  }
  if (checksum_hex(payload) !== checksum) return { ok: false, reason: 'checksum mismatch' }
  assert(payload.byteLength <= bytes.byteLength, 'payload lies inside the file')
  assert(header_end < header_size_bytes_max, 'header fits its bound')
  return { ok: true, envelope: { kind, label, payload } }
}

function checksum_hex(payload: Uint8Array): string {
  const checksum = Bun.hash.wyhash(payload).toString(16).padStart(16, '0')
  assert(checksum.length === 16, 'checksum is sixty-four bits of hex')
  return checksum
}

// The real disk. Writes are synchronous on purpose: a save runs to completion, so there is no
// interleaving to reason about, and it happens only after the pen has rested.
export function disk_open(directory: string): Disk {
  assert(path.isAbsolute(directory), 'data directory is an absolute path')
  fs.mkdirSync(directory, { recursive: true })
  assert(fs.statSync(directory).isDirectory(), 'the data directory exists')

  return {
    read(name) {
      assert(file_names.includes(name), 'file name is known')
      const file = path.join(directory, name)
      assert(path.dirname(file) === directory, 'files live directly in the data directory')
      if (!fs.existsSync(file)) return null
      return new Uint8Array(fs.readFileSync(file))
    },
    write_atomic(name, bytes) {
      assert(file_names.includes(name), 'file name is known')
      assert(bytes.byteLength > 0, 'a file is never written empty')
      const file = path.join(directory, name)
      const file_temporary = `${file}.tmp`
      assert(path.dirname(file) === directory, 'files live directly in the data directory')

      const descriptor = fs.openSync(file_temporary, 'w')
      fs.writeSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)

      fs.renameSync(file_temporary, file)
      directory_sync(directory)
      // Pair assertion: the file now on disk is as long as the bytes it was given.
      assert(fs.statSync(file).size === bytes.byteLength, 'the whole file was written')
      assert(!fs.existsSync(file_temporary), 'the temporary file was renamed away')
    },
  }
}

// Without this, the rename itself may not survive a power cut.
function directory_sync(directory: string): void {
  assert(fs.statSync(directory).isDirectory(), 'the data directory is a directory')
  const descriptor = fs.openSync(directory, 'r')
  fs.fsyncSync(descriptor)
  fs.closeSync(descriptor)
}
