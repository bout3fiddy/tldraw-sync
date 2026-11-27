// What the stage does once its canvas exists: stay read-only, keep the whole drawing in
// view, and keep the server's image of the drawing current.

import { react, type Editor } from 'tldraw'
import {
  image_edge_pixels_max,
  image_padding_px,
  image_scale_max,
  path_drawing_png,
} from '../shared/constants'
import { board_query } from '../shared/board_session'
import { time_real } from '../shared/time'
import { drawing_uploader_create } from './drawing_uploader'

// Total space kept clear around the drawing, across both sides of each axis.
const fit_inset_px = 160
// The Agent canvas gives its scene more of the pane: a narrow split view keeps its words as
// large as it can.
export const fit_inset_cleaned_px = 48
// A small sketch is not blown up to fill a monitor: past this it only looks coarse.
const fit_zoom_max = 2
// A board written zoomed far out is far larger than a window. tldraw stops zooming out at a
// twentieth, which would crop such a board, so the stage's own floor is ten times lower.
const fit_zoom_min = 0.005
const fit_duration_ms = 180

// `session` is the board this stage presents, and renders the image of.
export function stage_mount(editor: Editor, session: string): () => void {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.updateInstanceState({ isReadonly: true })
  // Locked against the viewer. The fit below moves the camera with `force`.
  editor.setCameraOptions({ isLocked: true, zoomSteps: [fit_zoom_min, fit_zoom_max] })

  const fit_stop = fit_start(editor, fit_inset_px, fit_duration_ms)
  const upload_stop = upload_start(editor, session)
  return () => {
    fit_stop()
    upload_stop()
  }
}

// The stage never follows the pen's zoom. It shows the whole drawing, and refits only when
// the drawing's extent or the window's size changes. The cleaned canvas fits the same way.
export function fit_start(editor: Editor, inset_px: number, duration_ms: number): () => void {
  let key_fitted = ''
  let frame = 0

  const fit = (): void => {
    frame = 0
    const bounds = editor.getCurrentPageBounds()
    if (bounds === undefined) return
    editor.zoomToBounds(bounds, {
      force: true,
      inset: inset_px,
      targetZoom: fit_zoom_max,
      animation: { duration: key_fitted === '' ? 0 : duration_ms },
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

function upload_start(editor: Editor, session: string): () => void {
  const uploader = drawing_uploader_create({
    time: time_real,
    records: () => {
      const types = editor.store.scopedTypes.document
      return editor.store.allRecords().filter((record) => types.has(record.typeName))
    },
    render: () => canvas_image(editor),
    // Called straight after the uploader has checked that the records still hash to `hash`,
    // so these bounds are the bounds of the drawing in the image.
    upload: async (hash, bytes) => {
      const bounds = editor.getCurrentPageBounds()
      const bounds_query = bounds === undefined ? ''
        : `&bounds=${[bounds.x, bounds.y, bounds.w, bounds.h].map(rounded).join(',')}`
      const query = `document_hash=${hash}&${board_query(session)}${bounds_query}`
      const response = await fetch(`${path_drawing_png}?${query}`, {
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

// Bounds to a thousandth of a page unit keep the query short.
function rounded(value: number): number {
  return Math.round(value * 1000) / 1000
}

// Everything on the canvas as one PNG, or null when there is nothing on it. The sketch's image
// and a draft's preview are both made here, so both are tldraw's own rendering.
export async function canvas_image(editor: Editor): Promise<Uint8Array | null> {
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
