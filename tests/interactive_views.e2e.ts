// An interactive drawing on the one canvas, on a disposable linked board. A static drawing
// brings no switch and no request for a scene. An agent-native diagram of a checkout gateway,
// with one of the person's strokes copied into it, brings a switch on the drawing's top edge.
// Its views genuinely differ; a finger, a mouse, the keyboard and a dashed hint in the drawing
// choose them; the Pencil writes straight through the switch and never chooses. A choice works
// offline once loaded, sends nothing, publishes nothing, moves no camera and leaves the ink as
// it was; the Mac stage keeps its own view at rest. A new revision or a restore lets the choice
// go. In a narrow window the switch folds into one button. The screenshots are kept with the
// results, and the board is left on the drawing at rest, switch showing, for review.
//
// Run: bun run build && npx playwright test tests/interactive_views.e2e.ts

import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { at_rest, board_menu, print_choose, print_fit, published } from './one_canvas'
import {
  action_ms,
  board_linked,
  chat_open,
  ipad_narrow,
  ipad_portrait,
  expect_revision,
  navigation_ms,
  print_region,
  print_shape,
  sketch_open,
  soon,
  step,
  stroke,
  surface,
  type Linked,
} from './whiteboard_board'

test.use({ trace: 'off' })

type Json = Record<string, any>

// The design's iPad Pro 11 in landscape, as a Mac window with a mouse and a keyboard.
const design_screen = { width: 1194, height: 834 }

const answer = (...values: string[]) => [{ control: 'answer', values }]
const approved = answer('approved')
const declined = answer('declined')
const timeout = answer('timeout')

const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true })
const switch_frame = (page: Page) => page.locator('.switch:not(.switch--measure)')
const view_of = (page: Page) => print_region(page).getAttribute('data-view')

// The print shows the view named, drawn and settled.
async function view_shown(page: Page, view: string) {
  await expect(print_region(page)).toHaveAttribute('data-view', view)
  await expect(print_region(page)).toHaveAttribute('aria-busy', 'false')
}

test('an interactive drawing switches on this screen only, offline, and the ink stays', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad, stage } = board
    const asked: string[] = []
    const sent: string[] = []
    const errors: string[] = []
    ipad.on('pageerror', (error) => errors.push(error.message))
    ipad.on('crash', () => errors.push('the page crashed'))
    ipad.on('request', (request) => {
      const url = new URL(request.url())

      if (url.pathname === '/api/cleaned/view.json') asked.push(url.search)

      if (request.method() !== 'GET') sent.push(`${request.method()} ${url.pathname}`)
    })

    await step('a static drawing has no switch, and asks for no scene', () =>
      static_drawing(board, asked),
    )
    const pen = await step('the person writes one stroke with the Pencil', () => pen_stroke(board))
    await step('the agent publishes the gateway, with the stroke copied in', async () =>
      publish_gateway(board, pen),
    )
    await step('both screens show their own controls at rest', () =>
      switch_arrives(board, asked, info),
    )
    await step('the read-only stage changes views without moving the camera or the pen', () =>
      stage_choices(board),
    )
    await step('a finger chooses; the views differ; camera, ink and canvas stay', () =>
      finger_choices(board, info),
    )
    await step('the Pencil writes through the switch and never chooses', () =>
      pencil_through(board),
    )
    await step('offline, a choice still changes the view and sends nothing', () =>
      offline_choice(board, asked, sent),
    )
    await desktop_inputs(board, browser)
    await soon(ipad.bringToFront())
    await step('a narrow window folds the switch into one button', () => folded(board, info))
    await step('a new revision and a restore let the choice go', () => transitions(board))
    await step('the chat opens beside the switch and moves nothing', () =>
      beside_chat(board, errors, info),
    )
    await step('the board is left at rest, with its switch, for review', () =>
      rest_state(board, info),
    )
    expect(sent).toEqual([])
    await expect(switch_frame(stage).first()).toBeVisible()
  })
})

