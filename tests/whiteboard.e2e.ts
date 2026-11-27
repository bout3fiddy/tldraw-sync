// A linked board end to end on the one canvas: an iPad paired by the stage QR sends words alone
// and its sketch from the board's chat, the agent's answers arrive under them, and a scene is
// published and printed in violet under the person's ink on both screens. The pen and eraser
// touch only the ink. The person chooses one printed shape with a finger, takes it into the
// sketch exactly where it lies, undoes and redoes that, and replaces the whole sketch from the
// board's menu. Every Send is one kind of request, and none of them writes to a canvas.
//
// Run: bun run build && npx playwright test tests/whiteboard.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { scene_format } from '../src/shared/scene_types'
import { whiteboard_protocol } from '../src/shared/whiteboard'
import { at_rest, board_menu, painted, print_choose, print_fit, published } from './one_canvas'
import {
  add_sketch,
  answers,
  board_linked,
  chat_button,
  chat_open,
  draw,
  expect_marks_clear,
  field,
  ipad_landscape,
  key,
  mine,
  print_region,
  print_shape,
  retired_controls,
  send_button,
  sketch_open,
  soon,
  step,
  step_long_ms,
  stroke,
  surface,
  type Cli,
  type Linked,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots. Capture the agent
// surface only after the paired iPad has removed the QR fragment from its history.
test.use({ trace: 'off' })

type Json = Record<string, any>

type Target = {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

// Where every control that `selector` finds is on the screen, in CSS pixels.
const targets = (page: Page, selector: string): Promise<Target[]> =>
  page.locator(selector).evaluateAll((controls) =>
    controls.map((control) => {
      const { width, height, left, right, top, bottom } = control.getBoundingClientRect()
      return { width, height, left, right, top, bottom }
    }),
  )

// Everything wrong with a set of controls, in words: each is to be a target of at least 44px
// and wholly on the screen. Pure, so that it can be shown to catch a fault without a browser.
function target_problems(list: Target[], screen: { width: number; height: number }): string[] {
  const problems: string[] = []

  for (const [index, target] of list.entries()) {
    if (target.width < 44 || target.height < 44) problems.push(`control ${index} is under 44px`)

    const inside =
      target.left >= 0 &&
      target.top >= 0 &&
      target.right <= screen.width &&
      target.bottom <= screen.height

    if (!inside) problems.push(`control ${index} is off the screen`)
  }

  return problems
}

type Shown = { x: number; y: number; width: number; height: number }

// What the iPad's one canvas is made of, as the design draws it: a surface from edge to edge,
// the board's title and its Boards button at the top left, Chat at the top right, four tools at
// the left, and the key at the foot. `retired_count` is every tab, layer switch or control the
// board had before; `footers_count` every band under the canvas.
type CanvasSeen = {
  screen: { width: number; height: number }
  footers_count: number
  retired_count: number
  boards: Target[]
  chat: Target[]
  tools: Target[]
  key: Target | null
  surface: Shown | null
}

const edge_px = 0.5

// Everything wrong with the one canvas, in words. Pure, so each fault can be shown to be named.
function canvas_problems(seen: CanvasSeen): string[] {
  const { screen, surface } = seen
  const problems = target_problems([...seen.boards, ...seen.chat, ...seen.tools], screen)

  if (seen.footers_count > 0) problems.push('a band lies under the canvas')

  if (seen.retired_count > 0) problems.push('a tab or a retired control is back')

  if (seen.chat.length !== 1) problems.push(`${seen.chat.length} Chat buttons, not 1`)

  for (const chat of seen.chat) {
    if (screen.width - chat.right > 24 || chat.top > 24) problems.push('Chat is not top right')
  }

  for (const boards of seen.boards) {
    if (boards.left > 24 || boards.top > 24) problems.push('Boards is not top left')
  }

  if (seen.tools.length !== 4) problems.push(`${seen.tools.length} tools, not 4`)

  if (seen.key === null) problems.push('the key is missing')
  else if (Math.abs((seen.key.left + seen.key.right) / 2 - screen.width / 2) > 2) {
    problems.push('the key is not centred')
  }

  if (surface === null) return [...problems, 'the canvas is missing']

  const whole =
    Math.abs(surface.x) <= edge_px &&
    Math.abs(surface.y) <= edge_px &&
    Math.abs(surface.width - screen.width) <= edge_px &&
    Math.abs(surface.height - screen.height) <= edge_px

  if (!whole) problems.push('the canvas does not fill the screen')

  return problems
}

async function canvas_seen(page: Page): Promise<CanvasSeen> {
  const keys = await targets(page, '.key')
  return {
    screen: page.viewportSize()!,
    footers_count: await page.locator('footer, .agent-rail').count(),
    retired_count: await retired_controls(page).count(),
    boards: await targets(page, '.rail-toggle'),
    chat: await targets(page, '.chat-toggle__button'),
    tools: await targets(page, '.strip > .strip__button, .strip__pen > .strip__button'),
    key: keys[0] ?? null,
    surface: await surface(page).boundingBox(),
  }
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

// What the Mac stage is made of. It only presents: the same canvas from edge to edge, and its
// one action, pairing an iPad, beside Chat at the top right.
type StageSeen = {
  screen: { width: number; height: number }
  footers_count: number
  surface: Shown | null
  pair: Target[]
  pair_pressed: boolean
}

function stage_problems(seen: StageSeen): string[] {
  const { surface, screen } = seen
  const problems = target_problems(seen.pair, screen)

  if (seen.footers_count > 0) problems.push('a band lies under the canvas')

  if (seen.pair.length !== 1) problems.push(`${seen.pair.length} Pair iPad buttons, not 1`)

  if (surface === null) return [...problems, 'the canvas is missing']

  if (Math.abs(surface.y + surface.height - screen.height) > edge_px) {
    problems.push('the canvas stops short of the bottom of the screen')
  }

  for (const button of seen.pair) {
    if (button.top > 24 || screen.width - button.right > 200) {
      problems.push('Pair iPad is not at the top right')
    }
  }

  if (!seen.pair_pressed) problems.push('a press on Pair iPad lands on something else')

  return problems
}

async function stage_seen(stage: Page): Promise<StageSeen> {
  const pair = stage.locator('.pair__button')
  const pressed = pair.evaluateAll((buttons) =>
    buttons.every((button) => {
      const at = button.getBoundingClientRect()
      const hit = document.elementFromPoint((at.left + at.right) / 2, (at.top + at.bottom) / 2)
      return hit !== null && button.contains(hit)
    }),
  )
  return {
    screen: stage.viewportSize()!,
    footers_count: await stage.locator('footer, .agent-rail').count(),
    surface: await surface(stage).boundingBox(),
    pair: await targets(stage, '.pair__button'),
    pair_pressed: await pressed,
  }
}

// Pressing Pair iPad shows the QR on a sheet over the canvas without moving or shrinking it.
// Escape puts it away.
async function geometry_stage(stage: Page, info: TestInfo, name: string) {
  await expect.poll(async () => stage_problems(await stage_seen(stage))).toEqual([])
  const pair = stage.getByRole('button', { name: 'Pair iPad' })
  const sheet = stage.getByRole('complementary', { name: 'Pair iPad' })
  const canvas = await surface(stage).boundingBox()
  await expect(pair).toHaveAttribute('aria-expanded', 'false')
  await expect(sheet).toHaveCount(0)
  await capture(stage, info, name)

  await pair.click()
  await expect(pair).toHaveAttribute('aria-expanded', 'true')
  await expect(sheet.locator('.guide__code')).toBeVisible()
  await expect(sheet).toContainText('Scan for sketchboard controls')
  expect(target_problems(await targets(stage, '.pair__sheet'), stage.viewportSize()!)).toEqual([])
  expect(await surface(stage).boundingBox()).toEqual(canvas)
  await capture(stage, info, `${name}-pair`)

  await stage.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(pair).toHaveAttribute('aria-expanded', 'false')
}

// The iPad's one canvas: every instrument where the design puts it, tldraw's notice whole and
// uncovered, and, with the chat open over the canvas, nothing on the canvas moved and every
// chat control a 44px target.
async function geometry_ipad(ipad: Page, info: TestInfo, name: string) {
  const screen = ipad.viewportSize()!
  await expect.poll(async () => canvas_problems(await canvas_seen(ipad))).toEqual([])
  await expect_marks_clear(ipad, 1)
  await capture(ipad, info, name)

  const ink = await at_rest(ipad, '.tl-shape[data-shape-type="draw"]')
  const print = await at_rest(ipad, '.print__shape')
  await chat_open(ipad)
  expect(await at_rest(ipad, '.tl-shape[data-shape-type="draw"]')).toBe(ink)
  expect(await at_rest(ipad, '.print__shape')).toBe(print)
  const controls = await targets(ipad, '.chat__composer button')
  expect(controls).toHaveLength(2)
  expect(target_problems(controls, screen)).toEqual([])
  expect(target_problems(await targets(ipad, '.chat__open'), screen)).toEqual([])
  expect(target_problems(await targets(ipad, '.chat-toggle__button'), screen)).toEqual([])
  await expect_marks_clear(ipad, screen.width > 720 ? 1 : 0)
  await capture(ipad, info, `${name}-chat`)
  await sketch_open(ipad)
}

// The checks above are the safeguard against tabs, bands and misplaced instruments coming back.
// Each fault below is one they must name, and the sound layout, read off the One canvas design,
// is one they must pass.
test('the one canvas check passes the design and names each old fault', () => {
  const screen = { width: 820, height: 1180 }
  const target = (left: number, top: number, width: number, height: number): Target => ({
    width,
    height,
    left,
    right: left + width,
    top,
    bottom: top + height,
  })
  const tools = [538, 584, 639, 685].map((top) => target(20, top, 44, 44))
  const sound: CanvasSeen = {
    screen,
    footers_count: 0,
    retired_count: 0,
    boards: [target(20, 20, 44, 44)],
    chat: [target(688, 20, 112, 44)],
    tools,
    key: target(330, 1132, 160, 24),
    surface: { x: 0, y: 0, width: 820, height: 1180 },
  }
  expect(canvas_problems(sound)).toEqual([])

  // The tabs this design replaced, and the band that once held Replace.
  expect(canvas_problems({ ...sound, retired_count: 3 })).toEqual([
    'a tab or a retired control is back',
  ])
  expect(
    canvas_problems({
      ...sound,
      footers_count: 1,
      surface: { x: 0, y: 85, width: 820, height: 1040 },
    }),
  ).toEqual(['a band lies under the canvas', 'the canvas does not fill the screen'])

  // Clear back on the strip; the tools short of the pen and eraser.
  expect(canvas_problems({ ...sound, tools: [...tools, target(20, 740, 44, 44)] })).toEqual([
    '5 tools, not 4',
  ])
  expect(canvas_problems({ ...sound, tools: tools.slice(1) })).toEqual(['3 tools, not 4'])
  expect(canvas_problems({ ...sound, chat: [target(80, 20, 112, 44)] })).toEqual([
    'Chat is not top right',
  ])
  expect(canvas_problems({ ...sound, chat: [target(760, 20, 112, 44)] })).toEqual([
    'control 1 is off the screen',
  ])
  expect(canvas_problems({ ...sound, chat: [] })).toEqual(['0 Chat buttons, not 1'])
  expect(canvas_problems({ ...sound, boards: [target(400, 20, 44, 44)] })).toEqual([
    'Boards is not top left',
  ])
  expect(canvas_problems({ ...sound, boards: [target(20, 20, 40, 40)] })).toEqual([
    'control 0 is under 44px',
  ])
  expect(canvas_problems({ ...sound, key: null })).toEqual(['the key is missing'])
  expect(canvas_problems({ ...sound, key: target(20, 1132, 160, 24) })).toEqual([
    'the key is not centred',
  ])
  expect(canvas_problems({ ...sound, surface: null })).toEqual(['the canvas is missing'])
})

test('the stage check passes the one canvas and names the old footer', () => {
  const screen = { width: 1440, height: 900 }
  const target = (left: number, top: number, width: number, height: number): Target => ({
    width,
    height,
    left,
    right: left + width,
    top,
    bottom: top + height,
  })
  const sound: StageSeen = {
    screen,
    footers_count: 0,
    surface: { x: 0, y: 0, width: 1440, height: 900 },
    pair: [target(1176, 20, 124, 44)],
    pair_pressed: true,
  }
  expect(stage_problems(sound)).toEqual([])
  const footed: StageSeen = {
    ...sound,
    footers_count: 1,
    surface: { x: 0, y: 0, width: 1440, height: 845 },
    pair: [target(16, 850, 95, 44)],
  }
  expect(stage_problems(footed)).toEqual([
    'a band lies under the canvas',
    'the canvas stops short of the bottom of the screen',
    'Pair iPad is not at the top right',
  ])
  expect(stage_problems({ ...sound, pair: [] })).toEqual(['0 Pair iPad buttons, not 1'])
  expect(stage_problems({ ...sound, pair_pressed: false })).toEqual([
    'a press on Pair iPad lands on something else',
  ])
  expect(stage_problems({ ...sound, pair: [target(1176, 20, 124, 40)] })).toEqual([
    'control 0 is under 44px',
  ])
  expect(stage_problems({ ...sound, surface: null })).toEqual(['the canvas is missing'])
})

test('paired Sends reach the agent; its print is shown, taken in one undo, and replaced', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { root, file, cli, bound, stage, ipad, session, linked } = board
    const status = () => cli('status', '--session', session)
    const ink_hash = await step('one pen stroke reaches the Mac', async () => {
      await draw(ipad)
      await expect.poll(() => status().shapes_count).toBe(1)
      return status().document_hash as string
    })
    await step(
      'a refused send keeps its words; words alone and the sketch both reach the agent',
      () => delivery(ipad, bound, ink_hash),
      step_long_ms,
    )
    await step('the agent publishes its scene', async () =>
      publish_canvas(root, bound, session, ink_hash),
    )
    await step(
      'the print shows on both screens',
      () => print_views(ipad, stage, info),
      step_long_ms,
    )
    await step('the pen and eraser touch only the ink', () => ownership(board, ink_hash))
    await step('one shape is taken exactly where it lies, undone and redone', () =>
      take_one(board, info, ink_hash),
    )
    await step('the whole sketch is replaced from the board menu, and undone', () =>
      replace_all(board, ink_hash),
    )
    expect(status()).toMatchObject({ protocol: whiteboard_protocol, agent_revision: 1 })
    const token = JSON.parse(fs.readFileSync(file, 'utf8')).token
    const snap = bound('snapshot', '--out', path.join(root, 'last'))
    expect(JSON.stringify({ linked, snap }).includes(token)).toBe(false)
  })
})

