// What the linked-board journeys share: a disposable board started through the real command
// line, a Mac stage and a paired iPad page, and the handles a person has on the iPad: the note
// button, the bell, the note itself and its one control. Nothing here touches a live board.
//
// The note is a modal dialog. While it is open the page behind it is inert: no press reaches
// it, and it is out of the accessibility tree. What lies behind is then read from the page
// itself, by attribute, and is never pressed. Pairing ends with the note put away, so every
// journey starts on a board that can be drawn on and pressed.

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
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

export const chat = (page: Page) => page.getByRole('button', { name: /^Agent note/ })
export const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ })
export const note = (page: Page) => page.getByRole('textbox', { name: 'Note to agent' })

// The one control on the note: it sends the sketch, with the note when there is one.
export const notify = (page: Page) => page.getByRole('button', { name: 'Send to agent' })
export const inbox = (page: Page) => page.getByRole('dialog', { name: 'Notifications' })
export const rows = (page: Page) => inbox(page).getByRole('listitem')

// The same two buttons and the list, found on the page itself. With the note open they are
// behind a modal dialog, where a role would not look for them: `chat`, `bell` and `inbox`,
// which find them by role, are for when the note is shut.
export const chat_behind = (page: Page) =>
  page.locator('.dock__button[aria-controls="agent-composer"]')
export const bell_behind = (page: Page) =>
  page.locator('.dock__button[aria-controls="agent-inbox"]')
export const inbox_behind = (page: Page) => page.locator('.inbox')

// The note is closed until asked for. Opening it is a tap on the button by the tools, which
// is pressed by role: it can be, with the note shut. Open, the note is the browser's own
// modal dialog, and its button says so from behind it.
export async function composer_open(page: Page) {
  const state = chat_behind(page)
  await expect(state).toBeVisible()

  if ((await state.getAttribute('aria-expanded')) !== 'true') await chat(page).tap()

  await expect(state).toHaveAttribute('aria-expanded', 'true')
  await expect(note(page)).toBeVisible()
  const sheet = page.getByRole('dialog', { name: 'Agent note' })
  expect(await sheet.evaluate((element) => element.matches(':modal'))).toBe(true)
}

// The note is put away with Escape, which is heard wherever the focus is. While the note is
// open nothing else on the page can be pressed, so every step outside it starts here. Its
// words and a request still on its way are kept.
export async function composer_close(page: Page) {
  const state = chat_behind(page)
  await expect(state).toBeVisible()

  if ((await state.getAttribute('aria-expanded')) === 'true') {
    await soon(page.keyboard.press('Escape'))
  }

  await expect(state).toHaveAttribute('aria-expanded', 'false')
  await expect(note(page)).toBeHidden()
}

// The list never opens by itself, and a press anywhere else closes it: open it to look. The
// bell can be pressed only with the note shut, so the note is put away first.
export async function inbox_open(page: Page) {
  await composer_close(page)
  const trigger = bell(page)

  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.tap()

  await expect(inbox(page)).toBeVisible()
}

export async function inbox_close(page: Page) {
  await composer_close(page)
  const trigger = bell(page)

  if ((await trigger.getAttribute('aria-expanded')) === 'true') await trigger.tap()

  await expect(inbox(page)).toBeHidden()
}

// The one row that says `text`, with the note put away and the list opened to read it.
export async function row_with(page: Page, text: string | RegExp): Promise<Locator> {
  await inbox_open(page)
  const row = rows(page).filter({ hasText: text })
  await expect(row).toHaveCount(1)
  return row
}

export const rows_about = (page: Page, subject: string, state?: string) =>
  inbox(page).locator(`li[data-subject="${subject}"]${state ? `[data-state="${state}"]` : ''}`)

export type Rect = Box & { width: number; height: number }

// Where this app's pieces are on screen, in CSS pixels, read in one go so that they belong to
// one frame. A piece that is not shown is null. `reach` is whether a press at the middle of
// each of the agent's two buttons lands on that button. `marks` are tldraw's own notices.
export type Layout = {
  screen: Rect
  views: Rect | null
  pane: Rect | null
  sheet: Rect | null
  margin: Rect | null
  strip: Rect | null
  dock: Rect | null
  chat: Rect | null
  bell: Rect | null
  tabs: Rect | null
  boards: Rect | null
  band: Rect | null
  capsule: Rect | null
  inbox: Rect | null
  marks: Rect[]
  reach: { chat: boolean; bell: boolean }
}

export function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (element === null) return null

      const r = element.getBoundingClientRect()
      const shown = r.width > 0 && r.height > 0

      if (!shown || getComputedStyle(element).visibility !== 'visible') return null

      const { left, top, right, bottom, width, height } = r
      return { left, top, right, bottom, width, height }
    }
    const one = (selector: string) => rect(document.querySelector(selector))
    const reached = (element: Element | undefined) => {
      if (element === undefined) return false

      const r = element.getBoundingClientRect()
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
      return hit !== null && element.contains(hit)
    }
    const [chat, bell] = document.querySelectorAll('.dock__button')
    const marks = [...document.querySelectorAll('[data-testid^="tl-watermark"]')].map(rect)
    return {
      screen: { left: 0, top: 0, right: innerWidth, bottom: innerHeight } as Rect,
      views: one('.views'),
      pane: one('.views__pane--sketch'),
      sheet: one('.views__pane--sketch .tl-canvas'),
      margin: one('.sheet__margin'),
      strip: one('.strip'),
      dock: one('.dock'),
      chat: rect(chat ?? null),
      bell: rect(bell ?? null),
      tabs: one('.tabs'),
      boards: one('.rail-toggle'),
      band: one('.composer'),
      capsule: one('.composer__capsule'),
      inbox: one('.inbox'),
      marks: marks.filter((mark) => mark !== null),
      reach: { chat: reached(chat), bell: reached(bell) },
    }
  })
}

