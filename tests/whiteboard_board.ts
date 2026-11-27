// What the linked-board journeys share: a disposable board started through the real command
// line, a Mac stage and a paired iPad page, and the handles a person has on a board's chat:
// the Chat button, the field, Add sketch and Send. Nothing here touches a live board. Pairing
// ends on the canvas, so every journey starts on a board that can be drawn on.

import { expect, test, type Browser, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jsQR from 'jsqr'
import { whiteboard_protocol } from '../src/shared/whiteboard'
import type { Box } from './screen_pixels'

// The protocol a host names when it links and polls, as the command line takes it.
export const protocol = String(whiteboard_protocol)

// Every wait in these journeys is bounded. A control that cannot be reached, a page that does
// not load or a window that does not open fails in seconds, under the name of its step, and
// never holds the browser check until its whole budget is gone.
export const action_ms = 5_000
export const navigation_ms = 10_000
export const step_long_ms = 60_000
const step_ms = 30_000
const command_ms = 30_000

// Playwright times what is done to a locator and what is expected of one. It does not time a
// bare key, a touch, a pointer move, a window size or a script in the page: with no answer
// from the browser those wait for as long as the test lasts. Each is given a few seconds
// here, and the error is made at the call, so that it names the line that got no answer.
export function soon<T>(work: Promise<T>, wait_ms = action_ms): Promise<T> {
  const late = new Error(`No answer from the browser within ${wait_ms}ms.`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const overdue = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late), wait_ms)
  })
  return Promise.race([work, overdue]).finally(() => clearTimeout(timer))
}

export type Cli = (...args: string[]) => any

export type Linked = {
  root: string
  file: string
  cli: Cli
  bound: Cli
  stage: Page
  ipad: Page
  session: string
  origin: string

  // The command's own answer to the link, for checks on what it does and does not reveal.
  linked: Record<string, unknown>
}

export const ipad_portrait = { width: 820, height: 1180 }
export const ipad_landscape = { width: 1180, height: 820 }

// A third of an iPad in Split View: the narrowest the draw page is asked to work at.
export const ipad_narrow = { width: 375, height: 800 }

export function command(root: string, ...args: string[]) {
  const result = spawnSync(process.env.BUN ?? 'bun', ['src/cli/main.ts', ...args, '--json'], {
    env: { ...process.env, BOARD_DATA_DIR: root, PATH: `${root}:${process.env.PATH}` },
    timeout: command_ms,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })

  // Named by its subcommand only: arguments and output may hold an address or a binding.
  if (typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    const how = result.error ? 'did not finish' : `exited ${result.status}`
    throw Error(`tldraw-sync ${args[0]} ${how} and printed nothing.`)
  }

  return JSON.parse(result.stdout)
}

// What a failure says on the spot, with any address taken out and nothing past its first lines.
function brief(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>')
    .split('\n')
    .slice(0, 3)
    .join(' | ')
    .slice(0, 400)
}

// One named, time-boxed step. Its name is printed as it starts, so that a check cut short
// from outside still shows which step it was in.
export async function step<T>(
  name: string,
  body: () => Promise<T>,
  timeout_ms = step_ms,
): Promise<T> {
  console.log(`  step: ${name}`)
  return test.step(name, body, { timeout: timeout_ms })
}

export type Phase = readonly [name: string, run: () => Promise<void>]

// The phases of one journey on one board. Each starts from the same settled screen and is
// judged by itself: a failure is printed at once and the next phase still runs, so one run
// shows everything that is wrong. The journey then fails with the first failure.
export async function phases(settle: () => Promise<void>, list: readonly Phase[]) {
  const failed: { name: string; error: unknown }[] = []

  for (const [name, run] of list) {
    try {
      await step(name, async () => {
        await settle()
        await run()
      })
    } catch (error) {
      failed.push({ name, error })
      console.log(`  failed: ${name}: ${brief(error)}`)
    }
  }

  const first = failed[0]

  if (first === undefined) return

  const names = failed.map((failure) => failure.name).join('; ')

  if (first.error instanceof Error) {
    first.error.message = `${failed.length} of ${list.length} phases failed (${names}). First: ${
      first.error.message
    }`
  }

  throw first.error
}

