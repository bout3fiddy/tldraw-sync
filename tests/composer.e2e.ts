// The iPad's note and its bell, in a real browser against a real, disposable linked board.
//
// - The note is hidden until asked for. Asked for, it is a modal dialog: a slip of paper in
//   the middle of the screen's width, a little above the middle of what can be seen of its
//   height, over a board that is neither dimmed nor resized. Opening it gives the field no
//   focus, so a bare send needs no keyboard. A finger tap on the field starts typing, and
//   typing keeps the focus through the keyboard's arrival and a rotation.
// - A press beside the note puts it away and draws nothing; so does Escape, wherever the
//   focus is. The focus goes back to the note button, and the words, the caret and a request
//   still on its way are kept.
// - The note is exactly as tall as its words: one line when empty, up to five, then it
//   scrolls. The regression this guards is a note that stayed a paragraph tall after its text
//   was deleted.
// - The note button and the bell are fixed to the drawing tools wherever the strip is and do
//   not move when the note opens. Replace has the head of the Agent canvas to itself: it
//   lies over no diagram, no band lies under the views, and the sketch is no smaller for it.
// - The sketch is tldraw's canvas as it comes, and the pen draws to the bottom of the screen.
//   tldraw's own link is uncovered and opens when it is pressed on purpose with the pen. A
//   finger tap is compared with the same tap on tldraw's canvas on the stage.
// - Each request is one row under the bell, changed in place from the Mac's receipt to the
//   agent's last word. Nothing opens by itself and the note shows no words about it.
// - A draft, the Interpret switch and the rows belong to one board.
//
// Two disposable boards serve the journeys, to keep the browser gate short. The first journey
// runs in phases that each start from the same settled screen and are judged separately, so
// one run reports every phase that is wrong. Every wait is bounded, down to a bare key or
// touch, and a failure is printed where it happens, with its lines in this file: a check cut
// short from outside has already said what was wrong.
//
// While the note is open the page behind it is inert. What lies behind is then read from the
// page itself, by attribute and by place, and is never asked for by role or pressed through a
// locator. With the note shut the same controls are found by role, as a person finds them.
//
// What is painted is judged from decoded screenshot pixels, not from styles alone.
//
// Chromium on a desktop has no palm and no software keyboard. A tap here is a real touch on
// the screen and the focus it gives is the browser's own, but whether an iPad then shows its
// keyboard is not something this can show. What the keyboard does to the screen is driven
// through the visualViewport contract.
//
// Run: bun run build && npx playwright test tests/composer.e2e.ts

import {
  errors,
  expect as expect_patient,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test'
import { ink_in, inset, pixels_read, type Box, type Pixels } from './screen_pixels'
import {
  action_ms,
  bell,
  board_linked,
  chat,
  dock_problems,
  inbox,
  interpret,
  ipad_landscape,
  ipad_narrow,
  ipad_portrait,
  layout as layout_read,
  marks as marks_read,
  navigation_ms,
  note,
  notify,
  rows,
  rows_about,
  stroke as stroke_pen,
  type DockSide,
  type Layout,
  type Linked,
  type Mark,
  type Phase,
  type Rect,
} from './whiteboard_board'

// Pairing material belongs neither in traces nor in screenshots: every capture here is taken
// after the paired page has removed the QR fragment from its address.
test.use({ trace: 'off', actionTimeout: action_ms, navigationTimeout: navigation_ms })

// What the page does by itself it does at once, and five seconds is a slow machine. An answer
// from the Mac comes with the page's next look at it, a second and a half apart.
const assertion_ms = 5_000
const mac_ms = 10_000

// One phase, and all of them. With pairing before them and the last phase running over, the
// journey still ends, and stops its board, inside the three minutes a test is given.
const phase_ms = 25_000
const journey_ms = 120_000
const step_ms = 30_000
const step_long_ms = 60_000

// Every assertion in this file waits five seconds at most, unless it names a longer wait.
const expect = expect_patient.configure({ timeout: assertion_ms })

// Playwright times what is done to a locator and what is expected of one. It does not time a
// bare key, a touch, a pointer move or a script in the page: with no answer from the browser
// those wait for as long as the test lasts. Each is given a few seconds here, and the error
// is made at the call, so that it names the line that got no answer.
function soon<T>(work: Promise<T>, wait_ms = action_ms): Promise<T> {
  const late = new Error(`No answer from the browser within ${wait_ms}ms.`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const overdue = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late), wait_ms)
  })
  return Promise.race([work, overdue]).finally(() => clearTimeout(timer))
}

type Point = { x: number; y: number }

const layout = (page: Page) => soon(layout_read(page))
const marks = (page: Page) => soon(marks_read(page))
const stroke = (page: Page, from: Point, by: Point) => soon(stroke_pen(page, from, by))
const press = (page: Page, key: string) => soon(page.keyboard.press(key))
const write = (page: Page, text: string) => soon(page.keyboard.type(text))
const insert = (page: Page, text: string) => soon(page.keyboard.insertText(text))
const touch = (page: Page, at: Point) => soon(page.touchscreen.tap(at.x, at.y))
const resize = (page: Page, size: { width: number; height: number }) =>
  soon(page.setViewportSize(size))

const said_lines_max = 6
const said_length_max = 600
const said_frames_max = 4

