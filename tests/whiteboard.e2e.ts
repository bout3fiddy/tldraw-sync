// A linked board end to end: an iPad paired by the stage QR sends its sketch with and without
// a note, the agent's replies arrive as rows under the bell, the Agent canvas is published
// and shown on both screens, and the person copies it into the sketch and takes that back.
//
// Run: bun run build && npx playwright test tests/whiteboard.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  bell,
  board_linked,
  chat,
  composer_open,
  draw,
  expect_marks_clear,
  inbox,
  inbox_open,
  interpret,
  ipad_landscape,
  note,
  notify,
  row_with,
  rows,
  rows_about,
  step,
  step_long_ms,
  type Cli,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots. Capture the agent
// surface only after the paired iPad has removed the QR fragment from its history.
test.use({ trace: 'off' })

// Every control is at least a 44px target and on the screen. On the iPad the note's controls
// and Replace sit in the band under the views, never over the Agent canvas.
async function geometry(page: Page, info: TestInfo, name: string, ipad: boolean) {
  const band = ipad ? '.composer button' : '.agent-rail button'
  const measure = (selector: string) =>
    page.locator(selector).evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect()
        return {
          width: r.width,
          height: r.height,
          x: r.x,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        }
      }),
    )
  const below = await measure(band)
  const beside = ipad ? await measure('.dock button') : []
  const pane = await page.locator('.views__pane--cleaned').boundingBox()
  expect(pane).not.toBeNull()
  expect(below.length).toBeGreaterThanOrEqual(ipad ? 3 : 1)
  expect(beside).toHaveLength(ipad ? 2 : 0)

  for (const b of [...below, ...beside]) {
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.right).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(b.bottom).toBeLessThanOrEqual(page.viewportSize()!.height)
  }

  for (const b of below) expect(b.top + 1).toBeGreaterThanOrEqual(pane!.y + pane!.height)

  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

test('paired notes and interpretation share one canvas, copied in one undo', async ({
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
    await step('the agent publishes its canvas', async () =>
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
    const snap = bound('snapshot', '--layer', 'canvas', '--out', path.join(root, 'after'))
    expect(snap.status).toBe('success')
    const { records } = JSON.parse(fs.readFileSync(snap.records_path, 'utf8'))
    const shapes = records.filter((r: { typeName: string }) => r.typeName === 'shape')
    const ids = new Set(shapes.map((s: { id: string }) => s.id))
    expect(shapes.map((s: { type: string }) => s.type).sort()).toEqual(['arrow', 'geo', 'geo'])
    const bindings = records.filter((r: { typeName: string }) => r.typeName === 'binding')
    expect(bindings).toHaveLength(2)

    for (const b of bindings) expect(ids.has(b.fromId) && ids.has(b.toId)).toBe(true)

    expect(records.every((r: { id: string }) => !r.id.includes(':cleaned-'))).toBe(true)
    await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
    await expect.poll(() => status().document_hash).toBe(ink_hash)
    expect(status()).toMatchObject({ protocol: 2, agent_revision: 1 })
    const token = JSON.parse(fs.readFileSync(file, 'utf8')).token
    expect(JSON.stringify({ linked, snap }).includes(token)).toBe(false)
  })
})

