// The benchmark's native control: tldraw itself showing the very records the board's print
// draws for each view, in one read-only editor that is kept, as a canvas shared by the person
// and the agent would show the agent's shapes. The views are projected by the board's own code
// (`interactive_scene`) and loaded by its own store (`print_store`). A change of view is one
// change to the store, timed until every shape of the view is in the page and two frames
// have passed. Nothing is repainted, exported or cached. It is a measure, not a renderer.

import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { createRoot } from 'react-dom/client'
import { Tldraw, type Editor, type TLRecord } from 'tldraw'
import 'tldraw/tldraw.css'
import {
  interactive_scene_read,
  interactive_view,
  scene_envelope,
  type LocalScene,
} from '../../../../src/client/interactive_scene'
import { canvas_store } from '../../../../src/client/print_store'
import type { ViewState } from '../../../../src/shared/scene_controls'

type Sample = { ms: number; shapes_count: number; long_task_ms_max: number }

const asset_urls = getAssetUrlsByImport()

// Frames waited for a view's shapes to reach the page before the sample fails.
const frames_count_max = 1200
const long_tasks: { start: number; ms: number }[] = []

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    long_tasks.push({ start: entry.startTime, ms: entry.duration })
  }

  long_tasks.splice(0, Math.max(0, long_tasks.length - 4096))
}).observe({ type: 'longtask', buffered: false })

let scene: LocalScene | null = null
let editor: Editor | null = null

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

// Every shape the editor holds is in the page, then two frames pass: the frame that commits
// the last of them and the one that paints it.
async function painted(mounted: Editor, started: number): Promise<Sample> {
  const ids = [...mounted.getCurrentPageShapeIds()]
  let present = false

  for (let count = 0; count < frames_count_max && !present; count += 1) {
    await frame()
    present = ids.every((id) => document.querySelector(`[data-shape-id="${id}"]`) !== null)
  }

  if (!present) throw new Error('The view never reached the page.')

  await frame()
  await frame()
  const ms = performance.now() - started
  const tasks = long_tasks.filter((task) => task.start >= started)
  const long_task_ms_max = Math.max(0, ...tasks.map((task) => task.ms))
  return { ms, shapes_count: ids.length, long_task_ms_max }
}

// One view as a single change to the store: shapes and bindings the view no longer has go,
// and those it has anew or otherwise come.
function view_apply(mounted: Editor, state: ViewState): void {
  const next = records_of(state)
  const wanted = new Map(next.map((record) => [record.id, record]))
  const store = mounted.store
  const held = store.allRecords().filter((record) => {
    return record.typeName === 'shape' || record.typeName === 'binding'
  })
  const gone = held.filter((record) => !wanted.has(record.id)).map((record) => record.id)
  const changed = next.filter((record) => {
    const current = store.get(record.id)
    return current === undefined || JSON.stringify(current) !== JSON.stringify(record)
  })
  store.mergeRemoteChanges(() => {
    store.remove(gone)
    store.put(changed)
  })
}

function records_of(state: ViewState): TLRecord[] {
  if (scene === null) throw new Error('The control has no scene.')

  return interactive_view(scene, state).records as unknown as TLRecord[]
}

const control = {

  // Mounts the editor on the view at rest, the camera on the whole scene, and times its first
  // paint with its lettering loaded.
  start(text: string, revision: number): Promise<Sample> {
    const read = interactive_scene_read(text, revision)

    if (!read.ok) throw new Error(`The scene was refused: ${read.reason}.`)

    scene = read.scene
    const envelope = scene_envelope(scene.elements)
    const store = canvas_store(records_of(scene.rest) as never)
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const mount = (mounted: Editor) => {
        editor = mounted
        mounted.user.updateUserPreferences({ colorScheme: 'light' })
        mounted.updateInstanceState({ isReadonly: true })

        if (envelope !== null) mounted.zoomToBounds(envelope, { immediate: true, inset: 40 })

        mounted.fonts
          .loadRequiredFontsForCurrentPage()
          .then(() => painted(mounted, started))
          .then(resolve, reject)
      }
      createRoot(document.getElementById('root')!).render(
        <Tldraw store={store} hideUi assetUrls={asset_urls} onMount={mount} />,
      )
    })
  },

  // Applies one view to the kept editor as a single change, and times it until painted.
  show(state: ViewState): Promise<Sample> {
    if (editor === null) throw new Error('The control is not started.')

    const started = performance.now()
    view_apply(editor, state)
    return painted(editor, started)
  },

  // Applies one view and returns at once, as a quick run of choices would.
  apply(state: ViewState): void {
    if (editor === null) throw new Error('The control is not started.')

    view_apply(editor, state)
  },

  // Whether a shape of the scene is in the page, and where, for the painted check.
  shape_box(scene_id: string): { x: number; y: number; width: number; height: number } | null {
    const element = document.querySelector(`[data-shape-id="shape:scene-${scene_id}"]`)

    if (element === null) return null

    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  },
}

Object.assign(window, { __control: control })