// What a failure says where it happens: its first lines, without colour and with any address
// or pairing code taken out, and then the lines of this file it came through.
function brief(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const said = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>')
    .replace(/pair=[^\s&"']+/gi, 'pair=<code>')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, said_lines_max)
    .join(' | ')
    .slice(0, said_length_max)
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const lines = [...stack.matchAll(/composer\.e2e\.ts:(\d+)/g)].map((match) => match[1])
  const from = [...new Set(lines)].slice(0, said_frames_max).join(' < ')
  return from === '' ? said : `${said} (composer.e2e.ts:${from})`
}

// One named, time-boxed step. Its name is printed as it starts and its failure as it fails,
// so that a check cut short from outside still shows where it was and what was wrong.
async function step<T>(name: string, body: () => Promise<T>, timeout_ms = step_ms): Promise<T> {
  console.log(`  step: ${name}`)

  try {
    return await test.step(name, body, { timeout: timeout_ms })
  } catch (error) {
    console.log(`  failed: ${name}: ${brief(error)}`)
    throw error
  }
}

const timed_out = (error: unknown) =>
  error instanceof errors.TimeoutError && error.message.startsWith('Step timeout')

const state_wait_ms = 2_000

// The few facts that tell one failure from another, read off the page as a phase fails: no
// words of a note or a board, and no address.
function state_of(page: Page): Promise<string> {
  const read = page.evaluate(() => {
    const sheet = document.querySelector<HTMLDialogElement>('dialog.notepad')
    const active = document.activeElement
    const kind = active?.getAttribute('class')?.split(' ')[0]
    const focus = active ? `${active.tagName.toLowerCase()}${kind ? `.${kind}` : ''}` : 'nothing'
    return [
      `note ${sheet?.open ? 'open' : 'shut'}${sheet?.matches(':modal') ? ' and modal' : ''}`,
      `its button says ${document.querySelector('.dock__button')?.getAttribute('aria-expanded')}`,
      `list ${document.querySelector('.inbox') ? 'open' : 'shut'}`,
      `focus on ${focus}`,
      `view ${document.querySelector('.views')?.getAttribute('data-view')}`,
      `window ${innerWidth}x${innerHeight}`,
    ].join('; ')
  })
  return soon(read, state_wait_ms).catch((error) => `not read (${brief(error)})`)
}

// The phases of one journey on one page. Each starts from the same settled screen and is
// judged by itself: a failure is printed at once, with the state the page was left in, and
// the next phase still runs, so one run shows everything that is wrong. The journey then
// fails with the first failure.
//
// Two things stop it short, and both are failures: a phase that ran out of time, whose
// abandoned steps may still be using the page, and a journey that has spent its own time.
// The phases left are then named as not run.
async function phases(page: Page, list: readonly Phase[]) {
  const failed: { name: string; error: unknown }[] = []
  const deadline_ms = Date.now() + journey_ms
  let stopped = ''

  for (const [name, run] of list) {
    if (stopped === '' && Date.now() > deadline_ms) stopped = `the journey spent ${journey_ms}ms`

    if (stopped !== '') {
      const error = Error(`Not run: ${stopped}.`)
      failed.push({ name, error })
      console.log(`  failed: ${name}: ${error.message}`)
      continue
    }

    try {
      await step(
        name,
        async () => {
          await settle(page)
          await run()
        },
        phase_ms,
      )
    } catch (error) {
      failed.push({ name, error })
      console.log(`  state: ${await state_of(page)}`)

      if (timed_out(error)) stopped = `"${name}" ran out of time`
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

// While the note is open the page behind it is inert: no press reaches it, and it is out of
// the accessibility tree, where a role would look for it. What its two buttons and its list
// say is then read from the page itself. `chat` and `bell`, which find them by role, are for
// when the note is shut.
const chat_behind = (page: Page) => page.locator('.dock__button[aria-controls="agent-composer"]')
const bell_behind = (page: Page) => page.locator('.dock__button[aria-controls="agent-inbox"]')
const inbox_behind = (page: Page) => page.locator('.inbox')

// The note is closed until asked for. Opening it is a tap on the button by the tools, which
// is found by role: it can be, with the note shut.
async function note_open(page: Page) {
  const state = chat_behind(page)
  await expect(state).toBeVisible()

  if ((await state.getAttribute('aria-expanded')) !== 'true') await chat(page).tap()

  await expect(state).toHaveAttribute('aria-expanded', 'true')
  await expect(note(page)).toBeVisible()
}

// The note is put away with Escape, which is heard wherever the focus is. While the note is
// open nothing else on the page can be pressed, so every step outside it starts here.
async function note_close(page: Page) {
  const state = chat_behind(page)

  if ((await state.getAttribute('aria-expanded')) === 'true') await press(page, 'Escape')

  await expect(state).toHaveAttribute('aria-expanded', 'false')
  await expect(note(page)).toBeHidden()
}

// The list never opens by itself, and a press anywhere else closes it: open it to look. The
// bell can be pressed only with the note shut.
async function inbox_open(page: Page) {
  const trigger = bell(page)

  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.tap()

  await expect(inbox(page)).toBeVisible()
}

async function inbox_close(page: Page) {
  const trigger = bell(page)

  if ((await trigger.getAttribute('aria-expanded')) === 'true') await trigger.tap()

  await expect(inbox(page)).toBeHidden()
}

// The one row that says `text`, with the list opened to read it. The row is the Mac's news.
async function row_with(page: Page, text: string | RegExp): Promise<Locator> {
  await inbox_open(page)
  const row = rows(page).filter({ hasText: text })
  await expect(row).toHaveCount(1, { timeout: mac_ms })
  return row
}

// The two buttons are fixed to the strip on the side asked, whole, uncovered and reachable:
// asked only with the note shut, when a press can reach them. Polled: a new window size is
// laid out a frame or two after it is asked for.
async function expect_dock(page: Page, side: DockSide) {
  await expect.poll(async () => dock_problems(await layout(page), side)).toEqual([])
}

const lines_count_max = 5
const keyboard_px = 245

// How far the keyboard's arrival scrolls what can be seen, in the cases that try it.
const scrolled_px = 40

// The note's middle, as a share of the height that can be seen, and its greatest width.
const note_middle = 0.42
const note_width_px_max = 544
const edge_px = 16

// The margin the sketch used to end above, where no pen could draw.
const margin_px_was = 64
const sentence =
  'Arrows out of the API box are writes; the dashed ones are reads that may be stale.'

// Light is luminance from 0 to 255. Ink (#1d1d1d) is 29, the blotter of the margin the
// sketch used to have (#ecede9) is 236, the vellum of the sketch (#f6f7f4) is 246, and the
// paper of the note (#fff) is 255.
const ink_light_max = 80
const glyph_light_max = 170

// A hairline of pencil lead on paper is mostly anti-aliasing: any pixel clearly under paper.
const quiet_light_max = 205
const blotter_light = 236
const paper_light = 255
const tone_tolerance = 8

// A wide window just past tldraw's own switch between the two forms of its notice.
const ipad_between = { width: 706, height: 1000 }

// A screenshot kept with the results, for a person to look at.
async function shot(page: Page, info: TestInfo, name: string) {
  const options = { scale: 'css', animations: 'disabled', timeout: action_ms } as const
  await info.attach(name, { body: await page.screenshot(options), contentType: 'image/png' })
}

// The same, and its pixels, where the journey itself judges what was painted.
async function shot_pixels(page: Page, info: TestInfo, name: string): Promise<Pixels> {
  const pixels = await pixels_read(page, action_ms)
  await info.attach(name, { body: pixels.png, contentType: 'image/png' })
  return pixels
}

const rect_of = async (locator: Locator): Promise<Rect> => {
  const box = (await locator.boundingBox())!
  return {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  }
}

// The lines the field shows, from its rendered height. Fractions mean a wrong height.
function lines_rendered(field: Locator): Promise<number> {
  return field.evaluate((element) => {
    const style = getComputedStyle(element)
    const padding_px = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    return (element.getBoundingClientRect().height - padding_px) / parseFloat(style.lineHeight)
  })
}

// The lines the text needs at the field's width, measured apart from the page's own sizing:
// a throwaway field of the same width and type, of no height, reports its content's height.
function lines_needed(field: Locator): Promise<number> {
  return field.evaluate((element: HTMLTextAreaElement) => {
    if (element.value === '') return 1

    const style = getComputedStyle(element)
    const probe = document.createElement('textarea')
    probe.rows = 1
    probe.value = element.value
    Object.assign(probe.style, {
      position: 'fixed',
      top: '0',
      left: '-9999px',
      boxSizing: 'border-box',
      width: `${element.getBoundingClientRect().width}px`,
      height: '0',
      minHeight: '0',
      maxHeight: 'none',
      padding: style.padding,
      border: '0',
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      overflow: 'hidden',
      resize: 'none',
    })
    document.body.append(probe)
    const padding_px = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const lines = Math.round((probe.scrollHeight - padding_px) / parseFloat(style.lineHeight))
    probe.remove()
    return lines
  })
}

// The field shows exactly the lines its text needs, up to the cap. Returns the lines needed.
// Both sides are read afresh on every try, so a late web font cannot leave one of them stale.
async function expect_fitted(field: Locator): Promise<number> {
  let needed = 0
  await expect
    .poll(async () => {
      needed = await lines_needed(field)
      return Math.abs((await lines_rendered(field)) - Math.min(lines_count_max, needed))
    })
    .toBeLessThan(0.05)
  return needed
}

// Where the note's two controls are, relative to its paper, and how big their glyphs are.
// Equal results before and after an edit mean the controls did not move or change size.
function controls_read(page: Page) {
  return page.evaluate(() => {
    const paper = document.querySelector('.composer')!.getBoundingClientRect()
    const round = (value: number) => Math.round(value * 100) / 100
    return ['.composer__interpret', '.composer__send'].map((selector) => {
      const target = document.querySelector(selector)!.getBoundingClientRect()
      const glyph = document.querySelector(`${selector} svg`)!.getBoundingClientRect()
      return {
        width: round(target.width),
        height: round(target.height),
        from_bottom: round(paper.bottom - target.bottom),
        from_right: round(paper.right - target.right),
        glyph_width: round(glyph.width),
        glyph_height: round(glyph.height),
      }
    })
  })
}

const controls = (page: Page) => soon(controls_read(page))

type Still = Awaited<ReturnType<typeof controls>>

// Two 44px targets on the paper's bottom line, each around a small square glyph.
async function expect_controls_fixed(page: Page): Promise<Still> {
  const still = await controls(page)

  for (const control of still) {
    expect(control).toMatchObject({ width: 44, height: 44, from_bottom: 3 })
    expect(control.glyph_width).toBe(control.glyph_height)
    expect(control.glyph_width).toBeLessThanOrEqual(20)
  }

  return still
}

// The same place on screen, to half a pixel.
function expect_unmoved(now: Rect | null, then: Rect | null) {
  expect(now).not.toBeNull()
  expect(then).not.toBeNull()
  expect(Math.abs(now!.left - then!.left)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(now!.top - then!.top)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(now!.width - then!.width)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(now!.height - then!.height)).toBeLessThanOrEqual(0.5)
}

// The keyboard as the page sees it: less of the screen can be seen, and what can be seen may
// have been scrolled down the page, as Safari does to bring a field into view.
async function keyboard_show(page: Page, shown: boolean, scrolled = 0) {
  const script = page.evaluate(
    ([inset_px, show, top_px]) => {
      const viewport = visualViewport!

      if (show) {
        const height = innerHeight - (inset_px as number)
        Object.defineProperty(viewport, 'height', { configurable: true, value: height })
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top_px })
      } else {
        Reflect.deleteProperty(viewport, 'height')
        Reflect.deleteProperty(viewport, 'offsetTop')
      }

      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
    },
    [keyboard_px, shown, scrolled] as const,
  )
  await soon(script)
}

// The part of an upright or turned screen the keyboard leaves in sight.
const in_sight = (screen: { width: number; height: number }, scrolled = 0): Box => ({
  left: 0,
  right: screen.width,
  top: scrolled,
  bottom: scrolled + screen.height - keyboard_px,
})

// One real finger tap at the middle of what `locator` shows: a touch on the screen, as a
// person's is. Nothing is focused, filled or clicked from script, and nothing is waited for:
// the tap lands on whatever is there, which with the note open may be the note's surround.
async function finger_tap(page: Page, locator: Locator) {
  const box = await locator.boundingBox()
  expect(box, 'what is to be tapped is on screen').not.toBeNull()
  await touch(page, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })
}

// A place on the upright sketch clear of the note, the tools, the list and tldraw's link.
const beside = (seen: Layout): Point => ({ x: seen.pane!.left + 240, y: seen.pane!.top + 160 })

// Everything wrong with where the note's paper is, in words. Its middle belongs in the middle
// of the width that can be seen and a little above the middle of the height that can be
// seen; `seen` is that part of the screen. Pure, so that it can be shown to catch a fault.
function note_problems(paper: Rect | null, seen: Box): string[] {
  if (paper === null) return ['the note is not shown']

  const problems: string[] = []
  const width = seen.right - seen.left
  const height = seen.bottom - seen.top
  const off_x = (paper.left + paper.right) / 2 - (seen.left + seen.right) / 2
  const off_y = (paper.top + paper.bottom) / 2 - (seen.top + height * note_middle)
  const wide = Math.min(note_width_px_max, width - 2 * edge_px)

  if (Math.abs(off_x) > 1) problems.push(`off the middle of the width by ${off_x}px`)

  if (Math.abs(off_y) > 1) problems.push(`off its place in the height by ${off_y}px`)

  if (Math.abs(paper.width - wide) > 1) problems.push(`${paper.width}px wide, not ${wide}px`)

  if (paper.top < seen.top || paper.bottom > seen.bottom) problems.push('not wholly in sight')

  return problems
}

// The note is where it belongs in `seen`, or in the whole screen when none is given. Polled:
// the page hears of a new window size a moment after it is asked for.
async function expect_note_placed(page: Page, seen?: Box) {
  await expect
    .poll(async () => {
      const now = await layout(page)
      return note_problems(now.band, seen ?? now.screen)
    })
    .toEqual([])
}

// tldraw's notice in every canvas on screen is whole, can be pressed, and has none of this
// app's chrome over it. Where it rests is tldraw's choice: on the sketch it lies over the
// drawing surface, as it does on tldraw's canvas as it comes.
async function expect_marks_untouched(page: Page, count: number): Promise<Mark[]> {
  const wrong = (mark: Mark) => !mark.own || mark.covered > 0 || mark.width <= 0 || mark.height <= 0

  // Polled: tldraw chooses the notice's form from a width it measures a moment after a resize.
  await expect
    .poll(async () => {
      const found = await marks(page)
      return { count: found.length, wrong: found.filter(wrong) }
    })
    .toEqual({ count, wrong: [] })
  return marks(page)
}

// Where every phase starts: upright, the sketch alone on screen, no keyboard, the list shut,
// the note open and empty.
async function settle(ipad: Page) {
  await keyboard_show(ipad, false)
  await expect(chat_behind(ipad)).toBeVisible()
  await note_close(ipad)
  await resize(ipad, ipad_portrait)
  const sketch = ipad.getByRole('tab', { name: 'Sketchboard' })

  if ((await sketch.getAttribute('aria-selected')) !== 'true') await sketch.tap()

  await inbox_close(ipad)
  await note_open(ipad)
  await note(ipad).fill('')
}

test('the note opens over the board and closes without a mark; the pen draws to the foot', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad } = board
    await phases(
      ipad,
      [
        ['the note starts hidden and opens over the board', () => opens_quietly(ipad, info)],
        ['a finger tap starts typing and keeps the focus', () => typed_by_touch(ipad, info)],
        ['a press beside the note puts it away and draws nothing', () => press_beside(board)],
        ['Escape closes the note wherever the focus is', () => escape_closes(ipad)],
        ['the buttons stay by the tools; Replace is on the canvas', () => by_the_tools(ipad, info)],
        ['the height follows typing, deleting and undo', () => height_follows_the_text(ipad, info)],
        ['the height follows cut and paste', () => height_follows_cut_and_paste(ipad, info)],
        ['the height follows the width', () => height_follows_the_width(ipad, info)],
        ['the keyboard moves only the note', () => keyboard_moves_only_the_note(ipad, info)],
        ['closing keeps the draft and the caret', () => closing_keeps_the_draft_and_caret(ipad)],
        ['Return adds a line and Command-Return sends', () => return_and_send(board)],
        ['the pen draws to the bottom of the screen', () => draws_to_the_bottom(board, info)],
        ['the link is untouched in every arrangement', () => link_in_every_arrangement(ipad, info)],
        ['a deliberate press opens the link', () => link_opens_when_pressed(board)],
      ],
    )
  })
})

