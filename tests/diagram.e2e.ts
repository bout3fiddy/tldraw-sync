// The semantic diagram journey in a real browser against the real board: draw, snapshot as an
// agent would, publish the synthetic nested-groups fixture as a semantic diagram (the command
// line composes it), then measure the native tldraw shapes the Cleaned canvas actually renders.
//
// Meaning is checked first: every label, group and connector of the fixture is on the canvas.
// Then geometry, from real browser bounds: labels inside their shapes, items inside their groups
// below the heading, no overlapping items, connectors that do not run through items they do not
// join, everything inside the pane, and text large enough to read. Then a refused publish, and
// a restart. None of this measures whether an agent read a sketch correctly.
//
// Run: bun run build && npx playwright test   (Bun and a Playwright Chromium on the host)

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli_entry = path.join(repo_root, 'src', 'cli', 'main.ts')
const fixture_path = path.join(repo_root, 'tests', 'fixtures', 'nested_groups.diagram.json')
const bun = process.env.BUN ?? 'bun'
const data_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-diagram-e2e-'))
const out_directory = path.join(data_directory, 'cleanup')
const ready_wait_ms = 20_000

type Fixture = {
  nodes: Array<{ id: string; kind: string; label: string; parent?: string }>
  edges: Array<{ id: string; from: string; to: string; label?: string }>
}
const fixture = JSON.parse(fs.readFileSync(fixture_path, 'utf8')) as Fixture

// Standalone text, ovals with long labels and an empty group, whose label fit is measured
// against the actual oval and text geometry rather than the shapes' bounding boxes.
const ovals_path = path.join(repo_root, 'tests', 'fixtures', 'text_and_ovals.diagram.json')
const fixture_ovals = JSON.parse(fs.readFileSync(ovals_path, 'utf8')) as Fixture

let port = 0
let server: ChildProcess | null = null

type CliResult = { exit_code: number; json: Record<string, unknown> }

function cli(...args: string[]): CliResult {
  const result = spawnSync(bun, [cli_entry, ...args, '--json'], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const json = JSON.parse(result.stdout) as Record<string, unknown>
  return { exit_code: result.status ?? -1, json }
}

async function port_free_pick(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      listener.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function server_start(): Promise<void> {
  server = spawn(bun, [cli_entry, 'serve', '--port', String(port)], {
    cwd: repo_root,
    env: { ...process.env, BOARD_DATA_DIR: data_directory },
    stdio: 'ignore',
  })
  const deadline_ms = Date.now() + ready_wait_ms

  while (Date.now() < deadline_ms) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`)

      if (response.ok) return
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('the board did not start')
}

async function server_stop(): Promise<void> {
  const child = server
  server = null

  if (child === null || child.exitCode !== null) return

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await exited
}

async function status(): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`)
  return (await response.json()) as Record<string, unknown>
}

async function stroke(page: Page): Promise<void> {
  const box = await page.locator('section[aria-label="Sketch"]').boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width * 0.4
  const y = box!.y + box!.height * 0.5
  await page.mouse.move(x, y)
  await page.mouse.down()

  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(x + step * 8, y + Math.sin(step) * 20, { steps: 2 })
  }

  await page.mouse.up()
}

function diagram_write(
  snapshot: string,
  base_revision: number,
  extra: object = {},
  source: Fixture = fixture,
): string {
  const file = path.join(out_directory, 'diagram.json')
  fs.mkdirSync(out_directory, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...source, snapshot, base_revision, ...extra }))
  return file
}

test.beforeAll(async () => {
  port = await port_free_pick()
  await server_start()
})

test.afterAll(async () => {
  await server_stop()
  fs.rmSync(data_directory, { recursive: true, force: true })
})

type Rect = { x: number; y: number; w: number; h: number }
type Measured = {
  pane: Rect
  shapes: Record<
    string,
    {
      type: string
      rect: Rect
      text: string
      text_rect: Rect | null
      line_rects: Rect[]
      line_height_px_min: number | null
      points: Array<{ x: number; y: number }>
    }
  >
}

