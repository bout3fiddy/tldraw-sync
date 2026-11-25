// The board's process: claim the data directory, open the saved board, and serve it. The
// command line runs this, in the foreground for `serve` and in a background process for
// `start`. Each way it can fail to start is returned, so the caller can report it plainly.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'
import { time_real } from '../shared/time'
import { StorageError } from './board'
import { BoardRegistry } from './board_registry'
import { server_start, static_files_load } from './http'
import { pairing_create, pairing_host, type Pairing } from './pairing'
import { server_state_claim, server_state_release, type ServerState } from './server_state'
import { machine_key } from './whiteboard_keys'
import { disk_open } from './storage'

export type ServerRunOptions = {
  readonly port: number
  readonly data_directory: string
  readonly static_directory: string
}

export type ServerRunResult =
  | { kind: 'serving'; pairing: Pairing; port: number }
  | { kind: 'held'; state: ServerState }
  | { kind: 'not_built' }
  | { kind: 'port_busy' }
  | { kind: 'storage_damaged'; message: string }

export function server_run(options: ServerRunOptions): ServerRunResult {
  assert(Number.isInteger(options.port), 'port is an integer')
  assert(options.port > 0 && options.port < 65536, 'port fits sixteen bits')
  assert(path.isAbsolute(options.data_directory), 'data directory is an absolute path')
  assert(path.isAbsolute(options.static_directory), 'static directory is an absolute path')
  if (!fs.existsSync(path.join(options.static_directory, 'index.html'))) {
    return { kind: 'not_built' }
  }

  const claim = server_state_claim(options.data_directory, {
    pid: process.pid,
    port: options.port,
  })
  if (claim.kind === 'held') return claim

  const result = board_serve(options)
  if (result.kind !== 'serving') server_state_release(options.data_directory)
  return result
}

function board_serve(options: ServerRunOptions): ServerRunResult {
  assert(Number.isInteger(options.port), 'port is an integer')
  let registry: BoardRegistry
  let key: string
  try {
    const disk = disk_open(options.data_directory)
    key = machine_key(disk)
    registry = BoardRegistry.open({
      time: time_real,
      disk,
      // Each other board in a directory of its own, made when the board first opens.
      disk_board: (id) => disk_open(path.join(options.data_directory, 'sessions', id)),
      id_create: board_id_random,
    })
  } catch (error) {
    if (!(error instanceof StorageError)) throw error
    return { kind: 'storage_damaged', message: error.message }
  }

  const pairing = pairing_create(pairing_host(), options.port)
  try {
    server_start({
      registry,
      machine_key: key,
      port: options.port,
      // All interfaces: the iPad reaches the board over the local network.
      hostname: '0.0.0.0',
      static_files: static_files_load(options.static_directory),
      pairing,
      on_fatal: (error) => {
        server_state_release(options.data_directory)
        console.error(error.stack ?? error.message)
        process.exit(1)
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    registry.close()
    return { kind: 'port_busy' }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      registry.close()
      server_state_release(options.data_directory)
      process.exit(0)
    })
  }
  assert(pairing.url.includes(`:${options.port}/`), 'the QR code carries the real port')
  return { kind: 'serving', pairing, port: options.port }
}

// Sixty-four random bits, so an id cannot be guessed from another or from the time.
function board_id_random(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  assert(id.length === 16, 'an id is sixteen hex digits')
  return id
}