// Hidden is where the note starts: no dialog, no field, no band under the views, and the
// whole screen for the sketch, down to its last row. Asking for it shows a modal dialog in
// the middle of the screen: one empty line and two 44px targets on its bottom line. Nothing
// behind it moves, is resized or is dimmed, and the field does not have the focus. Shut, the
// note button is found by role and can be pressed; open, no press reaches it or the bell.
async function opens_quietly(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const sheet = ipad.getByRole('dialog', { name: 'Agent note' })
  await ipad.reload()
  await expect(chat(ipad)).toBeVisible()
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
  await expect(chat(ipad)).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(chat(ipad)).toHaveAccessibleName('Agent note')
  const controlled = await chat(ipad).getAttribute('aria-controls')
  await expect(sheet).toBeHidden()
  await expect(field).toBeHidden()
  await expect(ipad.locator('footer')).toHaveCount(0)
  await expect_dock(ipad, 'above')
  const closed = await layout(ipad)
  expect(closed.band).toBeNull()
  expect(closed.pane!.bottom).toBeCloseTo(ipad_portrait.height, 0)
  expect(closed.sheet!.bottom).toBeCloseTo(ipad_portrait.height, 0)
  const closed_px = await shot_pixels(ipad, info, 'note-closed-portrait')
  foot_painted(closed_px, closed)

  // Closed, the button is an outline drawn on paper: a glyph, not a block of ink.
  const idle = ink_in(closed_px, closed.chat!, glyph_light_max)
  expect(idle.dark_count).toBeGreaterThan(30)
  expect(idle.dark_count).toBeLessThan(idle.pixels_count * 0.3)

  await chat(ipad).tap()
  await expect(sheet).toBeVisible()
  await expect(field).toBeVisible()
  expect(await sheet.evaluate((element) => element.matches(':modal'))).toBe(true)
  expect(await sheet.getAttribute('id')).toBe(controlled)
  await expect(chat_behind(ipad)).toHaveAttribute('aria-expanded', 'true')

  // The focus is the dialog's to hold, or nobody's: never the field's, which would raise the
  // keyboard, and never left behind on the page.
  await expect(field).not.toBeFocused()
  const focused = await soon(ipad.evaluate(() => document.activeElement?.tagName))
  expect(['DIALOG', 'BODY']).toContain(focused)
  expect(await expect_fitted(field)).toBe(1)
  await expect(notify(ipad)).toBeEnabled()
  const open = await layout(ipad)

  // The page behind is out of reach: a press where either button is lands on neither.
  expect(closed.reach).toEqual({ chat: true, bell: true })
  expect(open.reach).toEqual({ chat: false, bell: false })
  expect_unmoved(open.chat, closed.chat)
  expect_unmoved(open.bell, closed.bell)
  expect_unmoved(open.strip, closed.strip)
  expect(open.pane).toEqual(closed.pane)
  expect(open.sheet).toEqual(closed.sheet)
  await expect_note_placed(ipad)
  await expect_controls_fixed(ipad)

  // The paper is paper, not an inked box: no border and no edge of solid ink. Behind it
  // there is no scrim at all.
  const edge = await ipad.locator('.composer').evaluate((element) => {
    const style = getComputedStyle(element)
    const behind = getComputedStyle(element.parentElement!, '::backdrop').backgroundColor
    const { borderTopWidth: border, boxShadow: shadow, outlineStyle: outline } = style
    return { border, shadow, outline, behind }
  })
  expect(edge.border).toBe('0px')
  expect(edge.outline).toBe('none')
  expect(edge.shadow).not.toContain('rgb(29, 29, 29)')
  expect(edge.behind).toBe('rgba(0, 0, 0, 0)')
  const open_px = await shot_pixels(ipad, info, 'note-open-empty-portrait')
  await paper_painted(ipad, open_px, open)

  // A patch of the sketch well clear of the paper is painted exactly as it was before.
  const { left, top } = open.pane!
  const patch: Box = { left: left + 250, right: left + 450, top: top + 100, bottom: top + 260 }
  expect(ink_in(open_px, patch, glyph_light_max)).toEqual(ink_in(closed_px, patch, glyph_light_max))

  // Interpret on is a plate of solid ink the size of the send plate; off again, a glyph.
  await interpret(ipad).tap()
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
  const on_px = await shot_pixels(ipad, info, 'note-interpret-on-portrait')
  expect_plate(ink_in(on_px, await rect_of(interpret(ipad)), ink_light_max))
  await interpret(ipad).tap()
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'false')
}

// The foot of the screen as it was painted: the sketch's own vellum, lighter than the band
// of blotter that used to lie there. The grid's dots only ever darken a pixel.
function foot_painted(pixels: Pixels, seen: Layout) {
  const pane = seen.pane!
  const foot: Box = {
    left: pane.left + 120,
    right: pane.left + 280,
    top: pane.bottom - 40,
    bottom: pane.bottom - 4,
  }
  expect(ink_in(pixels, foot, ink_light_max).light_max - blotter_light).toBeGreaterThan(5)
}

// A 32px plate of solid ink inside a 44px target.
function expect_plate(plate: ReturnType<typeof ink_in>) {
  expect(plate.dark_count).toBeGreaterThan(450)
  expect(plate.dark_width).toBeGreaterThanOrEqual(28)
  expect(plate.dark_width).toBeLessThanOrEqual(34)
  expect(plate.dark_height).toBeGreaterThanOrEqual(28)
  expect(plate.dark_height).toBeLessThanOrEqual(34)
}

// The open, empty note as it was painted: white paper with no dark edge anywhere inside its
// outline, a round plate of ink carrying a light arrow, a small quiet broom, and the button
// that opened it now in solid ink. Only the paper is judged: the sketch around it has a grid.
async function paper_painted(ipad: Page, pixels: Pixels, seen: Layout) {
  const paper = seen.band!
  const middle = (paper.top + paper.bottom) / 2
  const centre = (paper.left + paper.right) / 2
  const inside = ink_in(
    pixels,
    { left: paper.left + 8, right: paper.left + 14, top: middle - 3, bottom: middle + 3 },
    ink_light_max,
  )
  expect(paper_light - inside.light_min).toBeLessThan(tone_tolerance)
  expect(paper_light - inside.light_max).toBeLessThan(tone_tolerance)

  // Just inside the left end, the top edge and the bottom edge: nothing as dark as lead.
  const edges: Box[] = [
    { left: paper.left, right: paper.left + 6, top: middle - 1, bottom: middle + 1 },
    { left: centre - 1, right: centre + 1, top: paper.top, bottom: paper.top + 6 },
    { left: centre - 1, right: centre + 1, top: paper.bottom - 6, bottom: paper.bottom },
  ]

  for (const edge of edges) {
    expect(ink_in(pixels, edge, ink_light_max).light_min).toBeGreaterThan(150)
  }

  const send = await rect_of(notify(ipad))
  expect_plate(ink_in(pixels, send, ink_light_max))
  expect(ink_in(pixels, inset(send, 15), ink_light_max).light_max).toBeGreaterThan(150)

  const broom = ink_in(pixels, await rect_of(interpret(ipad)), quiet_light_max)
  expect(broom.dark_count).toBeGreaterThan(15)
  expect(broom.dark_width).toBeGreaterThanOrEqual(8)
  expect(broom.dark_width).toBeLessThanOrEqual(24)
  expect(broom.dark_height).toBeGreaterThanOrEqual(8)
  expect(broom.dark_height).toBeLessThanOrEqual(24)

  const pressed = ink_in(pixels, seen.chat!, ink_light_max)
  expect(pressed.dark_count).toBeGreaterThan(pressed.pixels_count * 0.6)
}

const field_events = ['touchstart', 'touchend', 'pointerdown', 'click'] as const
const field_events_max = 32

type FieldWatch = { seen: Event[]; focus_count: number; blur_count: number; stop: AbortController }

// Watches the field without touching it: what a touch on it raised, and every time it gained
// or lost the focus. The listeners are passive, keep a bounded list and are removed after.
async function field_watch(field: Locator) {
  await field.evaluate(
    (element, [types, max]) => {
      const watch: FieldWatch = {
        seen: [],
        focus_count: 0,
        blur_count: 0,
        stop: new AbortController(),
      }
      const signal = watch.stop.signal
      const keep = (event: Event) => {
        if (watch.seen.length < max && event.target === element) watch.seen.push(event)
      }

      for (const type of types) {
        addEventListener(type, keep, { capture: true, passive: true, signal })
      }

      element.addEventListener('focus', () => (watch.focus_count += 1), { signal })
      element.addEventListener('blur', () => (watch.blur_count += 1), { signal })
      Object.assign(element, { field_watch: watch })
    },
    [field_events, field_events_max] as const,
  )
}

// What the watch has seen so far. Whether an event was cancelled is read only now, after
// every listener on the page has had its say.
function field_watched(field: Locator, stop: boolean) {
  return field.evaluate((element, last) => {
    const watch = (element as unknown as { field_watch: FieldWatch }).field_watch

    if (last) watch.stop.abort()

    return {
      focus_count: watch.focus_count,
      blur_count: watch.blur_count,
      events: watch.seen.map((event) => ({
        type: event.type,
        trusted: event.isTrusted,
        cancelled: event.defaultPrevented,
      })),
    }
  }, stop)
}

