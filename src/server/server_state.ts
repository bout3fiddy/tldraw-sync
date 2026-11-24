// The running board announces itself in one small file in its data directory: which process it
// is and which port it took. The file is also the lock that keeps a second board off the same
// data directory, because two processes saving one board would lose drawings.
//
// The file is created exclusively and removed on a clean stop. A crash leaves it behind; a
// file whose process is gone is stale, and the next board takes it over.

import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'

export type ServerState = { readonly pid: number; readonly port: number }

export type Claim = { kind: 'claimed' } | { kind: 'held'; state: ServerState }

const state_file_name = 'server.json'
const state_size_bytes_max = 4096
const claim_attempts_count_max = 3

export function server_state_read(data_directory: string): ServerState | null {
  assert(path.isAbsolute(data_directory), 'data directory is an absolute path')
  const file = path.join(data_directory, state_file_name)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // Anything could have written this file, so it is validated rather than asserted.
  if (text.length > state_size_bytes_max) return null
  try {
    const parsed = JSON.parse(text) as Partial<ServerState>
    if (!Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port)) return null
    const state = { pid: parsed.pid as number, port: parsed.port as number }
    if (state.pid <= 0 || state.port <= 0 || state.port >= 65536) return null
    assert(Number.isInteger(state.pid), 'a valid state names a process')
    return state
  } catch {
    return null
  }
}

// Takes the data directory for this process, unless a live process already holds it.
export function server_state_claim(data_directory: string, state: ServerState): Claim {
  assert(path.isAbsolute(data_directory), 'data directory is an absolute path')
  assert(state.pid === process.pid, 'a process claims only for itself')
  fs.mkdirSync(data_directory, { recursive: true })
  const file = path.join(data_directory, state_file_name)

  // Each failed attempt removes a stale file, so a second attempt normally succeeds. More
  // attempts than that only cover another process racing for the same stale file.
  for (let attempt = 0; attempt < claim_attempts_count_max; attempt += 1) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { flag: 'wx' })
      return { kind: 'claimed' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = server_state_read(data_directory)
    if (holder !== null && process_alive(holder.pid)) {
      assert(holder.pid !== process.pid, 'a process never holds a claim it is making')
      return { kind: 'held', state: holder }
    }
    fs.rmSync(file, { force: true })
  }
  throw new Error(`${file} keeps reappearing. Another board may be starting; try again.`)
}

// Removes the file, but only while it is still this process's own.
export function server_state_release(data_directory: string): void {
  assert(path.isAbsolute(data_directory), 'data directory is an absolute path')
  const state = server_state_read(data_directory)
  if (state === null || state.pid !== process.pid) return
  assert(state.pid === process.pid, 'a process releases only its own claim')
  fs.rmSync(path.join(data_directory, state_file_name), { force: true })
}

export function process_alive(pid: number): boolean {
  assert(Number.isInteger(pid), 'pid is an integer')
  assert(pid > 0, 'pid is positive')
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // The process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