// The mouse and keyboard need a third client only for these steps. Do not leave it rendering
// new revisions in parallel while measuring the iPad's animated fit after a rotation.
async function desktop_inputs(board: Linked, browser: Browser) {
  const mac = await browser.newPage({ viewport: design_screen })
  mac.setDefaultTimeout(action_ms)
  mac.setDefaultNavigationTimeout(navigation_ms)

  try {
    await mac.goto(`${board.origin}/s/${board.session}/draw`)
    await expect(surface(mac)).toBeVisible()
    await step('the keyboard reaches, moves and leaves the switch; motion is reduced', () =>
      keyboard_choices(board, mac),
    )
    await step('a mouse picks an option, and a dashed hint in the drawing', () =>
      mouse_choices(board, mac),
    )
  } finally {
    await mac.close()
  }
}

function scene_edit(file: string, change: (scene: Json) => void): Json {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
  change(scene)
  fs.writeFileSync(file, JSON.stringify(scene))
  return scene
}

async function static_drawing({ bound, root, ipad, stage }: Linked, asked: string[]) {
  const snap = bound('snapshot', '--out', path.join(root, 'plain'))
  scene_edit(snap.scene_path, (scene) => {
    scene.agent = 'e2e-agent'
    scene.summary = 'Two steps of a checkout.'
    scene.elements = [
      { type: 'geo', id: 'cart', x: 0, y: 0, w: 200, h: 80, text: 'Cart', font: 'sans' },
      { type: 'geo', id: 'pay', x: 300, y: 0, w: 200, h: 80, text: 'Pay', font: 'sans' },
      arrow_labeled('next', 'cart', 'pay', 'then'),
    ]
  })
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({ code: 'published' })

  for (const page of [ipad, stage]) {
    await expect_revision(page, 1)
    await view_shown(page, '1')
  }

  await print_fit(ipad, 'cart')
  await ipad.waitForTimeout(500)
  await expect(ipad.getByRole('group', { name: 'Views of this drawing' })).toHaveCount(0)
  await expect(ipad.getByRole('radio')).toHaveCount(0)
  expect(asked).toEqual([])
}

// One stroke drawn across empty sheet, and its id and box as the agent reads them.
async function pen_stroke({ bound, root, cli, session, ipad }: Linked): Promise<Json> {
  const before = cli('status', '--session', session).shapes_count as number
  await stroke(ipad, { x: 520, y: 980 }, { x: 30, y: -14 })
  await expect.poll(() => cli('status', '--session', session).shapes_count).toBe(before + 1)
  const snap = bound('snapshot', '--out', path.join(root, 'stroke'))
  const { strokes } = JSON.parse(fs.readFileSync(snap.strokes_path, 'utf8')) as Json
  expect(strokes).toHaveLength(1)
  return strokes[0] as Json
}