// The report this guards against: the note was open and the keyboard never came. Opened, the
// field has no focus, so the tap is all that can give it. A real finger tap on the field
// reaches the field, is cancelled by nobody, and focuses it; real keys then type into it; and
// the field keeps that one focus while the keyboard arrives, scrolls the screen, and the
// iPad is turned. No letter typed is taken for a canvas shortcut.
async function typed_by_touch(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const pen = ipad.getByRole('button', { name: 'Pen', exact: true })
  const words = 'Check the retry arrow'
  await note_close(ipad)
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
  await chat(ipad).tap()
  await expect(field).toBeVisible()
  await expect(field).not.toBeFocused()
  await field_watch(field)

  await finger_tap(ipad, field)
  await expect(field).toBeFocused()
  await write(ipad, words)
  await expect(field).toHaveValue(words)
  await expect(field).toBeFocused()

  // The button behind the note says a draft is waiting. Its name is asked for further down,
  // with the note shut; here it is read off the page.
  await expect(chat_behind(ipad)).toHaveAttribute('aria-label', 'Agent note, draft saved')

  // The keyboard arrives and Safari scrolls what can be seen: the note follows, still typing.
  await keyboard_show(ipad, true, scrolled_px)
  await expect_note_placed(ipad, in_sight(ipad_portrait, scrolled_px))
  await expect(field).toBeFocused()
  await write(ipad, ' twice')

  // Turned on its side with the keyboard up.
  await resize(ipad, ipad_landscape)
  await keyboard_show(ipad, true)
  await expect_note_placed(ipad, in_sight(ipad_landscape))
  await expect(field).toBeFocused()
  await write(ipad, '.')
  await expect(field).toHaveValue(`${words} twice.`)
  await shot(ipad, info, 'note-typed-by-touch-landscape')

  // One focus, from the tap, and never lost. The touch was the browser's own, and whole.
  const watched = await field_watched(field, true)
  expect(watched.focus_count).toBe(1)
  expect(watched.blur_count).toBe(0)

  for (const type of field_events) {
    const raised = watched.events.filter((event) => event.type === type)
    expect(raised.length, `a ${type} on the field`).toBeGreaterThanOrEqual(1)
    expect(raised.every((event) => event.trusted && !event.cancelled)).toBe(true)
  }

  await keyboard_show(ipad, false)
  await resize(ipad, ipad_portrait)

  // Put away with its words, the note leaves a button that says a draft is waiting, and a
  // pen that is still the pen: both asked for by role, now that they can be.
  await note_close(ipad)
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await expect(pen).toHaveAttribute('aria-pressed', 'true')

  // Cleared by the keys too, in a field entered by a tap: no draft is waiting any more.
  await chat(ipad).tap()
  await expect(field).toHaveValue(`${words} twice.`)
  await finger_tap(ipad, field)
  await expect(field).toBeFocused()
  await press(ipad, 'ControlOrMeta+A')
  await press(ipad, 'Backspace')
  await expect(field).toHaveValue('')
  await expect(chat_behind(ipad)).toHaveAttribute('aria-label', 'Agent note')
  await note_close(ipad)
  await expect(chat(ipad)).toHaveAccessibleName('Agent note')
}

const sketch_ids = (ipad: Page) =>
  ipad
    .locator('.views__pane--sketch .tl-shape[data-shape-type="draw"]')
    .evaluateAll((shapes) => shapes.map((shape) => shape.getAttribute('data-shape-id')))

// While the note is open, a press anywhere beside it puts it away and does nothing else: a
// finger tap, a pen tap and a whole pen stroke on the sketch draw nothing; a tap where the
// note button is does not open it again; a tap where the bell is opens no list; a tap where
// tldraw's link is opens no window. Each time the note button has the focus afterwards. A
// press that began in the note and ended beside it is the note's own. Then, with the note
// shut, one stroke at the same place is drawn: one stroke in all.
async function press_beside({ ipad, cli, session }: Linked) {
  const field = note(ipad)
  const count = () => cli('status', '--session', session).shapes_count as number
  const clear = beside(await layout(ipad))
  const before = count()
  const known = await sketch_ids(ipad)

  // The note button is tapped by role to open the note, and found by role once it is shut.
  // With the note open the two buttons are only places on the screen to put a finger.
  const reopen = async () => {
    await chat(ipad).tap()
    await expect(field).toBeVisible()
  }
  const expect_put_away = async () => {
    await expect(field).toBeHidden()
    await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
    await expect(chat(ipad)).toBeFocused()
    await expect(inbox(ipad)).toBeHidden()
  }
  await touch(ipad, clear)
  await expect_put_away()

  await reopen()
  await stroke(ipad, clear, { x: 0, y: 0 })
  await expect_put_away()

  await reopen()
  await stroke(ipad, clear, { x: 20, y: 15 })
  await expect_put_away()

  await reopen()
  await finger_tap(ipad, chat_behind(ipad))
  await expect_put_away()

  await reopen()
  await finger_tap(ipad, bell_behind(ipad))
  await expect_put_away()

  // tldraw's page is answered here should a window open after all. Whether one did is
  // judged at the end, when it has had the rest of this phase to appear.
  await answered_here(ipad.context())
  await reopen()
  await finger_tap(ipad, link_of(ipad))
  await expect_put_away()

  // A selection dragged out of the field, past the paper's edge, closes nothing.
  await reopen()
  const inside = (await field.boundingBox())!
  await soon(ipad.mouse.move(inside.x + 20, inside.y + inside.height / 2))
  await soon(ipad.mouse.down())
  await soon(ipad.mouse.move(clear.x, clear.y, { steps: 4 }))
  await soon(ipad.mouse.up())
  await expect(field).toBeVisible()
  await expect(chat_behind(ipad)).toHaveAttribute('aria-expanded', 'true')
  await note_close(ipad)

  // Nothing above was taken for a stroke, here or on the Mac. The control: with the note
  // shut, the same stroke at the same place is drawn.
  expect(await sketch_ids(ipad)).toEqual(known)
  expect(count()).toBe(before)
  await stroke(ipad, clear, { x: 20, y: 15 })
  await expect.poll(count, { timeout: mac_ms }).toBe(before + 1)
  await expect.poll(async () => (await sketch_ids(ipad)).length).toBe(known.length + 1)
  const windows = ipad.context().pages().filter((page) => page !== ipad)

  for (const page of windows) await page.close()

  expect(windows, 'no window was opened by a press beside the note').toHaveLength(0)
}

// Escape closes the note with the focus in the field, on the paper where opening left it,
// and nowhere at all, as on an iPad. Each time the note button takes the focus, and the pen
// stays the pen, because tldraw is told the key was not for it. One thing is open at a time:
// Escape closes the list when the list is open, and asking for the note shuts the list.
async function escape_closes(ipad: Page) {
  const field = note(ipad)
  const pen = ipad.getByRole('button', { name: 'Pen', exact: true })
  const frame = ipad.locator('.views__pane--sketch .tl-container')
  const reopen = async () => {
    await chat(ipad).tap()
    await expect(field).toBeVisible()
    await expect(field).not.toBeFocused()
  }
  const expect_closed = async () => {
    await expect(field).toBeHidden()
    await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
    await expect(chat(ipad)).toBeFocused()
    await expect(pen).toHaveAttribute('aria-pressed', 'true')
  }

  // In the field, by a finger tap. The pen is asked after with the note shut.
  await note_close(ipad)
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
  await reopen()
  await finger_tap(ipad, field)
  await expect(field).toBeFocused()
  await press(ipad, 'Escape')
  await expect_closed()

  await reopen()
  await press(ipad, 'Escape')
  await expect_closed()

  await reopen()
  await soon(ipad.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()))
  expect(await soon(ipad.evaluate(() => document.activeElement === document.body))).toBe(true)
  await press(ipad, 'Escape')
  await expect_closed()

  // The list alone: Escape closes it, with its focus back on the bell.
  await inbox_open(ipad)
  await press(ipad, 'Escape')
  await expect(inbox(ipad)).toBeHidden()
  await expect(bell(ipad)).toBeFocused()
  await expect(pen).toHaveAttribute('aria-pressed', 'true')

  // Asking for the note shuts the list, and the next Escape is the note's. The list is behind
  // the note by then, so that it is gone is read off the page.
  await inbox_open(ipad)
  await reopen()
  await expect(inbox_behind(ipad)).toHaveCount(0)
  await press(ipad, 'Escape')
  await expect_closed()
  await expect(inbox(ipad)).toBeHidden()

  // Control. With nothing of the agent's open the key on the canvas is tldraw's again, and
  // tldraw puts the pen down: what the checks above would have seen had it heard the key.
  await frame.focus()
  await press(ipad, 'Escape')
  await expect(pen).toHaveAttribute('aria-pressed', 'false')
  await pen.tap()
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
}

const replace = (page: Page) => page.getByRole('button', { name: 'Replace sketchboard' })

// Where Replace and the things about it are on screen, read in one go so that they belong to
// one frame. A piece that is not shown is null. `others` is everything Replace must keep
// clear of; `pressed` is whether a press at its middle lands on it.
type ReplaceSeen = {
  screen: Box
  views: Rect | null
  sketch: Rect | null
  pane: Rect | null
  head: Rect | null
  canvas: Rect | null
  button: Rect | null
  others: { name: string; box: Rect }[]
  pressed: boolean
}

function replace_seen(page: Page): Promise<ReplaceSeen> {
  const script = page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (element === null) return null

      const r = element.getBoundingClientRect()
      const shown = r.width > 0 && r.height > 0

      if (!shown || getComputedStyle(element).visibility !== 'visible') return null

      const { left, top, right, bottom, width, height } = r
      return { left, top, right, bottom, width, height }
    }
    const one = (selector: string) => rect(document.querySelector(selector))
    const named = {
      '.tabs': 'the tabs',
      '.dock': 'the two buttons',
      '.inbox': 'the list',
      '.rail-toggle': 'Boards',
      '.notice--floating': 'a notice',
      '.views__pane--cleaned .caption': 'the caption',
      '.views__pane--cleaned .tl-canvas': 'the diagram',
      '[data-testid^="tl-watermark"]': 'the link',
    }
    const others: { name: string; box: Rect }[] = []

    for (const [selector, name] of Object.entries(named)) {
      for (const element of document.querySelectorAll(selector)) {
        const box = rect(element)

        if (box !== null) others.push({ name, box })
      }
    }

    const button = document.querySelector('.cleaned__replace')
    const at = button?.getBoundingClientRect()
    const hit = at && document.elementFromPoint((at.left + at.right) / 2, (at.top + at.bottom) / 2)
    return {
      screen: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
      views: one('.views'),
      sketch: one('.views__pane--sketch'),
      pane: one('.views__pane--cleaned'),
      head: one('.agent-pane__head'),
      canvas: one('.agent-pane__canvas'),
      button: rect(button),
      others,
      pressed: !!button && !!hit && button.contains(hit),
    }
  })
  return soon(script)
}

const edge_tolerance_px = 0.5
const meets = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const holds = (outer: Box, inner: Box) =>
  inner.left >= outer.left - edge_tolerance_px &&
  inner.top >= outer.top - edge_tolerance_px &&
  inner.right <= outer.right + edge_tolerance_px &&
  inner.bottom <= outer.bottom + edge_tolerance_px

