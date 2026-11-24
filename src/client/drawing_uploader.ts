// Keeps the server's image of the drawing current. Once the pen has rested, the stage renders
// the drawing and uploads it together with the hash of the records it rendered. The server
// serves an image only while that hash matches its own document, so a late or lost upload can
// make a fetch wait, but it can never make a fetch return the wrong drawing.
//
// This module touches no browser API: rendering and uploading are passed in, which lets the
// simulator run it unchanged.

import { assert } from '../shared/assert'
import {
  render_delay_ms,
  upload_attempts_count_max,
  upload_retry_delay_ms,
} from '../shared/constants'
import { document_hash, shapes_count, type DocumentRecord } from '../shared/document_hash'
import type { Time, TimerHandle } from '../shared/time'

export type UploaderIO = {
  readonly time: Time
  records(): readonly DocumentRecord[]
  render(): Promise<Uint8Array | null>
  upload(hash: string, bytes: Uint8Array): Promise<boolean>
}

export type DrawingUploader = { change_notify(): void; stop(): void }

type Outcome = 'uploaded' | 'nothing_to_draw' | 'changed_meanwhile' | 'failed'

export function drawing_uploader_create(io: UploaderIO): DrawingUploader {
  let timer: TimerHandle | null = null
  let rendering = false
  let changed = false
  let attempts_count = 0
  let stopped = false

  function timer_restart(delay_ms: number): void {
    assert(!stopped, 'uploader is running')
    assert(!rendering, 'no timer is armed while rendering')
    if (timer !== null) io.time.timeout_clear(timer)
    timer = io.time.timeout_set(() => {
      timer = null
      void cycle()
    }, delay_ms)
  }

  async function cycle(): Promise<void> {
    assert(!rendering, 'one render at a time')
    rendering = true
    changed = false
    const outcome = await attempt(io)
    rendering = false
    if (stopped) return

    if (changed || outcome === 'changed_meanwhile') {
      // The drawing moved on while this one was being rendered: render the newer one.
      timer_restart(render_delay_ms)
    } else {
      if (outcome === 'failed') {
        attempts_count += 1
        if (attempts_count < upload_attempts_count_max) timer_restart(upload_retry_delay_ms)
      }
    }
    assert(attempts_count <= upload_attempts_count_max, 'retries are bounded')
  }

  return {
    change_notify() {
      if (stopped) return
      changed = true
      attempts_count = 0
      if (!rendering) timer_restart(render_delay_ms)
    },
    stop() {
      stopped = true
      if (timer !== null) io.time.timeout_clear(timer)
      timer = null
    },
  }
}

// One render and one upload. The hash is taken before rendering and checked after, so an
// image is only ever sent under the hash of the records it actually shows.
async function attempt(io: UploaderIO): Promise<Outcome> {
  const records = io.records()
  if (shapes_count(records) === 0) return 'nothing_to_draw'
  const hash = document_hash(records)

  let bytes: Uint8Array | null
  try {
    bytes = await io.render()
  } catch {
    return 'failed'
  }
  if (bytes === null) return 'failed'
  if (document_hash(io.records()) !== hash) return 'changed_meanwhile'

  try {
    return (await io.upload(hash, bytes)) ? 'uploaded' : 'failed'
  } catch {
    return 'failed'
  }
}