// The agent's side of a request for something drawn: a snapshot, a scene written into the file
// the snapshot made ready, and a publish. All the Sends before it left the canvas unwritten.
function publish_canvas(root: string, bound: Cli, session: string, hash: string) {
  const snap = bound('snapshot', '--out', path.join(root, 'out'))
  expect(snap).toMatchObject({
    status: 'success',
    base_revision: 0,
    snapshot: hash,
    canvas: { revision: 0, editable: false, legacy: false },
  })
  expect(snap.publish_command).toContain('whiteboard-publish --binding')
  expect(snap.schema).toContain(scene_format)
  const scene = JSON.parse(fs.readFileSync(snap.scene_path, 'utf8'))
  expect(scene).toMatchObject({ format: scene_format, session, snapshot: hash, elements: [] })
  scene.elements = [
    { type: 'geo', id: 'a', x: 0, y: 0, w: 200, h: 100, text: 'Request', font: 'sans' },
    { type: 'geo', id: 'b', geo: 'ellipse', x: 360, y: -10, w: 260, h: 120, font: 'sans' },
    { type: 'arrow', id: 'ab', from: 'a', to: 'b' },
  ]
  scene.elements[1].text = 'What about retries?'
  fs.writeFileSync(snap.scene_path, JSON.stringify(scene))
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({
    status: 'success',
    session,
    revision: 1,
    shapes_count: 3,
  })
}