// What happens to an order for each answer of the payment gateway, on one timeline: a
// headline, the marks along it and the outcome, for each answer. The outcome group holds two
// cards and an arrow when the charge is approved, and one card otherwise. A dashed hint asks
// what if no answer comes, and a tap on it shows that answer. The person's stroke is copied
// in at the 60 s mark, where it circles the moment the gateway gives up.
function gateway_elements(pen: Json): Json[] {
  const second = [...timeout, { control: 'attempt', values: ['second'] }]
  const text = (id: string, x: number, y: number, words: string, when?: Json[]) => {
    const element: Json = { type: 'text', id, x, y, text: words, font: 'sans', size: 's' }

    if (when !== undefined) element.visible_when = when

    return element
  }
  const headline = (id: string, words: string, when: Json[]) => {
    return { ...text(id, 0, -80, words, when), size: 'l' }
  }
  const tick = (id: string, x: number) => ({
    type: 'path',
    id,
    points: [
      [x, 52],
      [x, 68],
    ],
  })
  return [
    headline('ok', 'Approved: the order is placed in about 3 s', approved),
    headline('no', 'Declined: the cart is kept and another card is asked for', declined),
    headline('wait', 'Times out: retry once, then hold the order at 60 s', timeout),
    {
      type: 'path',
      id: 'axis',
      points: [
        [0, 60],
        [740, 60],
      ],
    },
    tick('tick0', 0),
    tick('tick30', 310),
    tick('tick60', 620),
    text('t0', -6, 76, '0 s'),
    text('t30', 296, 76, '30 s'),
    text('t60', 606, 76, '60 s'),
    { type: 'geo', id: 'charge', x: 0, y: 0, w: 34, h: 40, fill: 'semi', visible_when: approved },
    text('charged', 48, 10, 'Charge approved at 3 s', approved),
    {
      type: 'geo',
      id: 'hint',
      x: 310,
      y: 2,
      w: 210,
      h: 40,
      text: 'No answer by 30 s?',
      dash: 'dashed',
      font: 'sans',
      size: 's',
      visible_when: approved,
      on_tap: { control: 'answer', value: 'timeout' },
    },
    {
      type: 'geo',
      id: 'placed',
      x: 0,
      y: 160,
      w: 228,
      h: 60,
      text: 'Order placed',
      font: 'sans',
      fill: 'semi',
      parent: 'outcome',
      visible_when: approved,
    },
    {
      type: 'geo',
      id: 'receipt',
      x: 276,
      y: 160,
      w: 220,
      h: 60,
      text: 'Receipt emailed',
      font: 'sans',
      parent: 'outcome',
      visible_when: approved,
    },
    { ...arrow_labeled('sends', 'placed', 'receipt', 'then'), parent: 'outcome' },
    arrow_labeled('places', 'charge', 'placed', 'places'),
    { type: 'geo', id: 'refused', geo: 'x-box', x: 0, y: 0, w: 34, h: 40, visible_when: declined },
    {
      type: 'geo',
      id: 'again',
      x: 0,
      y: 160,
      w: 300,
      h: 60,
      text: 'Ask for another card',
      font: 'sans',
      parent: 'outcome',
      visible_when: declined,
    },
    arrow_labeled('asks', 'refused', 'again', 'asks'),
    {
      type: 'geo',
      id: 'first',
      x: 0,
      y: 0,
      w: 288,
      h: 40,
      text: 'Attempt 1 · no answer',
      dash: 'dashed',
      font: 'sans',
      size: 's',
      visible_when: timeout,
    },
    {
      type: 'geo',
      id: 'retry',
      x: 320,
      y: 0,
      w: 288,
      h: 40,
      text: 'Retry once · still quiet',
      fill: 'semi',
      font: 'sans',
      size: 's',
      visible_when: second,
    },
    {
      type: 'geo',
      id: 'hold',
      x: 200,
      y: 160,
      w: 400,
      h: 60,
      text: 'Hold the order for 10 min',
      font: 'sans',
      fill: 'semi',
      parent: 'outcome',
      visible_when: timeout,
    },
    { type: 'group', id: 'outcome' },
    text('note', 0, 250, 'The gateway gives up at 60 s; nothing is charged twice.', [
      { control: 'notes', values: ['on'] },
    ]),
    { type: 'sketch', id: 'mark', strokes: [pen.id], x: 590, y: 92 },
  ]
}

// An arrow says what it means. tldraw also exports an unlabeled arrow with an empty label box
// shrunk by its padding, a foreignObject 8.5 px less than nothing wide, which the browser
// reports on every print of it.
function arrow_labeled(id: string, from: string, to: string, words: string): Json {
  return { type: 'arrow', id, from, to, text: words, font: 'sans', size: 's' }
}

function gateway_controls(): Json[] {
  const option = (value: string, label: string) => ({ value, label })
  return [
    {
      id: 'answer',
      kind: 'choice',
      label: 'Gateway answers',
      options: [
        option('approved', 'Approved'),
        option('declined', 'Declined'),
        option('timeout', 'Times out'),
      ],
    },
    {
      id: 'attempt',
      kind: 'steps',
      label: 'Attempt',
      options: [option('first', 'First try'), option('second', 'Retry')],
    },
    { id: 'notes', kind: 'toggle', label: 'Notes' },
  ]
}

function publish_gateway({ bound, root, session }: Linked, pen: Json) {
  const snap = bound('snapshot', '--out', path.join(root, 'gateway'))
  scene_edit(snap.scene_path, (scene) => {
    scene.agent = 'e2e-agent'
    scene.summary = 'What happens to an order for each answer of the gateway.'
    scene.controls = gateway_controls()
    scene.elements = gateway_elements(pen)
  })
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({
    code: 'published',
    session,
    revision: 2,
  })
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file })
  return fs.readFileSync(file)
}

