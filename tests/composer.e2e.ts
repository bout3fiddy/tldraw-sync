// The iPad's note and its bell, in a real browser against a real, disposable linked board.
//
// - The note is hidden until asked for, never takes the focus by itself, and is exactly as tall
//   as its words: one line when empty, up to five, then it scrolls. The regression this guards
//   is a note that stayed a paragraph tall after its text was deleted.
// - The note button and the bell are fixed to the drawing tools wherever the strip is, do not
//   move when the note opens, and Escape closes the note wherever the focus happens to be.
// - The sketch is a sheet with a lower margin. tldraw's own link rests in that margin, outside
//   the drawing surface, uncovered, and opens when it is pressed on purpose with the pen. A
//   finger tap is compared with the same tap on tldraw's canvas as it comes, on the stage.
// - Each request is one row under the bell, changed in place from the Mac's receipt to the
//   agent's last word. Nothing opens by itself and the note's band says nothing.
// - A draft, the Interpret switch and the rows belong to one board.
//
// Two disposable boards serve the journeys, to keep the browser gate short. The first journey
// runs in phases that each start from the same settled screen and are judged separately, so
// one run reports every phase that is wrong. Every wait is bounded and every step is named.
//
// What is painted is judged from decoded screenshot pixels, not from styles alone.
//
// Chromium on a desktop has no palm and no software keyboard. The keyboard is driven through
// the visualViewport contract; palm contact on a real iPad is not something this can show.
//
// Run: bun run build && npx playwright test tests/composer.e2e.ts

import {
  expect,
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
  composer_open,
  dock_problems,
  expect_dock,
  expect_marks_clear,
  inbox,
  inbox_close,
  inbox_open,
  interpret,
  ipad_landscape,
  ipad_narrow,
  ipad_portrait,
  layout,
  marks,
  navigation_ms,
  note,
  notify,
  phases,
  row_with,
  rows,
  rows_about,
  step,
  step_long_ms,
  stroke,
  type Layout,
  type Linked,
  type Rect,
} from './whiteboard_board'

// Pairing material belongs neither in traces nor in screenshots: every capture here is taken
// after the paired page has removed the QR fragment from its address.
test.use({ trace: 'off', actionTimeout: action_ms, navigationTimeout: navigation_ms })

const lines_count_max = 5
const keyboard_px = 245
const sheet_margin_px = 64
const sentence =
  'Arrows out of the API box are writes; the dashed ones are reads that may be stale.'

// Light is luminance from 0 to 255. Ink (#1d1d1d) is 29, the blotter of the capsule and of
// the sheet's margin (#ecede9) is 236, and the vellum of the sheet (#f6f7f4) is 247.
const ink_light_max = 80
const glyph_light_max = 170

// A hairline of pencil lead on blotter is mostly anti-aliasing: any pixel clearly under paper.
const quiet_light_max = 205
const blotter_light = 236
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

// Where the capsule's two controls are, relative to the capsule, and how big their glyphs are.
// Equal results before and after an edit mean the controls did not move or change size.
function controls(page: Page) {
  return page.evaluate(() => {
    const capsule = document.querySelector('.composer__capsule')!.getBoundingClientRect()
    const round = (value: number) => Math.round(value * 100) / 100
    return ['.composer__interpret', '.composer__send'].map((selector) => {
      const target = document.querySelector(selector)!.getBoundingClientRect()
      const glyph = document.querySelector(`${selector} svg`)!.getBoundingClientRect()
      return {
        width: round(target.width),
        height: round(target.height),
        from_bottom: round(capsule.bottom - target.bottom),
        from_right: round(capsule.right - target.right),
        glyph_width: round(glyph.width),
        glyph_height: round(glyph.height),
      }
    })
  })
}

type Still = Awaited<ReturnType<typeof controls>>

// Two 44px targets on the capsule's bottom line, each around a small square glyph.
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

