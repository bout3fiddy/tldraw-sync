// A native board, end to end: the real command line links it and edits it as a host does, the
// Mac stage shows it, and a paired iPad draws on it with a pen and undoes with its own Undo and
// Redo. The person draws a rough box; the agent tidies that same stroke in place; the person
// draws an arrow; Undo takes back the arrow, then the tidy, to the exact pressure the pen left;
// Redo brings both back in order. A stale agent edit is refused without touching the scene.
//
// The room's own records are the verdict, read from the board as any client would; the stage
// is checked by what it paints.
//
// Run: bun run build && npx playwright test tests/native_board.e2e.ts

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { board_linked, step } from './whiteboard_board'

type Point = { x: number; y: number; z: number }
type Shape = { id: string; type: string; x: number; y: number; props: Record<string, any> }
type PenPoint = { x: number; y: number; force: number }

async function shapes(origin: string, session: string): Promise<Shape[]> {
  const response = await fetch(`${origin}/api/drawing.json?session=${session}`)
  expect(response.ok).toBe(true)
  const list = (await response.json()) as Shape[]
  return list.sort((a, b) => a.id.localeCompare(b.id))
}

function points(shape: Shape | undefined): Point[] | null {
  return shape === undefined ? null : (shape.props.segments[0].points as Point[])
}

// A pen pressed at the first point, carried through the rest with their own pressure, lifted.
async function pen(ipad: Page, path_points: readonly PenPoint[]): Promise<void> {
  const cdp = await ipad.context().newCDPSession(ipad)

  try {
    for (const [index, point] of path_points.entries()) {
      const last = index === path_points.length - 1
      const type = index === 0 ? 'mousePressed' : last ? 'mouseReleased' : 'mouseMoved'
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: last ? 0 : 1,
        pointerType: 'pen',
        force: point.force,
        clickCount: 1,
      })
    }
  } finally {
    await cdp.detach()
  }
}

// The outline the stage paints for a shape: what a person watching the Mac sees change.
async function painted(stage: Page, id: string): Promise<string> {
  const outline = stage.locator(`.surface .tl-shape[data-shape-id="${id}"] path`).first()
  return (await outline.getAttribute('d')) ?? ''
}

const rough_box: PenPoint[] = [
  { x: 320, y: 320, force: 0.2 },
  { x: 420, y: 316, force: 0.45 },
  { x: 522, y: 326, force: 0.7 },
  { x: 518, y: 400, force: 0.55 },
  { x: 526, y: 470, force: 0.35 },
  { x: 420, y: 476, force: 0.6 },
  { x: 316, y: 468, force: 0.8 },
  { x: 324, y: 396, force: 0.4 },
  { x: 321, y: 322, force: 0.3 },
]

const arrow: PenPoint[] = [
  { x: 340, y: 640, force: 0.5 },
  { x: 440, y: 642, force: 0.6 },
  { x: 540, y: 640, force: 0.5 },
  { x: 510, y: 615, force: 0.4 },
  { x: 540, y: 640, force: 0.5 },
  { x: 512, y: 668, force: 0.4 },
]