type Rect = { x: number; y: number; width: number; height: number }

const apart = (a: Rect, b: Rect) =>
  a.x + a.width <= b.x + 1 ||
  b.x + b.width <= a.x + 1 ||
  a.y + a.height <= b.y + 1 ||
  b.y + b.height <= a.y + 1

async function switch_arrives({ ipad, stage, session }: Linked, asked: string[], info: TestInfo) {
  await expect_revision(ipad, 2)
  await print_fit(ipad, 'axis')
  await expect(radio(ipad, 'Approved')).toHaveAttribute('aria-checked', 'true')
  await view_shown(ipad, '2')
  expect(asked).toEqual([`?session=${session}&interactive=1`])

  // Labelled, on the drawing's top edge, clear of every shape of it, and 44px to a control.
  await expect(ipad.locator('.print__shape[data-state="ghost"]')).toHaveCount(0)
  const frame = (await switch_frame(ipad).boundingBox())!
  const headline = (await print_shape(ipad, 'ok').boundingBox())!
  expect(frame.y + frame.height).toBeLessThanOrEqual(headline.y + 1)

  for (const shape of await ipad.locator('.print__shape').all()) {
    expect(apart(frame, (await shape.boundingBox())!)).toBe(true)
  }

  await expect(switch_frame(ipad)).toContainText('Gateway answers')

  for (const control of await switch_frame(ipad).locator('button').all()) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }

  // The stage starts at rest, with its own switch (possibly folded to fit its viewport).
  await view_shown(stage, '2')
  await expect(switch_frame(stage).first()).toBeVisible()
  await capture(ipad, info, 'interactive-ipad-rest')
}

async function stage_choices({ stage, ipad, cli, session }: Linked) {
  expect(new URL(stage.url()).pathname).toBe(`/s/${session}`)
  const fit = stage.getByRole('button', { name: 'Fit board' })
  const fold = stage.locator('.switch__fold')
  const camera = await camera_of(stage)
  const hash = cli('status', '--session', session).document_hash

  if (await fold.isVisible()) await fold.click()

  // All controls use the existing local projection, including while the server is unreachable.
  await stage.context().setOffline(true)

  try {
    await radio(stage, 'Approved').press('ArrowRight')
    await view_shown(stage, '2 declined/first/off')
    await stage.getByRole('button', { name: 'Next: Attempt' }).click()
    await view_shown(stage, '2 declined/second/off')
    await stage.getByRole('switch', { name: 'Notes' }).press('Space')
    await view_shown(stage, '2 declined/second/on')
    expect(await camera_of(stage)).toBe(camera)
    await expect(fit).toHaveCount(0)
    await stage.getByRole('switch', { name: 'Notes' }).click()
    await stage.getByRole('button', { name: 'Back: Attempt' }).click()
    await radio(stage, 'Approved').click()
    await view_shown(stage, '2')
  } finally {
    await stage.context().setOffline(false)
  }

  if (await fold.isVisible()) await fold.click()

  expect(await camera_of(stage)).toBe(camera)
  await expect(fit).toHaveCount(0)

  await stage_shortcut(stage, camera)
  expect(cli('status', '--session', session)).toMatchObject({
    document_hash: hash,
    agent_revision: 2,
  })
  await view_shown(ipad, '2')

  if (await fold.isVisible()) await fold.click()

  await radio(stage, 'Approved').click()
  await view_shown(stage, '2')

  if (await fold.isVisible()) await fold.click()
}