async function keyboard_show(page: Page, shown: boolean) {
  await page.evaluate(
    ([inset_px, show]) => {
      if (show) {
        Object.defineProperty(visualViewport, 'height', {
          configurable: true,
          value: innerHeight - (inset_px as number),
        })
      } else {
        Reflect.deleteProperty(visualViewport!, 'height')
      }

      visualViewport!.dispatchEvent(new Event('resize'))
    },
    [keyboard_px, shown] as const,
  )
}

// Where every phase starts: upright, the sketch alone on screen, no keyboard, the list shut,
// the note open and empty.
async function settle(ipad: Page) {
  await ipad.setViewportSize(ipad_portrait)
  await keyboard_show(ipad, false)
  await expect(chat(ipad)).toBeVisible()
  const sketch = ipad.getByRole('tab', { name: 'Sketchboard' })

  if ((await sketch.getAttribute('aria-selected')) !== 'true') await sketch.tap()

  await inbox_close(ipad)
  await composer_open(ipad)
  await note(ipad).fill('')
}

test('the note stays hidden, fits its words and sits by the tools; the link has a margin', async ({
  browser,
}, info) => {
  await board_linked(browser, async (board) => {
    const { ipad } = board
    await phases(() => settle(ipad), [
      ['the note starts hidden and opens without the focus', () => opens_quietly(ipad, info)],
      ['Escape closes the note wherever the focus is', () => escape_closes(ipad)],
      ['the two buttons stay fixed to the drawing tools', () => buttons_by_the_tools(ipad, info)],
      ['the height follows typing, deleting and undo', () => height_follows_the_text(ipad, info)],
      ['the height follows cut and paste', () => height_follows_cut_and_paste(ipad, info)],
      ['the height follows the width', () => height_follows_the_width(ipad, info)],
      ['the keyboard lifts only the band', () => keyboard_lifts_only_the_band(ipad, info)],
      ['closing keeps the draft and the caret', () => closing_keeps_the_draft_and_caret(ipad)],
      ['Return adds a line and Command-Return sends', () => return_and_send(board)],
      ['the link rests in the margin, outside the drawing', () => link_in_the_margin(board, info)],
      ['the margin holds in every arrangement', () => margin_in_every_arrangement(ipad, info)],
      ['a deliberate press opens the link', () => link_opens_when_pressed(board)],
    ])
  })
})

// Hidden is where the note starts: no band, no field, the whole screen for the sketch. Asking
// for it shows one empty line and two 44px targets on its bottom line, focuses nothing, and
// moves neither the button that was pressed nor the tools beside it.
async function opens_quietly(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  await ipad.reload()
  await expect(chat(ipad)).toBeVisible()
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')
  await expect(chat(ipad)).toHaveAccessibleName('Agent note')
  await expect(ipad.locator('.composer')).toBeHidden()
  await expect(field).toBeHidden()
  await expect_dock(ipad, 'above')
  const closed = await layout(ipad)
  expect(closed.pane!.bottom).toBeCloseTo(ipad_portrait.height, 0)
  const closed_px = await shot_pixels(ipad, info, 'note-closed-portrait')

  // Closed, the button is an outline drawn on paper: a glyph, not a block of ink.
  const idle = ink_in(closed_px, closed.chat!, glyph_light_max)
  expect(idle.dark_count).toBeGreaterThan(30)
  expect(idle.dark_count).toBeLessThan(idle.pixels_count * 0.3)

  await chat(ipad).tap()
  await expect(field).toBeVisible()
  await expect(field).not.toBeFocused()
  expect(await ipad.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
  expect(await expect_fitted(field)).toBe(1)
  await expect(notify(ipad)).toBeEnabled()
  const open = await layout(ipad)
  expect_unmoved(open.chat, closed.chat)
  expect_unmoved(open.bell, closed.bell)
  expect_unmoved(open.strip, closed.strip)
  await expect_dock(ipad, 'above')
  await expect_controls_fixed(ipad)

  // The capsule is paper, not an inked box: no border, and no edge darker than a rule.
  const edge = await ipad.locator('.composer__capsule').evaluate((element) => {
    const style = getComputedStyle(element)
    return { border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle }
  })
  expect(edge.border).toBe('0px')
  expect(edge.outline).toBe('none')
  expect(edge.shadow).not.toContain('rgb(29, 29, 29)')
  const open_px = await shot_pixels(ipad, info, 'note-open-empty-portrait')
  await capsule_painted(ipad, open_px, open)

  // Interpret on is a plate of solid ink the size of the send plate; off again, a glyph.
  await interpret(ipad).tap()
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
  const on_px = await shot_pixels(ipad, info, 'note-interpret-on-portrait')
  expect_plate(ink_in(on_px, await rect_of(interpret(ipad)), ink_light_max))
  await interpret(ipad).tap()
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'false')
}