// Everything wrong with where Replace is, in words. It has the head of the Agent canvas: a
// whole 44px target in a strip at the top of that pane, pressable, with the canvas beginning
// under the strip and running to the pane's bottom. So Replace lies over no part of a
// diagram, which is fitted to within 24px of its canvas's edges. It is clear of the tabs,
// the two buttons, the list and tldraw's notice. The head's room comes from the Agent canvas
// alone: nothing lies under the views, and the sketch beside it is no smaller than it. Pure,
// so that it can be shown to catch a bad placing without a browser.
function replace_problems(seen: ReplaceSeen): string[] {
  const { views, sketch, pane, head, canvas, button } = seen

  if (!views || !pane || !head || !canvas || !button) {
    return ['Replace, its head, the Agent canvas or the views are missing']
  }

  const problems: string[] = []

  if (button.width < 44 || button.height < 44) problems.push('Replace is under 44px')

  if (!holds(head, button)) problems.push('Replace is not wholly in the head')

  if (!holds(pane, head)) problems.push('the head is not wholly in the Agent canvas pane')

  if (meets(button, canvas)) problems.push('Replace lies over the Agent canvas')

  if (canvas.top < head.bottom - edge_tolerance_px) problems.push('the head lies over the canvas')

  if (Math.abs(canvas.bottom - pane.bottom) > edge_tolerance_px) {
    problems.push('something lies under the Agent canvas')
  }

  for (const other of seen.others) {
    if (meets(button, other.box)) problems.push(`Replace meets ${other.name}`)
  }

  if (!seen.pressed) problems.push('a press on Replace lands on something else')

  if (Math.abs(views.bottom - seen.screen.bottom) > edge_tolerance_px) {
    problems.push('something lies under the views')
  }

  // Beside or above the Agent canvas, the sketch has its half: the rule between them is the
  // one pixel the Agent canvas may have over it.
  if (sketch !== null) {
    const stacked = pane.top >= sketch.bottom - 1
    const short_px = stacked ? pane.height - sketch.height : pane.width - sketch.width

    if (short_px > 1.5) problems.push(`the sketch is ${short_px}px smaller than the Agent canvas`)
  }

  return problems
}

// Polled: a new window size is laid out a frame or two after it is asked for.
async function expect_replace_in_head(page: Page) {
  await expect(replace(page)).toBeVisible()
  await expect.poll(async () => replace_problems(await replace_seen(page))).toEqual([])
}

// The note button and the bell are fixed to the strip, eight pixels off it, whole, uncovered
// and reachable, in every arrangement the draw page has; and they hold still while the note
// grows. With only the Agent canvas on screen there is no strip, and they wait in the band.
// Replace is offered at the head of the Agent canvas wherever that canvas is, and nowhere
// without it. Every button here is pressed and judged with the note shut.
async function by_the_tools(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const tab = (name: string) => ipad.getByRole('tab', { name })
  const at = await layout(ipad)
  await field.fill('1\n2\n3\n4\n5\n6')
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  const grown = await layout(ipad)
  expect_unmoved(grown.chat, at.chat)
  expect_unmoved(grown.bell, at.bell)
  expect_unmoved(grown.strip, at.strip)
  expect(grown.pane).toEqual(at.pane)
  await field.fill('')
  await note_close(ipad)
  await expect_dock(ipad, 'above')
  await expect(replace(ipad)).toHaveCount(0)

  // Stacked views on a linked board: the strip lies along the bottom of the sketch.
  await tab('Side by side').tap()
  await expect_dock(ipad, 'left')
  await expect_replace_in_head(ipad)
  await shot(ipad, info, 'buttons-stacked-portrait')
  await resize(ipad, ipad_narrow)
  await expect_dock(ipad, 'above')
  await expect_replace_in_head(ipad)
  await shot(ipad, info, 'buttons-stacked-narrow')
  await resize(ipad, ipad_portrait)
  await tab('Sketchboard').tap()

  // Too short for a column: beside the head of the strip.
  await resize(ipad, ipad_narrow)
  await expect_dock(ipad, 'right')
  await resize(ipad, ipad_landscape)
  await expect_dock(ipad, 'right')
  await shot(ipad, info, 'buttons-landscape')
  await tab('Side by side').tap()
  await expect_dock(ipad, 'right')
  await expect_replace_in_head(ipad)
  await shot(ipad, info, 'replace-side-by-side-landscape')

  // No sketch, no strip: the band, clear of the tabs and of the list of boards.
  await tab('Agent canvas').tap()
  await expect_dock(ipad, 'band')
  await expect_replace_in_head(ipad)
  await resize(ipad, ipad_portrait)
  await expect_dock(ipad, 'band')
  await expect_replace_in_head(ipad)
  await shot(ipad, info, 'buttons-agent-canvas-portrait')
  await resize(ipad, ipad_narrow)
  await expect_replace_in_head(ipad)
  await resize(ipad, ipad_portrait)
  await tab('Sketchboard').tap()
  await expect_dock(ipad, 'above')
  await expect(replace(ipad)).toHaveCount(0)
  await expect(ipad.locator('.agent-pane__head')).toHaveCount(0)
}

async function height_follows_the_text(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  const one_line_px = (await field.boundingBox())!.height

  // Wrapped, not broken: one sentence too long for the line.
  await field.fill(`${sentence} ${sentence}`)
  const wrapped = await expect_fitted(field)
  expect(wrapped).toBeGreaterThan(1)
  expect(wrapped).toBeLessThanOrEqual(lines_count_max)
  expect(await controls(ipad)).toEqual(still)
  await expect_note_placed(ipad)
  await shot(ipad, info, 'note-wrapped-portrait')

  // The regression: delete everything, and the note is one line again, to the pixel.
  await field.press('ControlOrMeta+A')
  await field.press('Backspace')
  await expect(field).toHaveValue('')
  expect(await expect_fitted(field)).toBe(1)
  expect((await field.boundingBox())!.height).toBeCloseTo(one_line_px, 1)
  expect(await controls(ipad)).toEqual(still)

  // Negative control. Hold the height at five lines, as a stored measurement would after the
  // text is gone, and the same check must see a note stuck tall. Let go, and it is one line.
  const stuck = await ipad.addStyleTag({ content: '.composer__mirror { min-height: 132px; }' })

  try {
    expect(await lines_rendered(field)).toBeGreaterThan(lines_count_max - 0.1)
  } finally {
    await stuck.evaluate((element) => (element as Element).remove())
  }

  expect(await expect_fitted(field)).toBe(1)

  // Past the cap in one insertion, after the one word already there: five lines, and the
  // rest scrolls. The field is entered by a finger tap, past the end of its word.
  await field.fill('Short')
  await finger_tap(ipad, field)
  await expect(field).toBeFocused()
  await insert(ipad, `\n${Array(6).fill(sentence).join(' ')}`)
  const long = await field.inputValue()
  expect(long.startsWith('Short\n')).toBe(true)
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await controls(ipad)).toEqual(still)
  await expect_note_placed(ipad)
  await shot(ipad, info, 'note-five-lines-portrait')

  // Undo takes the insertion back, and the height with it.
  await field.press('ControlOrMeta+Z')
  await expect(field).not.toHaveValue(long)
  expect(await expect_fitted(field)).toBeLessThanOrEqual(lines_count_max)
  expect(await controls(ipad)).toEqual(still)
  await field.fill('')
  expect(await expect_fitted(field)).toBe(1)
}

type Kinds = { note_kinds?: string[] }

// The browser's own cut and paste, as a person's Command-X and Command-V reach the field:
// the edits arrive as `deleteByCut` and `insertFromPaste`, not as typing. The words pasted
// are the words this journey cut a moment before. Headless Chromium keeps its clipboard
// inside the browser process, so the desk's own clipboard is neither read nor written. In a
// headed run the same edits are made by delete and insert instead, and that is recorded.
async function height_follows_cut_and_paste(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  const words = `${sentence} ${sentence}`
  const kept = info.project.use.headless !== false
  const cut = () => field.press(kept ? 'ControlOrMeta+X' : 'Delete')
  const paste = () => (kept ? field.press('ControlOrMeta+V') : insert(ipad, words))

  if (!kept) {
    const description = 'Headed run: delete and insert stand in for cut and paste.'
    info.annotations.push({ type: 'clipboard', description })
  }

  await field.evaluate((element) => {
    const seen: string[] = []
    ;(window as Kinds).note_kinds = seen
    element.addEventListener('input', (event) => seen.push((event as InputEvent).inputType))
  })
  await field.fill(words)
  const wrapped = await expect_fitted(field)
  expect(wrapped).toBeGreaterThan(1)

  // Cut everything: one line. Paste it back: the lines it had when it was typed.
  await field.press('ControlOrMeta+A')
  await cut()
  await expect(field).toHaveValue('')
  expect(await expect_fitted(field)).toBe(1)
  expect(await controls(ipad)).toEqual(still)
  await paste()
  await expect(field).toHaveValue(words)
  expect(await expect_fitted(field)).toBe(wrapped)

  // Pasted three times more, past the cap: five lines, and the rest scrolls.
  for (let pasted = 0; pasted < 3; pasted += 1) await paste()

  await expect(field).toHaveValue(words.repeat(4))
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await controls(ipad)).toEqual(still)
  await shot(ipad, info, 'note-pasted-past-five-lines')

  // Cut all but the first copy: fewer words, fewer lines. Undo: the words and lines return.
  await field.evaluate(
    (element: HTMLTextAreaElement, from) => element.setSelectionRange(from, element.value.length),
    words.length,
  )
  await cut()
  await expect(field).toHaveValue(words)
  expect(await expect_fitted(field)).toBe(wrapped)
  await field.press('ControlOrMeta+Z')
  await expect(field).toHaveValue(words.repeat(4))
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  expect(await controls(ipad)).toEqual(still)
  const kinds = await soon(ipad.evaluate(() => (window as Kinds).note_kinds ?? []))
  expect(kinds).toContain('historyUndo')

  if (kept) {
    expect(kinds).toContain('deleteByCut')
    expect(kinds).toContain('insertFromPaste')
  }

  await field.fill('')
  expect(await expect_fitted(field)).toBe(1)
}

// The same words need more lines in a narrow window and fewer in a wide one. Nothing is typed
// between the sizes: the height has to follow the width alone, and the note keeps its place
// in each window. In the narrow one the list, opened with the note shut, fits the screen.
async function height_follows_the_width(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  await field.fill(sentence)
  const wide = await expect_fitted(field)
  await resize(ipad, ipad_narrow)
  const narrow = await expect_fitted(field)
  expect(narrow).toBeGreaterThan(wide)
  expect(await controls(ipad)).toEqual(still)
  await expect_note_placed(ipad)
  await shot(ipad, info, 'note-narrow')

  await note_close(ipad)
  await expect_dock(ipad, 'right')
  await inbox_open(ipad)
  const seen = await layout(ipad)
  const sheet = seen.inbox!
  expect(sheet.left).toBeGreaterThanOrEqual(0)
  expect(sheet.right).toBeLessThanOrEqual(ipad_narrow.width)
  expect(sheet.bottom).toBeLessThanOrEqual(seen.pane!.bottom)
  await shot(ipad, info, 'list-narrow')
  await inbox_close(ipad)
  await note_open(ipad)
  await expect(field).toHaveValue(sentence)

  await resize(ipad, ipad_landscape)
  expect(await expect_fitted(field)).toBe(wide)
  expect(await controls(ipad)).toEqual(still)
  await expect_note_placed(ipad)
  await shot(ipad, info, 'note-landscape')
  await resize(ipad, ipad_portrait)
  expect(await expect_fitted(field)).toBe(wide)
  await expect_note_placed(ipad)
  await field.fill('')
}