// A drag beginning on the published shortcut pans; only a click chooses its value.
async function stage_shortcut(stage: Page, camera: string) {
  const fit = stage.getByRole('button', { name: 'Fit board' })
  const shortcut = print_shape(stage, 'hint')
  const hint = (await shortcut.boundingBox())!
  const x = hint.x + hint.width / 2
  const y = hint.y + hint.height / 2
  await stage.mouse.move(x, y)
  await stage.mouse.down()

  try {
    await stage.mouse.move(x + 60, y + 40)

    // Check the drag itself, before release can start the hand tool's inertial slide.
    await expect
      .poll(async () => {
        const moved = (await shortcut.boundingBox())!
        return [Math.round(moved.x - hint.x), Math.round(moved.y - hint.y)]
      })
      .toEqual([60, 40])
  } finally {
    await stage.mouse.up()
  }

  await expect(fit).toBeVisible()
  await view_shown(stage, '2')
  await fit.click()
  await expect.poll(() => axis_box(stage)).toBe(camera)
  await stage.mouse.click(x, y)
  await view_shown(stage, '2 timeout/first/off')
  await expect(fit).toHaveCount(0)
  expect(await camera_of(stage)).toBe(camera)
  await expect(stage.getByRole('dialog', { name: 'Agent shape' })).toHaveCount(0)
}

async function finger_choices(board: Linked, info: TestInfo) {
  const { ipad, stage, cli, session, origin } = board
  const status = () => cli('status', '--session', session)
  const before = status()
  const records = await published(ipad, origin, session)
  const camera = await at_rest(ipad, '.print__shape[data-print-shape="shape:scene-axis"]')
  const ink = await at_rest(ipad, '.print__shape[data-print-shape="shape:scene-mark.0"]')
  const rest_picture = await capture(ipad, info, 'interactive-ipad-approved')

  await radio(ipad, 'Times out').tap()
  await expect(radio(ipad, 'Times out')).toHaveAttribute('aria-checked', 'true')
  await view_shown(ipad, '2 timeout/first/off')
  await expect(print_shape(ipad, 'wait')).toBeVisible()
  await expect(print_shape(ipad, 'ok')).toHaveCount(0)

  // The outcome group, left holding one card, is dissolved: the card stands on its own.
  await expect(print_shape(ipad, 'hold')).toBeVisible()
  await expect(print_shape(ipad, 'outcome')).toHaveCount(0)
  const timeout_picture = await capture(ipad, info, 'interactive-ipad-times-out')
  expect(timeout_picture.equals(rest_picture)).toBe(false)

  // The steps and the toggle change the view again, each by itself.
  await ipad.getByRole('button', { name: 'Next: Attempt' }).tap()
  await view_shown(ipad, '2 timeout/second/off')
  await expect(print_shape(ipad, 'retry')).toBeVisible()
  await ipad.getByRole('switch', { name: 'Notes' }).tap()
  await expect(ipad.getByRole('switch', { name: 'Notes' })).toHaveAttribute('aria-checked', 'true')
  await view_shown(ipad, '2 timeout/second/on')
  await expect(print_shape(ipad, 'note')).toBeVisible()
  await capture(ipad, info, 'interactive-ipad-retry-notes')

  // Nothing moved, nothing was written: the camera, the ink, the stroke copied in, the
  // canvas every page is served, and the Mac stage's own view.
  expect(await at_rest(ipad, '.print__shape[data-print-shape="shape:scene-axis"]')).toBe(camera)
  expect(await at_rest(ipad, '.print__shape[data-print-shape="shape:scene-mark.0"]')).toBe(ink)
  expect(status()).toMatchObject({
    document_hash: before.document_hash,
    agent_revision: 2,
    shapes_count: before.shapes_count,
  })
  expect(await published(ipad, origin, session)).toEqual(records)
  await view_shown(stage, '2')
  await ipad.getByRole('switch', { name: 'Notes' }).tap()
  await ipad.getByRole('button', { name: 'Back: Attempt' }).tap()
  await view_shown(ipad, '2 timeout/first/off')
}

// A Pencil press that starts on the switch writes a stroke, and chooses nothing.
async function pencil_through({ ipad, cli, session }: Linked) {
  const status = () => cli('status', '--session', session)
  const before = status()
  const declined_box = (await radio(ipad, 'Declined').boundingBox())!
  const from = { x: declined_box.x + declined_box.width / 2, y: declined_box.y + 22 }
  await stroke(ipad, from, { x: 26, y: 18 })
  await expect.poll(() => status().shapes_count).toBe(before.shapes_count + 1)
  await expect(radio(ipad, 'Declined')).toHaveAttribute('aria-checked', 'false')
  await expect(radio(ipad, 'Times out')).toHaveAttribute('aria-checked', 'true')
  await view_shown(ipad, '2 timeout/first/off')

  // The switch takes a finger again once the Pencil has lifted. Undo takes the stroke back.
  await ipad.getByRole('button', { name: 'Undo', exact: true }).tap()
  await expect.poll(() => status().document_hash).toBe(before.document_hash)
  await radio(ipad, 'Approved').tap()
  await view_shown(ipad, '2')
}