// A 32px plate of solid ink inside a 44px target.
function expect_plate(plate: ReturnType<typeof ink_in>) {
  expect(plate.dark_count).toBeGreaterThan(450)
  expect(plate.dark_width).toBeGreaterThanOrEqual(28)
  expect(plate.dark_width).toBeLessThanOrEqual(34)
  expect(plate.dark_height).toBeGreaterThanOrEqual(28)
  expect(plate.dark_height).toBeLessThanOrEqual(34)
}

// The open, empty capsule as it was painted: blotter paper with no dark edge anywhere round
// it, a round plate of ink carrying a light arrow, a small quiet broom, and the button that
// opened it now in solid ink.
async function capsule_painted(ipad: Page, pixels: Pixels, seen: Layout) {
  const capsule = seen.capsule!
  const middle = (capsule.top + capsule.bottom) / 2
  const centre = (capsule.left + capsule.right) / 2
  const paper = ink_in(
    pixels,
    { left: capsule.left + 8, right: capsule.left + 14, top: middle - 3, bottom: middle + 3 },
    ink_light_max,
  )
  expect(Math.abs(paper.light_min - blotter_light)).toBeLessThan(tone_tolerance)
  expect(Math.abs(paper.light_max - blotter_light)).toBeLessThan(tone_tolerance)

  // Across the left end, the top edge and the bottom edge: nothing as dark as pencil lead.
  const crossings: Box[] = [
    { left: capsule.left - 4, right: capsule.left + 6, top: middle - 1, bottom: middle + 1 },
    { left: centre - 1, right: centre + 1, top: capsule.top - 4, bottom: capsule.top + 6 },
    { left: centre - 1, right: centre + 1, top: capsule.bottom - 6, bottom: capsule.bottom + 4 },
  ]

  for (const crossing of crossings) {
    expect(ink_in(pixels, crossing, ink_light_max).light_min).toBeGreaterThan(150)
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

// Opened by a tap, nothing in the note has the focus. Escape still closes it: with the focus
// on the button, with no focus at all, as on an iPad, and with the focus on the canvas. The
// pen stays the pen each time, because tldraw is told the key was not for it.
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
    await expect(pen).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
  await chat(ipad).tap()
  await expect(field).toBeHidden()

  await reopen()
  await ipad.keyboard.press('Escape')
  await expect_closed()

  await reopen()
  await ipad.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await ipad.evaluate(() => document.activeElement === document.body)).toBe(true)
  await ipad.keyboard.press('Escape')
  await expect_closed()

  await reopen()
  await frame.focus()
  await ipad.keyboard.press('Escape')
  await expect_closed()

  // One Escape closes one thing: the list first, with its focus back on the bell.
  await reopen()
  await inbox_open(ipad)
  await ipad.keyboard.press('Escape')
  await expect(inbox(ipad)).toBeHidden()
  await expect(bell(ipad)).toBeFocused()
  await expect(field).toBeVisible()
  await ipad.keyboard.press('Escape')
  await expect_closed()

  // Control. With nothing of the agent's open the key on the canvas is tldraw's again, and
  // tldraw puts the pen down: what the checks above would have seen had it heard the key.
  await frame.focus()
  await ipad.keyboard.press('Escape')
  await expect(pen).toHaveAttribute('aria-pressed', 'false')
  await pen.tap()
  await expect(pen).toHaveAttribute('aria-pressed', 'true')
}

