// The uploader is driven here on a virtual clock, with a renderer and a server that the test
// controls, so every interleaving of drawing, rendering and uploading is exact.

import { expect, test } from 'bun:test'
import {
  render_delay_ms,
  upload_attempts_count_max,
  upload_retry_delay_ms,
} from '../shared/constants'
import { document_hash, type DocumentRecord } from '../shared/document_hash'
import { microtasks_drain, VirtualTime } from '../simulation/virtual_time'
import { drawing_uploader_create } from './drawing_uploader'

const render_ms = 50

function setup(options: { upload_succeeds: boolean }) {
  const time = new VirtualTime()
  const records: DocumentRecord[] = []
  const uploads: string[] = []
  let renders_count = 0
  const uploader = drawing_uploader_create({
    time,
    records: () => records,
    render: () => {
      renders_count += 1
      const image = new TextEncoder().encode(document_hash(records))
      return new Promise((resolve) => time.timeout_set(() => resolve(image), render_ms))
    },
    upload: async (hash, bytes) => {
      expect(new TextDecoder().decode(bytes)).toBe(hash)
      uploads.push(hash)
      return options.upload_succeeds
    },
  })

  let shapes_drawn = 0
  const draw = () => {
    shapes_drawn += 1
    records.push({ id: `shape:${shapes_drawn}`, typeName: 'shape' })
    uploader.change_notify()
  }
  const run_for = async (duration_ms: number) => {
    const until_ms = time.now_ms() + duration_ms
    while (time.run_next(until_ms)) await microtasks_drain()
    await microtasks_drain()
  }
  return { uploader, records, uploads, draw, run_for, renders_count: () => renders_count }
}

test('nothing is rendered while the pen is still moving', async () => {
  const board = setup({ upload_succeeds: true })
  for (let stroke = 0; stroke < 10; stroke += 1) {
    board.draw()
    await board.run_for(render_delay_ms - 1)
  }
  expect(board.renders_count()).toBe(0)

  await board.run_for(render_delay_ms + render_ms)
  expect(board.renders_count()).toBe(1)
  expect(board.uploads).toEqual([document_hash(board.records)])
})

test('an empty board is never rendered', async () => {
  const board = setup({ upload_succeeds: true })
  board.uploader.change_notify()
  await board.run_for(10_000)
  expect(board.renders_count()).toBe(0)
  expect(board.uploads).toEqual([])
})

test('a drawing that changes mid-render is rendered again, and only that is sent', async () => {
  const board = setup({ upload_succeeds: true })
  board.draw()
  await board.run_for(render_delay_ms + render_ms / 2)
  expect(board.renders_count()).toBe(1)

  board.draw()
  await board.run_for(10_000)
  expect(board.renders_count()).toBe(2)
  expect(board.uploads).toEqual([document_hash(board.records)])
})

test('a failed upload is retried a bounded number of times', async () => {
  const board = setup({ upload_succeeds: false })
  board.draw()
  await board.run_for(render_delay_ms + (upload_retry_delay_ms + render_ms) * 100)
  expect(board.uploads).toHaveLength(upload_attempts_count_max)

  // A new stroke starts a fresh set of attempts.
  board.draw()
  await board.run_for(render_delay_ms + (upload_retry_delay_ms + render_ms) * 100)
  expect(board.uploads).toHaveLength(upload_attempts_count_max * 2)
})

test('a stopped uploader does nothing more', async () => {
  const board = setup({ upload_succeeds: true })
  board.draw()
  board.uploader.stop()
  board.uploader.change_notify()
  await board.run_for(10_000)
  expect(board.renders_count()).toBe(0)
})