// Real browser bounds of every cleaned shape, its label's text, and sampled connector paths.
async function cleaned_measure(page: Page): Promise<Measured> {
  return await page.evaluate(async () => {
    await document.fonts.ready
    const to_rect = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height })
    const pane = document.querySelector('section[aria-label="Cleaned"]') as HTMLElement
    const shapes: Measured['shapes'] = {}
    const selector = '.tl-shape[data-shape-id]:not(.tl-shape-background)'

    for (const element of Array.from(pane.querySelectorAll<HTMLElement>(selector))) {
      const id = (element.dataset.shapeId ?? '').replace('shape:cleaned-', '')
      const content = element.querySelector('.tl-text-content')
      const text = content?.textContent ?? ''
      let text_rect: Rect | null = null
      let line_rects: Rect[] = []
      let line_height_px_min: number | null = null

      if (content !== null && text.length > 0) {
        const range = document.createRange()
        range.selectNodeContents(content)
        text_rect = to_rect(range.getBoundingClientRect())
        const lines = Array.from(range.getClientRects()).filter((rect) => rect.height > 0)
        line_rects = lines.map(to_rect)
        line_height_px_min = Math.min(...lines.map((rect) => rect.height))
      }

      const points: Array<{ x: number; y: number }> = []

      if (element.dataset.shapeType === 'arrow') {
        for (const path of Array.from(element.querySelectorAll('path'))) {
          if (path.closest('defs, clipPath, mask') !== null) continue

          const matrix = path.getScreenCTM()
          const length = path.getTotalLength()

          if (matrix === null || !(length > 0)) continue

          for (let index = 0; index <= 48; index += 1) {
            const point = path.getPointAtLength((length * index) / 48)
            points.push({
              x: matrix.a * point.x + matrix.c * point.y + matrix.e,
              y: matrix.b * point.x + matrix.d * point.y + matrix.f,
            })
          }
        }
      }

      shapes[id] = {
        type: element.dataset.shapeType ?? '',
        rect: to_rect(element.getBoundingClientRect()),
        text,
        text_rect,
        line_rects,
        line_height_px_min,
        points,
      }
    }

    return { pane: to_rect(pane.getBoundingClientRect()), shapes }
  })
}

// The canvas refits with a short animation when its pane changes size: wait until two
// measurements a moment apart agree.
async function cleaned_measure_stable(page: Page): Promise<Measured> {
  let previous = ''

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const measured = await cleaned_measure(page)
    const key = JSON.stringify(Object.values(measured.shapes).map((shape) => shape.rect))

    if (key === previous && Object.keys(measured.shapes).length > 0) return measured

    previous = key
    await page.waitForTimeout(250)
  }

  throw new Error('the cleaned canvas did not settle')
}

const tolerance_px = 1.5

function inside(inner: Rect, outer: Rect, margin_px = 0): boolean {
  return (
    inner.x >= outer.x + margin_px - tolerance_px &&
    inner.y >= outer.y + margin_px - tolerance_px &&
    inner.x + inner.w <= outer.x + outer.w - margin_px + tolerance_px &&
    inner.y + inner.h <= outer.y + outer.h - margin_px + tolerance_px
  )
}

function overlap(a: Rect, b: Rect, inset_px: number): boolean {
  return (
    a.x + a.w > b.x + inset_px &&
    b.x + b.w - inset_px > a.x &&
    a.y + a.h > b.y + inset_px &&
    b.y + b.h - inset_px > a.y
  )
}

function ancestors(id: string, source: Fixture): Set<string> {
  const found = new Set<string>()
  let parent = source.nodes.find((node) => node.id === id)?.parent

  while (parent !== undefined) {
    found.add(parent)
    parent = source.nodes.find((node) => node.id === parent)?.parent
  }

  return found
}

// Every corner of every drawn line of an oval's label lies inside the drawn ellipse.
function oval_overflow(shape: Measured['shapes'][string]): boolean {
  const a = shape.rect.w / 2
  const b = shape.rect.h / 2
  const cx = shape.rect.x + a
  const cy = shape.rect.y + b

  return shape.line_rects.some((line) =>
    [line.x, line.x + line.w].some((x) =>
      [line.y, line.y + line.h].some(
        (y) => ((x - cx) / (a + tolerance_px)) ** 2 + ((y - cy) / (b + tolerance_px)) ** 2 > 1,
      ),
    ),
  )
}