// The note button and the bell are fixed to the strip, eight pixels off it, whole, uncovered
// and reachable, in every arrangement the draw page has; and they hold still while the note
// grows. With only the Agent canvas on screen there is no strip, and they wait in the band.
async function buttons_by_the_tools(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const tab = (name: string) => ipad.getByRole('tab', { name })
  await expect_dock(ipad, 'above')
  const at = await layout(ipad)
  await field.fill('1\n2\n3\n4\n5\n6')
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  const grown = await layout(ipad)
  expect_unmoved(grown.chat, at.chat)
  expect_unmoved(grown.strip, at.strip)
  await expect_dock(ipad, 'above')
  await field.fill('')

  // Stacked views on a linked board: the strip lies along the bottom of the sketch.
  await tab('Side by side').tap()
  await expect_dock(ipad, 'left')
  await shot(ipad, info, 'buttons-stacked-portrait')
  await ipad.setViewportSize(ipad_narrow)
  await expect_dock(ipad, 'above')
  await shot(ipad, info, 'buttons-stacked-narrow')
  await ipad.setViewportSize(ipad_portrait)
  await tab('Sketchboard').tap()

  // Too short for a column: beside the head of the strip.
  await ipad.setViewportSize(ipad_narrow)
  await expect_dock(ipad, 'right')
  await ipad.setViewportSize(ipad_landscape)
  await expect_dock(ipad, 'right')
  await shot(ipad, info, 'buttons-landscape')
  await tab('Side by side').tap()
  await expect_dock(ipad, 'right')

  // No sketch, no strip: the band, clear of the tabs and of the list of boards.
  await tab('Agent canvas').tap()
  await expect_dock(ipad, 'band')
  await ipad.setViewportSize(ipad_portrait)
  await expect_dock(ipad, 'band')
  await shot(ipad, info, 'buttons-agent-canvas-portrait')
  await tab('Sketchboard').tap()
  await expect_dock(ipad, 'above')
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

  // Past the cap in one insertion: five lines, and the rest scrolls.
  await field.fill('Short')
  await field.focus()
  await ipad.keyboard.insertText(`\n${Array(6).fill(sentence).join(' ')}`)
  const long = await field.inputValue()
  expect(long.startsWith('Short\n')).toBe(true)
  expect(await expect_fitted(field)).toBeGreaterThan(lines_count_max)
  expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await controls(ipad)).toEqual(still)
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
  const paste = () => (kept ? field.press('ControlOrMeta+V') : ipad.keyboard.insertText(words))

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
  const kinds = await ipad.evaluate(() => (window as Kinds).note_kinds ?? [])
  expect(kinds).toContain('historyUndo')

  if (kept) {
    expect(kinds).toContain('deleteByCut')
    expect(kinds).toContain('insertFromPaste')
  }

  await field.fill('')
  expect(await expect_fitted(field)).toBe(1)
}

// The same words need more lines in a narrow window and fewer in a wide one. Nothing is typed
// between the sizes: the height has to follow the width alone.
async function height_follows_the_width(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  await field.fill(sentence)
  const wide = await expect_fitted(field)
  await ipad.setViewportSize(ipad_narrow)
  const narrow = await expect_fitted(field)
  expect(narrow).toBeGreaterThan(wide)
  expect(await controls(ipad)).toEqual(still)
  await expect_dock(ipad, 'right')
  const seen = await layout(ipad)
  expect(seen.capsule!.left).toBeGreaterThanOrEqual(0)
  expect(seen.capsule!.right).toBeLessThanOrEqual(ipad_narrow.width)

  await inbox_open(ipad)
  const sheet = (await layout(ipad)).inbox!
  expect(sheet.left).toBeGreaterThanOrEqual(0)
  expect(sheet.right).toBeLessThanOrEqual(ipad_narrow.width)
  expect(sheet.bottom).toBeLessThanOrEqual(seen.pane!.bottom)
  await shot(ipad, info, 'note-and-list-narrow')
  await inbox_close(ipad)

  await ipad.setViewportSize(ipad_landscape)
  expect(await expect_fitted(field)).toBe(wide)
  expect(await controls(ipad)).toEqual(still)
  await shot(ipad, info, 'note-landscape')
  await ipad.setViewportSize(ipad_portrait)
  expect(await expect_fitted(field)).toBe(wide)
  await field.fill('')
}

