// Independent authoring acceptance: an agent answers three synthetic questions on one
// disposable linked board, choosing the form of each answer, through the real command line.
//
// - A word's meaning is answered in the chat, in words. Nothing is drawn or published.
// - How a loom forms fabric and why a shadow changes through the day are drawn as freeform
//   scenes of native shapes, each with one "steps" control. The scene is checked against the
//   capabilities.json the snapshot hands over, every view is drawn by the Mac stage, and the
//   pictures are judged by their pixels: the frame maps back to page units, each view paints
//   what it shows and leaves clear what it hides, and its caption comes out at a legible size.
// - Choosing a view never changes the canonical drawing: the scene file, the revision and the
//   published records stay as they were, a publish saves the view at rest, and a snapshot
//   after it hands the same scene back.
//
// Every preview picture and a summary are attached to the test results for visual review.
//
// Run: bun run build && npx playwright test tests/interactive_authoring.e2e.ts

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { image_edge_pixels_max, image_padding_px, image_scale_max } from '../src/shared/constants'
import {
  answers,
  type Box,
  type DrawnAnswer,
  type Json,
  type View,
  type WordsAnswer,
} from './fixtures/interactive-authoring/answers'
import { published } from './one_canvas'
import {
  answers as chat_answers,
  board_linked,
  chat_send,
  sketch_open,
  step,
  step_long_ms,
  type Linked,
} from './whiteboard_board'

// Pairing material belongs neither in traces nor in screenshots.
test.use({ trace: 'off' })

const png_signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Light is luminance, 0 to 255. The page is #f9fafb (about 250): a pixel under `painted_max`
// has something drawn on it, the palest fill included; one at or under `dark_max` is ink.
const painted_max = 240
const dark_max = 96

// A region that shows something is at least this much painted; one that hides it, at most.
const painted_fraction_min = 0.08
const clear_fraction_max = 0.005

// A one-line caption at a legible size: its ink is this tall and at least this wide, in page
// units, whatever the picture's scale.
const caption_height_min = 8
const caption_height_max = 40
const caption_width_min = 250

// Authored shapes keep this far inside the frame, in page units.
const frame_margin = 8

// How far the picture's size may be from the frame's, in pixels, for rounding.
const image_slack_px = 4

type Region = {
  pixels: number
  painted: number
  dark: number
  dark_width: number
  dark_height: number
}

type ViewDrawn = { name: string; records_hash: string; shapes_count: number; image: Json }

test('an agent answers three questions in the form each needs, on one linked board', async ({
  browser,
}, info) => {
  test.setTimeout(step_long_ms * 3)
  const summary: Json[] = []

  await board_linked(browser, async (board) => {
    for (const answer of answers) {
      const title = `${answer.name}: answered as ${answer.form}`

      if (answer.form === 'words') {
        await step(title, () => words_answered(board, info, answer))
        summary.push({ ...answer })
        continue
      }

      const views = await step(title, () => drawing_answered(board, info, answer), step_long_ms)
      const { form, name, question, reason, reply } = answer
      summary.push({ form, name, question, reason, reply, controls: answer.controls, views })
    }
  })

  const body = Buffer.from(JSON.stringify(summary, null, 2))
  await info.attach('answers-summary', { body, contentType: 'application/json' })
  expect(summary).toHaveLength(answers.length)
})

// Words alone, answered in the chat: no snapshot is needed and nothing is published.
async function words_answered(board: Linked, info: TestInfo, answer: WordsAnswer) {
  const { ipad, bound, cli, session } = board
  const revision = cli('status', '--session', session).agent_revision
  expect(bound('poll').events).toEqual([])
  await chat_send(ipad, answer.question, false)
  await expect.poll(() => bound('poll').events.length).toBe(1)
  const event = bound('poll').events[0] as Json
  expect(event).toMatchObject({
    kind: 'sketch_notify',
    text: answer.question,
    include_sketch: false,
  })

  // A queued event is received before it is answered; the board refuses any other order.
  const id = String(event.id)
  expect(bound('ack', '--event', id, '--state', 'received').status).toBe('success')
  const acked = bound('ack', '--event', id, '--state', 'updated', '--message', answer.reply)
  expect(acked.status).toBe('success')
  await expect(chat_answers(ipad, answer.reply)).toBeVisible()
  await expect(chat_answers(ipad, answer.reply).locator('.chat__canvas')).toHaveCount(0)
  const screen = await ipad.screenshot()
  await info.attach(`${answer.name}-chat-answer`, { body: screen, contentType: 'image/png' })
  expect(bound('poll').events).toEqual([])
  expect(cli('status', '--session', session).agent_revision).toBe(revision)
  await sketch_open(ipad)
}