// Meaning first, then geometry, all from what the browser drew.
function diagram_check(
  measured: Measured,
  line_height_px_min: number,
  source: Fixture = fixture,
): string[] {
  const problems: string[] = []
  const { shapes } = measured
  const leaves = source.nodes.filter((node) => node.kind !== 'group')

  for (const node of source.nodes) {
    const shape = shapes[node.id]

    if (shape === undefined) {
      problems.push(`${node.id}: not drawn`)
      continue
    }

    if (shape.text !== node.label) problems.push(`${node.id}: shows "${shape.text}"`)

    if (shape.text_rect !== null && !inside(shape.text_rect, shape.rect)) {
      problems.push(`${node.id}: label overflows its shape`)
    }

    if (node.kind === 'ellipse' && oval_overflow(shape)) {
      problems.push(`${node.id}: label reaches past its oval`)
    }

    if (node.kind === 'text' && (shape.type !== 'text' || shape.line_rects.length === 0)) {
      problems.push(`${node.id}: standalone text not drawn as text`)
    }

    if ((shape.line_height_px_min ?? Infinity) < line_height_px_min) {
      problems.push(`${node.id}: text lines ${shape.line_height_px_min}px high`)
    }

    if (!inside(shape.rect, measured.pane)) problems.push(`${node.id}: outside the pane`)

    const parent = node.parent === undefined ? undefined : shapes[node.parent]

    if (parent !== undefined) {
      if (!inside(shape.rect, parent.rect, 4)) problems.push(`${node.id}: outside its group`)

      const heading = parent.text_rect

      if (heading !== null && heading.y + heading.h > shape.rect.y + tolerance_px) {
        problems.push(`${node.id}: under its group's heading`)
      }
    }
  }

  for (const [index, a] of leaves.entries()) {
    for (const b of leaves.slice(index + 1)) {
      const [ra, rb] = [shapes[a.id]?.rect, shapes[b.id]?.rect]

      if (ra !== undefined && rb !== undefined && overlap(ra, rb, 0)) {
        problems.push(`${a.id} overlaps ${b.id}`)
      }
    }
  }

  return [...problems, ...connectors_check(measured, source)]
}

function connectors_check(measured: Measured, source: Fixture): string[] {
  const problems: string[] = []

  for (const edge of source.edges) {
    const arrow = measured.shapes[edge.id]

    if (arrow === undefined || arrow.points.length === 0) {
      problems.push(`${edge.id}: no connector drawn`)
      continue
    }

    if (arrow.text !== (edge.label ?? '')) problems.push(`${edge.id}: labelled "${arrow.text}"`)

    const holders = new Set([...ancestors(edge.from, source), ...ancestors(edge.to, source)])
    const unrelated = source.nodes.filter(
      (node) => node.id !== edge.from && node.id !== edge.to && !holders.has(node.id),
    )

    for (const node of unrelated) {
      const rect = measured.shapes[node.id]?.rect

      if (rect === undefined) continue

      const crossing = arrow.points.find(
        (point) =>
          point.x > rect.x + 2 &&
          point.x < rect.x + rect.w - 2 &&
          point.y > rect.y + 2 &&
          point.y < rect.y + rect.h - 2,
      )

      if (crossing !== undefined) problems.push(`${edge.id}: runs through ${node.id}`)

      if (arrow.text_rect !== null && overlap(arrow.text_rect, rect, 2)) {
        problems.push(`${edge.id}: its label covers ${node.id}`)
      }
    }
  }

  return problems
}

async function evidence(page: Page, info: TestInfo, name: string, measured: Measured) {
  const file = info.outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await info.attach(name, { path: file, contentType: 'image/png' })
  const heights = Object.values(measured.shapes)
    .map((shape) => shape.line_height_px_min)
    .filter((height): height is number => height !== null)
  info.annotations.push({
    type: name,
    description: `smallest text line ${Math.min(...heights).toFixed(1)}px; pane ${Math.round(
      measured.pane.w,
    )}x${Math.round(measured.pane.h)}px`,
  })
}