// The keyboard covers the bottom of the screen. The band rides above it; the sketch keeps its
// size, the tools and the two buttons keep their place, and the note keeps its lines.
async function keyboard_lifts_only_the_band(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const still = await expect_controls_fixed(ipad)
  await field.fill('One\nTwo\nThree')
  expect(await expect_fitted(field)).toBe(3)
  const before = await layout(ipad)
  await keyboard_show(ipad, true)
  const lifted = await layout(ipad)
  expect(lifted.band!.bottom).toBeLessThanOrEqual(ipad_portrait.height - keyboard_px + 0.5)
  expect(lifted.pane).toEqual(before.pane)
  expect(lifted.sheet).toEqual(before.sheet)
  expect(lifted.strip).toEqual(before.strip)
  expect(lifted.chat).toEqual(before.chat)
  expect(await expect_fitted(field)).toBe(3)
  expect(await controls(ipad)).toEqual(still)
  await shot(ipad, info, 'note-above-keyboard')
  await keyboard_show(ipad, false)
  expect((await layout(ipad)).pane).toEqual(before.pane)
}

// Escape and the button both close the note. Either way the words, the selection and the
// height are there on reopening, the button says a draft is waiting, and nothing is focused.
async function closing_keeps_the_draft_and_caret(ipad: Page) {
  const field = note(ipad)
  const draft = 'alpha\nbeta\ngamma'
  const caret = () =>
    field.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])
  await field.fill(draft)
  await field.focus()
  await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 4))
  await field.press('Escape')
  await expect(field).toBeHidden()
  await expect(ipad.locator('.composer')).toBeHidden()
  await expect(chat(ipad)).toBeFocused()
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await expect(chat(ipad)).toHaveAttribute('aria-expanded', 'false')

  await chat(ipad).tap()
  await expect(field).toBeVisible()
  await expect(field).not.toBeFocused()
  await expect(field).toHaveValue(draft)
  expect(await caret()).toEqual([2, 4])
  expect(await expect_fitted(field)).toBe(3)

  // Closed by the button while typing: the field gives up the focus, and so the keyboard.
  await field.focus()
  await chat(ipad).tap()
  await expect(field).toBeHidden()
  expect(await ipad.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
  await chat(ipad).tap()
  await expect(field).toHaveValue(draft)
  expect(await caret()).toEqual([2, 4])

  // Typing lands where the caret was left.
  await field.focus()
  await ipad.keyboard.type('X')
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
  await expect(field).toHaveValue('')
  expect(await expect_fitted(field)).toBe(1)
  expect(await controls(ipad)).toEqual(still)
  const events = bound('poll').events
  expect(events).toHaveLength(waiting + 1)
  expect(events.at(-1)).toMatchObject({ kind: 'sketch_notify', text: 'Line one\n' })
}

const sketch_ids = (ipad: Page) =>
  ipad
    .locator('.views__pane--sketch .tl-shape[data-shape-type="draw"]')
    .evaluateAll((shapes) => shapes.map((shape) => shape.getAttribute('data-shape-id')))

