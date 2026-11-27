// One native scene in a real browser and editor: the stock tldraw 4.2.3 editor on two pages,
// synced to a disposable pinned `TLSocketRoom` (`tests/fixtures/native-scene/server.ts`). The
// iPad page edits; the Mac page is a read-only session refused at the server. An agent writes
// native records through the room's `updateStore`. Nothing here touches the product board.
//
// The user acts only through pointer and keyboard. The pages' editors are read to map shapes to
// the screen and to observe what they render; the room's own records are the verdict.
//
// Run: npx playwright test tests/native_scene.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { child_stop, contexts_close } from './board_child'

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture_server = path.join(repo_root, 'tests', 'fixtures', 'native-scene', 'server.ts')
const bun = process.env.BUN ?? 'bun'
const ready_wait_ms = 20_000
const viewport = { width: 1180, height: 820 }
const agent_id = 'shape:agent-box'

type Point = { x: number; y: number }
type Document = { state: Record<string, unknown>; changed_clock: number }
type Records = { document_clock: number; documents: Document[] }
type Shape = {
  id: string
  x: number
  y: number
  index: string
  parentId: string
  meta: Record<string, unknown>
  props: Record<string, unknown>
}

let port = 0
let server: ChildProcess | null = null

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

test.beforeAll(async () => {
  port = await port_free_pick()
  server = spawn(bun, [fixture_server, String(port)], { cwd: repo_root, stdio: 'ignore' })
  const deadline_ms = Date.now() + ready_wait_ms

  while (Date.now() < deadline_ms) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/records`)).ok) return
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('the native scene fixture did not start')
})

test.afterAll(async () => {
  if (server !== null) await child_stop(server)
})

async function records(): Promise<Records> {
  const response = await fetch(`http://127.0.0.1:${port}/records`)
  expect(response.ok).toBe(true)
  return (await response.json()) as Records
}

async function shape(id: string): Promise<Shape | null> {
  const document = (await records()).documents.find((candidate) => candidate.state.id === id)
  return document === undefined ? null : (document.state as unknown as Shape)
}

async function shapes_count(): Promise<number> {
  const { documents } = await records()
  return documents.filter((document) => document.state.typeName === 'shape').length
}

async function agent_write(body: { put?: unknown[]; delete?: string[] }): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/agent`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { document_clock: number }).document_clock
}

function agent_box(color: string, index: string): Shape {
  return {
    id: agent_id,
    x: 300,
    y: 200,
    index,
    parentId: 'page:native',
    meta: { origin: 'agent' },
    props: {
      w: 240,
      h: 160,
      geo: 'rectangle',
      dash: 'solid',
      growY: 0,
      url: '',
      scale: 1,
      color,
      labelColor: 'black',
      fill: 'solid',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: { type: 'doc', content: [{ type: 'paragraph' }] },
    },
    ...{ typeName: 'shape', type: 'geo', rotation: 0, isLocked: false, opacity: 1 },
  }
}

async function scene_open(page: Page, role: 'ipad' | 'mac'): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/?role=${role}`)
  await page.waitForFunction(() => 'native_scene_editor' in window)
}

// The shape's centre in the page's viewport, which is the window: the editor fills it.
async function shape_center(page: Page, id: string): Promise<Point> {
  return await page.evaluate((shape_id) => {
    const editor = (window as unknown as { native_scene_editor: EditorView }).native_scene_editor
    const bounds = editor.getShapePageBounds(shape_id)

    if (bounds === undefined) throw new Error(`the page has no ${shape_id}`)

    return editor.pageToViewport(bounds.center)
  }, id)
}

// Painted order, back to front, from the shapes' rendered stacking in the DOM.
async function painted_order(page: Page): Promise<string[]> {
  return await page.locator('.tl-shape[data-shape-type="geo"]').evaluateAll((elements) =>
    elements
      .map((element) => ({
        id: element.getAttribute('data-shape-id') ?? '',
        z: Number(getComputedStyle(element).zIndex),
      }))
      .sort((a, b) => a.z - b.z)
      .map((entry) => entry.id),
  )
}

async function drag(page: Page, from: Point, by: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 12 })
  await page.mouse.up()
}

type EditorView = {
  getShapePageBounds(id: string): { center: Point } | undefined
  pageToViewport(point: Point): Point
  getShape(id: string): Shape | undefined
  getIsReadonly(): boolean
  getSelectedShapeIds(): string[]
  getCurrentPageShapes(): Shape[]
  store: { put(records: unknown[]): void }
}

// A gesture can push more than once: a new rectangle appears, then takes its final size. The
// page's pushes have all landed when the room's shapes equal the editor's, field for field.
async function room_matches(page: Page): Promise<boolean> {
  const editor_shapes = await page.evaluate(() => {
    const editor = (window as unknown as { native_scene_editor: EditorView }).native_scene_editor
    return editor.getCurrentPageShapes()
  })
  const room_shapes = (await records()).documents
    .filter((document) => document.state.typeName === 'shape')
    .map((document) => document.state)
  const by_id = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.id).localeCompare(String(b.id))
  return isDeepStrictEqual(editor_shapes.sort(by_id), room_shapes.sort(by_id))
}

async function is_readonly(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const editor = (window as unknown as { native_scene_editor: EditorView }).native_scene_editor
    return editor.getIsReadonly()
  })
}

