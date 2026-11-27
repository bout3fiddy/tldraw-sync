// What a person asks of the agent from a linked board, end to end in real browsers. Every
// request is the same Send: the sketch as it is, and a note in the person's own words. What it
// is for is the agent's to read from those words:
//
// - A question is answered in the conversation. Nothing is drawn, and the canvas stays empty.
// - A tidy copy keeps the person's own pen stroke, named by the agent and copied by the board,
//   beside lettering the agent set. The draft is drawn by the Mac stage and looked at before
//   it is published, and publishing the same file saves exactly what the draft showed.
// - Once the sketch moves on, a scene made from the older sketch is refused, as a draft and
//   as a publish, and a change to the canvas alone is still taken.
// - A free variation uses every kind of element an agent places itself. The person copies it
//   into the sketch in one step, as shapes of their own, and Undo brings their ink back.
// - A request for the retired Interpret, left unconfirmed in a tab from before the upgrade,
//   is never sent again. Its words stay, and the next Send sends them as a note.
//
// The pictures of the drafts and the screens are attached to the test results for review. A
// picture of the Agent canvas is taken only once the whole scene is in view and at rest.
//
// Run: bun run build && npx playwright test tests/scenes.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scene_format } from '../src/shared/scene_types'
import { pixels_read } from './screen_pixels'
import {
  action_ms,
  board_linked,
  chat,
  composer_close,
  composer_open,
  draw,
  inbox_close,
  ipad_landscape,
  note,
  notify,
  row_with,
  soon,
  step,
  step_long_ms,
  stroke,
  type Cli,
  type Linked,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots: every capture
// here is taken after the paired iPad has removed the QR fragment from its address.
test.use({ trace: 'off' })

type Json = Record<string, any>

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenes')

// The free variation: one of every kind of element an agent places itself. A unit test reads
// the same file, so what is published here is known to be a scene the board takes whole.
const night_city = JSON.parse(
  fs.readFileSync(path.join(fixtures, 'night_city.scene.json'), 'utf8'),
) as Json[]

// The shapes of that scene which reach past the middle of a landscape screen it is fitted to:
// what a pane of half the screen cuts until its camera follows. In order of their ids.
const cut_at_half = ['boat', 'cloud', 'ground', 'hall', 'moon', 'river', 'star', 'to-moon']

const png_signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// A pixel this dark is ink: lettering or a pen stroke, never the page or a pale fill.
const ink_light_max = 96

// A shape on the Agent canvas, by the id its element was given: the shape itself, never the
// layer tldraw draws behind some shapes.
const canvas_region = (page: Page) => page.getByRole('region', { name: 'Agent canvas' })

const canvas_shape = (page: Page, id: string) =>
  canvas_region(page).locator(
    `.tl-shape[data-shape-id="shape:scene-${id}"]:not(.tl-shape-background)`,
  )

const canvas_words = (page: Page, id: string, text: string) =>
  canvas_shape(page, id).getByText(text, { exact: true }).first()

// Sample the center of an empty revision: a visible SVG alone does not prove dots were painted.
async function empty_surface(page: Page) {
  const pane = canvas_region(page)
  await expect(pane.locator('.tl-shape')).toHaveCount(0)
  const grid = pane.locator('svg.tl-grid')
  await expect(grid).toBeVisible()
  const box = (await grid.boundingBox())!
  const side = 96
  expect(Math.min(box.width, box.height)).toBeGreaterThan(side)
  const x = Math.floor(box.x + (box.width - side) / 2)
  const y = Math.floor(box.y + (box.height - side) / 2)
  const pixels = await pixels_read(page, action_ms)
  let vellum = 0
  let dots = 0

  for (let row = y; row < y + side; row++) {
    for (let col = x; col < x + side; col++) {
      const rgb = pixels.data.readUIntBE(4 * (row * pixels.width + col), 3)

      if (rgb === 0xf6f7f4) vellum++

      if (rgb >>> 16 < 235) dots++
    }
  }

  expect(vellum).toBeGreaterThan(side * side * 0.9)
  expect(dots).toBeGreaterThan(4)
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
}

// How a scene sits in its pane: how many shapes it has, which of them are not wholly in view,
// and where each is drawn, which tells a camera at rest from one still moving.
type Framing = { shapes: number; cut: string[]; boxes: string }

// Runs in the page, so it uses nothing from this file. A shape is measured as it is drawn: by
// its strokes where it has any, because tldraw boxes a shape from its first point and not
// from its extent, and by its box where it is lettering. A group draws nothing of its own.
// What can be seen of the canvas is its box, less whatever an ancestor or the window clips.
//
// The measure is taken on the next animation frame, so two measures are a frame or more
// apart. Given a tab to press, it is taken instead at the instant the views change: before
// the browser has told the canvas its new size, so before the camera can have followed.
async function framing_read(region: Element, press: Element | null): Promise<Framing> {
  if (press === null) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  } else {
    await new Promise<void>((resolve) => {
      const changed = new MutationObserver(() => {
        changed.disconnect()
        resolve()
      })
      changed.observe(region.closest('.views')!, { attributeFilter: ['data-view'] })
      press.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  const canvas = region.querySelector('.tl-container')!
  const seen = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }

  for (let node: Element | null = canvas; node !== null; node = node.parentElement) {
    if (node !== canvas && getComputedStyle(node).overflow === 'visible') continue

    const box = node.getBoundingClientRect()
    seen.left = Math.max(seen.left, box.left)
    seen.top = Math.max(seen.top, box.top)
    seen.right = Math.min(seen.right, box.right)
    seen.bottom = Math.min(seen.bottom, box.bottom)
  }

  const prefix = 'shape:scene-'
  const shapes = region.querySelectorAll(
    `.tl-shape[data-shape-id^="${prefix}"]:not(.tl-shape-background)`,
  )
  const cut: string[] = []
  const boxes: number[] = []

  for (const shape of shapes) {
    if (shape.getAttribute('data-shape-type') === 'group') continue

    const strokes = [...shape.querySelectorAll('path')].filter((path) => !path.closest('defs'))
    const drawn = strokes.length > 0 ? strokes : [shape]
    const parts = drawn.map((part) => part.getBoundingClientRect())
    const left = Math.min(...parts.map((part) => part.left))
    const top = Math.min(...parts.map((part) => part.top))
    const right = Math.max(...parts.map((part) => part.right))
    const bottom = Math.max(...parts.map((part) => part.bottom))

    // tldraw stops drawing a shape that is wholly outside its viewport.
    const culled = getComputedStyle(shape).display === 'none'
    const within = left >= seen.left && right <= seen.right
    const between = top >= seen.top && bottom <= seen.bottom

    if (culled || !within || !between) {
      cut.push(shape.getAttribute('data-shape-id')!.slice(prefix.length))
    }

    boxes.push(left, top, right, bottom)
  }

  return { shapes: shapes.length, cut, boxes: boxes.join(' ') }
}

// Waits for the whole scene to be in view on the Agent canvas, and at rest. A label is
// visible as soon as any of it is, and the camera follows a pane to its new size only a
// moment after the pane has it: so neither says that the scene is framed. Every shape has to
// lie inside what can be seen of the canvas, and be where it was a frame earlier.
async function scene_framed(page: Page, shapes_count: number) {
  const region = canvas_region(page)
  let boxes_last: string | null = null
  await expect
    .poll(
      async () => {
        const { boxes, ...scene } = await soon(region.evaluate(framing_read, null))
        const still = boxes === boxes_last
        boxes_last = boxes
        return { ...scene, still }
      },
      { message: 'The whole scene is in view on the Agent canvas, and at rest.' },
    )
    .toEqual({ shapes: shapes_count, cut: [], still: true })
}

// The only way a picture of the Agent canvas is taken: of a scene that is whole and at rest.
async function scene_capture(page: Page, info: TestInfo, name: string, shapes_count: number) {
  await scene_framed(page, shapes_count)
  await capture(page, info, name)
}

// Presses a view's tab and says how the scene sat at the instant the views changed.
async function view_pressed(page: Page, name: string): Promise<Framing> {
  const tab = await page.getByRole('tab', { name }).elementHandle()
  return soon(canvas_region(page).evaluate(framing_read, tab))
}

function scene_edit(file: string, change: (scene: Json) => void): Json {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
  change(scene)
  fs.writeFileSync(file, JSON.stringify(scene))
  return scene
}

function ack(bound: Cli, event: string, state: string, ...rest: string[]) {
  expect(bound('ack', '--event', event, '--state', state, ...rest).status).toBe('success')
}

// The person's side of every request: the note is opened, written and sent with its one
// control, and put away again. The Mac confirms the request, which clears the note.
async function send(ipad: Page, bound: Cli, words: string): Promise<Json> {
  const waiting = bound('poll').events.length
  await composer_open(ipad)
  await note(ipad).fill(words)
  await notify(ipad).tap()
  await expect.poll(() => bound('poll').events.length).toBe(waiting + 1)
  await expect(note(ipad)).toHaveValue('')
  await composer_close(ipad)
  const event = bound('poll').events.at(-1) as Json
  expect(event).toMatchObject({ kind: 'sketch_notify', state: 'queued', text: words })
  return event
}

// How many pixels of a saved picture are ink, counted by the browser's own image decoder.
function ink_count(page: Page, file: string): Promise<number> {
  const base64 = fs.readFileSync(file).toString('base64')
  return page.evaluate(
    async ([encoded, dark_max]) => {
      const image = new Image()
      image.src = `data:image/png;base64,${encoded}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let dark = 0

      for (let index = 0; index < data.length; index += 4) {
        const light = 0.299 * data[index]! + 0.587 * data[index + 1]! + 0.114 * data[index + 2]!

        if (data[index + 3]! > 0 && light <= (dark_max as number)) dark += 1
      }

      return dark
    },
    [base64, ink_light_max] as const,
  )
}

// A draft, drawn by the Mac stage and saved as a picture. Nothing of it is published or left
// on the stage: the revision and the sketch are as they were, and the workbench is gone.
async function draft_drawn(board: Linked, info: TestInfo, scene_path: string, name: string) {
  const { bound, cli, session, stage, root } = board
  const before = cli('status', '--session', session)
  const picture = path.join(root, `${name}.png`)
  const drafted = bound('preview', '--file', scene_path, '--out', picture)
  expect(drafted).toMatchObject({
    status: 'success',
    code: 'preview_saved',
    session,
    image_path: picture,
    published: false,
  })
  const bytes = fs.readFileSync(picture)
  expect([...bytes.subarray(0, png_signature.length)]).toEqual(png_signature)
  expect(drafted.image.width_px).toBeGreaterThan(100)
  expect(drafted.image.height_px).toBeGreaterThan(100)
  expect(await ink_count(stage, picture)).toBeGreaterThan(100)
  await info.attach(name, { path: picture, contentType: 'image/png' })
  const after = cli('status', '--session', session)
  expect(after.agent_revision).toBe(before.agent_revision)
  expect(after.document_hash).toBe(before.document_hash)
  await expect(stage.locator('.bench')).toHaveCount(0)
  return drafted
}

test('a question is answered in words; a tidy copy and a free variation are drawn', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad, cli, session } = board
    const status = () => cli('status', '--session', session)
    const hash = await step('one pen stroke reaches the Mac', async () => {
      await draw(ipad)
      await expect.poll(() => status().shapes_count).toBe(1)
      return status().document_hash as string
    })
    await step(
      'a question is answered in the conversation and nothing is drawn',
      () => conversation(board, info, hash),
      step_long_ms,
    )
    const tidy_path = await step(
      'a tidy copy keeps the pen stroke; its draft is seen before it is published',
      () => cleanup(board, info, hash),
      step_long_ms,
    )
    await step(
      'the sketch moves on: an old scene is refused, a change to the canvas is taken',
      () => moved_on(board, tidy_path),
      step_long_ms,
    )
    await step(
      'a free variation is drawn, copied into the sketch and undone',
      () => creative(board, info),
      step_long_ms,
    )
    await step('distant shapes share the initial Agent viewport', async () => {
      const snap = board.bound('snapshot', '--out', path.join(board.root, 'wide'))
      scene_edit(snap.scene_path, (scene) => {
        scene.elements = [-500_000, 500_000].map((x, i) => ({
          type: 'geo',
          id: `end-${i}`,
          x,
          y: 0,
          w: 10_000,
          h: 10_000,
        }))
      })
      expect(board.bound('publish', '--file', snap.scene_path)).toMatchObject({ code: 'published' })
      await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
      await expect(canvas_shape(ipad, 'end-0')).toHaveCount(1)
      await scene_framed(ipad, 2)
    })
    await step('an empty revision shows dots on vellum without its summary', async () => {
      const snap = board.bound('snapshot', '--out', path.join(board.root, 'empty'))
      const scene = scene_edit(snap.scene_path, (draft) => {
        draft.elements = []
        draft.summary = 'Cleared for the next drawing.'
      })
      expect(board.bound('publish', '--file', snap.scene_path)).toMatchObject({ code: 'published' })
      await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
      await empty_surface(ipad)
      await expect(canvas_region(ipad).getByText(scene.summary)).toHaveCount(0)
    })
    await step('an Interpret left unconfirmed before the upgrade is never sent again', () =>
      retired_request(board),
    )
  })
})

// The agent reads the sketch and the note, answers in words and publishes nothing.
async function conversation(board: Linked, info: TestInfo, hash: string) {
  const { ipad, bound, cli, session, root } = board
  const question = 'Is one stroke enough to read as a bridge?'
  const event = await send(ipad, bound, question)
  expect(event.sketch_hash).toBe(hash)

  // The snapshot is how the agent sees the sketch, and it says how a request is answered.
  const snap = bound('snapshot', '--out', path.join(root, 'talk'))
  expect(snap).toMatchObject({ status: 'success', snapshot: hash, base_revision: 0 })
  expect(snap.prompt).toContain('answer in the')
  expect(snap.prompt).toContain('Publish nothing')
  const answer = 'One stroke reads as a road. Two would read as a bridge.'

  for (const state of ['received', 'working']) ack(bound, event.id, state)

  ack(bound, event.id, 'updated', '--message', answer)

  // The answer is the last word of that request's one row. No canvas was written for it.
  const row = await row_with(ipad, answer)
  await expect(row).toHaveAttribute('data-state', 'updated')
  await expect(row).toHaveAttribute('data-subject', 'sketch_notify')
  await capture(ipad, info, 'conversation-answer-ipad')
  await inbox_close(ipad)
  expect(bound('poll')).toMatchObject({ agent_revision: 0, events: [] })
  expect(cli('status', '--session', session)).toMatchObject({
    agent_revision: 0,
    document_hash: hash,
  })
  await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
  await expect(ipad.getByText('Nothing on the agent canvas yet.', { exact: false })).toBeVisible()
  await expect(ipad.getByRole('button', { name: 'Replace sketchboard' })).toBeDisabled()
  await ipad.getByRole('tab', { name: 'Sketchboard' }).click()
}

// The agent names the person's stroke and sets a label beside it. The board copies the stroke
// from the sketch and records which sketch it came from. Returns the scene file of the next
// snapshot, which holds the canvas as it was published.
async function cleanup(board: Linked, info: TestInfo, hash: string): Promise<string> {
  const { ipad, stage, bound, session, root } = board
  const event = await send(ipad, bound, 'Tidy this up and label it.')

  for (const state of ['received', 'working']) ack(bound, event.id, state)

  const snap = bound('snapshot', '--out', path.join(root, 'tidy'))
  expect(snap).toMatchObject({
    status: 'success',
    snapshot: hash,
    base_revision: 0,
    shapes_count: 1,
    canvas: { revision: 0, editable: false, legacy: false },
  })
  const { strokes } = JSON.parse(fs.readFileSync(snap.strokes_path, 'utf8')) as Json
  expect(strokes).toHaveLength(1)
  const pen = strokes[0] as Json
  expect(pen.type).toBe('draw')
  const below = pen.y + pen.h + 40
  const scene = scene_edit(snap.scene_path, (draft) => {
    draft.agent = 'e2e-agent'
    draft.summary = 'Your stroke, kept as drawn, with a label.'
    draft.elements = [
      { type: 'geo', id: 'frame', x: pen.x - 60, y: pen.y - 60, w: pen.w + 300, h: pen.h + 200 },
      { type: 'sketch', id: 'ink', strokes: [pen.id] },
      { type: 'text', id: 'label', x: pen.x, y: below, text: 'A bridge', font: 'sans' },
    ]
  })
  expect(scene).toMatchObject({ format: scene_format, session, snapshot: hash, basis: 'sketch' })

  // The same file drafts to the same records, however often it is looked at.
  const drafted = await draft_drawn(board, info, snap.scene_path, 'cleanup-draft')
  expect(drafted).toMatchObject({ shapes_count: 3, base_revision: 0, snapshot: hash })
  const again = bound('preview', '--file', snap.scene_path, '--out', path.join(root, 'again.png'))
  expect(again).toMatchObject({ code: 'preview_saved', records_hash: drafted.records_hash })
  const published = bound('publish', '--file', snap.scene_path)
  expect(published).toMatchObject({
    status: 'success',
    code: 'published',
    session,
    revision: 1,
    shapes_count: 3,
    records_hash: drafted.records_hash,
  })
  ack(bound, event.id, 'updated', '--message', 'Tidied on the Agent canvas.')

  // The label and ink are scene content. The summary is metadata, not another label.
  for (const page of [ipad, stage]) {
    await page.getByRole('tab', { name: 'Agent canvas' }).click()
    await expect(canvas_words(page, 'label', 'A bridge')).toBeVisible()
    await expect(canvas_region(page).locator('svg.tl-grid')).toBeVisible()
    await expect(canvas_shape(page, 'ink.0')).toHaveAttribute('data-shape-type', 'draw')
    expect.soft(await canvas_region(page).getByText(scene.summary).count()).toBe(0)
    expect.soft(await canvas_region(page).getByRole('complementary').count()).toBe(0)
  }

  await scene_capture(ipad, info, 'cleanup-agent-canvas-ipad', published.shapes_count)
  await scene_capture(stage, info, 'cleanup-agent-canvas-mac', published.shapes_count)

  await viewer_zoom(stage, false)
  await viewer_zoom(ipad, true)
  expect(board.cli('status', '--session', session)).toMatchObject({
    document_hash: hash,
    agent_revision: 1,
  })

  // The canvas is handed back as the scene that was published, with where its ink came from.
  const next = bound('snapshot', '--out', path.join(root, 'tidied'))
  expect(next).toMatchObject({
    base_revision: 1,
    agent_source_hash: hash,
    canvas: { revision: 1, editable: true, legacy: false },
  })
  const held = JSON.parse(fs.readFileSync(next.scene_path, 'utf8')) as Json
  expect(held.elements.map((element: Json) => element.id)).toEqual(['frame', 'ink', 'label'])
  expect(held.elements[1]).toMatchObject({ type: 'sketch', strokes: [pen.id], source_hash: hash })
  expect(held.elements[1]).not.toHaveProperty('ink')
  return next.scene_path as string
}

// Exercise the input surface, not an editor API. Measure the width of the published frame
// on screen so a page zoom, a swallowed gesture or a locked camera cannot pass.
async function viewer_zoom(page: Page, touch: boolean) {
  const frame = canvas_shape(page, 'frame')
  const width = () => frame.evaluate((el) => el.getBoundingClientRect().width)
  const fitted = await width()
  const canvas = canvas_region(page).locator('.tl-canvas')
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  const x = bounds!.x + bounds!.width / 2
  const y = bounds!.y + bounds!.height / 2
  await page.mouse.click(x, y)

  if (touch) {
    const input = await page.context().newCDPSession(page)
    const fingers = (radius: number) => [
      { x: x - radius, y, id: 1 },
      { x: x + radius, y, id: 2 },
    ]

    try {
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(40) })
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(70) })
      await expect.poll(width).toBeGreaterThan(fitted * 1.1)
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(28) })
      await expect.poll(width).toBeLessThan(fitted * 0.95)
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await input.detach()
    }
  } else {
    await page.keyboard.down('Control')

    try {
      await page.mouse.wheel(0, -100)
      await expect.poll(width).toBeGreaterThan(fitted)

      // tldraw clamps each wheel tick and may discard a gesture-end tick. Wheel past the
      // initial fit and keep Control pressed until Chromium has rendered the smaller frame.

      for (let tick = 0; tick < 4; tick++) await page.mouse.wheel(0, 100)

      await expect.poll(width).toBeLessThan(fitted * 0.95)
    } finally {
      await page.keyboard.up('Control')
    }
  }

  await expect.poll(width).toBeLessThan(fitted)

  // Another navigation must preserve the user's scale rather than reapply the initial fit.
  const left = () => frame.evaluate((el) => el.getBoundingClientRect().left)
  const before = await left()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 45, y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(left).toBeGreaterThan(before + 20)
  expect(await width()).toBeLessThan(fitted)
}

// The person draws on. A scene made from the sketch as it was is refused, drafted or
// published, and nothing changes. A change to the canvas alone is taken, strokes and all.
async function moved_on(board: Linked, tidy_path: string) {
  const { ipad, bound, cli, session } = board
  const status = () => cli('status', '--session', session)
  await ipad.getByRole('tab', { name: 'Sketchboard' }).click()
  await stroke(ipad, { x: 420, y: 520 }, { x: 25, y: -10 })
  await expect.poll(() => status().shapes_count).toBe(2)

  for (const action of ['preview', 'publish']) {
    expect(bound(action, '--file', tidy_path)).toMatchObject({
      status: 'failure',
      code: 'sketch_changed',
      exit_code: 5,
    })
  }

  expect(status()).toMatchObject({ agent_revision: 1, cleaned_stale: true })
  await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
  await expect(ipad.getByRole('tab', { name: /Agent canvas.*out of date/ })).toBeVisible()
  await expect(canvas_region(ipad).getByRole('complementary')).toHaveCount(0)
  await expect(canvas_words(ipad, 'label', 'A bridge')).toBeVisible()

  scene_edit(tidy_path, (scene) => {
    scene.basis = 'canvas'
    scene.elements[2].text = 'Still a bridge'
  })
  expect(bound('publish', '--file', tidy_path)).toMatchObject({
    code: 'published',
    revision: 2,
    shapes_count: 3,
  })
  await expect(canvas_words(ipad, 'label', 'Still a bridge')).toBeVisible()
  await expect(canvas_shape(ipad, 'ink.0')).toHaveAttribute('data-shape-type', 'draw')
}

// A scene of the agent's own invention, placed element by element. The person then copies it
// into the sketch, where it is theirs to edit, and takes that back with one Undo.
async function creative(board: Linked, info: TestInfo) {
  const { ipad, stage, bound, cli, session, root } = board
  const status = () => cli('status', '--session', session)
  const event = await send(ipad, bound, 'Now imagine it as a city at night.')

  for (const state of ['received', 'working']) ack(bound, event.id, state)

  const snap = bound('snapshot', '--out', path.join(root, 'city'))
  expect(snap).toMatchObject({
    status: 'success',
    snapshot: event.sketch_hash,
    base_revision: 2,
    shapes_count: 2,
    canvas: { revision: 2, editable: true, legacy: false },
  })
  scene_edit(snap.scene_path, (scene) => {
    scene.basis = 'sketch'
    scene.summary = 'A city at night, loosely after your sketch.'
    scene.elements = night_city
  })
  const drafted = await draft_drawn(board, info, snap.scene_path, 'creative-draft')
  expect(drafted).toMatchObject({ shapes_count: night_city.length, base_revision: 2 })
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({
    code: 'published',
    revision: 3,
    shapes_count: night_city.length,
    records_hash: drafted.records_hash,
  })
  ack(bound, event.id, 'updated', '--message', 'Drawn on the Agent canvas.')

  // Every element is a shape on both screens, where the agent put it.
  for (const page of [ipad, stage]) {
    await page.getByRole('tab', { name: 'Agent canvas' }).click()
    await expect(canvas_words(page, 'tower', 'Tower')).toBeVisible()
    await expect(canvas_words(page, 'title', 'Night city')).toBeVisible()

    for (const element of night_city) await expect(canvas_shape(page, element.id)).toHaveCount(1)

    await expect(canvas_shape(page, 'ink.0')).toHaveCount(0)
  }

  await scene_capture(stage, info, 'creative-agent-canvas-mac', night_city.length)
  await soon(ipad.setViewportSize(ipad_landscape))
  await scene_framed(ipad, night_city.length)

  // Side by side, the canvas has half the screen at once and its camera follows a moment
  // later. At that instant the scene is still framed for the whole screen, so the half of it
  // past the middle is out of the pane: the Hall is cut by the pane's edge, and the Tower,
  // the title, the smoke and the bridge are whole. The Hall's label can be seen all the
  // while, which is all that a picture once waited for, and why one was taken of a cut scene.
  // The measure has to refuse that picture, and say which shapes are wrong in it.
  const early = await view_pressed(ipad, 'Side by side')
  expect(early.shapes).toBe(night_city.length)
  expect([...early.cut].sort()).toEqual(cut_at_half)
  await expect(canvas_words(ipad, 'hall', 'Hall')).toBeVisible()
  await scene_capture(ipad, info, 'creative-side-by-side-ipad', night_city.length)

  // Only the person replaces the sketch: one step, shapes of their own, and one Undo back.
  const ink_hash = status().document_hash
  await ipad.getByRole('button', { name: 'Replace sketchboard' }).tap()
  await expect(ipad.getByText('Sketch replaced. Undo restores your ink.')).toBeVisible()
  await expect.poll(() => status().shapes_count).toBe(night_city.length)
  const copied = bound('snapshot', '--out', path.join(root, 'copied'))
  expect(copied.status).toBe('success')
  const { records } = JSON.parse(fs.readFileSync(copied.records_path, 'utf8')) as Json
  const shapes = records.filter((record: Json) => record.typeName === 'shape')
  expect(shapes).toHaveLength(night_city.length)
  expect(records.every((record: Json) => !String(record.id).includes(':scene-'))).toBe(true)
  const group = shapes.find((shape: Json) => shape.type === 'group')
  expect(shapes.filter((shape: Json) => shape.parentId === group.id)).toHaveLength(2)
  expect(records.filter((record: Json) => record.typeName === 'binding')).toHaveLength(3)
  await capture(ipad, info, 'creative-copied-to-sketch-ipad')
  await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
  await expect.poll(() => status().document_hash).toBe(ink_hash)
  expect(status()).toMatchObject({ agent_revision: 3, shapes_count: 2 })
}

// A tab from before the upgrade may hold a request for an interpretation that the Mac never
// confirmed. The page drops the request and keeps the words: nothing is sent for it, and the
// next Send is an ordinary one, with a replay key of its own.
async function retired_request(board: Linked) {
  const { ipad, bound, cli, session } = board
  const words = 'Left from before the upgrade'
  const old_key = '01890a5d-ac96-774b-bcce-b302099a8057'
  const sketch_hash = cli('status', '--session', session).document_hash as string
  const pending = { kind: 'interpret_request', sketch_hash, request_id: old_key, text: words }
  const saved = JSON.stringify({ text: words, interpret: true, pending })
  await soon(
    ipad.evaluate(
      ([key, value]) => sessionStorage.setItem(key!, value!),
      [`tldraw-sync.notify.${session}`, saved],
    ),
  )
  await ipad.reload()
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  expect(bound('poll').events).toEqual([])
  await composer_open(ipad)
  await expect(note(ipad)).toHaveValue(words)
  await expect(note(ipad)).toBeEnabled()

  // Nothing is waiting to be sent again: the send is described as an ordinary one.
  await expect(ipad.locator('#agent-composer-hint')).toHaveText('')
  expect(bound('poll').events).toEqual([])
  await notify(ipad).tap()
  await expect(note(ipad)).toHaveValue('')
  const events = bound('poll').events as Json[]
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ kind: 'sketch_notify', text: words })
  expect(events[0]!.request_id).not.toBe(old_key)
  await composer_close(ipad)
}