async function delivery(ipad: Page, bound: Cli, hash: string) {
  await chat_open(ipad)

  // Words alone need words: until there are some, Send stays quiet.
  await expect(add_sketch(ipad)).toHaveAttribute('aria-pressed', 'false')
  await field(ipad).fill('   ')
  await expect(send_button(ipad)).toBeDisabled()

  // A real refusal from the board: an unconfirmed sketch hash substituted in transit. The
  // words stay in the field, the sketch stays added, and nothing is queued or shown as sent.
  const question = 'Which way round is this?'
  await add_sketch(ipad).click()
  await expect(ipad.locator('.chat__attached')).toContainText('1 shape')
  await field(ipad).fill(question)
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    (route) =>
      route.continue({
        postData: JSON.stringify({
          ...route.request().postDataJSON(),
          sketch_hash: '0'.repeat(16),
        }),
      }),
    { times: 1 },
  )
  await send_button(ipad).click()
  await expect(ipad.locator('.chat__caption')).toContainText('Not sent: Ink is syncing.')
  await expect(field(ipad)).toHaveValue(question)
  await expect(add_sketch(ipad)).toHaveAttribute('aria-pressed', 'true')
  await expect(mine(ipad, question)).toHaveCount(0)
  expect(bound('poll').events).toEqual([])

  // Sent again, the sketch goes as it is now, with the words, and comes off after.
  await send_button(ipad).click()
  await expect(field(ipad)).toHaveValue('')
  await expect(add_sketch(ipad)).toHaveAttribute('aria-pressed', 'false')
  await expect(mine(ipad, question).locator('.chat__sketch')).toContainText('Sketch, as it was')
  await expect(mine(ipad, question).locator('.chat__receipt')).toContainText('Queued on the Mac')
  const words = await words_alone(ipad, bound)
  await answered(ipad, bound, { hash, question, words })
  await sketch_open(ipad)
}