function publish_canvas(root: string, bound: Cli, session: string, hash: string) {
  const snap = bound('snapshot', '--out', path.join(root, 'out'))
  expect(snap).toMatchObject({ status: 'success', base_revision: 0, snapshot: hash })
  expect(snap.publish_command).toContain('whiteboard-publish --binding')
  fs.writeFileSync(
    snap.diagram_path,
    JSON.stringify({
      format: 'tldraw-sync.diagram.v1',
      session,
      snapshot: hash,
      base_revision: snap.base_revision,
      nodes: [
        { id: 'a', kind: 'box', label: 'Request' },
        { id: 'b', kind: 'ellipse', label: 'What about retries?', origin: 'agent' },
      ],
      edges: [{ id: 'ab', from: 'a', to: 'b', direction: 'forward', origin: 'agent' }],
    }),
  )
  expect(bound('publish', '--file', snap.diagram_path)).toMatchObject({
    status: 'success',
    layer: 'canvas',
    revision: 1,
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

  // The refusal is news on the bell. The list stays closed, and the band says nothing.
  await expect(bell(ipad)).toHaveAccessibleName('Notifications, 1 unread')
  await expect(inbox(ipad)).toBeHidden()
  await expect(ipad.locator('.composer')).not.toContainText('Ink is syncing')
  const refused = await row_with(ipad, 'Ink is syncing. Tap again to send.')
  await expect(refused).toHaveAttribute('data-state', 'refused')
  await expect(bell(ipad)).toHaveAccessibleName('Notifications')
  expect(bound('poll').events).toEqual([])
  await notify(ipad).tap()
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(2)
  await expect(rows_about(ipad, 'sketch_notify', 'queued')).toHaveCount(1)
  const toggle = interpret(ipad)
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  const text = '  筆 📝\nr and d?  '
  await composer_recovery(ipad, text, bound)
  await expect(note(ipad)).toHaveValue('')

  // Interpret was for that one send.
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toBeEnabled()
  const poll = bound('poll')
  expect(poll.events.map((e: { kind: string }) => e.kind)).toEqual([
    'sketch_notify',
    'interpret_request',
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
  await expect(rows_about(ipad, 'interpret_request', 'updated')).toHaveCount(1)
  await expect(rows_about(ipad, 'interpret_request', 'updated')).toContainText('Done')
  await expect(rows_about(ipad, 'sketch_notify', 'queued')).toContainText('last known')
  await expect(rows(ipad)).toHaveCount(3)
  expect(bound('poll').events).toEqual([])
  await empty_interpret_and_edited_notify(ipad, bound)
}

async function empty_interpret_and_edited_notify(ipad: Page, bound: Cli) {
  const field = note(ipad)
  const send = notify(ipad)
  const toggle = interpret(ipad)
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await send.tap()
  await expect.poll(() => bound('poll').events.length).toBe(1)
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
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
  expect(events[0]).toMatchObject({ kind: 'interpret_request' })
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
  // unconfirmed request still decides what the next send is.
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await expect(field).toBeHidden()
  await composer_open(ipad)
  await expect(field).toHaveValue(text)
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
  await expect(interpret(ipad)).toBeDisabled()
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
  await expect(field).toHaveValue(text)
  await notify(ipad).tap()
  await expect(field).toHaveValue('')
  expect(bound('poll').events).toEqual(before)

  // Three tries and the Mac's own report of the request are one row, not four.
  await inbox_open(ipad)
  await expect(rows_about(ipad, 'interpret_request')).toHaveCount(1)
  await expect(rows_about(ipad, 'interpret_request', 'queued')).toHaveCount(1)
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
    .locator(`.tl-shape[data-shape-id="shape:cleaned-${id}"]:not(.tl-shape-background)`)
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
// keeping the layout viewport fixed, and check that only the note's band follows the inset.
async function keyboard_geometry(page: Page, info: TestInfo) {
  const field = note(page)
  const sketch = page.locator('.views__pane--sketch')
  await field.fill('One\nTwo\nThree\nFour\nFive\nSix')
  const before = await sketch.boundingBox()
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
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 245 + 0.5)

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
  await field.fill('')
}

async function agent_views(ipad: Page, stage: Page, info: TestInfo) {
  for (const page of [ipad, stage]) {
    await page.getByRole('tab', { name: 'Agent canvas' }).click()
    await expect_layer_label(page, 'Request')
    await expect(page.getByRole('group', { name: 'Agent layer' })).toHaveCount(0)
    await expect_layer_label(page, 'What about retries?', 'b')

    // The note and its bell are the iPad's. The stage only presents.
    await expect(note(page)).toHaveCount(page === ipad ? 1 : 0)
    await expect(chat(page)).toHaveCount(page === ipad ? 1 : 0)
    await expect(bell(page)).toHaveCount(page === ipad ? 1 : 0)
    await geometry(page, info, page === ipad ? 'ipad-portrait' : 'mac-stage', page === ipad)
  }

  // With the note open under the Agent canvas, tldraw's notice in that canvas is untouched;
  // with both canvases on screen, so is each one's.
  await expect_marks_clear(ipad, 1)
  await ipad.setViewportSize(ipad_landscape)
  await ipad.getByRole('tab', { name: 'Side by side' }).tap()
  await expect_layer_label(ipad, 'What about retries?', 'b')
  await expect_marks_clear(ipad, 2)
  await geometry(ipad, info, 'ipad-landscape-side-by-side', true)
  await keyboard_geometry(ipad, info)
}