test('a semantic diagram is composed, rendered legibly, refused when invalid, and kept', async ({
  browser,
}, info) => {
  const origin = `http://127.0.0.1:${port}`
  const stage = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage()
  const ipad = await (
    await browser.newContext({ viewport: { width: 1180, height: 820 } })
  ).newPage()
  await stage.goto(origin)
  await ipad.goto(`${origin}/draw`)

  // An agent's turn: snapshot, write the diagram, publish. The ink is left exactly as drawn.
  await stroke(ipad)
  await expect.poll(async () => (await status()).shapes_count).toBe(1)
  const snapshot = cli('cleanup-snapshot', '--no-open', '--out', out_directory)
  expect(snapshot.json).toMatchObject({ code: 'snapshot_saved', previous_diagram_path: null })
  const ink_before = await status()
  const published = cli(
    'cleanup-publish',
    '--file',
    diagram_write(String(snapshot.json.snapshot), 0),
  )
  expect(published.json).toMatchObject({ code: 'published', revision: 1, shapes_count: 20 })
  const ink_after = await status()
  expect(ink_after.document_hash).toBe(ink_before.document_hash)
  expect(ink_after.shapes_count).toBe(1)

  // The Cleaned tab at a laptop size: everything drawn, legible and clear.
  await stage.getByRole('tab', { name: 'Cleaned' }).click()
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Release review board'),
  ).toBeVisible()
  const cleaned = await cleaned_measure_stable(stage)
  expect(diagram_check(cleaned, 16)).toEqual([])
  await evidence(stage, info, 'cleaned-1280x800', cleaned)

  // Side by side on the iPad: the same diagram fits its half and stays clear, at a smaller size.
  await ipad.getByRole('tab', { name: 'Side by side' }).click()
  await expect(ipad.locator('section[aria-label="Sketch"]')).toBeVisible()
  const split = await cleaned_measure_stable(ipad)
  expect(diagram_check(split, 8)).toEqual([])
  await evidence(ipad, info, 'split-1180x820', split)

  // An invalid diagram is refused with its path, and the published one stays.
  const broken = cli(
    'cleanup-publish',
    '--file',
    diagram_write(String(snapshot.json.snapshot), 1, { flow: 'sideways' }),
  )
  expect(broken.exit_code).toBe(1)
  expect(broken.json).toMatchObject({ code: 'invalid_diagram' })
  expect(String(broken.json.message)).toContain('diagram.flow')
  expect(await status()).toMatchObject({ cleaned_revision: 1 })
  expect(diagram_check(await cleaned_measure_stable(ipad), 8)).toEqual([])

  // A restart keeps the styled diagram and the interpretation behind it.
  await server_stop()
  await server_start()
  await stage.reload()
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Release review board'),
  ).toBeVisible()
  const restarted = await cleaned_measure_stable(stage)
  expect(diagram_check(restarted, 16)).toEqual([])
  expect(Object.keys(restarted.shapes).sort()).toEqual(Object.keys(cleaned.shapes).sort())
  const again = cli('cleanup-snapshot', '--no-open', '--out', out_directory)
  const previous = JSON.parse(fs.readFileSync(String(again.json.previous_diagram_path), 'utf8'))
  expect(previous.nodes.map((node: { id: string }) => node.id)).toEqual(
    fixture.nodes.map((node) => node.id),
  )
  expect(await status()).toMatchObject({ shapes_count: 1, cleaned_revision: 1 })

  // Standalone text, long oval labels and an empty group, measured against the drawn text and
  // the drawn ellipses, at both sizes.
  const ovals = cli(
    'cleanup-publish',
    '--file',
    diagram_write(String(again.json.snapshot), 1, {}, fixture_ovals),
  )
  expect(ovals.json).toMatchObject({ code: 'published', revision: 2, shapes_count: 13 })
  await expect(
    stage.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Plain lines join peers'),
  ).toBeVisible()
  const ovals_cleaned = await cleaned_measure_stable(stage)
  expect(diagram_check(ovals_cleaned, 16, fixture_ovals)).toEqual([])
  expect(Object.keys(ovals_cleaned.shapes).sort()).toEqual(
    [...fixture_ovals.nodes, ...fixture_ovals.edges].map((item) => item.id).sort(),
  )
  await evidence(stage, info, 'ovals-cleaned-1280x800', ovals_cleaned)

  // The iPad page outlived the restart; reload it so it shows the board as it is now.
  await ipad.reload()
  await ipad.getByRole('tab', { name: 'Side by side' }).click()
  await expect(
    ipad.locator('section[aria-label="Cleaned"] .tl-shape').getByText('Plain lines join peers'),
  ).toBeVisible()
  const ovals_split = await cleaned_measure_stable(ipad)
  expect(diagram_check(ovals_split, 8, fixture_ovals)).toEqual([])
  await evidence(ipad, info, 'ovals-split-1180x820', ovals_split)
  expect(await status()).toMatchObject({ shapes_count: 1, cleaned_revision: 2 })
})
