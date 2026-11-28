// A native rehearsal of a board whose Agent canvas has Drawing views, judged by what the Mac
// stage and an iPad paint. The legacy board is made by the board's own code and rehearsed
// through the real command line onto disposable folders; the copy is then served.
//
// Each screen chooses its own view and shows the drawing at rest when it opens. A view only
// hides shapes on that screen: a shape a view hides comes back as it was, and the person's edit
// to a shape every view shares is still there after switching away and back. Choosing writes
// nothing to the board, needs no network, and a tap on a shape that names a view chooses it.
//
// Run: bun run build && npx playwright test tests/native_views.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { board_menu } from './one_canvas'
import { action_ms, command, ipad_portrait, navigation_ms, soon, step } from './whiteboard_board'

type Shape = { id: string; type: string; x: number; y: number; props: Record<string, unknown> }

const shape = (page: Page, id: string) =>
  page.locator(`.surface .tl-shape[data-shape-id="shape:scene-${id}"]`)
const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true })
const switch_frame = (page: Page) => page.locator('.switch:not(.switch--measure)')

// What each view shows of the fixture's season control (`scene_controlled`).
const summer = { shown: ['house', 'sun', 'shine', 'caption'], hidden: ['snow', 'note', 'crane'] }
const winter = { shown: ['house', 'snow', 'caption'], hidden: ['sun', 'shine', 'note', 'crane'] }

async function view_is(page: Page, view: { shown: string[]; hidden: string[] }) {
  for (const id of view.shown) await expect(shape(page, id)).toBeVisible()

  for (const id of view.hidden) await expect(shape(page, id)).toHaveCount(0)
}

async function open_views(page: Page) {
  if (!(await switch_frame(page).isVisible())) await board_menu(page, 'Drawing views…')
}

// Puts the switch away if the board menu opened it over the canvas.
async function close_views(page: Page) {
  const done = page.getByRole('button', { name: 'Done' })

  if (await done.isVisible()) await done.click()
}

// The middle of a shape on the screen. The canvas, not the shape, takes the press there.
async function middle(page: Page, id: string): Promise<[number, number]> {
  const box = (await shape(page, id).boundingBox())!
  return [box.x + box.width / 2, box.y + box.height / 2]
}

async function shapes(origin: string, session: string): Promise<Map<string, Shape>> {
  const response = await fetch(`${origin}/api/drawing.json?session=${session}`)
  expect(response.ok).toBe(true)
  const list = (await response.json()) as Shape[]
  return new Map(list.map((record) => [record.id, record]))
}

