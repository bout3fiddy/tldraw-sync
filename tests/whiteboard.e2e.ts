// A linked board end to end: an iPad paired by the stage QR sends its sketch with and without
// a note, the agent's replies arrive as rows under the bell, a scene is published to the
// Agent canvas and shown on both screens, and the person copies it into the sketch and takes
// that back. Every Send is one kind of request, and none of them writes to a canvas.
//
// The note is a modal dialog over the board. While it is open nothing behind it can be
// pressed, so the journey puts it away before it draws, reads the bell's list, changes view
// or replaces the sketch, and asks for it again to write or send. The draft and an
// unconfirmed request have to survive each of those closings.
//
// Run: bun run build && npx playwright test tests/whiteboard.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { scene_format } from '../src/shared/scene_types'
import { whiteboard_protocol } from '../src/shared/whiteboard'
import {
  bell,
  bell_behind,
  board_linked,
  chat,
  composer_close,
  composer_open,
  draw,
  expect_dock,
  expect_marks_clear,
  inbox_behind,
  inbox_open,
  ipad_landscape,
  layout,
  mark_placed,
  marks,
  note,
  notify,
  row_with,
  rows,
  rows_about,
  soon,
  step,
  step_long_ms,
  type Cli,
  type DockSide,
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

// What the iPad's Agent canvas is made of, with the note shut. Replace is the one control at
// the head of that canvas; the canvas begins under the head and runs to the pane's bottom,
// which is the bottom of the screen. `footers_count` is every band or rail under the views.
type AgentSeen = {
  screen: { width: number; height: number }
  footers_count: number
  dock: Target[]
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
  const problems = target_problems([...seen.dock, ...seen.replace], screen)

  if (seen.footers_count > 0) problems.push('a band lies under the views')

  if (seen.dock.length !== 2) problems.push(`${seen.dock.length} agent buttons, not 2`)

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
    dock: await targets(ipad, '.dock button'),
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
// the head of the Agent canvas, and the agent's two buttons are on the side asked. tldraw's
// notice is whole and uncovered in each of the `notices_count` canvases on screen.
//
// Asked for, the note is a modal dialog laid over that board: one 44px target on a slip
// wholly on the screen, with no press reaching the buttons behind it. Nothing behind it
// moves or shrinks, and it covers no notice and moves none. It is put away again after.
async function geometry_ipad(
  ipad: Page,
  info: TestInfo,
  name: string,
  side: DockSide,
  notices_count: number,
) {
  const screen = ipad.viewportSize()!
  await composer_close(ipad)
  await expect_dock(ipad, side)
  await expect.poll(async () => agent_problems(await agent_seen(ipad))).toEqual([])
  const resting = await expect_marks_clear(ipad, notices_count)
  const shut = await layout(ipad)
  const shut_canvas = (await agent_seen(ipad)).canvas
  expect(shut.band).toBeNull()
  expect(shut.reach).toEqual({ chat: true, bell: true })

  await composer_open(ipad)
  const controls = await targets(ipad, '.composer button')
  expect(controls).toHaveLength(1)
  expect(target_problems(controls, screen)).toEqual([])
  const open = await layout(ipad)
  expect(open.band).not.toBeNull()
  expect(target_problems([open.band!], screen)).toEqual([])
  expect(open.reach).toEqual({ chat: false, bell: false })
  expect(open.views).toEqual(shut.views)
  expect(open.dock).toEqual(shut.dock)
  expect((await agent_seen(ipad)).canvas).toEqual(shut_canvas)
  expect((await marks(ipad)).map(mark_placed)).toEqual(resting.map(mark_placed))
  await capture(ipad, info, name)
  await composer_close(ipad)
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
    dock: [target(80, 20, 44, 44), target(126, 20, 44, 44)],
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
    'control 2 is under 44px',
  ])
  expect(agent_problems({ ...sound, dock: [target(800, 20, 44, 44)] })).toEqual([
    'control 0 is off the screen',
    '1 agent buttons, not 2',
  ])
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
      'refused, lost and inexact sends keep the draft',
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
  await composer_open(ipad)

  // Exercise the real server rejection by substituting an unconfirmed document hash in transit.
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
  await notify(ipad).tap()

  // The refusal is news on the bell, which is behind the open note: what it says is read off
  // the page. No list opens and the paper says nothing. A screen reader, which cannot hear
  // the page behind an open note, is told on the note itself.
  await expect(bell_behind(ipad)).toHaveAttribute('aria-label', 'Notifications, 1 unread')
  await expect(inbox_behind(ipad)).toHaveCount(0)
  await expect(ipad.locator('.composer')).not.toContainText('Ink is syncing')
  await expect(ipad.locator('.notepad [role="status"]')).toContainText('Ink is syncing')

  // Reading the list means putting the note away: the bell can be pressed and named again.
  const refused = await row_with(ipad, 'Ink is syncing. Tap again to send.')
  await expect(refused).toHaveAttribute('data-state', 'refused')
  await expect(bell(ipad)).toHaveAccessibleName('Notifications')
  expect(bound('poll').events).toEqual([])

  // Asking for the note again shuts the list. A second tap sends what the first could not.
  await composer_open(ipad)

  // The slip shook its head at the refusal, and not again as it is shown once more: an
  // opening note rests still at its centre, where `keyboard_geometry` measures it.
  const motions = await ipad.locator('.composer').evaluate((e) => e.getAnimations().length)
  expect(motions).toBe(0)
  await expect(inbox_behind(ipad)).toHaveCount(0)
  await notify(ipad).tap()
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(2)
  await expect(rows_about(ipad, 'sketch_notify', 'queued')).toHaveCount(1)
  await composer_open(ipad)

  // The note holds a field and one control. Nothing on it chooses what a send means.
  await expect(ipad.locator('.composer button')).toHaveCount(1)
  await expect(ipad.locator('.notepad [role="switch"], .notepad input')).toHaveCount(0)
  const text = '  筆 📝\nr and d?  '
  await composer_recovery(ipad, text, bound)

  // The confirmed send cleared the note. With or without words, a send is the same request.
  await composer_open(ipad)
  await expect(note(ipad)).toHaveValue('')
  await expect(notify(ipad)).toBeEnabled()
  const poll = bound('poll')
  expect(poll.events.map((e: { kind: string }) => e.kind)).toEqual([
    'sketch_notify',
    'sketch_notify',
  ])

  expect(poll.events[0].text).toBeUndefined()
  expect(poll.events[1].text).toBe(text)

  for (const event of poll.events) {
    expect(event.sketch_hash).toBe(hash)

    for (const state of ['received', 'working', 'updated']) {
      expect(bound('ack', '--event', event.id, '--state', state).status).toBe('success')
    }
  }

  // The newest request is followed to its end in its own row. The Mac publishes only that
  // one, so the earlier row keeps the last state this tab saw, and says so.
  await inbox_open(ipad)
  await expect(rows_about(ipad, 'sketch_notify', 'updated')).toHaveCount(1)
  await expect(rows_about(ipad, 'sketch_notify', 'updated')).toContainText('Done')
  await expect(rows_about(ipad, 'sketch_notify', 'queued')).toHaveCount(1)
  await expect(rows_about(ipad, 'sketch_notify', 'queued')).toContainText('last known')
  await expect(rows(ipad)).toHaveCount(3)
  expect(bound('poll').events).toEqual([])

  // None of these Sends drew anything: a request publishes nothing by itself.
  expect(bound('poll').agent_revision).toBe(0)
  await bare_send_and_edited_note(ipad, bound)

  // The board is left as a person leaves it: the note put away, so the views can be pressed.
  await composer_close(ipad)
}