// The drawing surface is tldraw's own canvas, and it ends where the margin begins. tldraw's
// link is whole inside the margin. The pen draws right up to the margin and lands where it
// was put; a pen or a finger in the margin leaves nothing and opens nothing.
async function link_in_the_margin({ ipad, cli, session }: Linked, info: TestInfo) {
  const [resting] = await expect_marks_clear(ipad, 1)
  const seen = await layout(ipad)
  const { pane, sheet, margin } = seen as { pane: Rect; sheet: Rect; margin: Rect }
  const mark = seen.marks[0]!
  expect(seen.marks).toHaveLength(1)
  expect(sheet.top).toBeCloseTo(pane.top, 0)
  expect(sheet.left).toBeCloseTo(pane.left, 0)
  expect(sheet.right).toBeCloseTo(pane.right, 0)
  expect(sheet.bottom).toBeCloseTo(margin.top, 0)
  expect(margin.bottom).toBeCloseTo(pane.bottom, 0)
  expect(margin.height).toBeCloseTo(sheet_margin_px, 0)
  expect(resting!.from_right).toBeGreaterThanOrEqual(0)
  expect(resting!.from_bottom).toBeGreaterThanOrEqual(0)
  expect(mark.top).toBeGreaterThanOrEqual(margin.top + 4)
  expect(mark.bottom).toBeLessThanOrEqual(margin.bottom)
  expect(mark.width).toBeGreaterThan(90)

  // Near the edge: six pixels above the margin, a stroke is drawn, where the pen was.
  const count = () => cli('status', '--session', session).shapes_count as number
  const before = count()
  const known = new Set(await sketch_ids(ipad))
  const edge = { x: pane.left + 300, y: margin.top - 6 }
  await stroke(ipad, edge, { x: 20, y: -2 })
  await expect.poll(count).toBe(before + 1)
  await expect.poll(async () => new Set(await sketch_ids(ipad)).size).toBe(known.size + 1)
  const [fresh] = (await sketch_ids(ipad)).filter((id) => !known.has(id))
  const shape = ipad.locator(`.tl-shape[data-shape-id="${fresh}"]:not(.tl-shape-background)`)
  const drawn = await rect_of(shape)
  expect(drawn.top).toBeLessThanOrEqual(edge.y + 3)
  expect(drawn.bottom).toBeGreaterThanOrEqual(edge.y - 3)
  expect(drawn.bottom).toBeLessThanOrEqual(margin.top + 3)
  expect(Math.abs(drawn.left - edge.x)).toBeLessThanOrEqual(8)

  // In the margin: the pen and a finger leave nothing. One more stroke on the sheet makes
  // two in all, so neither of them was taken for a stroke, and no window was opened.
  const rest = { x: pane.left + 300, y: (margin.top + margin.bottom) / 2 }
  const windows = ipad.context().pages().length
  await stroke(ipad, rest, { x: 20, y: 0 })
  await ipad.touchscreen.tap(rest.x, rest.y)
  await stroke(ipad, { x: pane.left + 300, y: pane.top + 200 }, { x: 20, y: 15 })
  await expect.poll(count).toBe(before + 2)
  expect(ipad.context().pages()).toHaveLength(windows)
  const painted = await shot_pixels(ipad, info, 'sheet-margin-and-link-portrait')
  margin_painted(painted, seen)
}

// The margin as it was painted: an even band of blotter paper a shade deeper than the sheet
// above it, under a ruled line, with the words of tldraw's link inked inside it.
function margin_painted(pixels: Pixels, seen: Layout) {
  const { pane, margin } = seen as { pane: Rect; margin: Rect }
  const left = pane.left + 120
  const right = pane.left + 280
  const band = ink_in(
    pixels,
    { left, right, top: margin.top + 8, bottom: margin.bottom - 8 },
    ink_light_max,
  )
  expect(band.dark_count).toBe(0)
  expect(band.light_max - band.light_min).toBeLessThan(4)
  expect(Math.abs(band.light_max - blotter_light)).toBeLessThan(tone_tolerance)

  // The sheet just above is lighter paper, whatever its grid dots add.
  const above = { left, right, top: margin.top - 40, bottom: margin.top - 12 }
  expect(ink_in(pixels, above, ink_light_max).light_max - band.light_max).toBeGreaterThan(5)

  // The rule between them, the margin's first row, is darker than either and far from ink.
  const rule = { left, right, top: Math.round(margin.top), bottom: Math.round(margin.top) + 1 }
  const ruled = ink_in(pixels, rule, ink_light_max)
  expect(ruled.light_min).toBeLessThan(band.light_min - 10)
  expect(ruled.light_min).toBeGreaterThan(150)

  // tldraw's words are there to read.
  expect(ink_in(pixels, seen.marks[0]!, 140).dark_count).toBeGreaterThan(30)
}

