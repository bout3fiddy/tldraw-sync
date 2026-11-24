// The one process: it serves the built client, runs the sync room, keeps the drawing on disk,
// and serves the latest image to agents.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'
import { path_drawing_png, port_default } from '../shared/constants'
import { time_real } from '../shared/time'
import { Board, StorageError } from './board'
import { server_start, static_files_load } from './http'
import { pairing_create, pairing_host, pairing_terminal } from './pairing'
import { disk_open } from './storage'

const root = path.resolve(import.meta.dir, '../..')
const static_directory = path.join(root, 'dist')
const data_directory = path.resolve(process.env.BOARD_DATA_DIR ?? path.join(root, 'data'))
const port = Number(process.env.PORT ?? port_default)

function main(): void {
  assert(Number.isInteger(port), 'PORT is an integer')
  assert(port > 0, 'PORT is positive')
  assert(port < 65536, 'PORT fits sixteen bits')
  if (!fs.existsSync(path.join(static_directory, 'index.html'))) {
    stop(`The client has not been built. Run "bun start", or "bun run build" first.`)
  }

  const board = board_open()
  const pairing = pairing_create(pairing_host(), port)
  server_start({
    board,
    port,
    // All interfaces: the iPad reaches the board over the local network.
    hostname: '0.0.0.0',
    static_files: static_files_load(static_directory),
    pairing,
    on_fatal: (error) => stop(error.stack ?? error.message),
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      board.close()
      process.exit(0)
    })
  }

  console.log(`
  Scan with the iPad camera to draw:

${pairing_terminal(pairing)}

  Draw      ${pairing.url}
  Present   http://localhost:${port}
  Fetch     http://localhost:${port}${path_drawing_png}
`)
}

function board_open(): Board {
  try {
    return Board.open({ time: time_real, disk: disk_open(data_directory) })
  } catch (error) {
    if (!(error instanceof StorageError)) throw error
    return stop(`${error.message}\nThe saved board in ${data_directory} cannot be read. `
      + 'Move that directory aside to start with an empty board.')
  }
}

function stop(message: string): never {
  assert(message.length > 0, 'a stop always says why')
  console.error(message)
  process.exit(1)
}

main()
