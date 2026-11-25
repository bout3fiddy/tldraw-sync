// Teardown for the browser journeys: stopping the board process each spec owns, and closing the
// browser contexts it opened, both bounded and timed so a slow step is visible in the output.
//
// A child that has already exited, by its own code or by a signal, never emits `exit` again:
// Node sets `exitCode` for a normal exit and `signalCode` for a signalled one, and only one of
// them is ever set. Waiting for `exit` after either would wait forever.

import type { BrowserContext } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'

// How long the board gets to leave after SIGTERM, then after SIGKILL.
export const child_term_wait_ms = 5_000
export const child_kill_wait_ms = 5_000

export type ChildStop = {
  outcome: 'already_exited' | 'terminated' | 'killed'
  elapsed_ms: number
}

export function child_exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

// Resolves true when the child exits within `wait_ms`, false otherwise. Never leaves a timer.
function child_exit_wait(child: ChildProcess, wait_ms: number): Promise<boolean> {
  if (child_exited(child)) return Promise.resolve(true)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', on_exit)
      resolve(child_exited(child))
    }, wait_ms)
    const on_exit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', on_exit)
  })
}

// Stops an owned child: SIGTERM, then SIGKILL, each waited for a bounded time. Throws only if
// the child outlives SIGKILL, which would leave a process behind.
export async function child_stop(
  child: ChildProcess,
  term_wait_ms = child_term_wait_ms,
  kill_wait_ms = child_kill_wait_ms,
): Promise<ChildStop> {
  const started_ms = Date.now()

  if (child_exited(child)) return { outcome: 'already_exited', elapsed_ms: 0 }

  child.kill('SIGTERM')

  if (await child_exit_wait(child, term_wait_ms)) {
    return { outcome: 'terminated', elapsed_ms: Date.now() - started_ms }
  }

  child.kill('SIGKILL')

  if (await child_exit_wait(child, kill_wait_ms)) {
    return { outcome: 'killed', elapsed_ms: Date.now() - started_ms }
  }

  throw new Error(`the board process ${child.pid} outlived SIGKILL`)
}

// Closes every context, even when one fails, and reports how long each took.
export async function contexts_close(contexts: readonly BrowserContext[]): Promise<number[]> {
  const elapsed_ms: number[] = []
  const errors: unknown[] = []

  for (const context of contexts) {
    const started_ms = Date.now()

    try {
      await context.close()
    } catch (error) {
      errors.push(error)
    }

    elapsed_ms.push(Date.now() - started_ms)
  }

  if (errors.length > 0) throw errors[0]

  return elapsed_ms
}