test('the agent tidies the person’s box in place, and one Undo and Redo walk both back', async ({
  browser,
}) => {
  await board_linked(
    browser,
    async ({ bound, ipad, stage, origin, session, root, linked }) => {
      expect(linked.native).toBe(true)
      const undo = ipad.getByRole('button', { name: 'Undo', exact: true })
      const redo = ipad.getByRole('button', { name: 'Redo', exact: true })
      let rough: Shape | null = null
      let tidied_points: Point[] = []
      let painted_rough = ''
      let edit_file = ''

      await step('the person draws a rough box with the pen', async () => {
        await pen(ipad, rough_box)
        await expect
          .poll(async () => (await shapes(origin, session))[0]?.props.isComplete)
          .toBe(true)
        rough = (await shapes(origin, session))[0]!
        expect(rough.type).toBe('draw')
        const pressures = new Set(points(rough)!.map((point) => point.z))
        expect(pressures.size).toBeGreaterThan(1)
        await expect.poll(() => painted(stage, rough!.id)).not.toBe('')
        painted_rough = await painted(stage, rough.id)
      })

      await step('the agent reads the scene and tidies the same stroke', async () => {
        const read = bound('scene')
        expect(read.status).toBe('success')
        const scene = JSON.parse(fs.readFileSync(read.scene_path, 'utf8'))
        const record = scene.records.find((r: Shape) => r.id === rough!.id)
        expect(record).toEqual(rough)
        const { w, h } = { w: 200, h: 150 }
        tidied_points = [
          { x: 0, y: 0, z: 0.5 },
          { x: w, y: 0, z: 0.5 },
          { x: w, y: h, z: 0.5 },
          { x: 0, y: h, z: 0.5 },
          { x: 0, y: 0, z: 0.5 },
        ]
        const tidied = {
          ...record,
          props: { ...record.props, segments: [{ type: 'free', points: tidied_points }] },
        }
        edit_file = path.join(root, 'tidy.json')
        const edit = {
          base_sequence: scene.base_sequence,
          adds: [],
          updates: [{ record: tidied, base_hash: scene.hashes[record.id] }],
          deletes: [],
        }
        fs.writeFileSync(edit_file, JSON.stringify(edit))
        const written = bound('edit', '--file', edit_file)
        expect([written.code, written.sequence]).toEqual(['edit_written', 1])
        await expect
          .poll(async () => points((await shapes(origin, session))[0]))
          .toEqual(tidied_points)
        await expect.poll(() => painted(stage, rough!.id)).not.toBe(painted_rough)

        // Running the same file again is a retry: answered, and nothing applied twice.
        const again = bound('edit', '--file', edit_file)
        expect([again.code, again.sequence]).toEqual(['edit_replayed', 1])
      })

      await step('an agent edit of bytes that have changed is refused whole', async () => {
        const stale = JSON.parse(fs.readFileSync(edit_file, 'utf8'))
        stale.request_id = 'stale-edit-0001'
        stale.updates[0].record.x += 300
        const stale_file = path.join(root, 'stale.json')
        fs.writeFileSync(stale_file, JSON.stringify(stale))
        const refused = bound('edit', '--file', stale_file)
        expect([refused.status, refused.code]).toEqual(['failure', 'conflict'])
        expect(refused.message).toContain('stale_base')
        expect(points((await shapes(origin, session))[0])).toEqual(tidied_points)
      })

      let arrow_shape: Shape | null = null

      await step('the person draws an arrow', async () => {
        await pen(ipad, arrow)
        const drawn = async () =>
          (await shapes(origin, session)).find((shape) => shape.id !== rough!.id)
        await expect.poll(async () => (await drawn())?.props.isComplete).toBe(true)
        arrow_shape = (await drawn())!
      })

      await step(
        'Undo takes back the arrow, then the tidy, to the pen’s exact pressure',
        async () => {
          await undo.click()
          await expect.poll(async () => (await shapes(origin, session)).length).toBe(1)
          expect(points((await shapes(origin, session))[0])).toEqual(tidied_points)
          await undo.click()
          await expect.poll(async () => (await shapes(origin, session))[0]).toEqual(rough)
          await expect.poll(() => painted(stage, rough!.id)).toBe(painted_rough)
        },
      )

      await step('Redo brings back the tidy, then the arrow, in order', async () => {
        await redo.click()
        await expect
          .poll(async () => points((await shapes(origin, session))[0]))
          .toEqual(tidied_points)
        expect(await shapes(origin, session)).toHaveLength(1)
        await redo.click()
        await expect.poll(async () => (await shapes(origin, session)).length).toBe(2)
        const now = await shapes(origin, session)
        expect(now.find((shape) => shape.id === arrow_shape!.id)).toEqual(arrow_shape)
        await expect(redo).toBeDisabled()
      })

      await step('a page without the pairing cannot take an agent revision back', async () => {
        const before = await shapes(origin, session)
        const status = await stage.evaluate(async (board) => {
          const response = await fetch(`/api/whiteboard/native/revert?session=${board}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${'0'.repeat(64)}`,
            },
            body: JSON.stringify({ sequence: 3 }),
          })
          return response.status
        }, session)
        expect(status).toBe(403)
        expect(await shapes(origin, session)).toEqual(before)
      })
    },
    ['--native'],
  )
})