// Words alone, sent with Return. Shift and Return is a new line; a key still being composed
// sends nothing; and typing never reaches the canvas behind.
async function words_alone(ipad: Page, bound: Cli): Promise<string> {
  const words = '  筆 📝\nr and d?  '
  await field(ipad).fill('d')
  await field(ipad).press('r')
  await field(ipad).press('Backspace')
  await field(ipad).press('Shift+Enter')
  await expect(field(ipad)).toHaveValue('d\n')
  await field(ipad).fill(words)
  await field(ipad).dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  expect(bound('poll').events).toHaveLength(1)
  await field(ipad).press('Enter')
  await expect(field(ipad)).toHaveValue('')
  await expect(mine(ipad, 'r and d?').locator('.chat__receipt')).toContainText('Words only')
  return words
}

type Sent = { hash: string; question: string; words: string }

// The host sees both requests as they were sent, and its answers come back under each. A
// status line is shown at the foot while the agent works, and is never the answer.
async function answered(ipad: Page, bound: Cli, { hash, question, words }: Sent) {
  const [drawn, alone] = bound('poll').events
  expect(drawn).toMatchObject({ include_sketch: true, sketch_hash: hash, text: question })
  expect(alone).toMatchObject({ include_sketch: false, text: words })

  for (const event of [drawn, alone]) {
    expect(bound('ack', '--event', event.id, '--state', 'received').status).toBe('success')
  }

  const status = ['--state', 'working', '--message', 'Reading the sketch']
  expect(bound('ack', '--event', drawn.id, ...status).status).toBe('success')
  await expect(ipad.locator('.chat__working')).toContainText('Agent is working')
  await expect(ipad.locator('.chat__working')).toContainText('Reading the sketch')
  await expect(answers(ipad, 'Reading the sketch')).toHaveCount(0)
  const reply = (id: string, message: string) =>
    bound('ack', '--event', id, '--state', 'updated', '--message', message).status
  expect(reply(drawn.id, 'It reads left to right.')).toBe('success')
  expect(reply(alone.id, 'Yes: R and D.')).toBe('success')
  await expect(answers(ipad, 'It reads left to right.')).toBeVisible()
  await expect(answers(ipad, 'Yes: R and D.')).toBeVisible()
  await expect(mine(ipad, question).locator('.chat__receipt')).toContainText('Done')
  await expect(ipad.locator('.chat__working')).toHaveCount(0)

  // Read as they came, on screen: nothing is left unread. None of these drew anything.
  await expect(ipad.getByTestId('chat-unread')).toHaveCount(0)
  expect(bound('poll')).toMatchObject({ events: [], agent_revision: 0 })
}

