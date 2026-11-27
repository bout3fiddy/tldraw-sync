// Several boards in real browsers against the real board: the default board drawn as before,
// new boards made and switched from the side rail on the iPad, two boards presented at once in
// two Mac tabs and fetched with --session, two more linked as an agent's host links them, a
// scene published to each with its own credentials and refused with the other's, a rename
// that beats the agent's title, a restart, and the default board at its old addresses
// afterwards.
//
// Run: bun run build && npx playwright test tests/sessions.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scene_format } from '../src/shared/scene_types'
import { whiteboard_protocol } from '../src/shared/whiteboard'
import { child_stop, contexts_close } from './board_child'

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli_entry = path.join(repo_root, 'src', 'cli', 'main.ts')
const bun = process.env.BUN ?? 'bun'
const protocol = String(whiteboard_protocol)

// Every journey owns its daemon, output paths and browser opener, never a live board.
let data_directory: string
let out_directory: string
let tools_directory: string
let private_directory: string
const ready_wait_ms = 20_000

let port = 0
let server: ChildProcess | null = null

type CliResult = { exit_code: number; json: Record<string, unknown> }

function cli(...args: string[]): CliResult {
  const result = spawnSync(bun, [cli_entry, ...args, '--json'], {
    cwd: repo_root,
    env: {
      ...process.env,
      BOARD_DATA_DIR: data_directory,
      TMPDIR: out_directory,
      PATH: `${tools_directory}:${process.env.PATH}`,
    },
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
  await expect(page.getByRole('region', { name: 'Canvas' })).toBeVisible()
  const box = await page.locator('section[aria-label="Canvas"]').boundingBox()
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

// Words in the agent's print on a linked board: in the picture the canvas shows, never the
// hidden editor the print is drawn from.
const shape_text = (page: Page, text: string) =>
  page
    .getByRole('region', { name: 'Agent print' })
    .locator('.print__shape')
    .getByText(text, { exact: true })

type Host = { session: string; bound: (action: string, ...args: string[]) => CliResult }

// A board linked as an agent's host links it: one board for each owner, and a private file
// with its credentials. Only a linked board has an Agent canvas an agent can publish to.
function host_link(owner: string): Host {
  const binding = path.join(private_directory, `${owner}.json`)
  const link = () =>
    cli('whiteboard-link', '--protocol', protocol, '--owner', owner, '--out', binding)
  const linked = link()
  expect(linked.json).toMatchObject({ status: 'success', code: 'linked' })
  const session = String(linked.json.session)

  // Linking again with the same owner and file is the same board, not another.
  expect(link().json).toMatchObject({ code: 'linked', session })
  expect(fs.statSync(binding).mode & 0o777).toBe(0o600)
  const bound = (action: string, ...args: string[]) =>
    cli(`whiteboard-${action}`, '--binding', binding, ...args)
  return { session, bound }
}

// The scene file a snapshot made ready, filled in and published with `sender`'s credentials.
function scene_publish(scene_path: string, title: string, sender: Host): CliResult {
  const scene = JSON.parse(fs.readFileSync(scene_path, 'utf8')) as Record<string, unknown>
  expect(scene).toMatchObject({ format: scene_format, base_revision: 0 })
  scene.title = title
  scene.agent = 'e2e-agent'
  scene.elements = [
    { type: 'geo', id: 'client', x: 0, y: 0, w: 260, h: 90, text: `${title} client`, font: 'sans' },
    { type: 'geo', id: 'server', geo: 'ellipse', x: 400, y: 0, w: 180, h: 90, text: 'Server' },
    { type: 'arrow', id: 'calls', from: 'client', to: 'server', text: 'calls' },
  ]
  fs.writeFileSync(scene_path, JSON.stringify(scene))
  return sender.bound('publish', '--file', scene_path)
}

test.beforeEach(async () => {
  data_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-sessions-e2e-')))
  out_directory = path.join(data_directory, 'out')
  tools_directory = path.join(data_directory, 'tools')
  private_directory = path.join(data_directory, 'private')
  fs.mkdirSync(out_directory)
  fs.mkdirSync(tools_directory)

  for (const opener of ['open', 'xdg-open']) {
    fs.writeFileSync(path.join(tools_directory, opener), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }

  port = await port_free_pick()
  await server_start()
})

test.afterEach(async () => {
  try {
    await server_stop()
  } finally {
    fs.rmSync(data_directory, { recursive: true, force: true })
  }
})

test('boards: make, switch, present two at once, publish to each, rename, restart', async ({
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
    await boards_present_and_fetch(stages, one, two)
    const hosts = [host_link('sessions-payments'), host_link('sessions-mine')] as const
    expect(new Set(['default', one, two, hosts[0].session, hosts[1].session]).size).toBe(5)
    await linked_boards_publish(stages, hosts)
    await rename_beats_title(ipad, hosts[1])
    await restart_and_default(ipad, stages, [one, two], hosts)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})

test('row actions preserve native links, confirm the exact target and isolate other pages', async ({
  page,
  context,
}) => {
  const origin = `http://127.0.0.1:${port}`
  const create = async (name: string) => {
    const response = await page.request.post(`${origin}/api/sessions`, { data: { name } })
    expect(response.ok()).toBe(true)
    return String((await response.json()).session.id)
  }
  const first = await create('Current sketch')
  const second = await create('Review sketch')
  const peer = await context.newPage()
  await peer.goto(`${origin}/s/${second}`)
  await expect(peer).toHaveTitle('Review sketch · Board')
  await page.goto(`${origin}/s/${first}/draw`)
  await rail_open(page)
  const list = rail(page)
  await rename_inactive(page, peer)
  const options = (name: string) => list.getByRole('button', { name: `Actions for ${name}` })
  await expect(page).toHaveURL(`${origin}/s/${first}/draw`)
  await options('Revised sketch').click()
  await list.getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete “Revised sketch”?' })
  await expect(confirm.getByText(/cannot be undone/)).toBeVisible()
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(options('Revised sketch')).toBeFocused()
  expect(await status(second)).toMatchObject({ session_name: 'Revised sketch' })
  expect(await status(first)).toMatchObject({ session_name: 'Current sketch' })

  await options('Revised sketch').click()
  await list.getByRole('menuitem', { name: 'Delete' }).click()
  const rename = await peer.request.post(`${origin}/api/sessions/rename`, {
    data: { session: second, name: 'Final review' },
  })
  expect(rename.ok()).toBe(true)
  await confirm.getByRole('button', { name: 'Delete board' }).click()
  await expect(list.getByText(/Deletion not confirmed/)).toBeVisible()
  expect(await status(second)).toMatchObject({ session_name: 'Final review' })
  await options('Final review').click()
  await list.getByRole('menuitem', { name: 'Delete' }).click()
  await page
    .getByRole('dialog', { name: 'Delete “Final review”?' })
    .getByRole('button', { name: 'Delete board' })
    .click()
  await expect(options('Final review')).toHaveCount(0)
  await expect(list.getByRole('link', { name: 'Current sketch' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await peer.bringToFront()
  await expect(peer).toHaveURL(`${origin}/`)
  await page.bringToFront()
  await delete_current(page, origin)

  for (const id of [first, second]) {
    expect((await page.request.get(`${origin}/api/status?session=${id}`)).status()).toBe(404)
    expect(fs.existsSync(path.join(data_directory, 'sessions', id))).toBe(false)
  }
})

async function rename_inactive(page: Page, peer: Page) {
  const list = rail(page)
  const link = list.getByRole('link', { name: 'Review sketch' })

  // Right click stays a native link action, not an alternate trigger for the app menu.
  await link.click({ button: 'right' })
  expect(
    await link.evaluate((a) =>
      a.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      ),
    ),
  ).toBe(true)
  await expect(list.getByRole('menu')).toHaveCount(0)
  const options = (name: string) => list.getByRole('button', { name: `Actions for ${name}` })
  await options('Review sketch').press('Space')
  await expect(list.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(options('Review sketch')).toBeFocused()
  await options('Review sketch').press('Enter')
  await list.getByRole('menuitem', { name: 'Rename' }).click()
  const field = list.getByRole('textbox', { name: 'Board name' })
  await field.fill('Revised sketch')
  await field.press('Enter')
  await peer.bringToFront()
  await expect(peer).toHaveTitle('Revised sketch · Board')
  await page.bringToFront()
}

async function delete_current(page: Page, origin: string) {
  const list = rail(page)
  await list.getByRole('button', { name: 'Actions for Current sketch' }).click()
  await list.getByRole('menuitem', { name: 'Delete' }).click()
  await page
    .getByRole('dialog', { name: 'Delete “Current sketch”?' })
    .getByRole('button', { name: 'Delete board' })
    .click()
  await expect(page).toHaveURL(`${origin}/draw`)
  await expect(list.locator('a[href="/s/default/draw"]')).toHaveAttribute('aria-current', 'page')
}

test('both role homes follow deletion through an empty list and a new first board', async ({
  page: ipad,
  context,
}) => {
  const origin = `http://127.0.0.1:${port}`
  const stage = await context.newPage()
  await stage.goto(origin)
  await expect(stage).toHaveTitle('Untitled board · Board')
  await ipad.setViewportSize({ width: 1024, height: 768 })
  await ipad.goto(`${origin}/draw`)
  const creation = await ipad.request.post(`${origin}/api/sessions`, { data: { name: 'Second' } })
  expect(creation.ok()).toBe(true)
  const second = (await creation.json()).session.id
  const remove = async (name: string) => {
    await rail(ipad)
      .getByRole('button', { name: `Actions for ${name}` })
      .click()
    await rail(ipad).getByRole('menuitem', { name: 'Delete' }).click()
    await ipad.getByRole('dialog').getByRole('button', { name: 'Delete board' }).click()
  }
  await rail_open(ipad)
  await rail(ipad).getByRole('link', { name: 'Second' }).click()
  await expect(ipad).toHaveURL(`${origin}/s/${second}/draw`)
  await ipad.goBack()
  await expect(ipad).toHaveTitle('Untitled board · Board')
  await rail_open(ipad)
  await remove('Untitled board')
  await expect(ipad).toHaveURL(`${origin}/draw`)
  await expect(ipad).toHaveTitle('Second · Board')
  await stage.bringToFront()
  await expect(stage).toHaveTitle('Second · Board')
  await ipad.bringToFront()
  await remove('Second')
  const new_board = (page: Page) => rail(page).getByRole('button', { name: 'New board' })
  await expect(new_board(ipad)).toBeFocused()
  await ipad.goForward()
  await expect(ipad).toHaveURL(`${origin}/s/${second}/draw`)
  await expect(ipad.getByText(/There is no such board/)).toBeVisible()
  await ipad.goBack()
  await expect(ipad).toHaveURL(`${origin}/draw`)
  await stage.bringToFront()
  await expect(new_board(stage)).toBeVisible()
  await stage.reload()
  await expect(stage.getByText('No boards yet.')).toBeVisible()
  await ipad.bringToFront()
  await new_board(ipad).click()
  await expect(ipad).toHaveURL(/\/s\/[0-9a-f]{16}\/draw$/)
  const first = board_id_of(ipad)
  expect(first).not.toBe(second)
  await ipad.goBack()
  await expect(ipad).toHaveURL(`${origin}/draw`)
  await expect(ipad).toHaveTitle('Untitled board · Board')
  await stage.bringToFront()
  await expect(stage).toHaveTitle('Untitled board · Board')
  expect(await status(first)).toMatchObject({ shapes_count: 0, session: first })
  await ipad.goto(`${origin}/s/default/draw`)
  await expect(ipad.getByText(/There is no such board/)).toBeVisible()
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
  await expect(ipad.getByRole('region', { name: 'Canvas' })).toBeVisible()
  await ipad.goForward()
  await expect(ipad).toHaveURL(new RegExp(`/s/${two}/draw$`))
  return [one, two]
}

// Two Mac tabs present two boards at once; each is fetched by its own id.
async function boards_present_and_fetch(
  stages: readonly [Page, Page],
  one: string,
  two: string,
): Promise<void> {
  const origin = `http://127.0.0.1:${port}`
  await stages[0].goto(`${origin}/s/${one}`)
  await stages[1].goto(`${origin}/s/${two}`)
  await expect.poll(async () => (await status(one)).stage_connected).toBe(true)
  await expect.poll(async () => (await status(two)).stage_connected).toBe(true)
  await expect(stages[0].locator('section[aria-label="Canvas"] .tl-shape')).toHaveCount(1)
  await expect(stages[1].locator('section[aria-label="Canvas"] .tl-shape')).toHaveCount(2)

  // Each board's image is its own, saved where the other's is not.
  const fetched_one = cli('fetch', '--session', one, '--no-open')
  const fetched_two = cli('fetch', '--session', two, '--no-open')
  const hash_one = (await status(one)).document_hash
  const hash_two = (await status(two)).document_hash
  expect(hash_one).not.toBe(hash_two)
  expect(fetched_one.json).toMatchObject({ session: one, document_hash: hash_one })
  expect(fetched_two.json).toMatchObject({ session: two, document_hash: hash_two })
  expect(fetched_one.json.path).not.toBe(fetched_two.json.path)

  // A board nobody linked has no way in for an agent's drawing: the commands that drew on
  // one are gone, and the canvas commands ask for a binding.
  expect(cli('cleanup-snapshot', '--session', one).json).toMatchObject({ code: 'usage_error' })
  expect(cli('whiteboard-snapshot', '--session', one).json).toMatchObject({ status: 'failure' })
  expect(await status(one)).toMatchObject({ cleaned_revision: 0 })
}

// Two linked boards, each presented in its own Mac tab. A scene is published to the board
// its snapshot came from, and is refused when sent with the other board's credentials.
async function linked_boards_publish(
  stages: readonly [Page, Page],
  hosts: readonly [Host, Host],
): Promise<void> {
  const origin = `http://127.0.0.1:${port}`
  const [first, second] = hosts
  await stages[0].goto(`${origin}/s/${first.session}`)
  await stages[1].goto(`${origin}/s/${second.session}`)
  await expect.poll(async () => (await status(first.session)).stage_connected).toBe(true)
  await expect.poll(async () => (await status(second.session)).stage_connected).toBe(true)

  // The first snapshot of an unnamed board asks for a title. Nothing is drawn on it yet, and
  // an empty sketch still has a snapshot and a scene file ready to fill in.
  const snapshot = first.bound('snapshot', '--no-open')
  expect(snapshot.json).toMatchObject({
    code: 'snapshot_saved',
    session: first.session,
    title_wanted: true,
    base_revision: 0,
    shapes_count: 0,
  })
  expect(String(snapshot.json.publish_command)).toContain('whiteboard-publish --binding')
  const scene_path = String(snapshot.json.scene_path)

  // Sent with the other board's credentials, the same scene is refused there.
  const replay = scene_publish(scene_path, 'Payments', second)
  expect(replay.exit_code).toBe(5)
  expect(replay.json).toMatchObject({ code: 'session_mismatch' })
  expect(await status(second.session)).toMatchObject({ cleaned_revision: 0 })
  const published = scene_publish(scene_path, 'Payments', first)
  expect(published.json).toMatchObject({
    session: first.session,
    revision: 1,
    title_applied: true,
  })

  // Each stage shows its own board's print, on the one canvas, with no tab to switch to.
  for (const [page, shown] of [
    [stages[0], 1],
    [stages[1], 0],
  ] as const) {
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(shape_text(page, 'Payments client')).toHaveCount(shown)
  }

  await expect(stages[0].locator('.key')).toContainText('Agent · revision 1')
  await expect(stages[1].locator('.key')).toContainText('Agent · nothing yet')
  await expect(stages[0]).toHaveTitle('Payments · Board')
}

// The agent snapshots an unnamed board; the person names it before the agent publishes.
async function rename_beats_title(ipad: Page, host: Host): Promise<void> {
  const two = host.session
  const snapshot = host.bound('snapshot', '--no-open')
  expect(snapshot.json).toMatchObject({ session: two, title_wanted: true })

  await rail_open(ipad)
  await expect(board_link(ipad, /Payments/)).toBeVisible()
  await rail(ipad).locator(`a[href="/s/${two}/draw"]`).click()
  await expect(ipad).toHaveURL(new RegExp(`/s/${two}/draw$`))
  await expect(ipad.getByRole('region', { name: 'Canvas' })).toBeVisible()
  await expect(rail(ipad)).toBeHidden()
  await rail_open(ipad)
  const active = rail(ipad).locator('li', { has: ipad.locator('[aria-current="page"]') })
  await active.getByRole('button', { name: /^Actions for / }).click()
  await active.getByRole('menuitem', { name: 'Rename' }).click()
  const field = rail(ipad).getByRole('textbox', { name: 'Board name' })
  await field.fill('Mine')
  await field.press('Enter')
  await expect(board_link(ipad, /Mine/)).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await status(two)).session_name).toBe('Mine')

  const published = scene_publish(String(snapshot.json.scene_path), 'Agent title', host)
  expect(published.json).toMatchObject({ session: two, revision: 1, title_applied: false })
  expect(await status(two)).toMatchObject({ session_name: 'Mine', cleaned_revision: 1 })
  await rail(ipad).getByRole('button', { name: 'Close the list of boards' }).click()
  await expect(rail(ipad)).toBeHidden()
}

// Everything comes back after a restart, and the default board is where it always was.
async function restart_and_default(
  ipad: Page,
  stages: readonly [Page, Page],
  drawn: readonly [string, string],
  hosts: readonly [Host, Host],
): Promise<void> {
  const [one, two] = drawn
  const [first, second] = hosts
  await server_stop()
  await server_start()
  await ipad.reload()
  await stages[0].reload()
  await expect(ipad).toHaveURL(new RegExp(`/s/${second.session}/draw$`))
  await expect(ipad.getByRole('region', { name: 'Canvas' })).toBeVisible()
  expect(await status(one)).toMatchObject({ shapes_count: 1, cleaned_revision: 0 })
  expect(await status(two)).toMatchObject({ shapes_count: 2, cleaned_revision: 0 })
  expect(await status(first.session)).toMatchObject({
    session_name: 'Payments',
    cleaned_revision: 1,
  })
  expect(await status(second.session)).toMatchObject({ session_name: 'Mine', cleaned_revision: 1 })
  await expect(shape_text(stages[0], 'Payments client')).toBeVisible()

  // Each binding still speaks for its own board, and for no other.
  for (const host of hosts) {
    const polled = host.bound('poll', '--protocol', protocol)
    expect(polled.json).toMatchObject({ code: 'polled', session: host.session, agent_revision: 1 })
  }

  // The default board: its own ink and its old addresses. It was never linked, so it has no
  // Agent canvas to publish to, and nothing published elsewhere reached it.
  await stages[1].goto(`http://127.0.0.1:${port}/`)
  await expect.poll(async () => (await status()).stage_connected).toBe(true)
  expect(await status()).toMatchObject({ shapes_count: 1, session: 'default', cleaned_revision: 0 })
  await rail_open(ipad)
  await rail(ipad).locator('a[href="/s/default/draw"]').click()
  await expect(ipad).toHaveURL(/\/draw$/)
  expect(new URL(ipad.url()).pathname).toBe('/s/default/draw')
  const fetched = cli('fetch', '--no-open')
  expect(fetched.json).toMatchObject({ code: 'image_saved', session: 'default' })

  // Never linked and never published to: the canvas holds the person's ink alone, and the key
  // names no agent.
  await expect(ipad.locator('.key')).toContainText('Your ink')
  await expect(ipad.locator('.key')).not.toContainText('Agent')
  await expect(ipad.locator('.print__shape')).toHaveCount(0)
}