// The keyboard covers the bottom of the screen. The note moves to its place in what is left
// in sight, scrolled or not; the sketch keeps its size, the tools and the two buttons keep
// their place, and the note keeps its lines. With the keyboard gone it is back where it was.
async function keyboard_moves_only_the_note(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  await field.fill('One\nTwo\nThree')
  expect(await expect_fitted(field)).toBe(3)
  await expect_note_placed(ipad)
  const before = await layout(ipad)
  await keyboard_show(ipad, true)
  await expect_note_placed(ipad, in_sight(ipad_portrait))
  const lifted = await layout(ipad)
  expect(lifted.band!.bottom).toBeLessThanOrEqual(ipad_portrait.height - keyboard_px)
  expect(lifted.band!.top).toBeLessThan(before.band!.top)
  expect(lifted.pane).toEqual(before.pane)
  expect(lifted.sheet).toEqual(before.sheet)
  expect(lifted.strip).toEqual(before.strip)
  expect(lifted.chat).toEqual(before.chat)
  expect(await expect_fitted(field)).toBe(3)
  expect(await controls(ipad)).toEqual(still)
  await shot(ipad, info, 'note-above-keyboard')

  await keyboard_show(ipad, true, scrolled_px)
  await expect_note_placed(ipad, in_sight(ipad_portrait, scrolled_px))
  expect((await layout(ipad)).pane).toEqual(before.pane)

  await keyboard_show(ipad, false)
  await expect_note_placed(ipad)
  const after = await layout(ipad)
  expect(after.pane).toEqual(before.pane)
  expect(after.band).toEqual(before.band)
}

// Escape and a tap beside the note both close it. Either way the words, the selection and
// the height are there on reopening, the button says a draft is waiting, and the field does
// not have the focus. Typing then lands where the caret was left.
async function closing_keeps_the_draft_and_caret(ipad: Page) {
  const field = note(ipad)
  const draft = 'alpha\nbeta\ngamma'
  const caret = () =>
    field.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])
  const select = () =>
    field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 4))
  await field.fill(draft)
  await finger_tap(ipad, field)
  await expect(field).toBeFocused()
  await select()
  await press(ipad, 'Escape')
  await expect(field).toBeHidden()
  await expect(ipad.locator('.notepad')).toBeHidden()
  await expect(chat(ipad)).toBeFocused()
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')

  await chat(ipad).tap()
  await expect(field).toBeVisible()
  await expect(field).not.toBeFocused()
  await expect(field).toHaveValue(draft)
  expect(await caret()).toEqual([2, 4])
  expect(await expect_fitted(field)).toBe(3)

  // Closed by a tap beside it while typing: the field gives up the focus, and so the keyboard.
  await finger_tap(ipad, field)
  await expect(field).toBeFocused()
  await select()
  await touch(ipad, beside(await layout(ipad)))
  await expect(field).toBeHidden()
  await expect(chat(ipad)).toBeFocused()
  expect(await soon(ipad.evaluate(() => document.activeElement?.tagName))).not.toBe('TEXTAREA')
  await chat(ipad).tap()
  await expect(field).toBeVisible()
  await expect(field).toHaveValue(draft)
  expect(await caret()).toEqual([2, 4])

  // The field is one Tab from where opening leaves the focus, and typing lands where the
  // caret was left.
  await press(ipad, 'Tab')
  await expect(field).toBeFocused()
  await write(ipad, 'X')
  await expect(field).toHaveValue('alXa\nbeta\ngamma')
  await field.fill('')
}

// Return adds a line. Command-Return sends, once, and the sent note leaves one line behind.
async function return_and_send({ ipad, bound }: Linked) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  const waiting = bound('poll').events.length
  await field.fill('Line one')
  await field.press('Enter')
  await expect(field).toHaveValue('Line one\n')
  await expect.poll(() => lines_rendered(field)).toBeCloseTo(2, 1)
  await field.press('Meta+Enter')
  await expect(field).toHaveValue('', { timeout: mac_ms })
  expect(await expect_fitted(field)).toBe(1)
  expect(await controls(ipad)).toEqual(still)
  const events = bound('poll').events
  expect(events).toHaveLength(waiting + 1)
  expect(events.at(-1)).toMatchObject({ kind: 'sketch_notify', text: 'Line one\n' })
}

// The drawing surface is tldraw's own canvas and it fills its pane: no margin, no band, and
// nothing under the views. The pen draws six pixels above the bottom of the screen and the
// stroke lands where the pen was put, in what used to be a margin that took no ink.
// tldraw's link is whole, in its pane, and uncovered.
async function draws_to_the_bottom({ ipad, cli, session }: Linked, info: TestInfo) {
  await note_close(ipad)
  const [resting] = await expect_marks_untouched(ipad, 1)
  const seen = await layout(ipad)
  const { pane, sheet, screen } = seen as { pane: Rect; sheet: Rect; screen: Rect }
  expect(seen.margin).toBeNull()
  expect(seen.band).toBeNull()
  await expect(ipad.locator('footer')).toHaveCount(0)
  expect(sheet.top).toBeCloseTo(pane.top, 0)
  expect(sheet.left).toBeCloseTo(pane.left, 0)
  expect(sheet.right).toBeCloseTo(pane.right, 0)
  expect(sheet.bottom).toBeCloseTo(pane.bottom, 0)
  expect(pane.bottom).toBeCloseTo(screen.bottom, 0)
  expect(seen.marks).toHaveLength(1)
  expect(resting!.from_right).toBeGreaterThanOrEqual(0)
  expect(resting!.from_bottom).toBeGreaterThanOrEqual(0)

  const count = () => cli('status', '--session', session).shapes_count as number
  const before = count()
  const known = new Set(await sketch_ids(ipad))
  const edge = { x: pane.left + 300, y: pane.bottom - 6 }
  await stroke(ipad, edge, { x: 20, y: -2 })
  await expect.poll(count, { timeout: mac_ms }).toBe(before + 1)
  await expect.poll(async () => new Set(await sketch_ids(ipad)).size).toBe(known.size + 1)
  const [fresh] = (await sketch_ids(ipad)).filter((id) => !known.has(id))
  const shape = ipad.locator(`.tl-shape[data-shape-id="${fresh}"]:not(.tl-shape-background)`)
  const drawn = await rect_of(shape)
  expect(drawn.top).toBeLessThanOrEqual(edge.y + 3)
  expect(drawn.top).toBeGreaterThan(pane.bottom - margin_px_was)
  expect(drawn.bottom).toBeGreaterThanOrEqual(edge.y - 3)
  expect(drawn.bottom).toBeLessThanOrEqual(edge.y + 9)
  expect(Math.abs(drawn.left - edge.x)).toBeLessThanOrEqual(8)
  await shot(ipad, info, 'sketch-drawn-to-the-bottom-portrait')
  await expect_marks_untouched(ipad, 1)
}

// The notice with everything about it but whether a press reaches it: while the note is
// open, the browser keeps every press from the page behind it.
const placed = ({ own: _own, ...rest }: Mark) => rest

// tldraw's notice is whole, pressable and uncovered where tldraw folds it into a tab in a
// narrow canvas, where the strip lies along the bottom of a stacked sketch, and in the few
// widths where a full-width notice and the strip would otherwise meet. With the note open
// and grown, the paper is nowhere near it, and it has not moved.
async function link_in_every_arrangement(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const tab = (name: string) => ipad.getByRole('tab', { name })
  await field.fill('1\n2\n3\n4\n5\n6')
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  const [behind] = await marks(ipad)
  expect(behind!.covered).toBe(0)
  await shot(ipad, info, 'link-behind-the-note-portrait')
  await field.fill('')
  await note_close(ipad)
  const [resting] = await expect_marks_untouched(ipad, 1)
  expect(placed(behind!)).toEqual(placed(resting!))

  await resize(ipad, ipad_narrow)
  await expect.poll(async () => (await marks(ipad))[0]?.width ?? 99).toBeLessThanOrEqual(12)
  await expect_marks_untouched(ipad, 1)
  await shot(ipad, info, 'link-narrow')
  await resize(ipad, ipad_portrait)

  await tab('Side by side').tap()
  await expect_marks_untouched(ipad, 1)
  await shot(ipad, info, 'link-stacked-portrait')
  await resize(ipad, ipad_between)
  await expect_marks_untouched(ipad, 1)
  await expect_dock(ipad, 'above')
  await shot(ipad, info, 'link-stacked-between')
  await resize(ipad, ipad_narrow)
  await expect_marks_untouched(ipad, 1)
  await resize(ipad, ipad_landscape)
  await expect_marks_untouched(ipad, 1)
  await shot(ipad, info, 'link-side-by-side-landscape')
  await resize(ipad, ipad_portrait)
  await tab('Sketchboard').tap()
  await expect.poll(() => marks(ipad)).toEqual([resting])
}

const link_tap_wait_ms = 1_500
const link_press_wait_ms = 3_000
const link_events_max = 16

const link_of = (page: Page) =>
  page.locator('.views__pane--sketch [data-testid="tl-watermark-unlicensed"]')

// tldraw's page is answered here, so nothing leaves this machine.
const answered_here = (context: BrowserContext) =>
  context.route('https://tldraw.dev/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>tldraw</title>' }),
  )

// The middle of tldraw's link, once a press there lands on the link's own button. Where a
// mouse is the main pointer, tldraw arms the button only after the pointer rests on it, so
// the pointer is rested there first, as a hand would.
async function link_middle(page: Page): Promise<{ x: number; y: number }> {
  const button = link_of(page).getByRole('button')
  await expect(button).toBeVisible({ timeout: action_ms })
  const box = (await button.boundingBox())!
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const hit = () =>
    button.evaluate((element, at) => document.elementFromPoint(at.x, at.y) === element, middle)

  if (!(await hit())) await soon(page.mouse.move(middle.x, middle.y))

  await expect.poll(hit, { timeout: action_ms }).toBe(true)
  return middle
}

type Tap = { touchends: number; cancelled: boolean; clicks: number; popups: number }
type Watch = { seen: Event[]; stop: AbortController }

