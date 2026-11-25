// Stopping the board's process is bounded whatever state the process is in: already gone by a
// signal, leaving on SIGTERM, or ignoring SIGTERM until killed.

import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { child_exited, child_stop } from './board_child'

function idle_child(ignore_term: boolean): ChildProcess {
  const handler = ignore_term ? "process.on('SIGTERM', () => {});" : ''
  const script = `${handler} process.stdout.write('ready'); setInterval(() => {}, 1000)`
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise((resolve) => child.stdout?.once('data', resolve))
}

async function exit_wait(child: ChildProcess): Promise<void> {
  if (child_exited(child)) return

  await new Promise((resolve) => child.once('exit', resolve))
}

// The regression: a child already ended by a signal has `exitCode` null and `signalCode` set.
// Checking `exitCode` alone waited for an `exit` event that had already been emitted.
test('a child already ended by a signal is not waited for', async () => {
  const child = idle_child(false)
  await ready(child)
  child.kill('SIGTERM')
  await exit_wait(child)
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBe('SIGTERM')

  const stop = await child_stop(child, 200, 200)
  expect(stop).toEqual({ outcome: 'already_exited', elapsed_ms: 0 })
})

test('a running child leaves on SIGTERM', async () => {
  const child = idle_child(false)
  await ready(child)
  const stop = await child_stop(child, 2_000, 2_000)
  expect(stop.outcome).toBe('terminated')
  expect(stop.elapsed_ms).toBeLessThan(2_000)
  expect(child_exited(child)).toBe(true)
})

test('a child ignoring SIGTERM is killed after the bounded wait', async () => {
  const child = idle_child(true)
  await ready(child)
  const stop = await child_stop(child, 200, 2_000)
  expect(stop.outcome).toBe('killed')
  expect(stop.elapsed_ms).toBeGreaterThanOrEqual(200)
  expect(child.signalCode).toBe('SIGKILL')
})
