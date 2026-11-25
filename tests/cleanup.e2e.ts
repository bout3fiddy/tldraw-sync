// The cleanup journey in real browsers against the real board: draw on the draw page while the
// stage renders, take a snapshot with the command line as an agent would, publish a cleanup,
// view it in each tab, keep drawing side by side, watch it go stale, see a refused publish leave
// it in place, restart the board, and restore an earlier revision from the page.
//
// Run: bun run build && npx playwright test   (Bun and a Playwright Chromium on the host)

import { expect, test, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { child_stop, contexts_close } from './board_child'

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli_entry = path.join(repo_root, 'src', 'cli', 'main.ts')
const bun = process.env.BUN ?? 'bun'
const data_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-e2e-'))
const out_directory = path.join(data_directory, 'cleanup')
const ready_wait_ms = 20_000

let port = 0
let server: ChildProcess | null = null

type CliResult = { exit_code: number; json: Record<string, unknown> }

function cli(...args: string[]): CliResult {
  const result = spawnSync(bun, [cli_entry, ...args, '--json'], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const json = JSON.parse(result.stdout) as Record<string, unknown>
  return { exit_code: result.status ?? -1, json }
}

async function port_free_pick(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      listener.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function server_start(): Promise<void> {
  server = spawn(bun, [cli_entry, 'serve', '--port', String(port)], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    stdio: 'ignore',
  })
  const deadline_ms = Date.now() + ready_wait_ms

  while (Date.now() < deadline_ms) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`)

      if (response.ok) return
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('the board did not start')
}

// Bounded: SIGTERM, then SIGKILL, and timed so a slow teardown shows where it was slow.
async function server_stop(): Promise<void> {
  const child = server
  server = null

  if (child === null) return

  const stop = await child_stop(child)
  console.log(`board stop: ${stop.outcome} after ${stop.elapsed_ms}ms`)
}

async function status(): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`)
  return (await response.json()) as Record<string, unknown>
}

// A stroke drawn with the mouse, which tldraw treats as a pen when the page has no touch.
async function stroke(page: Page, pane: string, offset_px: number): Promise<void> {
  const box = await page.locator(`section[aria-label="${pane}"]`).boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width * 0.45 + offset_px
  const y = box!.y + box!.height * 0.5
  await page.mouse.move(x, y)
  await page.mouse.down()

  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(x + step * 8, y + Math.sin(step) * 20, { steps: 2 })
  }

  await page.mouse.up()
}

function proposal(snapshot: string, base_revision: number, title: string) {
  return {
    format: 'tldraw-sync.cleanup.v1',
    snapshot,
    base_revision,
    agent: 'e2e-agent',
    summary: `${title}: a client and a server.`,
    shapes: [
      { kind: 'text', id: 'title', x: 0, y: -90, text: title, size: 'l' },
      { kind: 'rectangle', id: 'client', x: 0, y: 0, w: 180, h: 90, text: 'Client' },
      { kind: 'ellipse', id: 'server', x: 320, y: 0, w: 160, h: 90, text: 'Server' },
      { kind: 'arrow', id: 'calls', from: 'client', to: 'server', text: 'calls' },
    ],
  }
}

function publish(snapshot: string, base_revision: number, title: string): CliResult {
  const file = path.join(out_directory, `${title}.json`)
  fs.mkdirSync(out_directory, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(proposal(snapshot, base_revision, title)))
  return cli('cleanup-publish', '--file', file)
}

test.beforeAll(async () => {
  port = await port_free_pick()
  await server_start()
})

test.afterAll(async () => {
  try {
    await server_stop()
  } finally {
    fs.rmSync(data_directory, { recursive: true, force: true })
  }
})