// The same holds with the note grown and the list open, where tldraw folds its notice into a
// tab in a narrow canvas, where the strip lies in the margin of a stacked sketch, and in the
// few widths where a full-width notice and the strip would otherwise meet.
async function margin_in_every_arrangement(ipad: Page, info: TestInfo) {
  const field = note(ipad)
  const tab = (name: string) => ipad.getByRole('tab', { name })
  const expect_inside = async () => {
    await expect_marks_clear(ipad, 1)
    const seen = await layout(ipad)
    const mark = seen.marks[0]!
    expect(seen.marks).toHaveLength(1)
    expect(mark.top).toBeGreaterThanOrEqual(seen.margin!.top + 4)
    expect(mark.bottom).toBeLessThanOrEqual(seen.margin!.bottom)
    expect(seen.sheet!.bottom).toBeLessThanOrEqual(mark.top)
  }
  const [resting] = await expect_marks_clear(ipad, 1)
  await field.fill('1\n2\n3\n4\n5\n6')
  await inbox_open(ipad)
  await expect.poll(() => marks(ipad)).toEqual([resting])
  await expect_inside()
  await shot(ipad, info, 'link-with-note-and-list-portrait')
  await inbox_close(ipad)
  await field.fill('')

  await ipad.setViewportSize(ipad_narrow)
  await expect.poll(async () => (await marks(ipad))[0]?.width ?? 99).toBeLessThanOrEqual(12)
  await expect_inside()
  await shot(ipad, info, 'link-narrow')
  await ipad.setViewportSize(ipad_portrait)

  await tab('Side by side').tap()
  await expect_inside()
  await shot(ipad, info, 'link-stacked-portrait')
  await ipad.setViewportSize(ipad_between)
  await expect_inside()
  await expect_dock(ipad, 'above')
  await shot(ipad, info, 'link-stacked-between')
  await ipad.setViewportSize(ipad_narrow)
  await expect_inside()
  await ipad.setViewportSize(ipad_landscape)
  await expect_inside()
  await shot(ipad, info, 'link-side-by-side-landscape')
  await ipad.setViewportSize(ipad_portrait)
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

  if (!(await hit())) await page.mouse.move(middle.x, middle.y)

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
  await page.touchscreen.tap(middle.x, middle.y)
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

// The same tap on tldraw's canvas as it comes: the stage of the same board, which gives the
// notice no margin, in its own touch context of the iPad's size. Null if no baseline was had.
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
// no less here than on tldraw's own canvas. The press that must open it is the Pencil's: a
// real pen down and up at the middle of the visible button, or a real mouse click should this
// Chromium's pen make no click. Nothing is forced, and no click is made from script.
async function link_opens_when_pressed({ ipad, stage }: Linked) {
  const context = ipad.context()
  const [resting] = await expect_marks_clear(ipad, 1)
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
    ['mouse', () => ipad.mouse.click(middle.x, middle.y)],
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

      // No words and no keyboard: a bare tap sends the sketch.
      await expect(field).toHaveValue('')
      await expect(field).not.toBeFocused()
      await notify(ipad).tap()
      await expect.poll(() => bound('poll').events.length).toBe(1)
      const [event] = bound('poll').events
      expect(event.kind).toBe('sketch_notify')
      expect(event.text).toBeUndefined()

      // The receipt is news on the bell. Nothing opens, and the band holds no status.
      await expect(bell(ipad)).toHaveAccessibleName('Notifications, 1 unread')
      await expect(inbox(ipad)).toBeHidden()
      await expect(ipad.locator('.composer [role="status"], .composer p')).toHaveCount(0)
      const unread = await bell_corner_ink(ipad, info, 'bell-unread-portrait')
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
      await expect(row).toContainText('Received by your agent')
      ack(first.id, 'working')
      await expect(row).toContainText('Agent is working')
      await expect(row).not.toContainText('Received by your agent')
      await inbox_close(ipad)
      ack(first.id, 'failed', '--message', 'The sketch was too faint to read.')
      await expect(bell(ipad)).toHaveAccessibleName('Notifications, 1 unread')
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
      await interpret(ipad).tap()
      await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
      await notify(ipad).tap()
      await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'false')
      await field.fill('Check the retry arrow.')
      await notify(ipad).tap()
      await expect(field).toHaveValue('')
      await expect.poll(() => bound('poll').events.length).toBe(2)
      const [second, third] = bound('poll').events
      expect(second).toMatchObject({ kind: 'interpret_request' })
      expect(second.text).toBeUndefined()
      expect(third).toMatchObject({ kind: 'sketch_notify', text: 'Check the retry arrow.' })

      for (const state of ['received', 'working', 'updated']) ack(third.id, state)

      await inbox_open(ipad)
      await expect(rows(ipad)).toHaveCount(3)
      await expect(rows_about(ipad, 'sketch_notify', 'updated')).toContainText('Done')
      await expect(rows_about(ipad, 'interpret_request', 'queued')).toContainText('last known')
      await expect(rows_about(ipad, 'sketch_notify', 'failed')).toHaveCount(1)

      // The words of a note are sent to the agent, never shown again in the list.
      await expect(inbox(ipad)).not.toContainText('Check the retry arrow.')
      await shot(ipad, info, 'list-three-requests-portrait')

      // Escape gives the list back to the bell, and leaves the note open.
      await ipad.keyboard.press('Escape')
      await expect(inbox(ipad)).toBeHidden()
      await expect(bell(ipad)).toBeFocused()
      await expect(field).toBeVisible()
    })

    await step(
      'a board keeps its own note, switch and rows',
      () => boards_keep_their_own(board),
      step_long_ms,
    )
  })
})