type Box = { x: number; y: number; width: number; height: number }

// CSS transforms can leave fractional edges. Never excuse a whole pixel of clipped text.
const label_edge_tolerance_px = 0.5

function label_overflow_px(label: Box | null, pane: Box | null, viewport: Box): number {
  if (!label || !pane) return Infinity

  for (const box of [label, pane, viewport]) {
    if (!Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
      return Infinity
    }
  }

  return Math.max(
    0,
    Math.max(pane.x, viewport.x) - label.x,
    Math.max(pane.y, viewport.y) - label.y,
    label.x + label.width - Math.min(pane.x + pane.width, viewport.x + viewport.width),
    label.y + label.height - Math.min(pane.y + pane.height, viewport.y + viewport.height),
  )
}

test('label containment tolerates subpixels but rejects pane and viewport clipping', () => {
  const viewport = { x: 0, y: 0, width: 820, height: 1180 }
  const pane = { x: -20, y: 100, width: 600, height: 700 }
  const label = { x: -0.00001, y: 120, width: 90, height: 24 }
  expect(label_overflow_px(label, pane, viewport)).toBeLessThanOrEqual(label_edge_tolerance_px)

  // Inside the pane but offscreen; inside the viewport but clipped by the pane.
  for (const clipped of [
    { ...label, x: -1 },
    { ...label, y: 99 },
  ]) {
    expect(label_overflow_px(clipped, pane, viewport)).toBeGreaterThan(label_edge_tolerance_px)
  }
})

