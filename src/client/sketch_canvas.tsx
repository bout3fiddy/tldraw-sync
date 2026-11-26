// The iPad's sketch as a sheet with a lower margin. The drawing surface stops short of the
// bottom of its pane, and the strip left under it takes no ink: a resting hand there marks
// nothing and presses nothing of the canvas. tldraw anchors its own notice to the bottom of
// the editor, so the notice comes to rest in that margin, outside the drawing surface, exactly
// as tldraw draws it. Nothing here reads, styles, moves or handles the notice.
//
// This is tldraw's own canvas, given a smaller box through the `Canvas` component it lets an
// app supply. The canvas measures itself, so the pen, the zoom and the grid follow the box.
// Only the draw page uses it: the stage and the Agent canvas keep tldraw's canvas as it comes.

import type { SyntheticEvent } from 'react'
import { DefaultCanvas, type TLCanvasComponentProps, type TLComponents } from 'tldraw'
import { components_quiet } from './board_store'

// tldraw wraps its canvas, and so this margin, in the opener of its canvas menu, which a long
// press would raise. A hand at rest is a long press: the margin keeps its presses to itself.
const keep = (event: SyntheticEvent) => event.stopPropagation()

function SketchCanvas(props: TLCanvasComponentProps) {
  return (
    <>
      <div className="sheet">
        <DefaultCanvas {...props} />
      </div>
      <div
        className="sheet__margin"
        aria-hidden="true"
        onPointerDown={keep}
        onContextMenu={keep}
      />
    </>
  )
}

export const components_sketch: TLComponents = { ...components_quiet, Canvas: SketchCanvas }
