// A browser runs no animation frames for a hidden page, and Chrome on a Mac counts a window as
// hidden when it is minimised or fully covered, say by a full-screen terminal. tldraw applies
// incoming strokes and notifies store listeners on animation frames, so a hidden stage would
// stop rendering the image that agents fetch. While the page is hidden, frames come from a
// timer instead.
//
// Two details make that hold up:
//   - Each timer hands its frame over through a MessageChannel. A frame callback that sets the
//     next timer would otherwise build a chain of nested timers, which Chrome slows to one a
//     minute after five hidden minutes. A message is not a timer, so no chain forms.
//   - Frames already requested when the page hides are moved to a timer, and back to a real
//     frame when it shows. tldraw waits on a pending frame before it asks for another, so one
//     stranded frame would stall it until the page is visible again.

import { assert } from '../shared/assert'
import { hidden_frame_interval_ms, hidden_frames_count_max } from '../shared/constants'

type Frame = {
  callback: FrameRequestCallback
  real_id: number | null
  timer: ReturnType<typeof setTimeout> | null
}

export function hidden_frames_install(): void {
  assert(typeof window.requestAnimationFrame === 'function', 'the page has animation frames')
  const frame_request_real = window.requestAnimationFrame.bind(window)
  const frame_cancel_real = window.cancelAnimationFrame.bind(window)
  const channel = new MessageChannel()
  const frames = new Map<number, Frame>()
  let id_last = 0

  const frame_run = (id: number, time_ms: number): void => {
    const frame = frames.get(id)
    if (frame === undefined) return
    frames.delete(id)
    frame.callback(time_ms)
  }

  const frame_schedule = (id: number, frame: Frame): void => {
    if (frame.real_id !== null) frame_cancel_real(frame.real_id)
    if (frame.timer !== null) clearTimeout(frame.timer)
    frame.real_id = null
    frame.timer = null
    if (document.hidden) {
      frame.timer = setTimeout(() => channel.port2.postMessage(id), hidden_frame_interval_ms)
    } else {
      frame.real_id = frame_request_real((time_ms) => frame_run(id, time_ms))
    }
  }

  channel.port1.onmessage = (event: MessageEvent<number>) => {
    frame_run(event.data, performance.now())
  }

  window.requestAnimationFrame = (callback) => {
    assert(frames.size < hidden_frames_count_max, 'pending frames are bounded')
    id_last += 1
    const frame: Frame = { callback, real_id: null, timer: null }
    frames.set(id_last, frame)
    frame_schedule(id_last, frame)
    return id_last
  }

  window.cancelAnimationFrame = (id) => {
    const frame = frames.get(id)
    if (frame === undefined) return
    frames.delete(id)
    if (frame.real_id !== null) frame_cancel_real(frame.real_id)
    if (frame.timer !== null) clearTimeout(frame.timer)
  }

  document.addEventListener('visibilitychange', () => {
    for (const [id, frame] of frames) frame_schedule(id, frame)
  })
}