// A printed label, measured in the picture the canvas shows, wholly inside the canvas and the
// window.
async function expect_print_label(page: Page, text: string, id = 'a') {
  const label = print_shape(page, id).getByText(text, { exact: true })
  await expect(label).toBeVisible()
  const viewport = { x: 0, y: 0, ...page.viewportSize()! }
  await expect
    .poll(async () => {
      const [bounds, canvas] = await Promise.all([label.boundingBox(), surface(page).boundingBox()])
      return label_overflow_px(bounds, canvas, viewport)
    })
    .toBeLessThanOrEqual(label_edge_tolerance_px)
}

// Chromium on a desktop runner has no software keyboard. Drive its visualViewport contract while
// keeping the layout viewport fixed, and check that only the chat follows the inset: the
// composer moves up into what can still be seen, and the canvas is not resized.
async function keyboard_geometry(page: Page, info: TestInfo) {
  const composer = page.locator('.chat__composer')
  const canvas = surface(page)
  await chat_open(page)
  await field(page).fill('One\nTwo\nThree\nFour\nFive\nSix')
  const before = await canvas.boundingBox()
  const rested = await composer.boundingBox()
  const visible_px = page.viewportSize()!.height - 245
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', {
      configurable: true,
      value: innerHeight - 245,
    })
    visualViewport!.dispatchEvent(new Event('resize'))
  })
  const bottom = async () => {
    const box = await composer.boundingBox()
    return box!.y + box!.height
  }

  // The whole composer is in what the keyboard leaves in sight, and it moved up to get there.
  await expect.poll(bottom).toBeLessThanOrEqual(visible_px + 0.5)
  const lifted = await composer.boundingBox()
  expect(lifted!.y).toBeGreaterThanOrEqual(0)
  expect(lifted!.y).toBeLessThan(rested!.y)

  // Five lines of 22px and the field's own padding; the sixth line scrolls.
  expect((await field(page).boundingBox())!.height).toBeLessThanOrEqual(132.5)
  expect(await field(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await canvas.boundingBox()).toEqual(before)
  await info.attach('keyboard-inset', { body: await page.screenshot(), contentType: 'image/png' })
  await page.evaluate(() => {
    Reflect.deleteProperty(visualViewport!, 'height')
    visualViewport!.dispatchEvent(new Event('resize'))
  })

  // With the keyboard gone the composer is back where it rested.
  await expect.poll(() => composer.boundingBox()).toEqual(rested)
  await field(page).fill('')
  await sketch_open(page)
}