// A send with no words is the sketch alone. A note edited while its send is on its way is
// kept: the Mac has the words that were sent, and the field has the newer ones.
async function bare_send_and_edited_note(ipad: Page, bound: Cli) {
  const field = note(ipad)
  const send = notify(ipad)
  await composer_open(ipad)
  await expect(field).toHaveValue('')
  await send.tap()
  await expect.poll(() => bound('poll').events.length).toBe(1)
  await expect(send).toBeEnabled()
  await field.fill('First note')
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  let received!: () => void
  const committed = new Promise<void>((resolve) => {
    received = resolve
  })
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    async (route) => {
      const reply = await route.fetch()
      received()
      await hold
      await route.fulfill({ response: reply })
    },
    { times: 1 },
  )
  await send.tap()

  try {
    await committed
    await expect(send).toBeDisabled()
    await field.fill('Newer note')
    await field.press('Control+Enter')
  } finally {
    release()
  }

  await expect(send).toBeEnabled()
  await expect(field).toHaveValue('Newer note')
  const events = bound('poll').events
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({ kind: 'sketch_notify' })
  expect(events[0].text).toBeUndefined()
  expect(events[1]).toMatchObject({ kind: 'sketch_notify', text: 'First note' })
  await field.fill('')
}

async function composer_recovery(ipad: Page, text: string, bound: Cli) {
  const field = note(ipad)
  await field.fill('d')
  await field.press('r')
  await field.press('Backspace')
  await field.press('Enter')
  await expect(field).toHaveValue('d\n')
  await field.fill(text)
  await field.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
  expect(bound('poll').events).toHaveLength(1)

  // Simulate an old daemon before submitting any bytes. Then lose the successful response.
  await ipad.route('**/api/status?*', (r) => r.fulfill({ json: { protocol: 1 } }), { times: 1 })
  await field.press('Control+Enter')
  const upgrade = await row_with(ipad, /Upgrade and restart/)
  await expect(upgrade).toHaveAttribute('data-state', 'unconfirmed')
  expect(bound('poll').events).toHaveLength(1)

  // Put away to read the list and asked for again, the note has kept its words.
  await composer_open(ipad)
  await expect(field).toHaveValue(text)
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    async (route) => {
      expect((await route.fetch()).ok()).toBe(true)
      await route.abort('failed')
    },
    { times: 1 },
  )
  await notify(ipad).tap()
  const lost = await row_with(ipad, /No confirmation/)
  await expect(lost).toHaveAttribute('data-state', 'unconfirmed')
  const polled = bound('poll')
  const before = polled.events
  expect(before).toHaveLength(2)
  const status_url = new URL('/api/cleaned/status', ipad.url())
  status_url.searchParams.set('session', polled.session)
  const status = await (await ipad.request.get(status_url.href)).json()
  expect(status.last_event.id).toBe(before[1].id)
  expect(status.last_event.text).toBeUndefined()
  expect(status.last_event.request_id).toBeUndefined()
  await ipad.reload()

  // After a reload the note is closed again. Its button says a draft is waiting, and the
  // unconfirmed request is still the one the next send repeats.
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await expect(field).toBeHidden()
  await composer_open(ipad)
  await expect(field).toHaveValue(text)
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    async (route) => {
      const reply = await route.fetch()
      const body = await reply.json()
      delete body.text
      await route.fulfill({ response: reply, json: body })
    },
    { times: 1 },
  )
  await notify(ipad).tap()
  const inexact = await row_with(ipad, /No exact confirmation/)
  await expect(inexact).toHaveAttribute('data-state', 'unconfirmed')

  // Still unconfirmed after the note was put away: the words and the pending request are kept.
  await composer_open(ipad)
  await expect(field).toHaveValue(text)
  await notify(ipad).tap()
  await expect(field).toHaveValue('')
  expect(bound('poll').events).toEqual(before)

  // Three tries and the Mac's own report of the request are one row, not four: the refused
  // send, the bare send and this one.
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(3)
  await expect(rows_about(ipad, 'sketch_notify', 'refused')).toHaveCount(1)
  await expect(rows_about(ipad, 'sketch_notify', 'queued')).toHaveCount(2)
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
// keeping the layout viewport fixed, and check that only the note follows the inset: the slip
// moves up into what can still be seen, and no canvas is resized or zoomed.
async function keyboard_geometry(page: Page, info: TestInfo) {
  const field = note(page)
  const paper = page.locator('.composer')
  const sketch = page.locator('.views__pane--sketch')
  await composer_open(page)
  await field.fill('One\nTwo\nThree\nFour\nFive\nSix')
  const before = await sketch.boundingBox()
  const rested = await paper.boundingBox()
  const zoom = () =>
    sketch
      .locator('.tl-container')
      .evaluate((e) => getComputedStyle(e).getPropertyValue('--tl-zoom'))
  const initial = await zoom()
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', {
      configurable: true,
      value: innerHeight - 245,
    })
    visualViewport!.dispatchEvent(new Event('resize'))
  })
  const rail = await field.boundingBox()
  const lifted = await paper.boundingBox()
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 245 + 0.5)

  // The whole slip is in what the keyboard leaves in sight, and it moved up to get there.
  expect(lifted!.y).toBeGreaterThanOrEqual(0)
  expect(lifted!.y + lifted!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 245)
  expect(lifted!.y).toBeLessThan(rested!.y)

  // Five lines of 22px and the field's own padding; the sixth line scrolls.
  expect(rail!.height).toBeLessThanOrEqual(132.5)
  expect(await field.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await sketch.boundingBox()).toEqual(before)
  expect(await zoom()).toBe(initial)
  await info.attach('keyboard-inset', { body: await page.screenshot(), contentType: 'image/png' })
  await page.evaluate(() => {
    Reflect.deleteProperty(visualViewport!, 'height')
    visualViewport!.dispatchEvent(new Event('resize'))
  })

  // With the keyboard gone the slip is back where it rested.
  await expect.poll(() => paper.boundingBox()).toEqual(rested)
  await field.fill('')
  await composer_close(page)
}

