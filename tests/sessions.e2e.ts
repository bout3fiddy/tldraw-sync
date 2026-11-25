// Several boards in real browsers against the real board: the default board drawn as before,
// new boards made and switched from the side rail on the iPad, two boards presented at once in
// two Mac tabs, an agent fetching and cleaning each with --session, a proposal refused by the
// wrong board, a rename that beats the agent's title, a restart, and the default board at its
// old addresses afterwards.
//
// Run: bun run build && npx playwright test tests/sessions.e2e.ts

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
const data_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-sessions-e2e-'))

// The command line's temporary folder too, so default output paths stay inside the test.
const out_directory = path.join(data_directory, 'out')
fs.mkdirSync(out_directory, { recursive: true })
const ready_wait_ms = 20_000

let port = 0
let server: ChildProcess | null = null

type CliResult = { exit_code: number; json: Record<string, unknown> }

function cli(...args: string[]): CliResult {
  const result = spawnSync(bun, [cli_entry, ...args, '--json'], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory, TMPDIR: out_directory },
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

async function server_stop(): Promise<void> {
  const child = server
  server = null

  if (child === null) return

  const stop = await child_stop(child)
  console.log(`board stop: ${stop.outcome} after ${stop.elapsed_ms}ms`)
}

async function status(session = 'default'): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/status?session=${session}`)
  return (await response.json()) as Record<string, unknown>
}

// A stroke drawn with the mouse, which tldraw treats as a pen when the page has no touch.
async function stroke(page: Page, offset_px: number): Promise<void> {
  await expect(page.getByRole('tab', { name: 'Sketch' })).toBeVisible()
  const box = await page.locator('section[aria-label="Sketch"]').boundingBox()
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

const rail = (page: Page) => page.getByRole('complementary', { name: 'Boards' })
const rail_open = async (page: Page) => {
  await page.getByRole('button', { name: 'Boards', exact: true }).click()
  await expect(rail(page)).toBeVisible()
}
const board_link = (page: Page, name: RegExp) => rail(page).getByRole('link', { name })
const board_id_of = (page: Page) => /\/s\/([0-9a-f]{16})/.exec(page.url())?.[1] ?? ''
const shape_text = (page: Page, text: string) =>
  page.locator('section[aria-label="Cleaned"] .tl-shape').getByText(text, { exact: true })

function proposal_publish(snapshot: string, session: string, title: string, ...args: string[]) {
  const file = path.join(out_directory, `${session}-${title.replace(/\W/g, '')}.json`)
  fs.mkdirSync(out_directory, { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: 'tldraw-sync.cleanup.v1',
      snapshot,
      base_revision: 0,
      session,
      title,
      agent: 'e2e-agent',
      shapes: [
        { kind: 'rectangle', id: 'client', x: 0, y: 0, w: 180, h: 90, text: `${title} client` },
        { kind: 'ellipse', id: 'server', x: 320, y: 0, w: 160, h: 90, text: 'Server' },
        { kind: 'arrow', id: 'calls', from: 'client', to: 'server', text: 'calls' },
      ],
    }),
  )
  return cli('cleanup-publish', '--file', file, ...args)
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

test('boards: make, switch, present two at once, clean each, rename, restart', async ({
  browser,
}) => {
  const contexts = [
    await browser.newContext({ viewport: { width: 1280, height: 800 } }),
    await browser.newContext({ viewport: { width: 1180, height: 820 } }),
  ]

  try {
    const ipad = await contexts[1]!.newPage()
    const [one, two] = await boards_make_and_switch(ipad)
    const stages = [await contexts[0]!.newPage(), await contexts[0]!.newPage()] as const
    await boards_present_and_clean(stages, one, two)
    await rename_beats_title(ipad, two)
    await restart_and_default(ipad, stages, one, two)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})

// The default board first, at its old address; then two new boards from the rail and the CLI.
async function boards_make_and_switch(ipad: Page): Promise<[string, string]> {
  const origin = `http://127.0.0.1:${port}`
  await ipad.goto(`${origin}/draw`)
  await stroke(ipad, 0)
  await expect.poll(async () => (await status()).shapes_count).toBe(1)

  // The rail is a drawer on the iPad: it opens over the canvas, and Escape gives it back.
  await rail_open(ipad)
  await expect(board_link(ipad, /Untitled board/)).toHaveAttribute('aria-current', 'page')
  await ipad.keyboard.press('Escape')
  await expect(rail(ipad)).toBeHidden()
  await expect(ipad.getByRole('button', { name: 'Boards', exact: true })).toBeFocused()

  await rail_open(ipad)
  await rail(ipad).getByRole('button', { name: 'New board' }).click()
  await expect(ipad).toHaveURL(/\/s\/[0-9a-f]{16}\/draw$/)
  await expect(rail(ipad)).toBeHidden()
  const one = board_id_of(ipad)
  await stroke(ipad, 0)
  await expect.poll(async () => (await status(one)).shapes_count).toBe(1)
  expect(await status()).toMatchObject({ shapes_count: 1 })

  // A board made by the agent shows up in the rail without a reload.
  const made = cli('session-create')
  expect(made.json).toMatchObject({ code: 'session_created' })
  const two = String((made.json.session as { id: string }).id)
  await rail_open(ipad)
  await expect(rail(ipad).getByRole('link')).toHaveCount(3)
  await rail(ipad).locator(`a[href="/s/${two}/draw"]`).click()
  await expect(ipad).toHaveURL(new RegExp(`/s/${two}/draw$`))
  await stroke(ipad, -40)
  await stroke(ipad, 40)
  await expect.poll(async () => (await status(two)).shapes_count).toBe(2)
  expect(await status(one)).toMatchObject({ shapes_count: 1 })

  // Back goes to the board before, as it would between pages.
  await ipad.goBack()
  await expect(ipad).toHaveURL(new RegExp(`/s/${one}/draw$`))
  await expect(ipad.getByRole('tab', { name: 'Sketch' })).toBeVisible()
  await ipad.goForward()
  await expect(ipad).toHaveURL(new RegExp(`/s/${two}/draw$`))
  return [one, two]
}

