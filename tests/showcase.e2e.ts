// The README's pictures, taken from the real board on a disposable linked board with synthetic
// content: a person's ink on the iPad, a request with the sketch explicitly added, the agent's
// diagram printed beside the ink, one of its shapes chosen to take, and the board's
// chat beside the drawing on the Mac stage. Nothing here is a mockup: every picture is a
// screenshot of the built app, taken only once what it shows has been checked.
//
// The browser check runs it on every candidate, so the pictures can always be taken again; it
// then writes them to a temporary directory and removes it. To keep them:
//
//   bun run build && SHOWCASE_OUT=/absolute/scratch npx playwright test tests/showcase.e2e.ts
//
// SHOWCASE_OUT must be an existing absolute directory, such as private scratch: the pictures
// are looked at there before they replace those in docs/images. No picture holds a QR code or
// a pairing: the stage guide and its Pair iPad sheet are checked absent, and the iPad's
// address has lost its pairing fragment, before every capture.

import { expect, test, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { at_rest, painted, print_choose } from './one_canvas'
import {
  action_ms,
  add_sketch,
  answers,
  chat_open,
  command,
  field,
  ipad_landscape,
  expect_revision,
  mine,
  navigation_ms,
  pair,
  print_shape,
  protocol,
  send_button,
  sketch_open,
  soon,
  step,
  step_long_ms,
  surface,
  type Cli,
} from './whiteboard_board'

test.use({ trace: 'off' })

type Json = Record<string, any>
type Point = { x: number; y: number }

const out_kept = process.env.SHOWCASE_OUT ?? ''
let out = ''
const board_name = 'Sign-up flow'
const request_words = 'Sign up, verify email, welcome. What happens if the link expires?'
const answer_words =
  'Drew the flow beside your sketch, with a resend path for the step you circled.'

// Retina pictures: legible on a high-density screen and still sharp when scaled down.
const pixel_ratio = 2
const mac_screen = { width: 1440, height: 900 }

test('the README pictures: ink meets the agent, take in one undo, chat beside the drawing', async ({
  browser,
}) => {
  const out_temporary = out_kept === ''
  out = out_temporary ? fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-out-')) : out_kept
  expect(path.isAbsolute(out) && fs.statSync(out).isDirectory()).toBe(true)

  try {
    await journey_all(browser)

    for (const name of pictures) {
      expect(fs.statSync(path.join(out, `${name}.png`)).size).toBeGreaterThan(20_000)
    }
  } finally {
    if (out_temporary) fs.rmSync(out, { recursive: true, force: true })
  }
})

// Every picture the README shows, by file name in docs/images.
const pictures = ['ipad-add-sketch', 'ipad-one-canvas', 'ipad-take', 'mac-chat'] as const

async function journey_all(browser: Browser) {
  await showcase_board(browser, async (board) => {
    const drawn = await step(
      'the person draws a rough flow in black, the one ink of the pen',
      () => ink(board),
      step_long_ms,
    )
    await step('the sketch is added to a request, explicitly', () => request(board))
    const frame = await step('the agent reads the sketch', () => frame_read(board, drawn))
    await step('the agent publishes a diagram beside the ink', () => diagram(board, frame))
    await step('ink and print share the canvas on the iPad', () => together(board))
    await step('a print shape is chosen and taken in one undo', () => take(board))
    await step('the board chat lies beside the drawing on the Mac', () => mac_chat(board))
  })
}

type Board = {
  root: string
  cli: Cli
  bound: Cli
  stage: Page
  ipad: Page
  session: string
  origin: string
}

// A disposable linked board, as `board_linked` makes one, but with Retina pages: the iPad in
// landscape with touch and the Mac stage at a common laptop size. The board is always stopped
// and its directory removed after.
async function showcase_board(browser: Browser, journey: (board: Board) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-e2e-')))
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
  const scale = { deviceScaleFactor: pixel_ratio }
  const stage_context = await browser.newContext({ ...scale, viewport: mac_screen })
  const ipad_context = await browser.newContext({
    ...scale,
    viewport: ipad_landscape,
    hasTouch: true,
  })

  for (const context of [stage_context, ipad_context]) {
    context.setDefaultTimeout(action_ms)
    context.setDefaultNavigationTimeout(navigation_ms)
  }

  try {
    const stage = await stage_context.newPage()
    const ipad = await ipad_context.newPage()
    const linked = await step('link a disposable board and pair the iPad', () =>
      pair(root, file, stage, ipad),
    )
    const session = String(linked.session)
    const origin = new URL(String(linked.stage_url)).origin
    const renamed = cli('session-rename', '--session', session, '--name', board_name)
    expect(renamed).toMatchObject({ code: 'session_renamed', session: { name: board_name } })

    for (const page of [stage, ipad]) await page.reload()

    await expect(ipad.getByText(board_name).first()).toBeVisible()
    await journey({ root, cli, bound, stage, ipad, session, origin })
  } finally {
    await Promise.all([stage_context.close(), ipad_context.close()])
    expect(cli('stop').status).toBe('success')
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// A capture is taken only of a screen with no pairing on it, and with nothing still moving.
async function capture(page: Page, name: (typeof pictures)[number]) {
  await expect(page.locator('.guide__code, .pair__sheet')).toHaveCount(0)
  expect(new URL(page.url()).hash).toBe('')
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  expect(fs.statSync(file).size).toBeGreaterThan(20_000)
}

// Deterministic hand wobble: two slow waves, never random, so every run draws the same ink.
function wobble(index: number, amplitude: number): number {
  return amplitude * (Math.sin(index * 1.3) * 0.6 + Math.sin(index * 0.37) * 0.4)
}

// A rectangle drawn by hand: corners slightly missed and the end run past the start.
function box_points(left: number, top: number, width: number, height: number): Point[] {
  const corners = [
    { x: left + 6, y: top + 2 },
    { x: left + width, y: top - 2 },
    { x: left + width + 3, y: top + height },
    { x: left - 2, y: top + height + 3 },
    { x: left + 2, y: top - 4 },
    { x: left + 30, y: top + 1 },
  ]
  const points: Point[] = []

  for (let side = 0; side + 1 < corners.length; side += 1) {
    const [from, to] = [corners[side]!, corners[side + 1]!]

    for (let n = 0; n < 12; n += 1) {
      const t = n / 12
      const index = side * 12 + n
      points.push({
        x: from.x + (to.x - from.x) * t + wobble(index, 2),
        y: from.y + (to.y - from.y) * t + wobble(index + 5, 2),
      })
    }
  }

  return points
}

// A wavy shaft down to a tip, then the two barbs of its head, in one stroke.
function arrow_points(x: number, top: number, bottom: number): Point[] {
  const points: Point[] = []

  for (let n = 0; n <= 16; n += 1) {
    points.push({ x: x + Math.sin(n * 0.8) * 5, y: top + ((bottom - top) * n) / 16 })
  }

  points.push({ x: x - 14, y: bottom - 16 }, { x, y: bottom }, { x: x + 13, y: bottom - 15 })
  return points
}

// An ellipse gone round a little more than once, opening as it goes, as a circling hand does.
function circle_points(centre: Point, radius_x: number, radius_y: number): Point[] {
  const points: Point[] = []

  for (let n = 0; n <= 60; n += 1) {
    const angle = -2.4 + (n / 60) * Math.PI * 2.2
    const grow = 1 + n * 0.0015
    points.push({
      x: centre.x + Math.cos(angle) * radius_x * grow,
      y: centre.y + Math.sin(angle) * radius_y * grow,
    })
  }

  return points
}

// A question mark: a hook down to a short stem, and its dot as a stroke of its own.
function question_points(centre: Point): Point[][] {
  const hook: Point[] = []

  for (let n = 0; n <= 14; n += 1) {
    const angle = Math.PI * (1.1 - (n / 14) * 1.6)
    hook.push({ x: centre.x + Math.cos(angle) * 15, y: centre.y - Math.sin(angle) * 15 })
  }

  hook.push({ x: centre.x + 1, y: centre.y + 22 }, { x: centre.x, y: centre.y + 32 })
  const dot = [
    { x: centre.x, y: centre.y + 46 },
    { x: centre.x + 2, y: centre.y + 48 },
  ]
  return [hook, dot]
}

// One Pencil stroke through `points`, with a pressure that swells and eases like a hand's.
async function pen(page: Page, points: readonly Point[]) {
  expect(points.length).toBeGreaterThan(1)
  const cdp = await page.context().newCDPSession(page)

  try {
    for (const [n, point] of points.entries()) {
      const last = n === points.length - 1
      const type = n === 0 ? 'mousePressed' : last ? 'mouseReleased' : 'mouseMoved'
      await soon(
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: last ? 0 : 1,
          pointerType: 'pen',
          force: 0.35 + 0.35 * Math.sin((Math.PI * n) / points.length),
          clickCount: 1,
        }),
      )
    }
  } finally {
    await cdp.detach()
  }
}

const ink_strokes_count = 8

// Three rough boxes and the arrows between them, then the middle step circled and questioned,
// all with the pen as it comes: in black, its one ink. Returns every screen point the pen
// touched, from which the agent's frame is read.
async function ink({ ipad, cli, session, origin }: Board): Promise<Point[]> {
  const ink_drawn: Point[] = []
  const strokes = [
    ...[160, 340, 520].map((top) => box_points(200, top, 200, 76)),
    arrow_points(300, 246, 330),
    arrow_points(300, 426, 510),
    circle_points({ x: 300, y: 378 }, 158, 78),
    ...question_points({ x: 492, y: 300 }),
  ]
  expect(strokes).toHaveLength(ink_strokes_count)
  await expect(ipad.getByRole('button', { name: 'Pen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  for (const points of strokes) {
    await pen(ipad, points)
    ink_drawn.push(...points)
  }

  await expect.poll(() => cli('status', '--session', session).shapes_count).toBe(ink_strokes_count)
  const response = await ipad.request.get(`${origin}/api/drawing.json?session=${session}`)
  const colours = ((await response.json()) as Json[])
    .filter((record) => record.type === 'draw')
    .map((record) => record.props.color)
  expect(colours).toEqual(Array(ink_strokes_count).fill('black'))
  return ink_drawn
}

// The person opens the chat, adds the sketch with Add sketch and writes the request. The card
// says what goes with it. The picture is taken before Send, then the Mac confirms the request.
async function request({ ipad, bound }: Board) {
  await chat_open(ipad)
  await expect(add_sketch(ipad)).toHaveAttribute('aria-pressed', 'false')
  await add_sketch(ipad).click()
  await expect(add_sketch(ipad)).toHaveAttribute('aria-pressed', 'true')
  await expect(ipad.locator('.chat__attached')).toContainText('Sketch attached')
  await expect(ipad.locator('.chat__attached')).toContainText(`${ink_strokes_count} shapes`)
  await field(ipad).fill(request_words)
  await expect(send_button(ipad)).toBeEnabled()
  await capture(ipad, 'ipad-add-sketch')

  await send_button(ipad).click()
  await expect(field(ipad)).toHaveValue('')
  await expect(mine(ipad, request_words).locator('.chat__sketch')).toBeVisible()
  const events = bound('poll').events as Json[]
  expect(events).toMatchObject([
    { kind: 'sketch_notify', include_sketch: true, text: request_words },
  ])
  await sketch_open(ipad)
}

// Where the person's view sits on the page: the agent places its diagram in page units, and
// the iPad's camera is not moved for it, so the diagram is put where that view shows it.
type Frame = { zoom: number; page: Point; screen: Point; event: string; scene_path: string }

async function frame_read({ root, bound }: Board, ink_drawn: Point[]): Promise<Frame> {
  const event = (bound('poll').events as Json[])[0]!
  expect(bound('ack', '--event', event.id, '--state', 'received').status).toBe('success')
  expect(bound('ack', '--event', event.id, '--state', 'working').status).toBe('success')
  const snap = bound('snapshot', '--out', path.join(root, 'showcase'))
  expect(snap).toMatchObject({ status: 'success', base_revision: 0 })
  const { strokes } = JSON.parse(fs.readFileSync(snap.strokes_path, 'utf8')) as Json
  expect(strokes).toHaveLength(ink_strokes_count)

  const page_left = Math.min(...strokes.map((s: Json) => s.x))
  const page_top = Math.min(...strokes.map((s: Json) => s.y))
  const page_width = Math.max(...strokes.map((s: Json) => s.x + s.w)) - page_left
  const page_height = Math.max(...strokes.map((s: Json) => s.y + s.h)) - page_top
  const screen_left = Math.min(...ink_drawn.map((p) => p.x))
  const screen_top = Math.min(...ink_drawn.map((p) => p.y))
  const screen_width = Math.max(...ink_drawn.map((p) => p.x)) - screen_left
  const screen_height = Math.max(...ink_drawn.map((p) => p.y)) - screen_top
  const zoom = page_width / screen_width

  // One zoom on both axes, within what tldraw's smoothing of pen samples can change.
  expect(Math.abs(page_height / screen_height - zoom)).toBeLessThan(zoom * 0.08)
  expect(zoom).toBeGreaterThan(0.25)
  expect(zoom).toBeLessThan(4)
  return {
    zoom,
    page: { x: page_left, y: page_top },
    screen: { x: screen_left, y: screen_top },
    event: String(event.id),
    scene_path: String(snap.scene_path),
  }
}

// A useful diagram in native shapes: the flow the person drew, named in their words, with the
// resend path their question asked for, and a dashed arrow back to the step they circled.
// Every arrow runs between shapes through open space, so no arrow or its label crosses the
// words in a box.
async function diagram({ bound, cli, session }: Board, frame: Frame) {
  const at = (x: number, y: number) => ({
    x: Math.round(frame.page.x + (x - frame.screen.x) * frame.zoom),
    y: Math.round(frame.page.y + (y - frame.screen.y) * frame.zoom),
  })
  const size = (w: number, h: number) => ({
    w: Math.round(w * frame.zoom),
    h: Math.round(h * frame.zoom),
  })
  const step_box = (id: string, x: number, y: number, text: string) => ({
    type: 'geo',
    id,
    ...at(x, y),
    ...size(240, 64),
    text,
    font: 'sans',
    fill: 'semi',
  })
  const near_circle = at(470, 400)
  const elements = [
    { type: 'text', id: 'title', ...at(660, 96), text: board_name, size: 'l', font: 'sans' },
    step_box('signup', 660, 160, 'Sign up'),
    step_box('verify', 660, 290, 'Verify email'),
    {
      type: 'geo',
      id: 'expired',
      geo: 'diamond',
      ...at(665, 404),
      ...size(230, 120),
      text: 'Link expired?',
      size: 's',
      font: 'sans',
    },
    step_box('welcome', 660, 590, 'Welcome'),
    {
      type: 'geo',
      id: 'resend',
      ...at(956, 432),
      ...size(170, 64),
      text: 'Resend link',
      font: 'sans',
      fill: 'semi',
    },
    { type: 'arrow', id: 'to-verify', from: 'signup', to: 'verify' },
    { type: 'arrow', id: 'to-expired', from: 'verify', to: 'expired' },
    { type: 'arrow', id: 'to-welcome', from: 'expired', to: 'welcome', text: 'no', font: 'sans' },
    { type: 'arrow', id: 'to-resend', from: 'expired', to: 'resend', text: 'yes', font: 'sans' },
    {
      type: 'arrow',
      id: 'your-question',
      from: 'expired',
      to: [near_circle.x, near_circle.y],
      dash: 'dashed',
      bend: -30,
      text: 'your ?',
      font: 'sans',
    },
  ]
  const scene = JSON.parse(fs.readFileSync(frame.scene_path, 'utf8')) as Json
  scene.summary = 'The sign-up flow from the sketch, with a resend path.'
  scene.elements = elements
  fs.writeFileSync(frame.scene_path, JSON.stringify(scene))

  const published = bound('publish', '--file', frame.scene_path)
  expect(published).toMatchObject({ code: 'published', revision: 1, shapes_count: 11 })
  const message = ['--message', answer_words]
  expect(bound('ack', '--event', frame.event, '--state', 'updated', ...message).status).toBe(
    'success',
  )
  expect(cli('status', '--session', session).shapes_count).toBe(ink_strokes_count)
}

// The print arrives under the ink without moving the view: the person's strokes and the
// agent's diagram are both on screen, side by side and touching where they meet.
async function together({ ipad }: Board) {
  await expect_revision(ipad, 1)

  for (const id of ['signup', 'expired', 'resend', 'welcome']) {
    await expect(print_shape(ipad, id)).toBeVisible()
  }

  await at_rest(ipad, '.print__shape[data-print-shape="shape:scene-welcome"]')
  await expect(print_shape(ipad, 'expired').getByText('Link expired?')).toBeVisible()
  expect(await painted(ipad, 'verify', 0x1d1d1d)).toBeGreaterThan(50)
  await expect(surface(ipad).locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(
    ink_strokes_count,
  )
  await ipad.waitForTimeout(2_500)
  await capture(ipad, 'ipad-one-canvas')
}

// A finger on Resend link shows whose it is; Take copies it into the ink; one Undo takes the
// copy back and leaves the sketch exactly as it was.
async function take({ ipad, cli, session }: Board) {
  const status = () => cli('status', '--session', session)
  const before = status()
  const card = await print_choose(ipad, 'resend', true)
  await expect(card).toContainText('revision 1')
  await expect(card.getByRole('button', { name: 'Take into my sketch' })).toBeVisible()
  await capture(ipad, 'ipad-take')

  await card.getByRole('button', { name: 'Take into my sketch' }).click()
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await expect(print_shape(ipad, 'resend')).toHaveAttribute('data-state', 'taken')
  await ipad.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
  await expect(print_shape(ipad, 'resend')).toHaveAttribute('data-state', 'shown')
}

// The Mac stage presents the whole board, and its chat is this board's: the request with its
// sketch, and the agent's answer under it.
async function mac_chat({ stage }: Board) {
  await expect(stage.locator('.guide')).toHaveCount(0)
  await expect(print_shape(stage, 'resend')).toBeVisible()
  await chat_open(stage)
  await expect(stage.locator('.chat__standing')).toHaveCount(0)
  await expect(add_sketch(stage)).toBeEnabled()
  await expect(mine(stage, request_words).locator('.chat__sketch')).toBeVisible()
  await expect(answers(stage, answer_words)).toBeVisible()
  await at_rest(stage, '.print__shape[data-print-shape="shape:scene-welcome"]')
  await capture(stage, 'mac-chat')
}