// Snapshot, author against capabilities.json, preview every view, publish, snapshot again.
async function drawing_answered(
  board: Linked,
  info: TestInfo,
  answer: DrawnAnswer,
): Promise<ViewDrawn[]> {
  const { bound, root, stage, origin, session } = board
  const snap = bound('snapshot', '--out', path.join(root, `${answer.name}-before`))
  expect(snap).toMatchObject({ status: 'success', code: 'snapshot_saved' })
  const capabilities = JSON.parse(fs.readFileSync(snap.capabilities_path, 'utf8')) as Json
  expect(capabilities).toEqual(snap.capabilities)
  const scene_path = String(snap.scene_path)
  const scene = scene_author(scene_path, answer, snap.title_wanted === true)
  expect(capability_problems(scene, capabilities)).toEqual([])
  expect(frame_problems(answer)).toEqual([])
  const canonical = fs.readFileSync(scene_path)
  const records_before = await published(stage, origin, session)

  const drawn: ViewDrawn[] = []

  for (const view of answer.views) {
    drawn.push(await view_drawn(board, info, answer, scene_path, view))
  }

  // Choosing views changed neither the scene file nor what is published.
  expect(fs.readFileSync(scene_path).equals(canonical)).toBe(true)
  expect(await published(stage, origin, session)).toEqual(records_before)
  expect(new Set(drawn.map((view) => view.records_hash)).size).toBe(answer.views.length)

  const rest = drawn[0]!
  const publish = bound('publish', '--file', scene_path)
  expect(publish).toMatchObject({
    code: 'published',
    revision: snap.base_revision + 1,
    records_hash: rest.records_hash,
    shapes_count: rest.shapes_count,
  })
  await republished(board, info, answer, publish, drawn)
  return drawn
}

function scene_author(scene_path: string, answer: DrawnAnswer, title_wanted: boolean): Json {
  const scene = JSON.parse(fs.readFileSync(scene_path, 'utf8')) as Json
  expect(scene).toMatchObject({ basis: 'sketch', elements: expect.any(Array) })
  scene.agent = 'authoring-acceptance'
  scene.summary = answer.question
  scene.controls = answer.controls
  scene.elements = answer.elements

  if (title_wanted) scene.title = 'Weaving and shadows'

  fs.writeFileSync(scene_path, `${JSON.stringify(scene, null, 2)}\n`)
  return scene
}

// The snapshot after a publish hands the same scene back, and a view chosen from it is the
// same view as before, drawn without touching the canvas.
async function republished(
  board: Linked,
  info: TestInfo,
  answer: DrawnAnswer,
  publish: Json,
  drawn: readonly ViewDrawn[],
) {
  const { bound, cli, root, stage, origin, session } = board
  const after = bound('snapshot', '--out', path.join(root, `${answer.name}-after`))
  expect(after).toMatchObject({
    base_revision: publish.revision,
    scene_controls: answer.controls,
    states_count: answer.views.length,
  })
  const scene = JSON.parse(fs.readFileSync(after.scene_path, 'utf8')) as Json
  expect(scene.controls).toEqual(answer.controls)
  expect(scene.elements).toMatchObject(answer.elements)

  const records = await published(stage, origin, session)
  const last = answer.views.at(-1)!
  const again = await view_drawn(board, info, answer, String(after.scene_path), last, 'published')
  expect(again.records_hash).toBe(drawn.at(-1)!.records_hash)
  expect(await published(stage, origin, session)).toEqual(records)
  expect(cli('status', '--session', session).agent_revision).toBe(publish.revision)
}

// One view drawn by the stage: attached for review, then judged by its pixels. Nothing of a
// preview is published, and the sketch is untouched.
async function view_drawn(
  board: Linked,
  info: TestInfo,
  answer: DrawnAnswer,
  scene_path: string,
  view: View,
  suffix = 'draft',
): Promise<ViewDrawn> {
  const { bound, cli, session, stage, root } = board
  const before = cli('status', '--session', session)
  const name = `${view.name}-${suffix}`
  const picture = path.join(root, `${name}.png`)
  const state = view.state === null ? [] : ['--state', JSON.stringify(view.state)]
  const drafted = bound('preview', '--file', scene_path, '--out', picture, ...state)
  expect(drafted, name).toMatchObject({
    status: 'success',
    code: 'preview_saved',
    image_path: picture,
    published: false,
    view: view.state === null ? 'rest' : 'selected',
    states_count: answer.views.length,
  })
  await info.attach(name, { path: picture, contentType: 'image/png' })

  if (view.state !== null) expect(drafted.state).toMatchObject(view.state)

  const bytes = fs.readFileSync(picture)
  expect([...bytes.subarray(0, png_signature.length)]).toEqual(png_signature)
  expect(await picture_problems(stage, picture, drafted.image, answer, view)).toEqual([])
  const after = cli('status', '--session', session)
  expect(after.agent_revision).toBe(before.agent_revision)
  expect(after.document_hash).toBe(before.document_hash)
  await expect(stage.locator('.bench')).toHaveCount(0)
  const { records_hash, shapes_count, image } = drafted
  return { name, records_hash, shapes_count, image }
}

