// A native rehearsal, judged by what the Mac stage paints. A linked legacy board is made by the
// board's own code, copied, and rehearsed through the real command line. The copy of the source
// is served and its stage shows the sketch, with the Agent canvas printed under it; then the
// native copy is served and its stage shows the same shapes as one scene. Each Agent shape must
// sit where it sat beside the strokes, at the same size, and still under the strokes.
//
// Run: bun run build && npx playwright test tests/native_rehearsal.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { command, navigation_ms, step } from './whiteboard_board'

type Box = { x: number; y: number; width: number; height: number }
type Layout = Record<string, Box>

// The strokes the person drew, and the Agent shapes compared between the two stages.
const strokes = ['shape:hill', 'shape:sun']
const agent_shapes = ['shape:scene-api', 'shape:scene-db', 'shape:scene-pic.0']

// Two renderings of one record agree within a few percent of the distance between the strokes.
const tolerance_fraction = 0.04

test('a rehearsed native copy shows every shape where the legacy board did', async ({
  browser,
}) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-e2e-')))
  const [source, copy, native, live] = ['source', 'copy', 'native', 'live'].map((name) =>
    path.join(parent, name),
  ) as [string, string, string, string]
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultNavigationTimeout(navigation_ms)

  try {
    const session = await step('make, copy and rehearse a linked legacy board', async () => {
      fs.mkdirSync(live)
      const made = spawnSync(
        process.env.BUN ?? 'bun',
        ['tests/fixtures/native-rehearsal/legacy_board.ts', source],
        {
          encoding: 'utf8',
          timeout: 30_000,
        },
      )
      expect(made.status).toBe(0)
      const id = String(JSON.parse(made.stdout).session)
      fs.cpSync(source, copy, { recursive: true })
      const rehearsed = command(
        live,
        'native-rehearse',
        '--source',
        copy,
        '--session',
        id,
        '--out',
        native,
      )
      expect(rehearsed).toMatchObject({ status: 'success', code: 'rehearsed', session: id })
      return id
    })

    const legacy = await step('the legacy stage prints the canvas under the sketch', () =>
      layout_read(page, copy, session, 'legacy'),
    )
    const converted = await step('the native stage shows one scene', () =>
      layout_read(page, native, session, 'native'),
    )
    await step('every Agent shape keeps its place and size beside the strokes', async () => {
      layouts_compare(legacy, converted)
    })
  } finally {
    await page.close()

    for (const root of [copy, native]) {
      if (fs.existsSync(root)) command(root, 'stop')
    }

    fs.rmSync(parent, { recursive: true, force: true })
  }
})

// Serves the board at `root`, opens its stage, and measures every shape the person can see.
async function layout_read(page: Page, root: string, session: string, kind: string) {
  expect(command(root, 'start', '--no-open').status).toBe('success')

  try {
    const listed = command(root, 'session-list').sessions as { id: string; stage_url: string }[]
    const board = listed.find((candidate) => candidate.id === session)
    expect(board).toBeDefined()
    await page.goto(board!.stage_url)
    const agent = (id: string) =>
      kind === 'legacy'
        ? page.locator(`.print__shape[data-print-shape="${id}"]`)
        : page.locator(`.surface .tl-shape[data-shape-id="${id}"]`)
    const stroke = (id: string) => page.locator(`.surface .tl-shape[data-shape-id="${id}"]`)

    for (const id of strokes) await expect(stroke(id)).toBeVisible()

    for (const id of agent_shapes) await expect(agent(id)).toBeVisible()

    const found: Layout = {}

    for (const id of strokes) found[id] = (await stroke(id).boundingBox())!

    for (const id of agent_shapes) found[id] = (await agent(id).boundingBox())!

    if (kind === 'native') await stacking_check(page)

    return found
  } finally {
    expect(command(root, 'stop').status).toBe('success')
  }
}

// On the native stage the Agent shapes are painted under the person's strokes, as the print was.
async function stacking_check(page: Page) {
  const z = (id: string) =>
    page
      .locator(`.surface .tl-shape[data-shape-id="${id}"]`)
      .evaluate((element) => Number(getComputedStyle(element).zIndex))
  const lowest_stroke = Math.min(...(await Promise.all(strokes.map(z))))

  for (const id of agent_shapes) expect(await z(id)).toBeLessThan(lowest_stroke)
}

// Each Agent shape's centre and size, in units of the distance between the two strokes,
// measured from the hill: the same on both stages whatever the zoom.
function layouts_compare(legacy: Layout, native: Layout) {
  const centre = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const unit = (layout: Layout) => {
    const hill = centre(layout['shape:hill']!)
    const sun = centre(layout['shape:sun']!)
    return { origin: hill, length: Math.hypot(sun.x - hill.x, sun.y - hill.y) }
  }
  const scaled = (layout: Layout, id: string) => {
    const { origin, length } = unit(layout)
    const box = layout[id]!
    const middle = centre(box)
    return [
      (middle.x - origin.x) / length,
      (middle.y - origin.y) / length,
      box.width / length,
      box.height / length,
    ]
  }

  for (const id of agent_shapes) {
    const before = scaled(legacy, id)
    const after = scaled(native, id)
    const drift = before.map((value, index) => Math.abs(value - after[index]!))
    expect({ id, drift_max: Math.max(...drift) }).toEqual({ id, drift_max: expect.any(Number) })
    expect(Math.max(...drift)).toBeLessThan(tolerance_fraction)
  }
}
