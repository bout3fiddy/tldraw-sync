// What the stage does once its canvas exists: stay read-only, keep the whole drawing in
// view, and keep the server's image of the drawing current.

import { react, type Editor } from 'tldraw'
import {
  image_edge_pixels_max,
  image_scale_max,
  path_drawing_png,
} from '../shared/constants'
import { time_real } from '../shared/time'
import { drawing_uploader_create } from './drawing_uploader'

// Total space kept clear around the drawing, across both sides of each axis.
const fit_inset_px = 160
// A small sketch is not blown up to fill a monitor: past this it only looks coarse.
const fit_zoom_max = 2
const fit_duration_ms = 180
const image_padding_px = 32

export function stage_mount(editor: Editor): () => void {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.updateInstanceState({ isReadonly: true })
  // Locked against the viewer. The fit below moves the camera with `force`.
  editor.setCameraOptions({ isLocked: true })

  const fit_stop = fit_start(editor)
  const upload_stop = upload_start(editor)
  return () => {
    fit_stop()
    upload_stop()
  }
}

// The stage never follows the pen's zoom. It shows the whole drawing, and refits only when
// the drawing's extent or the window's size changes.
function fit_start(editor: Editor): () => void {
  let key_fitted = ''
  let frame = 0

  const fit = (): void => {
    frame = 0
    const bounds = editor.getCurrentPageBounds()
    if (bounds === undefined) return
    editor.zoomToBounds(bounds, {
      force: true,
      inset: fit_inset_px,
      targetZoom: fit_zoom_max,
      animation: { duration: key_fitted === '' ? 0 : fit_duration_ms },
    })
  }

  const react_stop = react('stage fit', () => {
    const bounds = editor.getCurrentPageBounds()
    const viewport = editor.getViewportScreenBounds()
    const key = bounds === undefined
      ? 'empty'
      : [bounds.x, bounds.y, bounds.w, bounds.h, viewport.w, viewport.h].join(' ')
    if (key !== key_fitted) {
      if (frame === 0) frame = window.requestAnimationFrame(fit)
      key_fitted = key
    }
  })
  return () => {
    react_stop()
    window.cancelAnimationFrame(frame)
  }
}

function upload_start(editor: Editor): () => void {
  const uploader = drawing_uploader_create({
    time: time_real,
    records: () => {
      const types = editor.store.scopedTypes.document
      return editor.store.allRecords().filter((record) => types.has(record.typeName))
    },
    render: () => render(editor),
    upload: async (hash, bytes) => {
      const response = await fetch(`${path_drawing_png}?document_hash=${hash}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: bytes as Uint8Array<ArrayBuffer>,
      })
      return response.ok
    },
  })

  const listen_stop = editor.store.listen(() => uploader.change_notify(), { scope: 'document' })
  // Once at the start: the drawing may have changed while no stage was open to render it.
  uploader.change_notify()
  return () => {
    listen_stop()
    uploader.stop()
  }
}

async function render(editor: Editor): Promise<Uint8Array | null> {
  const ids = [...editor.getCurrentPageShapeIds()]
  const bounds = editor.getCurrentPageBounds()
  if (ids.length === 0 || bounds === undefined) return null

  // Sharp for a drawing of ordinary size, and capped so a sprawling one stays a sane file.
  const edge_px = Math.max(bounds.w, bounds.h) + image_padding_px * 2
  const pixel_ratio = Math.min(image_scale_max, image_edge_pixels_max / edge_px)
  const image = await editor.toImage(ids, {
    format: 'png',
    background: true,
    padding: image_padding_px,
    pixelRatio: pixel_ratio,
  })
  return new Uint8Array(await image.blob.arrayBuffer())
}