// The board's chat: one button at the top right, a drawer over the canvas, a field, Add sketch
// and Send.
export const chat_button = (page: Page) => page.getByRole('button', { name: /^Chat/ })
export const field = (page: Page) => page.getByRole('textbox', { name: 'Message to agent' })
export const send_button = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })
export const add_sketch = (page: Page) =>
  page.getByRole('button', { name: /^(Add sketch|Remove sketch)$/ })
export const messages = (page: Page) => page.getByRole('log', { name: 'Messages' })
export const mine = (page: Page, text: string | RegExp) =>
  messages(page).locator('.chat__mine').filter({ hasText: text })
export const answers = (page: Page, text: string | RegExp) =>
  messages(page).locator('.chat__answer').filter({ hasText: text })

// The controls the board had before its chat and its one canvas. None of them may come back:
// no note, no bell, and no tabs or layer switch between the sketch and the agent's drawing.
export const retired_controls = (page: Page) =>
  page
    .getByRole('button', { name: /^(Agent note|Notifications|Replace sketchboard)/ })
    .or(page.getByRole('tab'))
    .or(page.getByRole('tablist'))
    .or(page.locator('dialog.notepad, .dock, .inbox, .views, .agent-pane'))

// The canvas: the person's ink and, under it, the agent's print.
export const surface = (page: Page) => page.getByRole('region', { name: 'Canvas' })
export const print_region = (page: Page) => page.getByRole('region', { name: 'Agent print' })
export const print_shape = (page: Page, id: string) =>
  page.locator(`.print__shape[data-print-shape="shape:scene-${id}"]`)

// The key at the foot of the canvas, and its name for the agent's print, which brings the
// print into view when pressed.
export const key = (page: Page) => page.locator('.key')
export const key_agent = (page: Page) => key(page).locator('[data-layer="agent"]')