// One finger tap at the middle of tldraw's link, and what came of it. The page is only
// watched: the listeners are passive, keep a bounded list and are removed after the tap.
// tldraw 4.2.3 cancels the end of a touch on its notice, so a finger may make no click.
async function link_tapped(page: Page, name: string): Promise<Tap> {
  const middle = await link_middle(page)
  const mark = link_of(page)
  await mark.evaluate(
    (element, [types, max]) => {
      const watch: Watch = { seen: [], stop: new AbortController() }
      const keep = (event: Event) => {
        if (watch.seen.length < max && element.contains(event.target as Node)) {
          watch.seen.push(event)
        }
      }

      for (const type of types) {
        addEventListener(type, keep, { capture: true, passive: true, signal: watch.stop.signal })
      }

      Object.assign(element, { link_watch: watch })
    },
    [['touchend', 'click'], link_events_max] as const,
  )
  const popup = page
    .context()
    .waitForEvent('page', { timeout: link_tap_wait_ms })
    .catch(() => null)
  await touch(page, middle)
  const opened = await popup
  await opened?.close()
  const seen = await mark.evaluate((element) => {
    const watch = (element as unknown as { link_watch: Watch }).link_watch
    watch.stop.abort()
    return watch.seen.map((event) => ({ type: event.type, cancelled: event.defaultPrevented }))
  })
  const ends = seen.filter((event) => event.type === 'touchend')
  const tap = {
    touchends: ends.length,
    cancelled: ends.some((event) => event.cancelled),
    clicks: seen.filter((event) => event.type === 'click').length,
    popups: opened === null ? 0 : 1,
  }
  console.log(
    `  link, finger tap, ${name}: touchend=${tap.touchends} cancelled=${tap.cancelled} ` +
      `clicks=${tap.clicks} popups=${tap.popups}`,
  )
  return tap
}

// The same tap on the stage of the same board, in its own touch context of the iPad's size.
// Both are now tldraw's canvas as it comes. Null if no baseline was had.
async function link_tapped_stock(stage: Page): Promise<Tap | null> {
  const context = await stage.context().browser()!.newContext({
    viewport: ipad_portrait,
    hasTouch: true,
  })
  context.setDefaultTimeout(action_ms)
  context.setDefaultNavigationTimeout(navigation_ms)

  try {
    await answered_here(context)
    const page = await context.newPage()
    const address = new URL(stage.url())
    await page.goto(address.origin + address.pathname + address.search)
    return await link_tapped(page, 'stock')
  } catch (error) {
    console.log(`  link, finger tap, stock: no baseline (${(error as Error).name})`)
    return null
  } finally {
    await context.close()
  }
}

// A deliberate press on tldraw's link opens tldraw's page, and only that. A finger tap must do
// no less here than on the stage. The press that must open it is the Pencil's: a real pen
// down and up at the middle of the visible button, or a real mouse click should this
// Chromium's pen make no click. Nothing is forced, and no click is made from script.
async function link_opens_when_pressed({ ipad, stage }: Linked) {
  const context = ipad.context()
  await note_close(ipad)
  const [resting] = await expect_marks_untouched(ipad, 1)
  await answered_here(context)

  const stock = await link_tapped_stock(stage)
  const ours = await link_tapped(ipad, 'candidate')
  expect(ours.clicks).toBeGreaterThanOrEqual(stock?.clicks ?? 0)
  expect(ours.popups).toBeGreaterThanOrEqual(stock?.popups ?? 0)

  // The press is judged by what it asks for: a new window, and in it a visit to tldraw's site.
  const middle = await link_middle(ipad)
  const visits_tldraw = (request: Request) =>
    request.isNavigationRequest() && new URL(request.url()).hostname === 'tldraw.dev'
  const presses = [
    ['pen', () => stroke(ipad, middle, { x: 0, y: 0 })],
    ['mouse', () => soon(ipad.mouse.click(middle.x, middle.y))],
  ] as const
  let visit: Request | null = null

  try {
    for (const [means, press] of presses) {
      if (visit !== null) break

      const pressed = await Promise.all([
        context.waitForEvent('request', { predicate: visits_tldraw, timeout: link_press_wait_ms }),
        context.waitForEvent('page', { timeout: link_press_wait_ms }),
        press(),
      ]).catch(() => null)
      visit = pressed?.[0] ?? null
      console.log(`  link, ${means} press: popups=${pressed === null ? 0 : 1}`)
    }

    expect(visit, 'a pen or mouse press on the link opens a window').not.toBeNull()
    expect(new URL(visit!.url()).pathname).toBe('/pricing')
    expect(context.pages()).toHaveLength(2)
  } finally {
    for (const page of context.pages()) if (page !== ipad) await page.close()
  }

  await expect.poll(() => marks(ipad)).toEqual([resting])
}

test('each request is one row under the bell, and a board keeps its own note and rows', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad, bound } = board
    const field = note(ipad)
    const ack = (id: string, state: string, ...rest: string[]) =>
      expect(bound('ack', '--event', id, '--state', state, ...rest).status).toBe('success')

    const first = await step('a bare tap sends the sketch; its receipt is one row', async () => {

      // No words and no keyboard: the note is opened afresh, wherever pairing left it, and
      // with nothing typed and no focus in the field a bare tap sends the sketch.
      await note_close(ipad)
      await note_open(ipad)
      await expect(field).toHaveValue('')
      await expect(field).not.toBeFocused()
      await notify(ipad).tap()
      await expect.poll(() => bound('poll').events.length, { timeout: mac_ms }).toBe(1)
      const [event] = bound('poll').events
      expect(event.kind).toBe('sketch_notify')
      expect(event.text).toBeUndefined()

      // The receipt is news on the bell. The bell is behind the open note, so what it says
      // is read off the page. Nothing opens, and the paper shows no words about it; a
      // screen reader, which cannot hear the page behind an open note, is told on the note.
      await expect(bell_behind(ipad)).toHaveAttribute('aria-label', 'Notifications, 1 unread', {
        timeout: mac_ms,
      })
      await expect(inbox_behind(ipad)).toHaveCount(0)
      await expect(ipad.locator('.composer [role="status"], .composer p')).toHaveCount(0)
      await expect(ipad.locator('.notepad [role="status"]')).toContainText(
        'Notification: Queued on the Mac',
      )
      const unread = await bell_corner_ink(ipad, info, 'bell-unread-portrait')

      // Put away by a tap beside it, the note takes nothing with it: the news is still
      // there, on a bell that can be asked for by role again.
      await touch(ipad, beside(await layout(ipad)))
      await expect(field).toBeHidden()
      await expect(bell(ipad)).toHaveAccessibleName('Notifications, 1 unread')
      await expect(inbox(ipad)).toBeHidden()
      await inbox_open(ipad)
      await expect(bell(ipad)).toHaveAccessibleName('Notifications')
      await expect(rows(ipad)).toHaveCount(1)

      // Unread news is a dot of ink at the bell's corner; once read, the dot is gone.
      await inbox_close(ipad)
      const read = await bell_corner_ink(ipad, info, 'bell-read-portrait')
      expect(unread).toBeGreaterThan(25)
      expect(unread - read).toBeGreaterThan(20)
      await inbox_open(ipad)
      const row = rows(ipad).first()
      await expect(row).toContainText('Notification')
      await expect(row).toContainText('Queued on the Mac')
      await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT\d\d:\d\d/)
      return event
    })

    await step('receipt, work and failure replace each other in that row', async () => {
      const row = rows(ipad).first()
      ack(first.id, 'received')
      await expect(row).toContainText('Received by your agent', { timeout: mac_ms })
      ack(first.id, 'working')
      await expect(row).toContainText('Agent is working', { timeout: mac_ms })
      await expect(row).not.toContainText('Received by your agent')
      await inbox_close(ipad)
      ack(first.id, 'failed', '--message', 'The sketch was too faint to read.')
      await expect(bell(ipad)).toHaveAccessibleName('Notifications, 1 unread', {
        timeout: mac_ms,
      })
      await expect(inbox(ipad)).toBeHidden()
      const failed = await row_with(ipad, 'The sketch was too faint to read.')
      await expect(failed).toHaveAttribute('data-state', 'failed')
      await expect(failed).toContainText('Failed')
      await expect(rows(ipad)).toHaveCount(1)
      const sheet = (await layout(ipad)).inbox!
      const pane = (await layout(ipad)).pane!
      expect(sheet.left).toBeGreaterThanOrEqual(pane.left)
      expect(sheet.right).toBeLessThanOrEqual(pane.right)
      expect(sheet.bottom).toBeLessThanOrEqual(pane.bottom)
      await shot(ipad, info, 'list-failed-portrait')
    })

    await step('an empty Interpret and a note are each their own row', async () => {

      // Asking for the note shuts the list that was left open: gone from the page behind.
      await note_open(ipad)
      await expect(inbox_behind(ipad)).toHaveCount(0)
      await interpret(ipad).tap()
      await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
      await notify(ipad).tap()
      await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'false', { timeout: mac_ms })
      await field.fill('Check the retry arrow.')
      await sent_while_put_away(ipad)
      await expect.poll(() => bound('poll').events.length, { timeout: mac_ms }).toBe(2)
      const [second, third] = bound('poll').events
      expect(second).toMatchObject({ kind: 'interpret_request' })
      expect(second.text).toBeUndefined()
      expect(third).toMatchObject({ kind: 'sketch_notify', text: 'Check the retry arrow.' })

      for (const state of ['received', 'working', 'updated']) ack(third.id, state)

      await inbox_open(ipad)
      await expect(rows(ipad)).toHaveCount(3, { timeout: mac_ms })
      await expect(rows_about(ipad, 'sketch_notify', 'updated')).toContainText('Done', {
        timeout: mac_ms,
      })
      await expect(rows_about(ipad, 'interpret_request', 'queued')).toContainText('last known')
      await expect(rows_about(ipad, 'sketch_notify', 'failed')).toHaveCount(1)

      // The words of a note are sent to the agent, never shown again in the list.
      await expect(inbox(ipad)).not.toContainText('Check the retry arrow.')
      await shot(ipad, info, 'list-three-requests-portrait')

      // Escape gives the list back to the bell. The note stays shut.
      await press(ipad, 'Escape')
      await expect(inbox(ipad)).toBeHidden()
      await expect(bell(ipad)).toBeFocused()
      await expect(field).toBeHidden()
    })

    await step(
      'a board keeps its own note, switch and rows',
      () => boards_keep_their_own(board),
      step_long_ms,
    )
  })
})

