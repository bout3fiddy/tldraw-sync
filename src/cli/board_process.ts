// What the command line does on this machine, as opposed to over HTTP: find the repository,
// build the client when its sources changed, pick a port, start the board in the background,
// and open a browser.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assert } from '../shared/assert'

// The command runs from any folder, through a link; every path is relative to the repository.
export const repo_root = path.resolve(import.meta.dir, '../..')
export const static_directory = path.join(repo_root, 'dist')
export const cli_entry = path.join(repo_root, 'src', 'cli', 'main.ts')

export function data_directory(): string {
  return path.resolve(process.env.BOARD_DATA_DIR ?? path.join(repo_root, 'data'))
}

export function log_file(directory: string): string {
  return path.join(directory, 'server.log')
}

export function installed(): boolean {
  return fs.existsSync(path.join(repo_root, 'node_modules', 'tldraw', 'package.json'))
}

// Everything the client build reads. A build is needed when any of it is newer than the last
// build, which covers a `git pull` as well as an edit.
const build_inputs = ['index.html', 'vite.config.ts', 'package.json', 'bun.lock', 'public',
  'src/client', 'src/shared']
const build_input_files_count_max = 10_000

export function build_stale(): boolean {
  const built = path.join(static_directory, 'index.html')
  if (!fs.existsSync(built)) return true
  const built_ms = fs.statSync(built).mtimeMs
  const pending = build_inputs.map((input) => path.join(repo_root, input))
  let files_count = 0

  while (pending.length > 0) {
    const file = pending.pop() as string
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat === undefined) continue
    files_count += 1
    assert(files_count <= build_input_files_count_max, 'build inputs are bounded')
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) pending.push(path.join(file, entry))
    } else if (stat.mtimeMs > built_ms) {
      return true
    }
  }
  return false
}

export function build(): { ok: true } | { ok: false; output: string } {
  const result = Bun.spawnSync([process.execPath, 'run', 'build', '--logLevel', 'warn'], {
    cwd: repo_root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) return { ok: true }
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  return { ok: false, output: output.trim().split('\n').slice(-20).join('\n') }
}

// A port is free when nothing answers on it locally and this process can listen on it. Both
// checks matter: a dev server listening only on localhost does not stop a listen on all
// interfaces, but it would still answer every request sent to localhost.
export async function port_free(port: number): Promise<boolean> {
  assert(Number.isInteger(port) && port > 0 && port < 65536, 'port fits sixteen bits')
  for (const hostname of ['127.0.0.1', '::1']) {
    try {
      const socket = await Bun.connect({ hostname, port, socket: { data() {} } })
      socket.end()
      return false
    } catch {
      // Nothing answered on this address.
    }
  }
  try {
    const listener = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } })
    listener.stop(true)
    return true
  } catch {
    return false
  }
}

// Any free port, chosen by the system.
export function port_any(): number {
  const listener = Bun.listen({ hostname: '0.0.0.0', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  assert(port > 0, 'the system assigned a port')
  return port
}

export type Spawned = { pid: number; exited: () => boolean }

// Starts `serve` in a process of its own that outlives this one. Its output goes to a log.
export function server_spawn(port: number, directory: string): Spawned {
  assert(Number.isInteger(port) && port > 0, 'a background board has a definite port')
  fs.mkdirSync(directory, { recursive: true })
  const log = fs.openSync(log_file(directory), 'w')
  const child = spawn(process.execPath, [cli_entry, 'serve', '--port', String(port)], {
    cwd: repo_root,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, BOARD_DATA_DIR: directory },
  })
  fs.closeSync(log)
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  child.unref()
  assert(child.pid !== undefined, 'a spawned process has a pid')
  return { pid: child.pid, exited: () => exited }
}

export function log_tail(directory: string): string {
  try {
    return fs.readFileSync(log_file(directory), 'utf8').trim().split('\n').slice(-10).join('\n')
  } catch {
    return ''
  }
}

// Opens a page in the default browser. Returns false where there is no way to do that.
export function browser_open(url: string): boolean {
  assert(url.startsWith('http://'), 'only the board is ever opened')
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'linux' ? 'xdg-open'
      : null
  if (command === null) return false
  const result = Bun.spawnSync([command, url], { stdout: 'ignore', stderr: 'ignore' })
  return result.exitCode === 0
}