// The print on both screens: in violet, under the ink, with no tab to reach it. The iPad's
// camera stayed where the person left it when the revision arrived; the key offers to bring
// the print into view. The stage, which presents, keeps all of it in view itself, and has the
// agent's answers waiting as news.
async function print_views(ipad: Page, stage: Page, info: TestInfo) {
  const ink = await at_rest(ipad, '.tl-shape[data-shape-type="draw"]')
  await expect(print_shape(ipad, 'a')).toHaveCount(1)
  expect(await at_rest(ipad, '.tl-shape[data-shape-type="draw"]')).toBe(ink)
  await expect(key(ipad)).toContainText('Agent · revision 1')
  await print_fit(ipad, 'a')

  for (const page of [ipad, stage]) {
    await expect_print_label(page, 'Request')
    await expect_print_label(page, 'What about retries?', 'b')
    await expect(retired_controls(page)).toHaveCount(0)

    // The arrow runs level between the two: a flat picture of it must still be drawn.
    await expect(page.locator('.print__shape')).toHaveCount(3)
    await expect(print_region(page)).toHaveAttribute('data-failed', '0')

    // The agent's ink is printed in violet: none of its own black reaches the screen.
    await expect.poll(async () => (await painted(page, 'b')).violet).toBeGreaterThan(50)
    expect((await painted(page, 'b')).black).toBe(0)
  }

  await expect(stage.getByTestId('chat-unread')).toBeVisible()
  await expect(chat_button(stage)).toHaveAccessibleName(/^Chat\W+2 new answers$/)
  await geometry_ipad(ipad, info, 'ipad-portrait')
  await geometry_stage(stage, info, 'mac-stage')

  // Turned on its side, the canvas keeps its instruments where the design puts them.
  await soon(ipad.setViewportSize(ipad_landscape))
  await print_fit(ipad, 'b')
  await expect_print_label(ipad, 'What about retries?', 'b')
  await geometry_ipad(ipad, info, 'ipad-landscape')
  await keyboard_geometry(ipad, info)
}

// The pen writes over the print and the eraser takes that writing away: the print is the same
// revision, every shape of it still shown, and the ink is as it was.
async function ownership({ ipad, cli, session }: Linked, ink_hash: string) {
  const status = () => cli('status', '--session', session)
  await print_fit(ipad, 'b')
  const box = (await print_shape(ipad, 'b').boundingBox())!
  const from = { x: box.x + box.width * 0.3, y: box.y + box.height / 2 }
  await stroke(ipad, from, { x: 30, y: 4 })
  await expect.poll(() => status().shapes_count).toBe(2)
  expect(status()).toMatchObject({ agent_revision: 1 })

  await ipad.getByRole('button', { name: 'Eraser' }).tap()
  await stroke(ipad, { x: from.x - 10, y: from.y - 20 }, { x: 40, y: 15 })
  await expect.poll(() => status().document_hash).toBe(ink_hash)
  await ipad.getByRole('button', { name: 'Pen' }).tap()
  await expect(ipad.getByRole('button', { name: 'Pen' })).toHaveAttribute('aria-pressed', 'true')
  await expect(ipad.locator('.print__shape')).toHaveCount(3)
  expect(status()).toMatchObject({ agent_revision: 1, shapes_count: 1 })
}