// Opens the chat if it is not open, and waits until its field is there.
export async function chat_open(page: Page) {
  if ((await chat_button(page).getAttribute('aria-expanded')) !== 'true') {
    await chat_button(page).click()
  }

  await expect(chat_button(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(field(page)).toBeVisible()

  // The drawer slides in. What is measured next is measured where it comes to rest. The check
  // runs in the page, so it carries everything it needs.
  const drawer = page.getByRole('complementary', { name: 'Chat' })
  await expect
    .poll(() =>
      drawer.evaluate((element) =>
        element.getAnimations().some((animation) => animation.playState !== 'finished'),
      ),
    )
    .toBe(false)
}

// Closes the chat if it is open: the canvas has the whole screen again.
export async function sketch_open(page: Page) {
  if ((await chat_button(page).getAttribute('aria-expanded')) === 'true') {
    await chat_button(page).click()
  }

  await expect(chat_button(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('complementary', { name: 'Chat' })).toHaveCount(0)
}

// Writes `words` in the chat and sends them, the sketch with them if asked, and waits until the
// Mac has them: the field is cleared only by a confirmed send.
export async function chat_send(page: Page, words: string, with_sketch = false) {
  await chat_open(page)

  if (with_sketch && (await add_sketch(page).getAttribute('aria-pressed')) !== 'true') {
    await add_sketch(page).click()
  }

  await expect(add_sketch(page)).toHaveAttribute('aria-pressed', String(with_sketch))
  await field(page).fill(words)
  await send_button(page).click()
  await expect(field(page)).toHaveValue('')
  await expect(add_sketch(page)).toHaveAttribute('aria-pressed', 'false')
}

export type Rect = Box & { width: number; height: number }

export type Mark = {
  own: boolean
  covered: number
  sketch: boolean
  drawn_over: boolean
  from_right: number
  from_bottom: number
  width: number
  height: number
}

// tldraw's notice in each canvas that is on screen: whether a press at its centre reaches it,
// how many pieces of this app's chrome overlap it, and where it sits in its own pane.
export function marks(page: Page): Promise<Mark[]> {
  return page.evaluate(() => {
    const chrome = '.chat, .drawer, .strip, .title, .corner, .key, .notice'
    const round = (value: number) => Math.round(value * 100) / 100
    const found: Mark[] = []

    for (const mark of document.querySelectorAll('[data-testid^="tl-watermark"]')) {
      const pane = mark.closest('.surface, .bench, .print-bench')!

      if (getComputedStyle(pane).visibility !== 'visible') continue

      const whole = mark.getBoundingClientRect()
      const frame = pane.getBoundingClientRect()

      // In a narrow canvas tldraw hangs its notice two pixels past the pane's edge, where the
      // pane clips it. What counts is the part a person can see and press.
      const box = {
        left: Math.max(whole.left, frame.left),
        right: Math.min(whole.right, frame.right),
        top: Math.max(whole.top, frame.top),
        bottom: Math.min(whole.bottom, frame.bottom),
      }
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)
      const meets = (element: Element) => {
        const other = element.getBoundingClientRect()
        const apart =
          other.right <= box.left ||
          other.left >= box.right ||
          other.bottom <= box.top ||
          other.top >= box.bottom
        return other.width > 0 && other.height > 0 && !apart
      }
      const covered = [...document.querySelectorAll(chrome)].filter(meets).length
      const canvas = pane.querySelector('.tl-canvas')
      found.push({
        own: hit !== null && mark.contains(hit),
        covered,
        sketch: pane.classList.contains('surface'),

        // Whether the drawing surface of its own canvas reaches under the notice.
        drawn_over: canvas !== null && meets(canvas),
        from_right: round(frame.right - whole.right),
        from_bottom: round(frame.bottom - whole.bottom),
        width: round(box.right - box.left),
        height: round(box.bottom - box.top),
      })
    }

    return found
  })
}

// Every notice on screen is whole, reachable and clear of this app's chrome. Where it rests
// is tldraw's choice: the sketch is tldraw's canvas as it comes, so its notice lies over the
// drawing surface, in the corner tldraw keeps it in. The branding is tldraw's: these journeys
// only ever look at it and press it, as a person would.
export async function expect_marks_clear(page: Page, count: number): Promise<Mark[]> {
  const wrong = (mark: Mark) => !mark.own || mark.covered > 0 || mark.width <= 0 || mark.height <= 0

  // Polled: tldraw chooses the notice's form from a width it measures a moment after a resize.
  await expect
    .poll(async () => {
      const found = await marks(page)
      return { count: found.length, wrong: found.filter(wrong) }
    })
    .toEqual({ count, wrong: [] })
  return marks(page)
}

async function scan(stage: Page) {
  const qr = stage.locator('.guide--card .guide__code')
  await expect(qr).toBeVisible()
  const pixels = await qr.evaluate(async (svg) => {
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)

    try {
      const image = new Image()
      image.src = url
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 480
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, 480, 480)
      ctx.drawImage(image, 0, 0, 480, 480)
      return Array.from(ctx.getImageData(0, 0, 480, 480).data)
    } finally {
      URL.revokeObjectURL(url)
    }
  })
  const decoded = jsQR(new Uint8ClampedArray(pixels), 480, 480)

  if (!decoded) throw Error('The stage QR is unreadable.')

  return new URL(decoded.data)
}

// One pen stroke, clear of the tools on the left.
export const draw = (ipad: Page) => stroke(ipad, { x: 280, y: 290 }, { x: 20, y: 15 })

// A pen pressed at `from` and moved three steps of `by` before it lifts.
export async function stroke(
  ipad: Page,
  from: { x: number; y: number },
  by: { x: number; y: number },
) {
  const cdp = await ipad.context().newCDPSession(ipad)

  try {
    for (const [n, type] of [
      'mousePressed',
      'mouseMoved',
      'mouseMoved',
      'mouseReleased',
    ].entries()) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: type as 'mousePressed' | 'mouseMoved' | 'mouseReleased',
        x: from.x + n * by.x,
        y: from.y + n * by.y,
        button: 'left',
        buttons: n < 3 ? 1 : 0,
        pointerType: 'pen',
        force: 0.5,
        clickCount: 1,
      })
    }
  } finally {
    await cdp.detach()
  }
}