async function selected(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const editor = (window as unknown as { native_scene_editor: EditorView }).native_scene_editor
    return editor.getSelectedShapeIds()
  })
}

async function editor_shape(page: Page, id: string): Promise<Shape | null> {
  return await page.evaluate((shape_id) => {
    const editor = (window as unknown as { native_scene_editor: EditorView }).native_scene_editor
    return editor.getShape(shape_id) ?? null
  }, id)
}

test('the iPad moves and undoes an agent shape in place; the stage only watches', async ({
  browser,
}) => {
  const contexts = [await browser.newContext({ viewport }), await browser.newContext({ viewport })]

  try {
    const ipad = await contexts[0]!.newPage()
    const mac = await contexts[1]!.newPage()
    await scene_open(ipad, 'ipad')
    await scene_open(mac, 'mac')
    expect(await is_readonly(mac)).toBe(true)
    expect(await is_readonly(ipad)).toBe(false)

    await agent_write({ put: [agent_box('red', 'a2')] })
    await expect.poll(async () => (await editor_shape(ipad, agent_id))?.x).toBe(300)
    await expect.poll(async () => (await editor_shape(mac, agent_id))?.x).toBe(300)

    // The user drags the agent's shape: the same record moves, nothing is copied.
    await drag(ipad, await shape_center(ipad, agent_id), { x: 200, y: 0 })
    await expect.poll(async () => (await shape(agent_id))?.x).toBe(500)
    expect(await shapes_count()).toBe(1)
    expect((await shape(agent_id))!.meta).toEqual({ origin: 'agent' })
    await expect.poll(async () => (await editor_shape(mac, agent_id))?.x).toBe(500)

    await ipad.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await shape(agent_id))?.x).toBe(300)
    await ipad.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await shape(agent_id))?.x).toBe(500)

    // The agent recolours the shape after the user's move; the user's undo then restores the
    // whole record it remembers, reverting the agent's colour along with the move.
    const moved = (await shape(agent_id))!
    await agent_write({ put: [{ ...moved, props: { ...moved.props, color: 'blue' } }] })
    await expect.poll(async () => (await editor_shape(ipad, agent_id))?.props.color).toBe('blue')
    await ipad.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await shape(agent_id))?.x).toBe(300)
    expect((await shape(agent_id))!.props.color).toBe('red')

    // The stage cannot move it by pointer, nor by writing to its own store.
    await expect.poll(() => room_matches(ipad)).toBe(true)
    const clock_before = (await records()).document_clock
    await drag(mac, await shape_center(mac, agent_id), { x: -150, y: 80 })
    await mac.evaluate((id) => {
      const editor = (window as unknown as { native_scene_editor: EditorView }).native_scene_editor
      editor.store.put([{ ...editor.getShape(id), x: 999 }])
    }, agent_id)
    await expect.poll(async () => (await editor_shape(mac, agent_id))?.x).toBe(300)
    expect((await shape(agent_id))!.x).toBe(300)
    expect((await records()).document_clock).toBe(clock_before)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})

test('stacking is per object, in either order, whoever reorders', async ({ browser }) => {
  const contexts = [await browser.newContext({ viewport }), await browser.newContext({ viewport })]

  try {
    const ipad = await contexts[0]!.newPage()
    const mac = await contexts[1]!.newPage()
    await scene_open(ipad, 'ipad')
    await scene_open(mac, 'mac')
    await agent_write({ put: [agent_box('red', 'a2')] })
    await expect.poll(async () => (await editor_shape(ipad, agent_id))?.x).toBe(300)

    // The user draws a rectangle across the agent's with the geo tool: new shapes go on top.
    await ipad.keyboard.press('r')
    const corner = await shape_center(ipad, agent_id)
    await drag(ipad, { x: corner.x - 60, y: corner.y - 40 }, { x: 220, y: 150 })
    await expect.poll(shapes_count).toBe(2)
    await expect.poll(() => room_matches(ipad)).toBe(true)
    const user = (await records()).documents.find(
      (document) => document.state.typeName === 'shape' && document.state.id !== agent_id,
    )!.state as unknown as Shape
    await expect.poll(() => painted_order(mac)).toEqual([agent_id, user.id])
    await expect.poll(() => painted_order(ipad)).toEqual([agent_id, user.id])

    // The agent brings its shape forward through the room; only its record changes.
    const user_clock = (await records()).documents.find(
      (d) => d.state.id === user.id,
    )!.changed_clock
    const agent_now = (await shape(agent_id))!
    await agent_write({ put: [{ ...agent_now, index: `${user.index}V` }] })
    await expect.poll(() => painted_order(mac)).toEqual([user.id, agent_id])
    await expect.poll(() => painted_order(ipad)).toEqual([user.id, agent_id])
    await expect.poll(() => room_matches(ipad)).toBe(true)
    const after = (await records()).documents.find((d) => d.state.id === user.id)!
    expect(after.changed_clock).toBe(user_clock)

    // The user brings theirs back to the front with the editor's own shortcut.
    await ipad.mouse.click(corner.x + 140, corner.y + 95)
    await expect.poll(() => selected(ipad)).toEqual([user.id])
    await ipad.keyboard.press(']')
    await expect.poll(() => painted_order(mac)).toEqual([agent_id, user.id])
    expect((await shape(agent_id))!.index).toBe(`${user.index}V`)
  } finally {
    console.log(`contexts closed after ${await contexts_close(contexts)}ms`)
  }
})
