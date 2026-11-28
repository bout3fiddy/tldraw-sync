// Files on disk are envelopes: one header line, then the payload. The header carries the
// payload's size and checksum, so a file is verified on every read and again straight after
// every write. A file is replaced atomically, so a crash leaves the old one or the new one.

import fs from 'node:fs'
import path from 'node:path'
import { assert, AssertionError } from '../shared/assert'
import { board_default_id, board_id_pattern } from '../shared/board_session'

export type Disk = {
  read(name: FileName): Uint8Array | null
  write_atomic(name: FileName, bytes: Uint8Array): void
}

// A board's files live in one directory: the data directory itself for the default board,
// and a directory of its own for every other board session. The registry of sessions lives
// only in the data directory. The archives are canvases saved in retired formats, kept as
// they were when the board moved on from them. `agent_canvas.archive` is the Agent canvas of a
// board rehearsed as native (`native_rehearsal.ts`), byte for byte, and is never read back.
export const board_file_names = [
  'board.snapshot', 'drawing.image', 'drawing.frame', 'cleaned.state', 'ideas.state',
  'events.state', 'interpretation.archive', 'ideas.archive', 'canvas.archive', 'native.journal',
  'agent_canvas.archive',
] as const
export const file_names = [...board_file_names, 'sessions.registry', 'whiteboard.key'] as const
export type FileName = (typeof file_names)[number]

export type EnvelopeKind =
  'board' | 'image' | 'frame' | 'cleaned' | 'registry' | 'events' | 'native'

// A saved file cannot be trusted. This is an operating error: the caller reports it and
// refuses to start, because starting empty would silently discard someone's work.
export class StorageError extends Error {}
export type Envelope = { kind: EnvelopeKind; label: string; payload: Uint8Array }
export type Decoded = { ok: true; envelope: Envelope } | { ok: false; reason: string }

const magic = 'tldraw-sync'
const version = 1
// 64 named boards, their owners, legacy ids, and a single pending deletion fit comfortably.
const registry_size_bytes_max = 128 * 1024
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
      if (name === 'whiteboard.key') return key_read(file)
      if (name === 'sessions.registry') {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false })
        if (!stat) return null
        if (!stat.isFile() || stat.size > registry_size_bytes_max) {
          throw new StorageError('Invalid board registry file.')
        }
      } else if (!fs.existsSync(file)) return null

      if (name.endsWith('.state') || name.endsWith('.archive')) {
        // Nine normalized canvas versions, or sixty-four events including ACK messages.
        const max_bytes = name === 'events.state' ? 2 * 1024 * 1024 : 32 * 1024 * 1024
        const stat = fs.statSync(file)
        if (!stat.isFile() || stat.size > max_bytes) throw new StorageError(`Invalid ${name} size.`)
      }
      return new Uint8Array(fs.readFileSync(file))
    },
    write_atomic(name, bytes) {
      assert(file_names.includes(name), 'file name is known')
      assert(bytes.byteLength > 0, 'a file is never written empty')
      const file = path.join(directory, name)
      const file_temporary = `${file}.tmp`
      assert(path.dirname(file) === directory, 'files live directly in the data directory')

      // A daemon owns this directory exclusively. Retire a partial left by a crash without
      // opening it: an old symlink must never be followed, nor can partials grow without bound.
      fs.rmSync(file_temporary, { force: true })
      const descriptor = fs.openSync(file_temporary, 'wx', 0o600)
      try {
        try {
          fs.writeFileSync(descriptor, bytes)
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
        fs.renameSync(file_temporary, file)
      } finally {
        fs.rmSync(file_temporary, { force: true })
      }
      directory_sync(directory)
      // Pair assertion: the file now on disk is as long as the bytes it was given.
      assert(fs.statSync(file).size === bytes.byteLength, 'the whole file was written')
      assert(!fs.existsSync(file_temporary), 'the temporary file was renamed away')
    },
  }
}

// Only registered board files under real session directories are ours. Never recurse or
// follow a directory symlink, and leave unrelated contents in place. The daemon exclusively
// owns the storage tree. A crash may leave any prefix of the unlinks already completed.
export function session_storage(root: string) {
  assert(path.isAbsolute(root), 'session storage has an absolute root')
  const parent = path.join(root, 'sessions')
  const location = (id: string) => {
    assert(board_id_pattern.test(id) && id !== board_default_id, 'a separate session id')
    for (const directory of [parent, path.join(parent, id)]) {
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
      if (stat && !stat.isDirectory()) throw new StorageError('Unsafe board directory.')
    }
    return path.join(parent, id)
  }

  return {
    disk_board: (id: string) => disk_open(location(id)),
    disk_exists: (id: string) => fs.existsSync(location(id)),
    disk_remove(id: string) {
      // The original board shares its directory with registry, keys, and unrelated files.
      // Unlink only the known board files. Never remove or enumerate the root directory.
      try {
        if (id === board_default_id) return board_files_unlink(root)

        const directory = location(id)
        assert(path.dirname(directory) === parent, 'cleanup stays in the session namespace')
        if (fs.existsSync(directory)) session_files_remove(directory)
        if (fs.existsSync(parent)) directory_sync(parent)
      } catch (error) {
        if (error instanceof AssertionError || error instanceof StorageError) throw error
        throw new StorageError('Cannot finish deleted board cleanup. Check session storage.')
      }
    },
  }
}

function session_files_remove(directory: string): void {
  board_files_unlink(directory)
  try {
    fs.rmdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  }
}

function board_files_unlink(directory: string): void {
  for (const name of board_file_names) {
    for (const suffix of ['', '.tmp']) {
      const file = path.join(directory, name + suffix)
      assert(path.dirname(file) === directory, 'only direct board files are removed')
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isDirectory()) {
        fs.rmSync(file, { force: true })
      }
    }
  }

  directory_sync(directory)
}

// Never issue credentials from a public, linked or oversized key file, even if its contents
// happen to look like a valid key. Check the open descriptor, not a path checked before open.
function key_read(file: string): Uint8Array | null {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  let fd: number
  try {
    fd = fs.openSync(file, flags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StorageError('Cannot open the private whiteboard key.')
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64 || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600) throw new StorageError('Unsafe whiteboard key file.')
    const bytes = new Uint8Array(64)
    if (fs.readSync(fd, bytes) !== bytes.length) {
      throw new StorageError('Incomplete whiteboard key.')
    }
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}

// Without this, the rename itself may not survive a power cut.
function directory_sync(directory: string): void {
  assert(fs.statSync(directory).isDirectory(), 'the data directory is a directory')
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}
