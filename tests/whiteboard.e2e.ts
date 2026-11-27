// A linked board end to end: an iPad paired by the stage QR sends words alone and its sketch
// from the board's chat, the agent's answers arrive under them, a scene is published to the
// Agent canvas and shown on both screens, and the person copies it into the sketch and takes
// that back. Every Send is one kind of request, and none of them writes to a canvas.
//
// Run: bun run build && npx playwright test tests/whiteboard.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { scene_format } from '../src/shared/scene_types'
import { whiteboard_protocol } from '../src/shared/whiteboard'
import {
  add_sketch,
  answers,
  board_linked,
  chat_open,
  chat_tab,
  draw,
  expect_marks_clear,
  field,
  ipad_landscape,
  mine,
  retired_controls,
  send_button,
  sketch_open,
  soon,
  step,
  step_long_ms,
  type Cli,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots. Capture the agent
// surface only after the paired iPad has removed the QR fragment from its history.
test.use({ trace: 'off' })

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

// What the iPad's Agent canvas is made of. Replace is the one control at the head of that
// canvas; the canvas begins under the head and runs to the pane's bottom, which is the bottom
// of the screen. `footers_count` is every band or rail under the views. `chat` is the Chat tab,
// the one way to the agent, and `retired_count` every control the board had before it.
type AgentSeen = {
  screen: { width: number; height: number }
  footers_count: number
  retired_count: number
  chat: Target[]
  replace: Target[]
  replace_pressed: boolean
  pane: Shown | null
  head: Shown | null
  canvas: Shown | null
}

const edge_px = 0.5

// Everything wrong with the iPad's Agent canvas, in words. The faults are the ones the old
// band under the views would be: a footer, a canvas that stops short of the screen's bottom,
// and Replace anywhere but the head. Pure, so that it can be shown to catch each of them.
function agent_problems(seen: AgentSeen): string[] {
  const { pane, head, canvas, screen } = seen
  const problems = target_problems([...seen.chat, ...seen.replace], screen)

  if (seen.footers_count > 0) problems.push('a band lies under the views')

  if (seen.retired_count > 0) problems.push('a retired control is back')

  if (seen.chat.length !== 1) problems.push(`${seen.chat.length} Chat tabs, not 1`)

  for (const tab of seen.chat) {
    if (screen.width - tab.right > 24) problems.push('Chat is not at the top right')

    if (tab.top > 24) problems.push('Chat is not at the top')
  }

  if (seen.replace.length !== 1) problems.push(`${seen.replace.length} Replace buttons, not 1`)

  if (!pane || !head || !canvas) return [...problems, 'the Agent canvas or its head is missing']

  if (Math.abs(pane.y + pane.height - screen.height) > edge_px) {
    problems.push('the Agent canvas pane stops short of the bottom of the screen')
  }

  if (Math.abs(canvas.y + canvas.height - (pane.y + pane.height)) > edge_px) {
    problems.push('something lies under the Agent canvas')
  }

  if (canvas.y < head.y + head.height - edge_px) problems.push('the head lies over the canvas')

  for (const button of seen.replace) {
    const head_bottom = head.y + head.height
    const in_head = button.top >= head.y - edge_px && button.bottom <= head_bottom + edge_px
    const over_canvas =
      button.bottom > canvas.y + edge_px && button.top < canvas.y + canvas.height - edge_px

    if (!in_head) problems.push('Replace is not in the head')

    if (over_canvas) problems.push('Replace lies over the Agent canvas')
  }

  if (!seen.replace_pressed) problems.push('a press on Replace lands on something else')

  return problems
}

async function agent_seen(ipad: Page): Promise<AgentSeen> {
  const replace = ipad.locator('.cleaned__replace')
  const pressed = replace.evaluateAll((buttons) =>
    buttons.every((button) => {
      const at = button.getBoundingClientRect()
      const hit = document.elementFromPoint((at.left + at.right) / 2, (at.top + at.bottom) / 2)
      return hit !== null && button.contains(hit)
    }),
  )
  return {
    screen: ipad.viewportSize()!,
    footers_count: await ipad.locator('footer, .agent-rail').count(),
    retired_count: await retired_controls(ipad).count(),
    chat: await targets(ipad, '.tabs__tab[data-view="chat"]'),
    replace: await targets(ipad, '.cleaned__replace'),
    replace_pressed: await pressed,
    pane: await ipad.locator('.views__pane--cleaned').boundingBox(),
    head: await ipad.locator('.agent-pane__head').boundingBox(),
    canvas: await ipad.locator('.agent-pane__canvas').boundingBox(),
  }
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

// What the Mac stage is made of. It only presents: its one action, pairing an iPad, is an
// instrument in the band above the views, and the views run to the bottom of the screen.
type StageSeen = {
  screen: { width: number; height: number }
  footers_count: number
  views: Shown | null
  pair: Target[]
  pair_pressed: boolean
}

// Everything wrong with the stage, in words. The faults are the ones the old footer was: a
// band under the views, views that stop short of the bottom, and Pair iPad down in it. Pure,
// so that it can be shown to catch each of them.
function stage_problems(seen: StageSeen): string[] {
  const { views, screen } = seen
  const problems = target_problems(seen.pair, screen)

  if (seen.footers_count > 0) problems.push('a band lies under the views')

  if (seen.pair.length !== 1) problems.push(`${seen.pair.length} Pair iPad buttons, not 1`)

  if (views === null) return [...problems, 'the views are missing']

  if (Math.abs(views.y + views.height - screen.height) > edge_px) {
    problems.push('the views stop short of the bottom of the screen')
  }

  for (const button of seen.pair) {
    if (button.bottom > views.y + edge_px) problems.push('Pair iPad is not in the band above')
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
    views: await stage.locator('.views').boundingBox(),
    pair: await targets(stage, '.pair__button'),
    pair_pressed: await pressed,
  }
}

// The stage has no footer: Pair iPad is in the band above the views, and pressing it shows
// the QR on a sheet over the board without moving or shrinking anything. Escape puts it away.
async function geometry_stage(stage: Page, info: TestInfo, name: string) {
  await expect.poll(async () => stage_problems(await stage_seen(stage))).toEqual([])
  const pair = stage.getByRole('button', { name: 'Pair iPad' })
  const sheet = stage.getByRole('complementary', { name: 'Pair iPad' })
  const views = await stage.locator('.views').boundingBox()
  await expect(pair).toHaveAttribute('aria-expanded', 'false')
  await expect(sheet).toHaveCount(0)
  await capture(stage, info, name)

  await pair.click()
  await expect(pair).toHaveAttribute('aria-expanded', 'true')
  await expect(sheet.locator('.guide__code')).toBeVisible()
  await expect(sheet).toContainText('Scan for sketchboard controls')
  const shown = await targets(stage, '.pair__sheet')
  expect(target_problems(shown, stage.viewportSize()!)).toEqual([])
  expect(await stage.locator('.views').boundingBox()).toEqual(views)
  await capture(stage, info, `${name}-pair`)

  await stage.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(pair).toHaveAttribute('aria-expanded', 'false')
}

// The iPad has no rail and no band: the views run to the bottom of the screen, Replace has
// the head of the Agent canvas, and Chat is one tab at the top right. tldraw's notice is whole
// and uncovered in the Agent canvas. In the chat every control is a 44px target on the screen.
async function geometry_ipad(ipad: Page, info: TestInfo, name: string) {
  const screen = ipad.viewportSize()!
  await expect.poll(async () => agent_problems(await agent_seen(ipad))).toEqual([])
  await expect_marks_clear(ipad, 1)
  await capture(ipad, info, name)

  await chat_open(ipad)
  const controls = await targets(ipad, '.chat__composer button')
  expect(controls).toHaveLength(2)
  expect(target_problems(controls, screen)).toEqual([])
  expect(target_problems(await targets(ipad, '.chat__open'), screen)).toEqual([])
  await capture(ipad, info, `${name}-chat`)
  await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
}

// The checks above are the safeguard against the band coming back. Each fault below is one
// they must name, and the sound layout, read off the retained design, is one they must pass.
test('the Agent canvas check passes the modal layout and names the old band', () => {
  const screen = { width: 820, height: 1180 }
  const target = (left: number, top: number, width: number, height: number): Target => ({
    width,
    height,
    left,
    right: left + width,
    top,
    bottom: top + height,
  })
  const sound: AgentSeen = {
    screen,
    footers_count: 0,
    retired_count: 0,
    chat: [target(730, 19, 71, 44)],
    replace: [target(644, 88, 160, 44)],
    replace_pressed: true,
    pane: { x: 0, y: 85, width: 820, height: 1095 },
    head: { x: 0, y: 85, width: 820, height: 52 },
    canvas: { x: 0, y: 137, width: 820, height: 1043 },
  }
  expect(agent_problems(sound)).toEqual([])

  // The band this design replaced: a footer under the views, holding Replace, with the pane
  // and its canvas ending above it.
  const banded: AgentSeen = {
    ...sound,
    footers_count: 1,
    replace: [target(644, 1130, 160, 44)],
    pane: { x: 0, y: 85, width: 820, height: 1040 },
    canvas: { x: 0, y: 137, width: 820, height: 988 },
  }
  expect(agent_problems(banded)).toEqual([
    'a band lies under the views',
    'the Agent canvas pane stops short of the bottom of the screen',
    'Replace is not in the head',
  ])
  expect(agent_problems({ ...sound, canvas: { x: 0, y: 137, width: 820, height: 988 } })).toEqual([
    'something lies under the Agent canvas',
  ])
  expect(agent_problems({ ...sound, canvas: { x: 0, y: 85, width: 820, height: 1095 } })).toEqual([
    'the head lies over the canvas',
    'Replace lies over the Agent canvas',
  ])
  expect(agent_problems({ ...sound, replace: [target(644, 150, 160, 44)] })).toEqual([
    'Replace is not in the head',
    'Replace lies over the Agent canvas',
  ])
  expect(agent_problems({ ...sound, replace: [target(644, 90, 160, 40)] })).toEqual([
    'control 1 is under 44px',
  ])

  // The two buttons the chat replaced, back by the tools, and Chat moved off its corner.
  expect(agent_problems({ ...sound, retired_count: 2 })).toEqual(['a retired control is back'])
  expect(agent_problems({ ...sound, chat: [target(80, 20, 71, 44)] })).toEqual([
    'Chat is not at the top right',
  ])
  expect(agent_problems({ ...sound, chat: [target(800, 20, 71, 44)] })).toEqual([
    'control 0 is off the screen',
  ])
  expect(agent_problems({ ...sound, chat: [] })).toEqual(['0 Chat tabs, not 1'])
  expect(agent_problems({ ...sound, replace: [] })).toEqual(['0 Replace buttons, not 1'])
  expect(agent_problems({ ...sound, replace_pressed: false })).toEqual([
    'a press on Replace lands on something else',
  ])
  expect(agent_problems({ ...sound, head: null })).toEqual([
    'the Agent canvas or its head is missing',
  ])
})

// The same for the stage. The footer it had, holding Pair iPad, is the fault each check names.
test('the stage check passes the band layout and names the old footer', () => {
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
    views: { x: 0, y: 84, width: 1440, height: 816 },
    pair: [target(80, 20, 132, 44)],
    pair_pressed: true,
  }
  expect(stage_problems(sound)).toEqual([])

  // The base this replaced: a footer under the views, holding Pair iPad, the views above it.
  const footed: StageSeen = {
    ...sound,
    footers_count: 1,
    views: { x: 0, y: 84, width: 1440, height: 761 },
    pair: [target(16, 850, 95, 44)],
  }
  expect(stage_problems(footed)).toEqual([
    'a band lies under the views',
    'the views stop short of the bottom of the screen',
    'Pair iPad is not in the band above',
  ])
  expect(stage_problems({ ...sound, pair: [] })).toEqual(['0 Pair iPad buttons, not 1'])
  expect(stage_problems({ ...sound, pair_pressed: false })).toEqual([
    'a press on Pair iPad lands on something else',
  ])
  expect(stage_problems({ ...sound, pair: [target(80, 20, 132, 40)] })).toEqual([
    'control 0 is under 44px',
  ])
  expect(stage_problems({ ...sound, views: null })).toEqual(['the views are missing'])
})

test('paired Sends reach the agent, and its scene is shown and copied in one undo', async ({
  browser,
}, info) => {
  await board_linked(browser, async ({ root, file, cli, bound, stage, ipad, session, linked }) => {
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
      'the Agent canvas shows on both screens',
      () => agent_views(ipad, stage, info),
      step_long_ms,
    )
    console.log('  step: replace the sketch, then undo')
    await ipad.getByRole('button', { name: 'Replace sketchboard' }).tap()
    await expect(ipad.getByRole('tab', { name: 'Sketchboard' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(ipad.getByText('Sketch replaced. Undo restores your ink.')).toBeVisible()
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
    await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
    await expect.poll(() => status().document_hash).toBe(ink_hash)
    expect(status()).toMatchObject({ protocol: whiteboard_protocol, agent_revision: 1 })
    const token = JSON.parse(fs.readFileSync(file, 'utf8')).token
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

async function expect_layer_label(page: Page, text: string, id = 'a') {

  // Measure the published node, never the hidden copy tldraw uses to lay out rich text.
  const pane = page.getByRole('region', { name: 'Agent canvas' })
  const label = pane
    .locator(`.tl-shape[data-shape-id="shape:scene-${id}"]:not(.tl-shape-background)`)
    .getByText(text, { exact: true })

  await expect(label).toBeVisible()
  const viewport = { x: 0, y: 0, ...page.viewportSize()! }
  await expect
    .poll(async () => {
      const [bounds, canvas] = await Promise.all([label.boundingBox(), pane.boundingBox()])
      return label_overflow_px(bounds, canvas, viewport)
    })
    .toBeLessThanOrEqual(label_edge_tolerance_px)
}

// Chromium on a desktop runner has no software keyboard. Drive its visualViewport contract while
// keeping the layout viewport fixed, and check that only the chat follows the inset: the
// composer moves up into what can still be seen, and no view is resized.
async function keyboard_geometry(page: Page, info: TestInfo) {
  const composer = page.locator('.chat__composer')
  const views = page.locator('.views')
  await chat_open(page)
  await field(page).fill('One\nTwo\nThree\nFour\nFive\nSix')
  const before = await views.boundingBox()
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
  expect(await views.boundingBox()).toEqual(before)
  await info.attach('keyboard-inset', { body: await page.screenshot(), contentType: 'image/png' })
  await page.evaluate(() => {
    Reflect.deleteProperty(visualViewport!, 'height')
    visualViewport!.dispatchEvent(new Event('resize'))
  })

  // With the keyboard gone the composer is back where it rested.
  await expect.poll(() => composer.boundingBox()).toEqual(rested)
  await field(page).fill('')
}

// The Agent canvas on both screens, and the tabs that lead to it: Sketchboard, Agent canvas
// and Chat, and nothing the board had before its chat. The stage, which presents and was not
// looking at the chat, has the agent's answers waiting there as news.
async function agent_views(ipad: Page, stage: Page, info: TestInfo) {
  for (const page of [ipad, stage]) {
    await page.getByRole('tab', { name: 'Agent canvas' }).click()
    await expect_layer_label(page, 'Request')
    await expect(page.getByRole('group', { name: 'Agent layer' })).toHaveCount(0)
    await expect_layer_label(page, 'What about retries?', 'b')
    await expect(retired_controls(page)).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveText(['Sketchboard', 'Agent canvas', /^Chat/])
  }

  await expect(stage.getByTestId('chat-unread')).toBeVisible()
  await expect(chat_tab(stage)).toHaveAccessibleName(/^Chat\W+2 new answers$/)
  await geometry_ipad(ipad, info, 'ipad-portrait')
  await geometry_stage(stage, info, 'mac-stage')

  // Turned on its side, the Agent canvas keeps its head and Replace, and the chat its column.
  await soon(ipad.setViewportSize(ipad_landscape))
  await expect_layer_label(ipad, 'What about retries?', 'b')
  await geometry_ipad(ipad, info, 'ipad-landscape')
  await keyboard_geometry(ipad, info)
  await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
}