// Link a board as a pih host does, then pair the iPad by scanning the stage QR. Before the
// scan the chat can be written in but neither read nor sent, and says why. The scan is read
// with the chat open, and a reload keeps the pairing and drops it from the address. Pairing
// ends with the chat closed, on the canvas, where a pen stroke draws.
export async function pair(root: string, file: string, stage: Page, ipad: Page) {
  const link = () =>
    command(root, 'whiteboard-link', '--protocol', protocol, '--owner', 'e2e', '--out', file)
  const opener = path.join(root, process.platform === 'darwin' ? 'open' : 'xdg-open')
  fs.writeFileSync(opener, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  expect(link().code).toBe('stage_closed')
  fs.writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$BOARD_DATA_DIR/opened"\n')
  const linked = link()
  expect(linked.status).toBe('success')
  expect(link().session).toBe(linked.session)
  expect(fs.readFileSync(path.join(root, 'opened'), 'utf8')).toBe(linked.stage_url)
  await stage.goto(linked.stage_url)
  const paired = await scan(stage)
  expect(paired.hash.startsWith('#pair=')).toBe(true)
  await ipad.goto(new URL(linked.stage_url).origin + paired.pathname)
  await chat_open(ipad)
  await expect(field(ipad)).toHaveAttribute('placeholder', 'Scan the Mac stage QR to chat here')
  await expect(ipad.locator('.chat__standing')).toContainText('Not paired')
  await field(ipad).fill('Hello')
  await expect(send_button(ipad)).toBeDisabled()
  await ipad.evaluate((hash) => {
    location.hash = hash
  }, paired.hash)
  await expect(send_button(ipad)).toBeEnabled()
  await expect(ipad.locator('.chat__standing')).toHaveCount(0)
  await expect(field(ipad)).toHaveAttribute('placeholder', /^Message the agent about /)
  await ipad.reload()

  // The words, the pairing and the open chat outlive the reload; the pairing leaves the address.
  await expect(chat_button(ipad)).toHaveAttribute('aria-expanded', 'true')
  await expect(field(ipad)).toHaveValue('Hello')
  await expect(send_button(ipad)).toBeEnabled()
  expect(new URL(ipad.url()).hash.length).toBe(0)

  // Opening the chat raised no keyboard: nothing in it took the focus by itself.
  await expect(field(ipad)).not.toBeFocused()
  await field(ipad).fill('')
  await expect(send_button(ipad)).toBeDisabled()
  await sketch_open(ipad)
  return linked
}

// Runs one journey on its own disposable linked board, and always stops that board after.
export async function board_linked(browser: Browser, journey: (board: Linked) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-e2e-')))
  const file = path.join(root, 'binding.json')
  const cli: Cli = (...args) => command(root, ...args)
  const bound: Cli = (action, ...args) =>
    cli(
      `whiteboard-${action}`,
      '--binding',
      file,
      ...(action === 'poll' ? ['--protocol', protocol] : []),
      ...args,
    )
  const stage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const ipad = await browser.newPage({ viewport: ipad_portrait, hasTouch: true })

  // Set on the pages and on their contexts, which also bound a window opened from a page.
  for (const page of [stage, ipad]) {
    page.setDefaultTimeout(action_ms)
    page.setDefaultNavigationTimeout(navigation_ms)
    page.context().setDefaultTimeout(action_ms)
    page.context().setDefaultNavigationTimeout(navigation_ms)
  }

  try {
    const linked = await step('link a disposable board and pair the iPad by the stage QR', () =>
      pair(root, file, stage, ipad),
    )
    const origin = new URL(linked.stage_url).origin
    const session = String(linked.session)
    await journey({ root, file, cli, bound, stage, ipad, session, origin, linked })
  } finally {
    await Promise.all([stage.close(), ipad.close()])
    const stopped = cli('stop')
    expect(stopped.status).toBe('success')

    if (fs.existsSync(file)) expect(bound('poll').code).toBe('not_running')

    fs.rmSync(root, { recursive: true, force: true })
  }
}