// Where the two buttons are meant to be: over the strip, at its right, at its left end, or,
// with no strip on screen, in the band above the views.
export type DockSide = 'above' | 'right' | 'left' | 'band'

const dock_gap_px = 8
const edge_tolerance_px = 0.5
const near = (a: number, b: number) => Math.abs(a - b) <= edge_tolerance_px
const overlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const within = (a: Box, b: Box) =>
  a.left >= b.left - edge_tolerance_px &&
  a.top >= b.top - edge_tolerance_px &&
  a.right <= b.right + edge_tolerance_px &&
  a.bottom <= b.bottom + edge_tolerance_px

// Whether the dock is fixed to the strip on the side asked: the gap between them and the
// edge they share. An empty list means it is.
function side_problems(dock: Rect, strip: Rect, side: Exclude<DockSide, 'band'>): string[] {
  const fixed = {
    above: [strip.top - dock.bottom, dock.left - strip.left],
    right: [dock.left - strip.right, dock.top - strip.top],
    left: [strip.left - dock.right, dock.bottom - strip.bottom],
  }[side] as [number, number]
  const problems: string[] = []

  if (!near(fixed[0], dock_gap_px)) problems.push(`${side}: gap to the strip is ${fixed[0]}px`)

  if (!near(fixed[1], 0)) problems.push(`${side}: out of line with the strip by ${fixed[1]}px`)

  return problems
}

// Everything wrong with where the agent's two buttons are, in words. Pure, so that it can be
// shown to catch a bad placing without a browser.
export function dock_problems(seen: Layout, side: DockSide): string[] {
  const { dock, chat, bell, strip, pane, views } = seen

  if (dock === null || chat === null || bell === null) return ['the two buttons are not shown']

  const problems: string[] = []
  const covered = { tabs: seen.tabs, Boards: seen.boards, 'the note band': seen.band }

  for (const [name, button] of Object.entries({ note: chat, bell })) {
    if (button.width < 44 || button.height < 44) problems.push(`${name} button is under 44px`)

    if (!within(button, seen.screen)) problems.push(`${name} button is off the screen`)

    if (!seen.reach[name === 'note' ? 'chat' : 'bell']) {
      problems.push(`a press on the ${name} button lands on something else`)
    }
  }

  if (overlap(chat, bell)) problems.push('the two buttons overlap')

  for (const [name, other] of Object.entries(covered)) {
    if (other !== null && overlap(dock, other)) problems.push(`the buttons cover ${name}`)
  }

  if (seen.marks.some((mark) => overlap(dock, mark))) problems.push('the buttons cover the link')

  if (side === 'band') {
    if (strip !== null) problems.push('band: the strip is on screen')

    if (views === null || dock.bottom > views.top) problems.push('band: the buttons hang below it')

    return problems
  }

  if (strip === null || pane === null) return [...problems, 'the strip is not on screen']

  if (overlap(dock, strip)) problems.push('the buttons cover the strip')

  if (!within(dock, pane)) problems.push('the buttons are cut off by the sketch pane')

  return [...problems, ...side_problems(dock, strip, side)]
}

// The two buttons are fixed to the strip on the side asked, whole, uncovered and reachable.
// Polled: a new window size is laid out a frame or two after it is asked for.
export async function expect_dock(page: Page, side: DockSide) {
  await expect.poll(async () => dock_problems(await layout(page), side)).toEqual([])
}

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
    const chrome = '.dock, .inbox, .composer:not([hidden]), .caption, .strip, .tabs, .notice'
    const round = (value: number) => Math.round(value * 100) / 100
    const found: Mark[] = []

    for (const mark of document.querySelectorAll('[data-testid^="tl-watermark"]')) {
      const pane = mark.closest('.views__pane')!

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
        sketch: pane.classList.contains('views__pane--sketch'),

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

// The notice with everything about it but whether a press reaches it: while the note is
// open, the browser keeps every press from the page behind it.
export const mark_placed = ({ own: _own, ...rest }: Mark) => rest

// Every notice on screen is whole, reachable and clear of this app's chrome. Where it rests
// is tldraw's choice: the sketch is tldraw's canvas as it comes, so its notice lies over the
// drawing surface, in the corner tldraw keeps it in. The branding is tldraw's: these journeys
// only ever look at it and press it, as a person would. Asked with the note shut, when a
// press can reach the page.
export async function expect_marks_clear(page: Page, count: number): Promise<Mark[]> {
  const wrong = (mark: Mark) =>
    !mark.own || mark.covered > 0 || mark.width <= 0 || mark.height <= 0

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
// scan the note can be written but not sent, and says why where the note would be typed.
// The scan is read while the note is open, and a reload shuts the note. Pairing ends with
// the note put away and its button holding the focus, so no journey starts behind a modal
// dialog, where a pen stroke would only put the note away and draw nothing.
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
  await composer_open(ipad)
  await expect(notify(ipad)).toBeDisabled()
  await expect(note(ipad)).toHaveAttribute('placeholder', 'Scan the Mac stage QR to send requests.')
  await ipad.evaluate((hash) => {
    location.hash = hash
  }, paired.hash)
  await expect(notify(ipad)).toBeEnabled()
  await expect(note(ipad)).toHaveAttribute('placeholder', 'Add a note (optional)')
  await ipad.reload()

  // A reload closes the note again: hidden is where it starts.
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
  await expect(note(ipad)).toBeHidden()
  await composer_open(ipad)
  await expect(notify(ipad)).toBeEnabled()
  expect(new URL(ipad.url()).hash.length).toBe(0)
  await composer_close(ipad)
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
  await expect(chat(ipad)).toBeFocused()
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