// How much ink is painted in the corner of the bell where its dot goes, with the list shut.
async function bell_corner_ink(ipad: Page, info: TestInfo, name: string): Promise<number> {
  await expect(bell(ipad)).toHaveAttribute('aria-expanded', 'false')
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
// lifecycle journey leaves behind: three rows, and one request still waiting on the Mac.
async function boards_keep_their_own({ ipad, bound, cli, session, stage }: Linked) {
  const field = note(ipad)
  const draft = '  Keep the left column.\n\nThen ask about retries.  '
  const boards = ipad.getByRole('complementary', { name: 'Boards' })
  const board_open = async (id: string) => {
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
  await composer_open(ipad)
  await expect(field).toHaveValue('')
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'false')
  await expect(notify(ipad)).toBeDisabled()
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(0)
  await expect(inbox(ipad)).toContainText('Scan the Mac stage QR to send requests.')
  await expect(inbox(ipad)).toContainText('Nothing sent from this board yet.')
  await inbox_close(ipad)
  await field.fill('Only for the other board')

  // Back on the first board: its own words, switch and rows, exactly as they were left.
  await board_open(session)
  await expect(chat(ipad)).toHaveAccessibleName('Agent note, draft saved')
  await composer_open(ipad)
  await expect(field).toHaveValue(draft)
  await expect(interpret(ipad)).toHaveAttribute('aria-checked', 'true')
  await inbox_open(ipad)
  await expect(rows(ipad)).toHaveCount(listed)
  await inbox_close(ipad)

  // Sending from here sends this board's note to this board, once, as written.
  await notify(ipad).tap()
  await expect(field).toHaveValue('')
  await expect.poll(() => bound('poll').events.length).toBe(waiting + 1)
  const sent = bound('poll').events.at(-1)
  expect(sent).toMatchObject({ kind: 'interpret_request', text: draft })
  expect(drawn()).toBe(ink_hash)
  await board_open(other)
  await composer_open(ipad)
  await expect(field).toHaveValue('Only for the other board')
  expect(bound('poll').events).toHaveLength(waiting + 1)
}

// The placement check is the safeguard for "by the tools". It has to see a wrong placing:
// each fault below is one it must name, and the sound layout is one it must pass.
test('the placement check passes a sound layout and names each kind of fault', () => {
  const rect = (left: number, top: number, width: number, height: number): Rect => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  })
  const sound: Layout = {
    screen: rect(0, 0, 820, 1180),
    views: rect(0, 84, 820, 1096),
    pane: rect(0, 85, 820, 1095),
    sheet: rect(0, 85, 820, 1031),
    margin: rect(0, 1116, 820, 64),
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