// Every tab and button here is pressed with the note shut: `delivery` leaves it put away,
// and each geometry check puts it away again after looking at it open.
async function agent_views(ipad: Page, stage: Page, info: TestInfo) {
  for (const page of [ipad, stage]) {
    await page.getByRole('tab', { name: 'Agent canvas' }).click()
    await expect_layer_label(page, 'Request')
    await expect(page.getByRole('group', { name: 'Agent layer' })).toHaveCount(0)
    await expect_layer_label(page, 'What about retries?', 'b')

    // The note, its button and the bell are the iPad's. The stage only presents. The note
    // is hidden until asked for, so the dialog is counted on the page, not found by role.
    await expect(page.locator('dialog.notepad')).toHaveCount(page === ipad ? 1 : 0)
    await expect(note(page)).toHaveCount(0)
    await expect(chat(page)).toHaveCount(page === ipad ? 1 : 0)
    await expect(bell(page)).toHaveCount(page === ipad ? 1 : 0)
  }

  // With only the Agent canvas on screen the two buttons wait in the band above the views,
  // and tldraw's notice in that canvas is untouched, with the note shut and with it open.
  await geometry_ipad(ipad, info, 'ipad-portrait', 'band', 1)
  await geometry_stage(stage, info, 'mac-stage')

  // Turned on its side with both canvases on screen: each has its own notice, the sketch is
  // too short for a column of buttons over the strip, and Replace keeps the canvas's head.
  await soon(ipad.setViewportSize(ipad_landscape))
  await ipad.getByRole('tab', { name: 'Side by side' }).tap()
  await expect_layer_label(ipad, 'What about retries?', 'b')
  await geometry_ipad(ipad, info, 'ipad-landscape-side-by-side', 'right', 2)
  await keyboard_geometry(ipad, info)
}