// Two Mac tabs present two boards at once; each is fetched and cleaned by its own id.
async function boards_present_and_clean(
  stages: readonly [Page, Page],
  one: string,
  two: string,
): Promise<void> {
  const origin = `http://127.0.0.1:${port}`
  await stages[0].goto(`${origin}/s/${one}`)
  await stages[1].goto(`${origin}/s/${two}`)
  await expect.poll(async () => (await status(one)).stage_connected).toBe(true)
  await expect.poll(async () => (await status(two)).stage_connected).toBe(true)
  await expect(stages[0].locator('section[aria-label="Sketch"] .tl-shape')).toHaveCount(1)
  await expect(stages[1].locator('section[aria-label="Sketch"] .tl-shape')).toHaveCount(2)

  // Each board's image is its own, saved where the other's is not.
  const fetched_one = cli('fetch', '--session', one, '--no-open')
  const fetched_two = cli('fetch', '--session', two, '--no-open')
  const hash_one = (await status(one)).document_hash
  const hash_two = (await status(two)).document_hash
  expect(hash_one).not.toBe(hash_two)
  expect(fetched_one.json).toMatchObject({ session: one, document_hash: hash_one })
  expect(fetched_two.json).toMatchObject({ session: two, document_hash: hash_two })
  expect(fetched_one.json.path).not.toBe(fetched_two.json.path)

  // The first cleanup of an unnamed board asks for a title and names the board with it.
  const snapshot = cli('cleanup-snapshot', '--session', one, '--no-open')
  expect(snapshot.json).toMatchObject({ session: one, title_wanted: true })
  expect(String(snapshot.json.publish_command)).toContain(`--session ${one}`)
  const hash = String(snapshot.json.snapshot)

  // Replayed against the other board, the same proposal is refused there.
  const replay = proposal_publish(hash, one, 'Payments', '--session', two)
  expect(replay.exit_code).toBe(5)
  expect(replay.json).toMatchObject({ code: 'session_mismatch' })
  const published = proposal_publish(hash, one, 'Payments')
  expect(published.json).toMatchObject({ session: one, revision: 1, title_applied: true })

  for (const [page, shown] of [
    [stages[0], 1],
    [stages[1], 0],
  ] as const) {
    await page.getByRole('tab', { name: 'Cleaned' }).click()
    await expect(shape_text(page, 'Payments client')).toHaveCount(shown)
  }

  await expect(stages[1].getByText('No cleaned diagram yet.', { exact: false })).toBeVisible()
  await expect(stages[0]).toHaveTitle('Payments · Board')
}

