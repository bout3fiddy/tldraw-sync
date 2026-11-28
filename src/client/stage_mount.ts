// The stage owns a read-only camera. Following frames the whole board; navigating changes
// only this camera. In either mode the uploader renders all ink, independent of the viewport.

import { Box, react, type Atom, type Editor, type TLEventInfo } from 'tldraw'
import {
  image_edge_pixels_max,
  image_padding_px,
  image_scale_max,
  path_drawing_png,
} from '../shared/constants'
import { board_query } from '../shared/board_session'
import { time_real } from '../shared/time'
import { drawing_uploader_create } from './drawing_uploader'
import type { NativeViewChoice } from './native_view_choice'
import type { PrintExtent } from './print_engine'
import type { PrintBox } from './print_svg'

// Total space kept clear around the drawing, across both sides of each axis.
const fit_inset_px = 160

// A small sketch is not blown up to fill a monitor: past this it only looks coarse.
const fit_zoom_max = 2

// A board written zoomed far out is far larger than a window. tldraw stops zooming out at a
// twentieth, which would crop such a board, so the stage's own floor is ten times lower.
const fit_zoom_min = 0.005
const zoom_steps = [fit_zoom_min, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]

// `session` is the board this stage presents, and renders the image of. `print` is where the
// agent's print lies, so the stage keeps both it and the ink in view.
export function stage_mount(
  editor: Editor,
  session: string,
  print: Atom<PrintExtent | null>,
  following: Atom<boolean>,
  views: NativeViewChoice,
): () => void {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.updateInstanceState({ isReadonly: true, isGridMode: true })
  editor.setCameraOptions({ wheelBehavior: 'pan', zoomSteps: zoom_steps })

  // Escape in the SDK's idle hand switches to select. The stage has no selection tool.
  const hand_stop = react('stage hand', () => {
    if (editor.getCurrentToolId() !== 'hand') editor.setCurrentTool('hand')
  })
  following.set(true)

  const navigation_stop = navigation_start(editor, print, following)
  const fit_stop = fit_start(editor, print, following)
  const upload_stop = upload_start(editor, session, views)
  return () => {
    hand_stop()
    navigation_stop()
    fit_stop()
    upload_stop()
  }
}

// Observe navigation at its source, not camera record changes: a fit is a camera change too.
function navigation_start(
  editor: Editor,
  print: Atom<PrintExtent | null>,
  following: Atom<boolean>,
) {
  const detach = () => {
    if (
      following.get() &&
      (editor.getCurrentPageShapeIds().size > 0 || print.get()?.bounds != null)
    ) {
      following.set(false)
    }
  }

  // In 4.2.3 wheel, pinch and middle-button pan return before the SDK's post-event hook.
  const before = (event: TLEventInfo) => {
    if (event.type === 'wheel') {
      if (event.ctrlKey ? event.delta.z : event.delta.x || event.delta.y) detach()
    }

    if (event.name === 'pinch' && editor.inputs.isPinching) {
      const zoom = event.point.z ?? editor.getZoomLevel()

      if (event.delta.x || event.delta.y || zoom !== editor.getZoomLevel()) detach()
    }

    if (event.type === 'click' && event.phase === 'settle') detach()

    if (
      event.name === 'pointer_move' &&
      event.pointerId >= 0 &&
      editor.inputs.isPanning &&
      editor.inputs.isPointing
    ) {
      detach()
    }
  }

  // The hand tool has already passed its drag threshold. Ignore synthetic moves emitted by
  // the SDK during a camera update (negative pointer IDs), hover, and a simple press.
  const after = (event: TLEventInfo) => {
    if (event.name === 'pointer_move' && event.pointerId >= 0 && editor.isIn('hand.dragging')) {
      detach()
    }
  }

  editor.on('before-event', before)
  editor.on('event', after)
  return () => {
    editor.off('before-event', before)
    editor.off('event', after)
  }
}

// While following, frame both layers together. At most one fit waits for the next paint.
function fit_start(editor: Editor, print: Atom<PrintExtent | null>, following: Atom<boolean>) {
  let key_fitted = ''
  let frame = 0
  const board = editor.getContainer().closest<HTMLElement>('.board')

  const fit = (): void => {
    frame = 0

    if (!following.get()) return

    const bounds = board_bounds(editor, print.get()?.bounds ?? null)

    if (bounds === undefined) return

    editor.updateViewportScreenBounds(editor.getContainer())
    editor.zoomToBounds(bounds, { inset: fit_inset_px, targetZoom: fit_zoom_max })
  }

  const react_stop = react('stage fit', () => {
    if (!following.get()) {
      key_fitted = ''
      return
    }

    const ink = editor.getCurrentPageBounds()
    const revision = print.get()?.revision ?? 0
    const viewport = editor.getViewportScreenBounds()

    // Follow new ink, a published print, or a resized window. Moving the chat divider and
    // choosing a local view of the same revision do not move the camera.
    const width = board?.clientWidth ?? viewport.w
    const key = [
      ink?.x,
      ink?.y,
      ink?.w,
      ink?.h,
      revision,
      width,
      viewport.h,
      board?.dataset.chat,
    ].join(' ')

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

// Everything on the board: the ink, the print, or both together.
function board_bounds(editor: Editor, print: PrintBox | null): Box | undefined {
  const ink = editor.getCurrentPageBounds()

  if (print === null) return ink

  const box = new Box(print.x, print.y, print.w, print.h)
  return ink === undefined ? box : Box.Common([ink, box])
}

// The image is of the drawing at rest, whichever view this Mac shows: it is identified by the
// records alone, so it never depends on a choice made on one screen.
function upload_start(editor: Editor, session: string, views: NativeViewChoice): () => void {
  const uploader = drawing_uploader_create({
    time: time_real,
    records: () => {
      const types = editor.store.scopedTypes.document
      return editor.store.allRecords().filter((record) => types.has(record.typeName))
    },
    render: () => views.at_rest(() => canvas_image(editor)),

    // Called straight after the uploader has checked that the records still hash to `hash`,
    // so these bounds are the bounds of the drawing in the image.
    upload: async (hash, bytes) => {
      const bounds = editor.getCurrentPageBounds()
      const bounds_query =
        bounds === undefined
          ? ''
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
