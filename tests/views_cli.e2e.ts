// Views of a scene with controls, as an agent's host reaches them through the command line,
// drawn by the real Mac stage. A snapshot hands the scene back whole, with its controls and
// what the board accepts as data, so the file publishes again as it is. A preview draws the
// view at rest, or the one view --state names, and says which; a view the scene does not have
// is refused with the reason. Nothing of a preview is published or left on the stage.
//
// Run: bun run build && npx playwright test tests/views_cli.e2e.ts

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { board_linked, step, step_long_ms, type Linked } from './whiteboard_board'

test.use({ trace: 'off' })

type Json = Record<string, any>

// Neutral names: a choice of two values and a toggle, so four views.
const controls = [
  {
    id: 'mode',
    kind: 'choice',
    label: 'Mode',
    options: [
      { value: 'first', label: 'First' },
      { value: 'second', label: 'Second' },
    ],
  },
  { id: 'more', kind: 'toggle', label: 'More' },
]
const elements = [
  { type: 'geo', id: 'base', x: 0, y: 0, w: 240, h: 120, text: 'Always', fill: 'solid' },
  {
    type: 'geo',
    id: 'second_only',
    x: 0,
    y: 200,
    w: 240,
    h: 120,
    fill: 'solid',
    color: 'red',
    visible_when: [{ control: 'mode', values: ['second'] }],
  },
  {
    type: 'text',
    id: 'more_only',
    x: 300,
    y: 40,
    text: 'More',
    visible_when: [{ control: 'more', values: ['on'] }],
  },
]

const png_signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function scene_edit(file: string, change: (scene: Json) => void): Json {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
  change(scene)
  fs.writeFileSync(file, JSON.stringify(scene))
  return scene
}

// A draft drawn by the stage: a real picture, and the canvas and sketch as they were.
function drafted(board: Linked, scene_path: string, name: string, ...state: string[]): Json {
  const { bound, cli, session, root } = board
  const before = cli('status', '--session', session)
  const picture = path.join(root, `${name}.png`)
  const result = bound('preview', '--file', scene_path, '--out', picture, ...state)
  expect(result, name).toMatchObject({ code: 'preview_saved', image_path: picture })
  expect(result.published).toBe(false)
  const bytes = fs.readFileSync(picture)
  expect([...bytes.subarray(0, png_signature.length)]).toEqual(png_signature)
  const after = cli('status', '--session', session)
  expect(after.agent_revision).toBe(before.agent_revision)
  expect(after.document_hash).toBe(before.document_hash)
  return { ...result, bytes }
}

async function authored(board: Linked): Promise<string> {
  const { bound, root } = board
  const first = bound('snapshot', '--out', path.join(root, 'first'))
  expect(first).toMatchObject({ status: 'success', scene_controls: [], states_count: 1 })
  expect(first.capabilities.format).toBe('tldraw-sync.scene-capabilities.v1')
  scene_edit(first.scene_path, (scene) => {
    scene.controls = controls
    scene.elements = elements
  })
  const published = bound('publish', '--file', first.scene_path)
  expect(published).toMatchObject({ code: 'published', revision: 1, shapes_count: 1 })

  const second = bound('snapshot', '--out', path.join(root, 'second'))
  expect(second).toMatchObject({ base_revision: 1, scene_controls: controls, states_count: 4 })
  const capabilities = JSON.parse(fs.readFileSync(second.capabilities_path, 'utf8'))
  expect(capabilities).toEqual(second.capabilities)
  const scene = JSON.parse(fs.readFileSync(second.scene_path, 'utf8')) as Json
  expect(scene.controls).toEqual(controls)
  expect(scene.elements).toMatchObject(elements)
  const again = bound('publish', '--file', second.scene_path)
  expect(again).toMatchObject({ revision: 2, records_hash: published.records_hash })

  // A scene file is tied to the revision it was snapshotted at; drafts build on the current one.
  const stale = bound('preview', '--file', second.scene_path)
  expect(stale).toMatchObject({ status: 'failure', code: 'revision_conflict' })
  const third = bound('snapshot', '--out', path.join(root, 'third'))
  expect(third).toMatchObject({ base_revision: 2, scene_controls: controls, states_count: 4 })
  const current = JSON.parse(fs.readFileSync(third.scene_path, 'utf8')) as Json
  expect(current.controls).toEqual(scene.controls)
  expect(current.elements).toEqual(scene.elements)
  return String(third.scene_path)
}

test('a host previews one view of a scene with controls, drawn by the stage', async ({
  browser,
}) => {
  test.setTimeout(step_long_ms * 3)

  await board_linked(browser, async (board) => {
    const scene_path = await step('snapshot, publish and re-author a scene with controls', () =>
      authored(board),
    )

    await step('the stage draws the view at rest and one chosen view', async () => {
      const rest = drafted(board, scene_path, 'view-rest')
      expect(rest).toMatchObject({
        view: 'rest',
        state: { mode: 'first', more: 'off' },
        states_count: 4,
        base_revision: 2,
        shapes_count: 1,
      })
      const chosen = drafted(board, scene_path, 'view-chosen', '--state', '{"mode":"second"}')
      expect(chosen).toMatchObject({
        view: 'selected',
        state: { mode: 'second', more: 'off' },
        base_revision: 2,
        shapes_count: 2,
      })
      expect(chosen.records_hash).not.toBe(rest.records_hash)
      expect(Buffer.compare(chosen.bytes, rest.bytes)).not.toBe(0)
      await expect(board.stage.locator('.bench')).toHaveCount(0)
    })

    await step('a view the scene does not have is refused, and nothing changes', async () => {
      const { bound, cli, session } = board
      const refused = bound('preview', '--file', scene_path, '--state', '{"mode":"third"}')
      expect(refused).toMatchObject({
        status: 'failure',
        code: 'invalid_state',
        message: 'state.mode: Expected one of: first, second.',
        exit_code: 1,
      })
      expect(cli('status', '--session', session).agent_revision).toBe(2)
    })
  })
})