// The agent snapshots an unnamed board; the person names it before the agent publishes.
async function rename_beats_title(ipad: Page, two: string): Promise<void> {
  const snapshot = cli('cleanup-snapshot', '--session', two, '--no-open')
  expect(snapshot.json).toMatchObject({ session: two, title_wanted: true })

  await rail_open(ipad)
  await expect(board_link(ipad, /Payments/)).toBeVisible()
  const active = rail(ipad).locator('li', { has: ipad.locator('[aria-current="page"]') })
  await active.getByRole('button', { name: /^Rename/ }).click()
  const field = rail(ipad).getByRole('textbox', { name: 'Board name' })
  await field.fill('Mine')
  await field.press('Enter')
  await expect(board_link(ipad, /Mine/)).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await status(two)).session_name).toBe('Mine')

  const published = proposal_publish(String(snapshot.json.snapshot), two, 'Agent title')
  expect(published.json).toMatchObject({ session: two, revision: 1, title_applied: false })
  expect(await status(two)).toMatchObject({ session_name: 'Mine', cleaned_revision: 1 })
  await rail(ipad).getByRole('button', { name: 'Close the list of boards' }).click()
  await expect(rail(ipad)).toBeHidden()
}

// Everything comes back after a restart, and the default board is where it always was.
async function restart_and_default(
  ipad: Page,
  stages: readonly [Page, Page],
  one: string,
  two: string,
): Promise<void> {
  await server_stop()
  await server_start()
  await ipad.reload()
  await stages[0].reload()
  await expect(ipad).toHaveURL(new RegExp(`/s/${two}/draw$`))
  await expect(ipad.getByRole('tab', { name: 'Sketch' })).toBeVisible()
  expect(await status(two)).toMatchObject({ shapes_count: 2, session_name: 'Mine' })
  expect(await status(one)).toMatchObject({ shapes_count: 1, session_name: 'Payments' })
  await expect(shape_text(stages[0], 'Payments client')).toBeVisible()

  // The default board: its own ink, its old addresses, and a cleanup written before sessions.
  await stages[1].goto(`http://127.0.0.1:${port}/`)
  await expect.poll(async () => (await status()).stage_connected).toBe(true)
  expect(await status()).toMatchObject({ shapes_count: 1, session: 'default' })
  await rail_open(ipad)
  await board_link(ipad, /Untitled board/).click()
  await expect(ipad).toHaveURL(/\/draw$/)
  expect(new URL(ipad.url()).pathname).toBe('/draw')
  const fetched = cli('fetch', '--no-open')
  expect(fetched.json).toMatchObject({ code: 'image_saved', session: 'default' })
  const snapshot = cli('cleanup-snapshot', '--no-open')
  expect(snapshot.json).toMatchObject({ session: 'default', base_revision: 0 })
  const legacy = path.join(out_directory, 'legacy.json')
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      format: 'tldraw-sync.cleanup.v1',
      snapshot: snapshot.json.snapshot,
      base_revision: 0,
      shapes: [{ kind: 'text', id: 'title', x: 0, y: 0, text: 'Default still works' }],
    }),
  )
  expect(cli('cleanup-publish', '--file', legacy).json).toMatchObject({ revision: 1 })
  await ipad.getByRole('tab', { name: 'Cleaned' }).click()
  await expect(shape_text(ipad, 'Default still works')).toBeVisible()
  expect(await status(one)).toMatchObject({ cleaned_revision: 1 })
}