// The stage frames a picture on the page bounds of what it draws, with padding, at a capped
// scale. Every view keeps the same frame, so its size is known and its pixels map back.
function picture_scale(answer: DrawnAnswer): number {
  const edge = Math.max(answer.frame.w, answer.frame.h) + image_padding_px * 2
  return Math.min(image_scale_max, image_edge_pixels_max / edge)
}

function pixels_of(box: Box, scale: number): Box {
  return {
    left: (box.left + image_padding_px) * scale,
    top: (box.top + image_padding_px) * scale,
    right: (box.right + image_padding_px) * scale,
    bottom: (box.bottom + image_padding_px) * scale,
  }
}

async function picture_problems(
  page: Page,
  picture: string,
  image: Json,
  answer: DrawnAnswer,
  view: View,
): Promise<string[]> {
  const scale = picture_scale(answer)
  const width_px = (answer.frame.w + image_padding_px * 2) * scale
  const height_px = (answer.frame.h + image_padding_px * 2) * scale
  const problems: string[] = []

  // A shape past the frame, or a label grown out of it, would widen the picture.
  if (Math.abs(Number(image.width_px) - width_px) > image_slack_px) {
    problems.push(`width ${image.width_px}px, expected ${width_px}px`)
  }

  if (Math.abs(Number(image.height_px) - height_px) > image_slack_px) {
    problems.push(`height ${image.height_px}px, expected ${height_px}px`)
  }

  const boxes = [...view.probes.map((probe) => probe.box), view.caption]
  const regions = await regions_read(
    page,
    picture,
    boxes.map((box) => pixels_of(box, scale)),
  )

  for (const [index, probe] of view.probes.entries()) {
    const region = regions[index]!
    const fraction = region.painted / region.pixels
    const shown =
      probe.expect === 'painted' ? fraction >= painted_fraction_min : fraction <= clear_fraction_max

    if (!shown)
      problems.push(`${probe.name}: expected ${probe.expect}, ${fraction.toFixed(3)} painted`)
  }

  const caption = regions.at(-1)!
  const height = caption.dark_height / scale
  const width = caption.dark_width / scale
  const legible = height >= caption_height_min && height <= caption_height_max
  const wide = width >= caption_width_min

  if (!legible || !wide) {
    problems.push(
      `caption ink ${width.toFixed(1)} x ${height.toFixed(1)} units is not one legible line`,
    )
  }

  return problems
}

// What each region of a saved picture holds, counted by the browser's own image decoder. The
// pixels stay in the page: only the counts come back.
function regions_read(page: Page, picture: string, boxes: Box[]): Promise<Region[]> {
  const base64 = fs.readFileSync(picture).toString('base64')
  return page.evaluate(
    async ({ encoded, regions, painted_max, dark_max }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${encoded}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(image, 0, 0)
      const { data, width } = context.getImageData(0, 0, canvas.width, canvas.height)

      return regions.map((box) => {
        const found = { pixels: 0, painted: 0, dark: 0 }
        const ink = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
        const bottom = Math.min(Math.floor(box.bottom), canvas.height)
        const right = Math.min(Math.floor(box.right), canvas.width)

        for (let y = Math.max(0, Math.ceil(box.top)); y < bottom; y += 1) {
          for (let x = Math.max(0, Math.ceil(box.left)); x < right; x += 1) {
            const at = (y * width + x) * 4
            const light = 0.299 * data[at]! + 0.587 * data[at + 1]! + 0.114 * data[at + 2]!
            found.pixels += 1

            if (light < painted_max) found.painted += 1

            if (light > dark_max) continue

            found.dark += 1
            ink.left = Math.min(ink.left, x)
            ink.right = Math.max(ink.right, x + 1)
            ink.top = Math.min(ink.top, y)
            ink.bottom = Math.max(ink.bottom, y + 1)
          }
        }

        const some = found.dark > 0
        const dark_width = some ? ink.right - ink.left : 0
        const dark_height = some ? ink.bottom - ink.top : 0
        return { ...found, dark_width, dark_height }
      })
    },
    { encoded: base64, regions: boxes, painted_max, dark_max },
  )
}

