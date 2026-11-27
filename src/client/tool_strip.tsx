// The drawing tools, down the left edge under the hand that is not holding the Pencil: pen,
// eraser, undo and redo, and nothing else. The pen and the eraser are one choice: pressing one
// lets go of the other, and pressing the one already held puts both down, leaving the pointer,
// which chooses and moves the person's own ink. The pen writes in black only; ink written in
// another colour before stays as it was. Clearing the sketch and deleting the board are in the
// board's menu, away from a resting palm. Both tools touch only the person's ink: the agent's
// print lies under the glass, out of their reach.

import type { ReactNode } from 'react'
import { DefaultColorStyle, useEditor, useValue, type Editor } from 'tldraw'
import { assert } from '../shared/assert'
import { icon_eraser, icon_pen, icon_redo, icon_undo } from './icons'

// The one ink the pen writes in: tldraw's black, which the chrome is drawn in too.
export const pen_ink = 'black'

// The tool held when neither the pen nor the eraser is: tldraw's pointer.
export const pointer_tool = 'select'

type HeldTool = 'draw' | 'eraser'

// What pressing a tool does: take it up, or put it down if it is already held. Pure, so the
// strip's whole rule can be checked without a canvas.
export function tool_after_press(current: string, pressed: HeldTool): string {
  assert(pressed === 'draw' || pressed === 'eraser', 'only the pen and eraser are held')
  const next = current === pressed ? pointer_tool : pressed
  assert(next !== current || current === pointer_tool, 'a press always changes the tool')
  return next
}

// Takes up the pen in its one ink, or puts down whichever tool is held.
export function tool_press(editor: Editor, pressed: HeldTool): void {
  const next = tool_after_press(editor.getCurrentToolId(), pressed)

  if (next === 'draw') pen_ink_set(editor)

  editor.setCurrentTool(next)
  assert(editor.getCurrentToolId() === next, 'the pressed tool is held')
}

// New ink is black, whatever colour an earlier visit or a taken shape left set for the next.
export function pen_ink_set(editor: Editor): void {
  if (editor.getStyleForNextShape(DefaultColorStyle) !== pen_ink) {
    editor.setStyleForNextShapes(DefaultColorStyle, pen_ink)
  }

  assert(editor.getStyleForNextShape(DefaultColorStyle) === pen_ink, 'the pen writes in black')
}

export function ToolStrip() {
  const editor = useEditor()
  const tool = useValue('tool', () => editor.getCurrentToolId(), [editor])
  const undo_possible = useValue('undo', () => editor.getCanUndo(), [editor])
  const redo_possible = useValue('redo', () => editor.getCanRedo(), [editor])
  return (
    <div className="toolside">
      <nav
        className="strip"
        aria-label="Drawing tools"
        data-tool={tool}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <StripButton
          label="Pen"
          active={tool === 'draw'}
          onPress={() => tool_press(editor, 'draw')}
        >
          {icon_pen}
        </StripButton>
        <StripButton
          label="Eraser"
          active={tool === 'eraser'}
          onPress={() => tool_press(editor, 'eraser')}
        >
          {icon_eraser}
        </StripButton>

        <div className="strip__rule" />
        <StripButton label="Undo" disabled={!undo_possible} onPress={() => editor.undo()}>
          {icon_undo}
        </StripButton>
        <StripButton label="Redo" disabled={!redo_possible} onPress={() => editor.redo()}>
          {icon_redo}
        </StripButton>
      </nav>
    </div>
  )
}

type StripButtonProps = {
  label: string
  active?: boolean
  disabled?: boolean
  onPress: () => void
  children: ReactNode
}

function StripButton(props: StripButtonProps) {
  const { label, active, disabled = false, onPress, children } = props
  return (
    <button
      type="button"
      className="strip__button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  )
}
