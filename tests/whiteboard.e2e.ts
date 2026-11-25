import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jsQR from 'jsqr'

// Disposable pairing material belongs neither in traces nor in screenshots. Capture the agent
// surface only after the paired iPad has removed the QR fragment from its history.
test.use({ trace: 'off' })

function command(root: string, ...args: string[]) {
  const result = spawnSync(process.env.BUN ?? 'bun', ['src/cli/main.ts', ...args, '--json'], {
    env: { ...process.env, BOARD_DATA_DIR: root, PATH: `${root}:${process.env.PATH}` },
    timeout: 30_000,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(result.stdout)
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

async function draw(ipad: Page) {
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
        x: 280 + n * 20,
        y: 290 + n * 15,
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

async function geometry(page: Page, info: TestInfo, name: string) {
  const controls = page.locator('.agent-rail button')
  const bounds = await controls.evaluateAll((buttons) =>
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
  const pane = await page.locator('.views__pane--cleaned').boundingBox()
  expect(pane).not.toBeNull()

  for (const b of bounds) {
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.top + 1).toBeGreaterThanOrEqual(pane!.y + pane!.height)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.right).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(b.bottom).toBeLessThanOrEqual(page.viewportSize()!.height)
  }

  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

test('paired notes and interpretation share one canvas, copied in one undo', async ({
  browser,
}, info) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-e2e-')))
  const file = path.join(root, 'binding.json')
  const cli = (...args: string[]) => command(root, ...args)
  const bound = (action: string, ...args: string[]) =>
    cli(
      `whiteboard-${action}`,
      '--binding',
      file,
      ...(action === 'poll' ? ['--protocol', '2'] : []),
      ...args,
    )
  const stage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const ipad = await browser.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true })

  try {
    const linked = await pair(root, file, stage, ipad)
    await draw(ipad)
    const status = () => cli('status', '--session', linked.session)
    await expect.poll(() => status().shapes_count).toBe(1)
    const ink_hash = status().document_hash
    await delivery(ipad, bound, ink_hash)

    publish_canvas(root, bound, linked.session, ink_hash)

    await agent_views(ipad, stage, info)
    await ipad.getByRole('button', { name: 'Replace sketchboard' }).tap()
    await expect(ipad.getByRole('tab', { name: 'Sketchboard' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
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
  } finally {
    await Promise.all([stage.close(), ipad.close()])
    const stopped = cli('stop')
    expect(stopped.status).toBe('success')

    if (fs.existsSync(file)) expect(bound('poll').code).toBe('not_running')

    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function pair(root: string, file: string, stage: Page, ipad: Page) {
  const link = () =>
    command(root, 'whiteboard-link', '--protocol', '2', '--owner', 'e2e', '--out', file)
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
  await expect(ipad.getByRole('button', { name: 'Notify agent' })).toBeDisabled()
  await ipad.evaluate((hash) => {
    location.hash = hash
  }, paired.hash)
  await expect(ipad.getByRole('button', { name: 'Notify agent' })).toBeEnabled()
  await ipad.reload()
  await expect(ipad.getByRole('button', { name: 'Notify agent' })).toBeEnabled()
  expect(new URL(ipad.url()).hash.length).toBe(0)
  return linked
}

function publish_canvas(
  root: string,
  bound: (action: string, ...args: string[]) => any,
  session: string,
  hash: string,
) {
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

async function delivery(
  ipad: Page,
  bound: (action: string, ...args: string[]) => any,
  hash: string,
) {

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
  await ipad.getByRole('button', { name: 'Notify agent' }).tap()
  await expect(ipad.getByText('Ink is syncing. Tap again to send.')).toBeVisible()
  expect(bound('poll').events).toEqual([])
  await ipad.getByRole('button', { name: 'Notify agent' }).tap()
  await expect(ipad.getByText('Notification: queued')).toBeVisible()
  const toggle = ipad.getByRole('button', { name: 'Interpret', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.tap()
  const note = '  筆 📝\nr and d?  '
  await composer_recovery(ipad, note, bound)
  await expect(ipad.getByRole('textbox')).toHaveValue('')
  await expect(ipad.getByText('Interpretation: queued')).toBeVisible()
  const poll = bound('poll')
  expect(poll.events.map((e: { kind: string }) => e.kind)).toEqual([
    'sketch_notify',
    'interpret_request',
  ])

  expect(poll.events[0].text).toBeUndefined()
  expect(poll.events[1].text).toBe(note)

  for (const event of poll.events) {
    expect(event.sketch_hash).toBe(hash)

    for (const state of ['received', 'working', 'updated']) {
      expect(bound('ack', '--event', event.id, '--state', state).status).toBe('success')
    }
  }

  await expect(ipad.getByText('Interpretation: updated')).toBeVisible()
  expect(bound('poll').events).toEqual([])
  await empty_interpret_and_edited_notify(ipad, bound)
}

async function empty_interpret_and_edited_notify(ipad: Page, bound: (action: string) => any) {
  const field = ipad.getByRole('textbox', { name: 'Note to agent' })
  const notify = ipad.getByRole('button', { name: 'Notify agent' })
  const toggle = ipad.getByRole('button', { name: 'Interpret', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await notify.tap()
  await expect.poll(() => bound('poll').events.length).toBe(1)
  await toggle.tap()
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
  await notify.tap()

  try {
    await committed
    await expect(notify).toBeDisabled()
    await field.fill('Newer note')
    await field.press('Control+Enter')
  } finally {
    release()
  }

  await expect(notify).toBeEnabled()
  await expect(field).toHaveValue('Newer note')
  const events = bound('poll').events
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({ kind: 'interpret_request' })
  expect(events[0].text).toBeUndefined()
  expect(events[1]).toMatchObject({ kind: 'sketch_notify', text: 'First note' })
  await field.fill('')
}

async function composer_recovery(ipad: Page, note: string, bound: (action: string) => any) {
  const field = ipad.getByRole('textbox', { name: 'Note to agent' })
  const notify = ipad.getByRole('button', { name: 'Notify agent' })
  await field.fill('d')
  await field.press('r')
  await field.press('Backspace')
  await field.press('Enter')
  await expect(field).toHaveValue('d\n')
  await field.fill(note)
  await field.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
  expect(bound('poll').events).toHaveLength(1)

  // Simulate an old daemon before submitting any bytes. Then lose the successful response.
  await ipad.route('**/api/status?*', (r) => r.fulfill({ json: { protocol: 1 } }), { times: 1 })
  await field.press('Control+Enter')
  await expect(ipad.getByText(/Upgrade and restart/)).toBeVisible()
  expect(bound('poll').events).toHaveLength(1)
  await expect(field).toHaveValue(note)
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    async (route) => {
      expect((await route.fetch()).ok()).toBe(true)
      await route.abort('failed')
    },
    { times: 1 },
  )
  await notify.tap()
  await expect(ipad.getByText(/No confirmation/)).toBeVisible()
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
  await expect(field).toHaveValue(note)
  await ipad.route('**/api/whiteboard/event/v2?*', async (route) => {
    const reply = await route.fetch()
    const body = await reply.json()
    delete body.text
    await route.fulfill({ response: reply, json: body })
  }, { times: 1 })
  await notify.tap()
  await expect(ipad.getByText(/No exact confirmation/)).toBeVisible()
  await expect(field).toHaveValue(note)
  await notify.tap()
  await expect(field).toHaveValue('')
  expect(bound('poll').events).toEqual(before)
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
// keeping the layout viewport fixed, and check that only the action rail follows the inset.
async function keyboard_geometry(page: Page, info: TestInfo) {
  const field = page.getByRole('textbox', { name: 'Note to agent' })
  const sketch = page.locator('.views__pane--sketch')
  await field.fill('One\nTwo\nThree\nFour\nFive')
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
  expect(rail!.height).toBeLessThanOrEqual(110.5)
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
    await expect(page.getByRole('textbox', { name: 'Note to agent' })).toHaveCount(
      page === ipad ? 1 : 0,
    )
    await geometry(page, info, page === ipad ? 'ipad-portrait' : 'mac-stage')
  }

  await ipad.setViewportSize({ width: 1180, height: 820 })
  await ipad.getByRole('tab', { name: 'Side by side' }).tap()
  await expect_layer_label(ipad, 'What about retries?', 'b')
  await geometry(ipad, info, 'ipad-landscape-side-by-side')
  await keyboard_geometry(ipad, info)
}