async function offline_choice({ ipad }: Linked, asked: string[], sent: string[]) {
  const asked_count = asked.length
  const sent_count = sent.length
  await soon(ipad.context().setOffline(true))

  try {
    await radio(ipad, 'Declined').tap()
    await view_shown(ipad, '2 declined/first/off')
    await expect(print_shape(ipad, 'no')).toBeVisible()
    await expect(print_shape(ipad, 'again')).toBeVisible()
    await expect(print_shape(ipad, 'sends')).toHaveCount(0)
    await radio(ipad, 'Approved').tap()
    await view_shown(ipad, '2')
  } finally {
    await soon(ipad.context().setOffline(false))
  }

  expect(asked).toHaveLength(asked_count)
  expect(sent).toHaveLength(sent_count)
}

async function keyboard_choices({ cli, session }: Linked, mac: Page) {
  const before = cli('status', '--session', session).document_hash
  await print_fit(mac, 'axis')
  await expect(radio(mac, 'Approved')).toHaveAttribute('aria-checked', 'true')
  await soon(mac.emulateMedia({ reducedMotion: 'reduce' }))
  const duration = await radio(mac, 'Declined').evaluate((element) => {
    return getComputedStyle(element).transitionDuration
  })
  expect(duration).toBe('0s')

  // Tab reaches the switch from the canvas, on the chosen option.
  await surface(mac).locator('.tl-container').first().focus()
  let reached = false

  for (let press = 0; press < 16 && !reached; press += 1) {
    await soon(mac.keyboard.press('Tab'))
    reached = await radio(mac, 'Approved').evaluate((element) => element === document.activeElement)
  }

  expect(reached).toBe(true)
  await soon(mac.keyboard.press('ArrowRight'))
  await expect(radio(mac, 'Declined')).toBeFocused()
  await expect(radio(mac, 'Declined')).toHaveAttribute('aria-checked', 'true')
  await soon(mac.keyboard.press('End'))
  await expect(radio(mac, 'Times out')).toBeFocused()
  await view_shown(mac, '2 timeout/first/off')
  const said = 'Gateway answers, Times out, 3 of 3. Changes this drawing on this screen only.'
  await expect(mac.getByRole('status').filter({ hasText: said })).toHaveCount(1)

  // Escape returns to the canvas, holding the pen; the next key goes to the canvas.
  await soon(mac.keyboard.press('Escape'))
  await expect(radio(mac, 'Times out')).not.toBeFocused()
  expect(await mac.evaluate(() => document.activeElement?.closest('.switch') ?? null)).toBeNull()
  await expect(mac.getByRole('button', { name: 'Pen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await mac.getByRole('switch', { name: 'Notes' }).focus()
  await soon(mac.keyboard.press('Space'))
  await view_shown(mac, '2 timeout/first/on')
  await soon(mac.keyboard.press('Space'))
  await view_shown(mac, '2 timeout/first/off')
  expect(cli('status', '--session', session).document_hash).toBe(before)
}

async function mouse_choices({ cli, session, ipad }: Linked, mac: Page) {
  const before = cli('status', '--session', session).document_hash
  await radio(mac, 'Approved').click()
  await view_shown(mac, '2')

  // A shape chosen in one view is let go when the view changes: a take copies only what is
  // on screen.
  const card = await print_choose(mac, 'charge', false)
  await radio(mac, 'Declined').click()
  await expect(card).toHaveCount(0)
  await view_shown(mac, '2 declined/first/off')
  await expect(print_shape(mac, 'charge')).toHaveCount(0)
  await radio(mac, 'Approved').click()
  await view_shown(mac, '2')

  // A click on the dashed hint picks the answer it names, and leaves no dot of ink.
  const hint = (await print_shape(mac, 'hint').boundingBox())!
  await soon(mac.mouse.click(hint.x + hint.width / 2, hint.y + hint.height / 2))
  await expect(radio(mac, 'Times out')).toHaveAttribute('aria-checked', 'true')
  await view_shown(mac, '2 timeout/first/off')
  await expect(mac.getByRole('dialog', { name: 'Agent shape' })).toHaveCount(0)
  await mac.waitForTimeout(500)
  expect(cli('status', '--session', session).document_hash).toBe(before)

  // Each device keeps its own choice.
  expect(await view_of(ipad)).toBe('2')
  await radio(mac, 'Approved').click()
  await view_shown(mac, '2')
}

async function folded({ ipad }: Linked, info: TestInfo) {
  await soon(ipad.setViewportSize(ipad_narrow))
  await print_fit(ipad, 'axis')
  const fold = ipad.getByRole('button', { name: /^Gateway answers: Approved/ })
  await expect(fold).toBeVisible()
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(radio(ipad, 'Approved')).toHaveCount(0)
  await fold.tap()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await radio(ipad, 'Times out').tap()
  await view_shown(ipad, '2 timeout/first/off')
  await expect(ipad.getByRole('button', { name: /^Gateway answers: Times out/ })).toBeVisible()
  await capture(ipad, info, 'interactive-ipad-narrow-folded')
  await radio(ipad, 'Approved').tap()
  await view_shown(ipad, '2')
  await soon(ipad.setViewportSize(ipad_portrait))
}

async function transitions({ ipad, stage, bound, cli, root, session }: Linked) {
  await print_fit(ipad, 'axis')
  await radio(ipad, 'Times out').tap()
  await view_shown(ipad, '2 timeout/first/off')

  // A new revision of the same drawing opens at rest.
  const snap = bound('snapshot', '--out', path.join(root, 'gateway-3'))
  scene_edit(snap.scene_path, (scene) => {

    // The board's snapshot carries the controls (`scene_controls`); the CLI scene file does
    // not write them yet (src/cli/canvas_commands.ts, outside this change). Supply them only
    // when absent, so the edit stays the agent's: same controls, a shorter hold.
    scene.controls ??= gateway_controls()
    scene.summary = 'The same gateway, with the hold made shorter.'
    const hold = (scene.elements as Json[]).find((element) => element.id === 'hold')!
    hold.text = 'Hold the order for 5 min'
  })
  expect(bound('publish', '--file', snap.scene_path)).toMatchObject({ revision: 3 })
  await expect_revision(ipad, 3)
  await view_shown(ipad, '3')
  await expect(radio(ipad, 'Approved')).toHaveAttribute('aria-checked', 'true')

  // The revision before is shown at rest, with no switch. Back on the current one, the
  // switch returns with the view chosen of it. Looking back doesn't change that choice.
  await radio(ipad, 'Declined').tap()
  await expect(radio(ipad, 'Declined')).toHaveAttribute('aria-checked', 'true')
  await board_menu(ipad, 'Show revision 2')
  await view_shown(ipad, '2')
  await expect(ipad.getByRole('radio')).toHaveCount(0)
  await board_menu(ipad, 'Back to revision 3')
  await view_shown(ipad, '3 declined/first/off')
  await expect(radio(ipad, 'Declined')).toHaveAttribute('aria-checked', 'true')

  // A restore is a new revision, and opens at rest too.
  await radio(ipad, 'Times out').tap()
  await view_shown(ipad, '3 timeout/first/off')
  expect(
    cli('cleanup-restore', '--session', session, '--base-revision', '3', '--revision', '2'),
  ).toMatchObject({ status: 'success' })
  await expect_revision(ipad, 4)
  await view_shown(ipad, '4')
  await expect(radio(ipad, 'Approved')).toHaveAttribute('aria-checked', 'true')
  await view_shown(stage, '4')
}

// Read the shown axis and its box in the same layout. A redraw may briefly have no axis;
// a duplicate axis or a browser error must not be reported as an unsettled camera.
async function axis_box(page: Page): Promise<string | null> {
  const selector = '.print__shape[data-state="shown"][data-print-shape="shape:scene-axis"]'
  return soon(
    page.evaluate((selector) => {
      const axes = document.querySelectorAll(selector)

      if (axes.length > 1) throw Error('Only one shown axis should supply the camera reading.')

      const box = axes[0]?.getBoundingClientRect()

      if (!box || box.width <= 0 || box.height <= 0) return null

      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value)).join(' ')
    }, selector),
  )
}

// Compare actual screen geometry, not an editor camera record. Include both samples in a
// failure so a camera which keeps moving is distinguishable from a print which disappears.
async function camera_of(page: Page): Promise<string> {
  let last = ''
  await expect
    .poll(async () => {
      const previous = last
      last = (await axis_box(page)) ?? ''

      if (last === '') return 'No shown axis with a rendered box.'

      return last === previous ? 'settled' : `${previous} -> ${last}`
    })
    .toBe('settled')
  return last
}

// What the page showed when a step failed: its errors, and the print and switch as drawn.
async function page_state(page: Page, errors: string[]): Promise<string> {
  const drawn = await soon(
    page.evaluate(() => {
      const region = document.querySelector('[aria-label="Agent print"]')
      return {
        view: region?.getAttribute('data-view') ?? null,
        busy: region?.getAttribute('aria-busy') ?? null,
        showing: region?.getAttribute('data-showing') ?? null,
        shapes_count: document.querySelectorAll('.print__shape').length,
        switches_count: document.querySelectorAll('.switch:not(.switch--measure)').length,
        canvas_count: document.querySelectorAll('.surface .tl-canvas').length,
      }
    }),
  ).catch((error: unknown) => String(error))
  return JSON.stringify({ drawn, errors: errors.slice(-8) })
}

async function beside_chat({ ipad }: Linked, errors: string[], info: TestInfo) {
  try {
    await chat_beside(ipad, info)
  } catch (error) {
    const state = await page_state(ipad, errors)
    await soon(capture(ipad, info, 'interactive-ipad-chat-failed')).catch(() => null)
    throw new Error(`${String(error)}\nThe iPad page: ${state}`, { cause: error })
  }
}

async function chat_beside(ipad: Page, info: TestInfo) {
  await soon(ipad.setViewportSize({ width: 1180, height: 820 }))
  await board_menu(ipad, 'Fit agent drawing')
  const camera = await camera_of(ipad)
  await chat_open(ipad)
  await switch_inside_canvas(ipad)
  expect(await camera_of(ipad)).toBe(camera)

  const edge = ipad.getByRole('separator', { name: 'Chat width' })

  for (const [key, width] of [
    ['Home', '320'],
    ['End', '720'],
  ] as const) {
    await edge.press(key)
    await expect(edge).toHaveAttribute('aria-valuenow', width)
    await switch_inside_canvas(ipad)
    expect(await camera_of(ipad)).toBe(camera)
  }

  await capture(ipad, info, 'interactive-ipad-chat-wide')
  await sketch_open(ipad)
  await soon(ipad.setViewportSize(ipad_portrait))
}

// Only the form shown exists. Both inline and folded controls must fit the actual canvas.
async function switch_inside_canvas(ipad: Page) {
  const forms = switch_frame(ipad)
  await expect(forms.first()).toBeVisible()
  await expect
    .poll(async () => {
      const canvas = (await surface(ipad).boundingBox())!
      return forms.evaluateAll((frames, box) => {
        return (
          frames.length > 0 &&
          frames.every((frame) => {
            const bounds = frame.getBoundingClientRect()
            return bounds.left >= box.x - 1 && bounds.right <= box.x + box.width + 1
          })
        )
      }, canvas)
    })
    .toBe(true)
}

async function rest_state({ ipad, stage }: Linked, info: TestInfo) {
  await print_fit(ipad, 'axis')
  await expect(radio(ipad, 'Approved')).toHaveAttribute('aria-checked', 'true')
  await view_shown(ipad, '4')
  await capture(ipad, info, 'interactive-ipad-final-rest')
  await capture(stage, info, 'interactive-mac-stage-rest')
}