test('each screen chooses its own view of a native copy; hidden shapes and edits survive', async ({
  browser,
}) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-views-e2e-')))
  const [source, native, live] = ['source', 'native', 'live'].map((name) =>
    path.join(parent, name),
  ) as [string, string, string]
  const stage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const ipad = await browser.newPage({ viewport: ipad_portrait, hasTouch: true })
  const asked: string[] = []
  ipad.on('request', (request) => asked.push(request.url()))

  for (const page of [stage, ipad]) {
    page.setDefaultTimeout(action_ms)
    page.setDefaultNavigationTimeout(navigation_ms)
  }

  try {
    const session = await step('rehearse a linked board whose drawing has views', async () => {
      fs.mkdirSync(live)
      const made = spawnSync(
        process.env.BUN ?? 'bun',
        ['tests/fixtures/native-rehearsal/legacy_board.ts', source, 'interactive'],
        { encoding: 'utf8', timeout: 30_000 },
      )
      expect(made.status).toBe(0)
      const id = String(JSON.parse(made.stdout).session)
      const rehearsed = command(
        live,
        'native-rehearse',
        '--source',
        source,
        '--session',
        id,
        '--out',
        native,
      )
      expect(rehearsed).toMatchObject({ code: 'rehearsed', session: id, view_controls_count: 3 })
      expect(command(native, 'start', '--no-open').status).toBe('success')
      return id
    })

    const listed = command(native, 'session-list').sessions as { id: string; stage_url: string }[]
    const stage_url = listed.find((board) => board.id === session)!.stage_url
    const origin = new URL(stage_url).origin
    const hash = () => command(native, 'status', '--session', session).document_hash as string
    let house: Shape | null = null
    let sun: Shape | null = null

    await step('the Mac and the iPad both open the drawing at rest', async () => {
      await stage.goto(stage_url)
      await ipad.goto(`${origin}/s/${session}/draw`)
      await board_menu(ipad, 'Fit my ink')
      await view_is(stage, summer)
      await view_is(ipad, summer)
      const records = await shapes(origin, session)
      house = records.get('shape:scene-house')!
      sun = records.get('shape:scene-sun')!
      expect(records.get('shape:scene-snow')).toBeDefined()
    })

    await step('the iPad chooses winter, offline: its own view only, nothing written', async () => {
      const before = hash()
      const asked_count = asked.length
      await soon(ipad.context().setOffline(true))

      try {
        await open_views(ipad)
        await radio(ipad, 'WINTER').click()
        await close_views(ipad)
        await view_is(ipad, winter)
      } finally {
        await soon(ipad.context().setOffline(false))
      }

      expect(asked).toHaveLength(asked_count)
      await view_is(stage, summer)
      expect(hash()).toBe(before)
    })

    await step('the Mac steps to build and taps the sun; the iPad keeps winter', async () => {
      await open_views(stage)
      await stage.getByRole('button', { name: 'Next: Stage' }).click()
      await expect(shape(stage, 'crane')).toBeVisible()
      await expect(shape(ipad, 'crane')).toHaveCount(0)
      await close_views(stage)
      await stage.mouse.click(...(await middle(stage, 'sun')))
      await view_is(stage, { shown: winter.shown, hidden: ['sun', 'shine'] })
      await view_is(ipad, winter)
    })

    await step('a finger tap on the snow brings the iPad back to summer', async () => {
      await ipad.touchscreen.tap(...(await middle(ipad, 'snow')))
      await view_is(ipad, summer)

      // The hidden shapes come back exactly as they were.
      const records = await shapes(origin, session)
      expect(records.get('shape:scene-sun')).toEqual(sun)
    })

    await step('the iPad moves the house, which every view shares', async () => {
      await ipad.getByRole('button', { name: 'Pen', exact: true }).click()
      const box = (await shape(ipad, 'house').boundingBox())!
      await pen_drag(ipad, { x: box.x + 2, y: box.y + box.height / 2 }, { x: 60, y: 40 })

      // Moved, and settled: the board holds the same place twice in a row.
      let last = house!.x
      await expect
        .poll(
          async () => {
            const x = (await shapes(origin, session)).get('shape:scene-house')!.x
            const settled = x === last && x !== house!.x
            last = x
            return settled
          },
          { intervals: [250] },
        )
        .toBe(true)
    })

    await step('the moved house stays through winter and back', async () => {
      const moved = (await shapes(origin, session)).get('shape:scene-house')!
      const placed = (await shape(ipad, 'house').boundingBox())!
      const before = hash()
      await open_views(ipad)
      await radio(ipad, 'WINTER').click()
      await view_is(ipad, winter)
      await radio(ipad, 'SUMMER').click()
      await close_views(ipad)
      await view_is(ipad, summer)
      expect(hash()).toBe(before)
      expect((await shapes(origin, session)).get('shape:scene-house')).toEqual(moved)
      const after = (await shape(ipad, 'house').boundingBox())!
      expect([after.x, after.y]).toEqual([placed.x, placed.y])
    })

    await step('a reload shows the iPad the drawing at rest, with the edit', async () => {
      await ipad.reload()
      await board_menu(ipad, 'Fit my ink')
      await view_is(ipad, summer)
      expect((await shapes(origin, session)).get('shape:scene-house')!.x).not.toBe(house!.x)
      expect((await shapes(origin, session)).get('shape:scene-sun')).toEqual(sun)
    })
  } finally {
    await Promise.all([stage.close(), ipad.close()])

    if (fs.existsSync(native)) command(native, 'stop')

    fs.rmSync(parent, { recursive: true, force: true })
  }
})

// The Pencil pressed at `from`, carried by `by` in four steps, and lifted.
async function pen_drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page)
  const steps = 4

  try {
    for (let n = 0; n <= steps + 1; n += 1) {
      const type = n === 0 ? 'mousePressed' : n > steps ? 'mouseReleased' : 'mouseMoved'
      const along = Math.min(n, steps) / steps
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: from.x + by.x * along,
        y: from.y + by.y * along,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        pointerType: 'pen',
        force: 0.5,
        clickCount: 1,
      })
    }
  } finally {
    await cdp.detach()
  }
}
