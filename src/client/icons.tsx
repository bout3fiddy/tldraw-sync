// The interface's icons. The rail and chat use Phosphor at its light weight, so their strokes
// sit close to the one-pixel ink edges of the chrome. Each is imported on its own to keep the
// bundle small.
// tldraw's icon font is not loaded, because its interface is hidden.

import type { Icon } from '@phosphor-icons/react'
import { ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
import { ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp'
import { ArrowUpRight } from '@phosphor-icons/react/dist/csr/ArrowUpRight'
import { DotsThreeVertical } from '@phosphor-icons/react/dist/csr/DotsThreeVertical'
import { FrameCorners } from '@phosphor-icons/react/dist/csr/FrameCorners'
import { PencilSimpleLine } from '@phosphor-icons/react/dist/csr/PencilSimpleLine'
import { Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { PushPin } from '@phosphor-icons/react/dist/csr/PushPin'
import { QrCode } from '@phosphor-icons/react/dist/csr/QrCode'
import { Scribble } from '@phosphor-icons/react/dist/csr/Scribble'
import { Trash } from '@phosphor-icons/react/dist/csr/Trash'
import { X } from '@phosphor-icons/react/dist/csr/X'
import type { ReactNode } from 'react'

const icon_size_px = 24

function glyph(Glyph: Icon, size_px = icon_size_px): ReactNode {
  return <Glyph size={size_px} weight="light" aria-hidden="true" focusable="false" />
}

// The board's own instruments are drawn as the One canvas design draws them: plain strokes at
// one and a half units, in whatever ink the control is set in.
function drawn(paths: readonly string[], size_px = icon_size_px, width = 1.5): ReactNode {
  return (
    <svg
      width={size_px}
      height={size_px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

const pen_path = 'M15.5 4.5l4 4L9 19l-5 1 1-5z'
const chat_path = 'M4 5.5h16v10.5H10l-4.5 3.5V16H4z'

export const icon_pen = drawn([pen_path])
export const icon_pen_small = drawn([pen_path], 20, 1.6)
export const icon_eraser = drawn([
  'M14 4.5l5.5 5.5-8.5 8.5H6.5L4.5 16.5z',
  'M9 9.5l5.5 5.5M11 18.5h8.5',
])
export const icon_undo = drawn(['M9 6L4.5 10.5 9 15', 'M5 10.5h9a5 5 0 010 10h-3'])
export const icon_redo = drawn(['M15 6l4.5 4.5L15 15', 'M19 10.5h-9a5 5 0 000 10h3'])
export const icon_chat = drawn([chat_path], 22)

// The view switch: the chosen answer's tick, a step back or on, and the folded switch's caret.
export const icon_check_small = drawn(['M5 12.5l4.5 4.5L19 7.5'], 20, 2)
export const icon_step_back = drawn(['M14.5 6L8.5 12l6 6'], 20, 1.75)
export const icon_step_next = drawn(['M9.5 6l6 6-6 6'], 20, 1.75)
export const icon_fold_open = drawn(['M6.5 14.5L12 9l5.5 5.5'], 20, 1.75)
export const icon_chat_small = drawn([chat_path], 20, 1.6)
export const icon_boards = (
  <svg
    width={icon_size_px}
    height={icon_size_px}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    aria-hidden="true"
    focusable="false"
  >
    <rect x="3.5" y="4.5" width="17" height="15" rx="1" />
    <path d="M9 4.5v15" />
  </svg>
)
export const icon_plus = glyph(Plus, 20)
export const icon_close = glyph(X)
export const icon_close_small = glyph(X, 20)
export const icon_pin = glyph(PushPin)
export const icon_actions = glyph(DotsThreeVertical)
export const icon_delete = glyph(Trash, 20)
export const icon_rename = glyph(PencilSimpleLine, 20)
export const icon_pair = glyph(QrCode)
export const icon_recenter = glyph(FrameCorners)

// The chat's: adding the sketch, a sent sketch's place, sending again, opening the canvas.
export const icon_sketch = glyph(Scribble)
export const icon_sketch_small = glyph(Scribble, 20)
export const icon_retry = glyph(ArrowClockwise, 20)
export const icon_open = glyph(ArrowUpRight, 20)

// The send arrow keeps one small size whatever the message grows to. It is set on solid ink,
// where a light stroke would thin out, so it alone is drawn bold.
export const icon_send = <ArrowUp size={18} weight="bold" aria-hidden="true" focusable="false" />