// A finger chooses the agent's box. Taking it copies it into the sketch where the print has
// it, as a native shape of the person's own, recording the revision and sketch it came from;
// the print fades beneath it. Undo takes the copy back and the print returns; Redo again.
async function take_one(board: Linked, info: TestInfo, ink_hash: string) {
  const { ipad, cli, session, origin } = board
  const status = () => cli('status', '--session', session)
  await print_fit(ipad, 'a')
  const card = await print_choose(ipad, 'a', true)
  await expect(card).toContainText('Drawn by the agent · revision 1')
  await expect(ipad.getByRole('button', { name: 'Take into my sketch' })).toBeFocused()
  expect(status().shapes_count).toBe(1)
  await capture(ipad, info, 'ipad-inspect')
  await card.getByRole('button', { name: 'Take into my sketch' }).tap()
  await expect(key(ipad)).toContainText('Copied into your sketch. Undo takes it back.')
  await expect.poll(() => status().shapes_count).toBe(2)
  await expect(print_shape(ipad, 'a')).toHaveAttribute('data-state', 'taken')
  await expect(card).toHaveCount(0)
  await capture(ipad, info, 'ipad-taken')

  const source = (await published(ipad, origin, session)).find((r) => r.id === 'shape:scene-a')!
  const copy = await taken_copy(board)
  expect(copy).toMatchObject({ type: source.type, x: source.x, y: source.y, props: source.props })
  expect(copy.parentId).toMatch(/^page:/)
  expect(copy.id).not.toBe(source.id)
  expect(copy.meta.taken_from).toMatchObject({
    revision: 1,
    sketch_hash: ink_hash,
    shape_id: 'shape:scene-a',
  })

  const undo = ipad.getByRole('button', { name: 'Undo', exact: true })
  const redo = ipad.getByRole('button', { name: 'Redo', exact: true })
  await undo.tap()
  await expect.poll(() => status().document_hash).toBe(ink_hash)
  await expect(print_shape(ipad, 'a')).toHaveAttribute('data-state', 'shown')
  await redo.tap()
  await expect.poll(() => status().shapes_count).toBe(2)
  await expect(print_shape(ipad, 'a')).toHaveAttribute('data-state', 'taken')
  await undo.tap()
  await expect.poll(() => status().document_hash).toBe(ink_hash)
  expect(status()).toMatchObject({ agent_revision: 1 })
}

async function taken_copy({ bound, root }: Linked): Promise<Json> {
  const snap = bound('snapshot', '--out', path.join(root, 'taken'))
  expect(snap.status).toBe('success')
  const { records } = JSON.parse(fs.readFileSync(snap.records_path, 'utf8')) as Json
  const copies = (records as Json[]).filter((record) => record.meta?.taken_from !== undefined)
  expect(copies).toHaveLength(1)
  return copies[0]!
}

// The old whole-sketch replace, now in the board's menu: one step, every shape the person's own
// with the arrow still joined, and one Undo back to the ink.
async function replace_all({ ipad, bound, cli, session, root }: Linked, ink_hash: string) {
  const status = () => cli('status', '--session', session)
  await board_menu(ipad, 'Replace my sketch with revision 1')
  await expect(key(ipad)).toContainText('Sketch replaced. Undo restores your ink.')
  await expect.poll(() => status().shapes_count).toBe(3)
  const snap = bound('snapshot', '--out', path.join(root, 'after'))
  expect(snap.status).toBe('success')
  const { records } = JSON.parse(fs.readFileSync(snap.records_path, 'utf8'))
  const shapes = records.filter((r: { typeName: string }) => r.typeName === 'shape')
  const ids = new Set(shapes.map((s: { id: string }) => s.id))
  expect(shapes.map((s: { type: string }) => s.type).sort()).toEqual(['arrow', 'geo', 'geo'])
  const bindings = records.filter((r: { typeName: string }) => r.typeName === 'binding')
  expect(bindings).toHaveLength(2)

  for (const b of bindings) expect(ids.has(b.fromId) && ids.has(b.toId)).toBe(true)

  expect(records.every((r: { id: string }) => !r.id.includes(':scene-'))).toBe(true)
  await expect(ipad.locator('.print__shape[data-state="taken"]')).toHaveCount(3)
  await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
  await expect.poll(() => status().document_hash).toBe(ink_hash)
  await expect(ipad.locator('.print__shape[data-state="taken"]')).toHaveCount(0)
}
