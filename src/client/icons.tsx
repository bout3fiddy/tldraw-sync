// The interface's icons, all from Phosphor at its light weight, so their strokes sit close to
// the one-pixel ink edges of the chrome. Each is imported on its own to keep the bundle small.
// tldraw's icon font is not loaded, because its interface is hidden.

import type { Icon } from '@phosphor-icons/react'
import { ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp'
import { ArrowUUpLeft } from '@phosphor-icons/react/dist/csr/ArrowUUpLeft'
import { ArrowUUpRight } from '@phosphor-icons/react/dist/csr/ArrowUUpRight'
import { Bell } from '@phosphor-icons/react/dist/csr/Bell'
import { ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle'
import { Cursor } from '@phosphor-icons/react/dist/csr/Cursor'
import { DotsThreeVertical } from '@phosphor-icons/react/dist/csr/DotsThreeVertical'
import { Eraser } from '@phosphor-icons/react/dist/csr/Eraser'
import { PencilSimpleLine } from '@phosphor-icons/react/dist/csr/PencilSimpleLine'
import { Pen } from '@phosphor-icons/react/dist/csr/Pen'
import { Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { PushPin } from '@phosphor-icons/react/dist/csr/PushPin'
import { QrCode } from '@phosphor-icons/react/dist/csr/QrCode'
import { SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple'
import { Trash } from '@phosphor-icons/react/dist/csr/Trash'
import { X } from '@phosphor-icons/react/dist/csr/X'
import type { ReactNode } from 'react'

const icon_size_px = 24

function glyph(Glyph: Icon, size_px = icon_size_px): ReactNode {
  return <Glyph size={size_px} weight="light" aria-hidden="true" focusable="false" />
}

export const icon_select = glyph(Cursor)
export const icon_pen = glyph(Pen)
export const icon_eraser = glyph(Eraser)
export const icon_undo = glyph(ArrowUUpLeft)
export const icon_redo = glyph(ArrowUUpRight)
export const icon_clear = glyph(Trash)
export const icon_boards = glyph(SidebarSimple)
export const icon_plus = glyph(Plus, 20)
export const icon_close = glyph(X)
export const icon_pin = glyph(PushPin)
export const icon_actions = glyph(DotsThreeVertical)
export const icon_delete = glyph(Trash, 20)
export const icon_rename = glyph(PencilSimpleLine, 20)
export const icon_chat = glyph(ChatCircle)
export const icon_bell = glyph(Bell)
export const icon_pair = glyph(QrCode)

// The glyph on the note's paper keeps one small size whatever the note grows to. The arrow
// is set on solid ink, where a light stroke would thin out, so it alone is drawn bold.
export const icon_send = <ArrowUp size={18} weight="bold" aria-hidden="true" focusable="false" />