test('draw, snapshot, publish, view, go stale, restart and restore', async ({ browser }) => {
  const origin = `http://127.0.0.1:${port}`
  const contexts = [
    await browser.newContext({ viewport: { width: 1280, height: 800 } }),
    await browser.newContext({ viewport: { width: 1180, height: 820 } }),
  ]

  try {
    const stage = await contexts[0]!.newPage()
    const ipad = await contexts[1]!.newPage()
    await stage.goto(origin)
    await ipad.goto(`${origin}/draw`)
    await expect(ipad.getByRole('tab', { name: 'Sketch' })).toHaveAttribute('aria-selected', 'true')

    const hash_one = await first_cleanup_publish_and_view(ipad, stage)
    await sketch_continue_and_refuse(ipad, hash_one)
    await board_restart_and_restore(ipad, stage)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})

const cleaned_pane = (page: Page) => page.locator('section[aria-label="Cleaned"]')
// The only words over the cleaned diagram: the agent's description, and whether it is stale.
const caption = (page: Page) =>
  cleaned_pane(page).getByRole('complementary', { name: 'About this diagram' })
const stale_notice = (page: Page) =>
  cleaned_pane(page).getByText('The sketch has changed since this cleanup.')

// Shape text only: tldraw also keeps an off-screen element for measuring text.
const shape_text = (page: Page, text: string) =>
  cleaned_pane(page).locator('.tl-shape').getByText(text, { exact: true })

// Draws, snapshots and publishes as an agent would, then looks at the result in both pages.
// Returns the hash of the sketch the first cleanup was made from.
async function first_cleanup_publish_and_view(ipad: Page, stage: Page): Promise<string> {

  // Draw, and let the stage render it.
  await stroke(ipad, 'Sketch', 0)
  await expect.poll(async () => (await status()).shapes_count).toBe(1)
  const snapshot = cli('cleanup-snapshot', '--no-open', '--out', out_directory)
  expect(snapshot.exit_code).toBe(0)
  expect(snapshot.json).toMatchObject({ code: 'snapshot_saved', base_revision: 0, shapes_count: 1 })
  expect(snapshot.json.bounds).not.toBeNull()
  expect(fs.statSync(String(snapshot.json.path)).size).toBeGreaterThan(100)
  const hash_one = String(snapshot.json.snapshot)

  const first = publish(hash_one, 0, 'First')
  expect(first.json).toMatchObject({ code: 'published', revision: 1 })

  // The Cleaned tab shows the diagram and where it came from; the sketch is set aside.
  await ipad.getByRole('tab', { name: 'Cleaned' }).click()
  await expect(shape_text(ipad, 'Client')).toBeVisible()
  await expect(shape_text(ipad, 'Server')).toBeVisible()
  await expect(caption(ipad)).toHaveText('First: a client and a server.')
  await expect(caption(ipad).getByRole('button')).toHaveCount(0)
  await expect(ipad.locator('section[aria-label="Sketch"]')).toBeHidden()
  await expect(stale_notice(ipad)).toHaveCount(0)

  // The stage looks at the cleaned diagram too, and must keep rendering the sketch meanwhile.
  await stage.getByRole('tab', { name: 'Cleaned' }).click()
  await expect(shape_text(stage, 'Client')).toBeVisible()
  return hash_one
}

// Keeps drawing beside the cleanup, which goes stale, and has a publish from before refused.
async function sketch_continue_and_refuse(ipad: Page, hash_one: string): Promise<void> {

  // Side by side: drawing continues in the sketch, and the cleanup goes stale.
  await ipad.getByRole('tab', { name: 'Side by side' }).click()
  await expect(ipad.locator('section[aria-label="Sketch"]')).toBeVisible()
  await expect(cleaned_pane(ipad)).toBeVisible()
  await stroke(ipad, 'Sketch', -60)
  await expect.poll(async () => (await status()).shapes_count).toBe(2)
  await expect(stale_notice(ipad)).toBeVisible()
  await expect(ipad.locator('.tabs__stale')).toBeVisible()

  // The image agents fetch is current although the stage shows the cleaned tab.
  const fetched = cli('fetch', '--no-open', '--out', path.join(out_directory, 'now.png'))
  expect(fetched.json).toMatchObject({
    code: 'image_saved',
    document_hash: (await status()).document_hash,
  })

  // A publish from the old snapshot is refused, and the published diagram stays.
  const refused = publish(hash_one, 1, 'Refused')
  expect(refused.exit_code).toBe(5)
  expect(refused.json).toMatchObject({ code: 'sketch_changed' })
  await expect(shape_text(ipad, 'First')).toBeVisible()
}

// Restarts the board under both pages, then publishes again and restores the first revision.
async function board_restart_and_restore(ipad: Page, stage: Page): Promise<void> {
  const cleaned = cleaned_pane(ipad)

  // Restart: both canvases, and each page's chosen view, come back.
  await server_stop()
  await server_start()
  await ipad.reload()
  await stage.reload()
  await expect(ipad.getByRole('tab', { name: 'Side by side' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(shape_text(ipad, 'Client')).toBeVisible()
  await expect(stale_notice(ipad)).toBeVisible()
  expect(await status()).toMatchObject({ shapes_count: 2, cleaned_revision: 1 })

  // A second cleanup of the new sketch, then the agent brings back the first. The page has no
  // control for that: it only shows the result.
  const fresh = cli('cleanup-snapshot', '--no-open', '--out', out_directory)
  expect(fresh.json).toMatchObject({ base_revision: 1, shapes_count: 2 })
  expect(publish(String(fresh.json.snapshot), 1, 'Second').json).toMatchObject({ revision: 2 })
  await expect(shape_text(ipad, 'Second')).toBeVisible()
  await expect(stale_notice(ipad)).toHaveCount(0)
  await expect(cleaned.getByRole('button', { name: /Restore/ })).toHaveCount(0)
  const restored = cli('cleanup-restore', '--base-revision', '2', '--revision', '1')
  expect(restored.json).toMatchObject({ code: 'restored', revision: 3, restored_from: 1 })
  await expect(shape_text(ipad, 'First')).toBeVisible()
  // The first cleanup was made from the one-stroke sketch, so it comes back marked stale.
  await expect(caption(ipad)).toHaveText(
    'First: a client and a server.The sketch has changed since this cleanup.',
  )
  expect(await status()).toMatchObject({ cleaned_revision: 3, shapes_count: 2 })
}