// The scene uses only what capabilities.json says the board accepts, within its limits.
function capability_problems(scene: Json, capabilities: Json): string[] {
  const problems: string[] = []
  const limits = capabilities.limits as Record<string, number>
  const bytes = Buffer.byteLength(JSON.stringify(scene))
  const elements = scene.elements as Json[]

  if (scene.format !== capabilities.scene_format) problems.push('scene format')

  if (bytes > limits.scene_size_bytes_max!) problems.push(`scene of ${bytes} bytes`)

  if (elements.length > limits.elements_count_max!) problems.push('too many elements')

  for (const element of elements) problems.push(...element_problems(element, capabilities))

  problems.push(...controls_problems(scene.controls as Json[], capabilities))
  return problems
}

const style_lists: Record<string, string> = {
  color: 'color',
  label_color: 'color',
  size: 'size',
  font: 'font',
  fill: 'fill',
  dash: 'dash',
  geo: 'geo',
  route: 'route',
  arrowhead_start: 'arrowhead',
  arrowhead_end: 'arrowhead',
}

function element_problems(element: Json, capabilities: Json): string[] {
  const problems: string[] = []
  const styles = capabilities.styles as Record<string, string[]>
  const limits = capabilities.limits as Record<string, number>
  const controls = capabilities.controls as Json
  const id = String(element.id)

  if (!(capabilities.element_types as string[]).includes(String(element.type))) {
    problems.push(`${id}: type ${element.type}`)
  }

  for (const [field, list] of Object.entries(style_lists)) {
    if (field in element && !styles[list]!.includes(String(element[field]))) {
      problems.push(`${id}: ${field} ${element[field]}`)
    }
  }

  const aligns = element.type === 'geo' ? styles.label_align! : styles.text_align!

  if ('align' in element && !aligns.includes(String(element.align))) problems.push(`${id}: align`)

  if (String(element.text ?? '').length > limits.text_length_max!) problems.push(`${id}: text`)

  const points = (element.points ?? []) as unknown[]

  if (element.type === 'path' && points.length > limits.path_points_count_max!) {
    problems.push(`${id}: points`)
  }

  const conditions = (element.visible_when ?? []) as unknown[]

  if (conditions.length > Number(controls.conditions_count_max)) problems.push(`${id}: conditions`)

  return problems
}

function controls_problems(controls: Json[], capabilities: Json): string[] {
  const allowed = capabilities.controls as Json
  const id_pattern = new RegExp(String(allowed.id_pattern))
  const value_pattern = new RegExp(String(allowed.value_pattern))
  const problems: string[] = []

  if (controls.length > Number(allowed.count_max)) problems.push('too many controls')

  for (const control of controls) {
    const options = (control.options ?? []) as Json[]
    const counted =
      options.length >= Number(allowed.options_count_min) &&
      options.length <= Number(allowed.options_count_max)

    if (!(allowed.kinds as string[]).includes(String(control.kind))) problems.push('control kind')

    if (!id_pattern.test(String(control.id))) problems.push(`control id ${control.id}`)

    if (String(control.label).length > Number(allowed.label_length_max)) problems.push('label')

    if (control.kind !== 'toggle' && !counted) problems.push(`${control.id}: options`)

    for (const option of options) {
      if (!value_pattern.test(String(option.value))) problems.push(`value ${option.value}`)

      if (String(option.label).length > Number(allowed.label_length_max)) problems.push('option')
    }
  }

  return problems
}

// Every point the agent placed lies inside the frame, so the frame alone sets the picture's
// bounds. Lettering is checked for its width here and for its height in the pixels.
function frame_problems(answer: DrawnAnswer): string[] {
  const problems: string[] = []
  const inside = (x: number, y: number) =>
    x >= frame_margin &&
    y >= frame_margin &&
    x <= answer.frame.w - frame_margin &&
    y <= answer.frame.h - frame_margin

  for (const element of answer.elements) {
    if (element.id === 'frame') continue

    const x = Number(element.x)
    const y = Number(element.y)
    const corners: Array<[number, number]> = []

    if (element.type === 'text') corners.push([x, y], [x + Number(element.w), y])

    if (element.type === 'geo') {
      corners.push([x, y], [x + Number(element.w), y + Number(element.h)])
    }

    for (const point of (element.points ?? []) as Array<[number, number]>) corners.push(point)

    for (const end of [element.from, element.to]) {
      if (Array.isArray(end)) corners.push(end as [number, number])
    }

    if (corners.length === 0) problems.push(`${element.id}: not placed`)

    for (const [px, py] of corners) {
      if (!inside(px, py)) problems.push(`${element.id}: (${px}, ${py}) outside the frame`)
    }
  }

  return problems
}
