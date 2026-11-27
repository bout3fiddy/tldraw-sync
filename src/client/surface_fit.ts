// Bringing something into view on the one canvas. Only a person's explicit action moves the
// draw page's camera: a new revision never does. The stage keeps the whole board in view by
// itself (`stage_mount.ts`).

import { Box, type Editor } from 'tldraw'
import { assert } from '../shared/assert'
import type { PrintBox } from './print_svg'

// Total space kept clear around what is brought into view, across both sides of an axis: room
// for the instruments at the edges.
export const fit_inset_px = 160

// Something small is not blown up past its own size.
const fit_zoom_max = 1
const fit_duration_ms = 220

// tldraw's own furthest zoom. A board can hold shapes far further apart than a screen shows
// at that zoom, so a fit may go further out, never further than the fit itself needs.
const zoom_floor_tldraw = 0.05

// tldraw reads the canvas's size up to 200 ms after it changes, as when the chat closes or the
// window turns. A fit planned for the old size, then carried out at the new one, scales the
// box by the change in width and cuts it. So the size is read now, before anything is planned.
export function camera_fit(editor: Editor, box: PrintBox): void {
  assert(box.w >= 0 && box.h >= 0, 'a box has a size')
  editor.updateViewportScreenBounds(editor.getContainer())
  const viewport = editor.getViewportScreenBounds()
  const container = editor.getContainer().getBoundingClientRect()
  assert(Math.abs(viewport.w - Math.max(1, container.width)) <= 1, 'the fit sees the canvas size')
  const room_w = Math.max(1, viewport.w - fit_inset_px)
  const room_h = Math.max(1, viewport.h - fit_inset_px)
  const zoom_needed = Math.min(room_w / Math.max(1, box.w), room_h / Math.max(1, box.h))
  const steps = editor.getCameraOptions().zoomSteps.filter((step) => step >= zoom_floor_tldraw)
  assert(steps.length > 0, 'the camera has zoom steps')

  if (zoom_needed < steps[0]!) editor.setCameraOptions({ zoomSteps: [zoom_needed, ...steps] })

  editor.zoomToBounds(new Box(box.x, box.y, box.w, box.h), {
    inset: fit_inset_px,
    targetZoom: fit_zoom_max,
    animation: { duration: fit_duration_ms },
  })
}

// Whether any of a page box is in the camera's view.
export function box_seen(editor: Editor, box: PrintBox): boolean {
  const view = editor.getViewportPageBounds()
  const apart =
    box.x > view.maxX || box.x + box.w < view.minX || box.y > view.maxY || box.y + box.h < view.minY
  return !apart
}

export function ink_box(editor: Editor): PrintBox | null {
  const bounds = editor.getCurrentPageBounds()

  if (bounds === undefined) return null

  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
}
