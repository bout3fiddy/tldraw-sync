// Time is passed in, never reached for. Production hands out the real clock; the simulator
// hands out a virtual one, which is what makes every run replayable from a seed.

export type TimerHandle = { readonly timer: unique symbol }

export type Time = {
  now_ms(): number
  timeout_set(callback: () => void, delay_ms: number): TimerHandle
  timeout_clear(handle: TimerHandle): void
}

export const time_real: Time = {
  now_ms: () => Date.now(),
  timeout_set: (callback, delay_ms) => setTimeout(callback, delay_ms) as unknown as TimerHandle,
  timeout_clear: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
}
