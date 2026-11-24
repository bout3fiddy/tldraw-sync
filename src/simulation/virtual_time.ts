// A clock that only moves when the simulator says so. While installed it also replaces the
// global timer functions, `Date.now`, and the random sources, because the sync library calls
// those directly. With every source of time and chance under one seed, a run is replayable.

import { assert } from '../shared/assert'
import type { Time, TimerHandle } from '../shared/time'
import type { Prng } from './prng'

type Timer = { at_ms: number; sequence: number; callback: () => void; interval_ms: number | null }

const timers_count_max = 10_000
// An arbitrary fixed instant, so that no run depends on the day it happens to run.
const epoch_ms = 1_700_000_000_000

export class VirtualTime implements Time {
  private readonly timers = new Map<number, Timer>()
  private sequence = 0
  private now = epoch_ms

  now_ms(): number {
    return this.now
  }

  timeout_set(callback: () => void, delay_ms: number): TimerHandle {
    return this.timer_add(callback, delay_ms, null) as unknown as TimerHandle
  }

  timeout_clear(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number)
  }

  timer_add(callback: () => void, delay_ms: number, interval_ms: number | null): number {
    assert(this.timers.size < timers_count_max, 'timers are bounded')
    const delay = Number.isFinite(delay_ms) ? Math.max(0, delay_ms) : 0
    this.sequence += 1
    this.timers.set(this.sequence, {
      at_ms: this.now + delay, sequence: this.sequence, callback, interval_ms,
    })
    return this.sequence
  }

  timer_remove(id: unknown): void {
    if (typeof id === 'number') this.timers.delete(id)
  }

  // Runs the earliest timer due at or before `until_ms`. Returns false, with the clock moved
  // to `until_ms`, when none is due. Ties run in the order the timers were created.
  run_next(until_ms: number): boolean {
    assert(until_ms >= this.now, 'time does not run backwards')
    let next: Timer | null = null
    let next_id = 0
    for (const [id, timer] of this.timers) {
      if (timer.at_ms <= until_ms) {
        if (next === null || timer.at_ms < next.at_ms
          || (timer.at_ms === next.at_ms && timer.sequence < next.sequence)) {
          next = timer
          next_id = id
        }
      }
    }
    if (next === null) {
      this.now = until_ms
      return false
    }

    this.now = Math.max(this.now, next.at_ms)
    if (next.interval_ms === null) {
      this.timers.delete(next_id)
    } else {
      this.sequence += 1
      next.at_ms = this.now + Math.max(1, next.interval_ms)
      next.sequence = this.sequence
    }
    next.callback()
    return true
  }
}

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  date_now: Date.now,
  math_random: Math.random,
  random_values: crypto.getRandomValues.bind(crypto),
}

// Lets every pending promise continuation run before the simulator takes its next step.
export function microtasks_drain(): Promise<void> {
  return new Promise((resolve) => real.setImmediate(resolve))
}

type Callback = (...parameters: unknown[]) => void

export function globals_install(time: VirtualTime, prng: Prng): () => void {
  const bind = (callback: Callback, parameters: unknown[]) => () => callback(...parameters)
  const globals = globalThis as unknown as Record<string, unknown>

  globals.setTimeout = (callback: Callback, delay_ms = 0, ...parameters: unknown[]) =>
    time.timer_add(bind(callback, parameters), delay_ms, null)
  globals.setInterval = (callback: Callback, delay_ms = 0, ...parameters: unknown[]) =>
    time.timer_add(bind(callback, parameters), delay_ms, delay_ms)
  globals.clearTimeout = (id: unknown) => time.timer_remove(id)
  globals.clearInterval = (id: unknown) => time.timer_remove(id)
  Date.now = () => time.now_ms()
  Math.random = () => prng.fraction()
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = prng.below(256)
    }
    return array
  }) as typeof crypto.getRandomValues

  return () => {
    globals.setTimeout = real.setTimeout
    globals.setInterval = real.setInterval
    globals.clearTimeout = real.clearTimeout
    globals.clearInterval = real.clearInterval
    Date.now = real.date_now
    Math.random = real.math_random
    crypto.getRandomValues = real.random_values
  }
}