// A request still on its way when the note is put away is not lost with it. The Mac's answer
// is held back until the note has been dismissed by a tap beside it. The button says a draft
// is waiting for as long as it is; then the answer clears the words that were sent, and the
// receipt is news on the bell. A field that is put away has no role to be found by, so its
// words are read off the page.
async function sent_while_put_away(ipad: Page) {
  const field = note(ipad)
  const field_behind = ipad.locator('.composer__input')
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
  await notify(ipad).tap()

  try {
    await soon(committed, mac_ms)
    await expect(notify(ipad)).toBeDisabled()
    await touch(ipad, beside(await layout(ipad)))
    await expect(field).toBeHidden()
    await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
    await expect(field_behind).toHaveValue('Check the retry arrow.')
  } finally {
    release()
  }

  await expect(chat(ipad)).toHaveAccessibleName('Agent note', { timeout: mac_ms })
  await expect(field_behind).toHaveValue('')
  await expect(field).toBeHidden()
  await expect(bell(ipad)).toHaveAccessibleName(/^Notifications, \d+ unread$/)
}

// How much ink is painted in the corner of the bell where its dot goes, with the list shut.
async function bell_corner_ink(ipad: Page, info: TestInfo, name: string): Promise<number> {
  await expect(bell_behind(ipad)).toHaveAttribute('aria-expanded', 'false')
  const pixels = await shot_pixels(ipad, info, name)
  const button = (await layout(ipad)).bell!
  const corner: Box = {
    left: button.right - 17,
    right: button.right - 7,
    top: button.top + 7,
    bottom: button.top + 17,
  }
  return ink_in(pixels, corner, ink_light_max).dark_count
}

// A draft, the Interpret switch and the rows belong to one board. Runs on the board the
// lifecycle journey leaves behind: three rows, and one request still waiting on the Mac. The
// list of boards and the bell are pressed only with the note shut.
async function boards_keep_their_own({ ipad, bound, cli, session, stage }: Linked) {
  const field = note(ipad)
  const draft = '  Keep the left column.\n\nThen ask about retries.  '
  const boards = ipad.getByRole('complementary', { name: 'Boards' })
  const board_open = async (id: string) => {
    await note_close(ipad)
    await ipad.getByRole('button', { name: 'Boards', exact: true }).click()
    await boards.locator(`a[href="/s/${id}/draw"]`).click()
    await expect(ipad).toHaveURL(new RegExp(`/s/${id}/draw$`))
    await expect(chat(ipad)).toBeVisible()
  }
  const drawn = () => cli('status', '--session', session).document_hash
  const waiting = bound('poll').events.length
  await inbox_open(ipad)
  const listed = await rows(ipad).count()
  expect(listed).toBeGreaterThan(0)
  await inbox_close(ipad)

  // A draft with the switch on. Writing a note draws nothing, here or on the Mac.
  const ink_hash = drawn()
  await note_open(ipad)
  await field.fill(draft)
  await interpret(ipad).tap()
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
  expect(drawn()).toBe(ink_hash)
  await expect(stage.locator('section[aria-label="Sketchboard"] .tl-shape')).toHaveCount(0)

  // Another board: the note is closed and empty, the switch is off, the list has no rows,
  // and without a scan of its own stage nothing can be sent from it.
  const other = String(cli('session-create').session.id)
  await board_open(other)
  await expect(chat(ipad)).toHaveAccessibleName('Agent note')
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
  await expect(bell(ipad)).toHaveAccessibleName('Notifications')
  await note_open(ipad)
  await expect(field).toHaveValue('')
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'false')
  await expect(notify(ipad)).toBeDisabled()
  await field.fill('Only for the other board')
  await note_close(ipad)
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(0)
  await expect(inbox(ipad)).toContainText('Scan the Mac stage QR to send requests.')
  await expect(inbox(ipad)).toContainText('Nothing sent from this board yet.')
  await inbox_close(ipad)

  // Back on the first board: its own words, switch and rows, exactly as they were left.
  await board_open(session)
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(listed)
  await inbox_close(ipad)
  await note_open(ipad)
  await expect(field).toHaveValue(draft)
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')

  // Sending from here sends this board's note to this board, once, as written.
  await notify(ipad).tap()
  await expect(field).toHaveValue('', { timeout: mac_ms })
  await expect.poll(() => bound('poll').events.length, { timeout: mac_ms }).toBe(waiting + 1)
  const sent = bound('poll').events.at(-1)
  expect(sent).toMatchObject({ kind: 'interpret_request', text: draft })
  expect(drawn()).toBe(ink_hash)
  await board_open(other)
  await note_open(ipad)
  await expect(field).toHaveValue('Only for the other board')
  expect(bound('poll').events).toHaveLength(waiting + 1)
}

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

// The placement check is the safeguard for "by the tools". It has to see a wrong placing:
// each fault below is one it must name, and the sound layout is one it must pass.
test('the placement check passes a sound layout and names each kind of fault', () => {
  const sound: Layout = {
    screen: rect(0, 0, 820, 1180),
    views: rect(0, 84, 820, 1096),
    pane: rect(0, 85, 820, 1095),
    sheet: rect(0, 85, 820, 1095),
    margin: null,
    strip: rect(16, 383, 52, 499),
    dock: rect(16, 277, 52, 98),
    chat: rect(20, 281, 44, 44),
    bell: rect(20, 327, 44, 44),
    tabs: rect(450, 16, 354, 52),
    boards: rect(16, 16, 52, 52),
    band: null,
    capsule: null,
    inbox: null,
    marks: [rect(716, 1140, 100, 36)],
    reach: { chat: true, bell: true },
  }
  const moved = (by_x: number, by_y: number): Layout => ({
    ...sound,
    dock: rect(16 + by_x, 277 + by_y, 52, 98),
    chat: rect(20 + by_x, 281 + by_y, 44, 44),
    bell: rect(20 + by_x, 327 + by_y, 44, 44),
  })
  expect(dock_problems(sound, 'above')).toEqual([])
  expect(dock_problems(moved(0, -30), 'above')).toEqual(['above: gap to the strip is 38px'])
  expect(dock_problems(moved(12, 0), 'above')).toEqual([
    'above: out of line with the strip by 12px',
  ])
  expect(dock_problems(moved(0, 40), 'above')).toContain('the buttons cover the strip')
  expect(dock_problems(moved(0, -200), 'above')).toContain(
    'the buttons are cut off by the sketch pane',
  )
  expect(dock_problems(sound, 'right')).not.toEqual([])
  expect(dock_problems(sound, 'band')).toContain('band: the strip is on screen')
  expect(dock_problems({ ...sound, reach: { chat: false, bell: true } }, 'above')).toEqual([
    'a press on the note button lands on something else',
  ])
  expect(dock_problems({ ...sound, chat: rect(20, 281, 40, 44) }, 'above')).toEqual([
    'note button is under 44px',
  ])
  expect(dock_problems({ ...sound, marks: [rect(30, 300, 100, 36)] }, 'above')).toEqual([
    'the buttons cover the link',
  ])
  expect(dock_problems({ ...sound, dock: null }, 'above')).toEqual([
    'the two buttons are not shown',
  ])
})

// The same for where the note is put. The faults are the ones this design replaced or could
// slide back into: a band along the bottom, a note left under the keyboard, a note off to
// one side, and a note as wide as the screen.
test('the note placement check passes a sound placing and names each kind of fault', () => {
  const screen: Box = { left: 0, top: 0, right: 820, bottom: 1180 }
  const sound = rect(138, 470.6, 544, 50)
  const one = (words: string) => [expect.stringContaining(words)]
  expect(note_problems(sound, screen)).toEqual([])
  expect(note_problems(rect(138, 449, 544, 94), screen)).toEqual([])
  expect(note_problems(rect(138, 1127, 544, 50), screen)).toEqual(
    one('off its place in the height'),
  )
  expect(note_problems(sound, { ...screen, bottom: 935 })).toEqual(
    one('off its place in the height'),
  )
  expect(note_problems(rect(16, 470.6, 544, 50), screen)).toEqual(
    one('off the middle of the width'),
  )
  expect(note_problems(rect(16, 470.6, 788, 50), screen)).toEqual(one('788px wide, not 544px'))
  expect(note_problems(rect(138, -30, 544, 1051), screen)).toEqual(one('not wholly in sight'))
  expect(note_problems(null, screen)).toEqual(['the note is not shown'])
})

// And for where Replace is put. The first fault is the regression this guards: Replace hung
// over the Agent canvas as a tab, where a diagram fitted to within 24px of the canvas's edge
// ran under it. The others are the ways of making room for it that are ruled out: a band
// under the views, and a sketch made smaller.
test('the Replace placement check passes a sound placing and names each kind of fault', () => {
  const sound: ReplaceSeen = {
    screen: { left: 0, top: 0, right: 820, bottom: 1180 },
    views: rect(0, 84, 820, 1096),
    sketch: rect(0, 85, 820, 547),
    pane: rect(0, 632, 820, 548),
    head: rect(0, 633, 820, 52),
    canvas: rect(0, 685, 820, 495),
    button: rect(644, 637, 160, 44),
    others: [
      { name: 'the tabs', box: rect(450, 16, 354, 52) },
      { name: 'the diagram', box: rect(0, 685, 820, 495) },
      { name: 'the link', box: rect(716, 1140, 100, 36) },
    ],
    pressed: true,
  }
  const tab = rect(644, 633, 160, 44)
  const whole = rect(0, 633, 820, 547)
  const hung: ReplaceSeen = {
    ...sound,
    head: tab,
    button: tab,
    canvas: whole,
    others: [{ name: 'the diagram', box: whole }],
  }
  expect(replace_problems(sound)).toEqual([])
  expect(replace_problems({ ...sound, sketch: null })).toEqual([])
  expect(replace_problems(hung)).toEqual([
    'Replace lies over the Agent canvas',
    'the head lies over the canvas',
    'Replace meets the diagram',
  ])
  expect(replace_problems({ ...sound, views: rect(0, 84, 820, 1041) })).toContain(
    'something lies under the views',
  )
  expect(replace_problems({ ...sound, canvas: rect(0, 685, 820, 440) })).toEqual([
    'something lies under the Agent canvas',
  ])
  expect(
    replace_problems({
      ...sound,
      sketch: rect(0, 85, 820, 495),
      pane: rect(0, 580, 820, 600),
      head: rect(0, 581, 820, 52),
      button: rect(644, 585, 160, 44),
    }),
  ).toEqual(['the sketch is 105px smaller than the Agent canvas'])
  expect(replace_problems({ ...sound, button: rect(644, 639, 160, 40) })).toEqual([
    'Replace is under 44px',
  ])
  expect(replace_problems({ ...sound, button: rect(700, 637, 160, 44) })).toEqual([
    'Replace is not wholly in the head',
  ])
  expect(replace_problems({ ...sound, pressed: false })).toEqual([
    'a press on Replace lands on something else',
  ])
  expect(replace_problems({ ...sound, button: null })).toEqual([
    'Replace, its head, the Agent canvas or the views are missing',
  ])
})
