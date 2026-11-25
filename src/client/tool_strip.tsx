// The whole iPad interface: pen, eraser, four inks, undo, redo, and a way to start over.
// It sits under the hand that is not holding the Pencil.

import { useEffect, useState, type ReactNode } from 'react'
import { DefaultColorStyle, useEditor, useValue } from 'tldraw'
import { icon_clear, icon_eraser, icon_pen, icon_redo, icon_undo } from './icons'

// tldraw's own ink names, with the colours it draws them in, so a well matches its stroke.
const inks = [
  { name: 'black', label: 'Black ink', colour: '#1d1d1d' },
  { name: 'blue', label: 'Blue ink', colour: '#4465e9' },
  { name: 'red', label: 'Red ink', colour: '#e03131' },
  { name: 'green', label: 'Green ink', colour: '#099268' },
] as const

const clear_confirm_ms = 3000

export function ToolStrip() {
  const editor = useEditor()
  const tool = useValue('tool', () => editor.getCurrentToolId(), [editor])
  const ink = useValue('ink', () => editor.getStyleForNextShape(DefaultColorStyle), [editor])
  const undo_possible = useValue('undo', () => editor.getCanUndo(), [editor])
  const redo_possible = useValue('redo', () => editor.getCanRedo(), [editor])
  const tool_set = (name: 'draw' | 'eraser') => editor.setCurrentTool(name)

  return (
    <nav
      className="strip"
      aria-label="Drawing tools"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <StripButton label="Pen" active={tool === 'draw'} onPress={() => tool_set('draw')}>
        {icon_pen}
      </StripButton>
      <StripButton label="Eraser" active={tool === 'eraser'} onPress={() => tool_set('eraser')}>
        {icon_eraser}
      </StripButton>

      <div className="strip__rule" />
      {inks.map((candidate) => (
        <button
          key={candidate.name}
          type="button"
          className="strip__ink"
          aria-label={candidate.label}
          aria-pressed={ink === candidate.name}
          style={{ '--ink-well': candidate.colour } as React.CSSProperties}
          onClick={() => {
            editor.setStyleForNextShapes(DefaultColorStyle, candidate.name)
            editor.setCurrentTool('draw')
          }}
        />
      ))}

      <div className="strip__rule" />
      <StripButton label="Undo" disabled={!undo_possible} onPress={() => editor.undo()}>
        {icon_undo}
      </StripButton>
      <StripButton label="Redo" disabled={!redo_possible} onPress={() => editor.redo()}>
        {icon_redo}
      </StripButton>

      <div className="strip__rule" />
      <ClearButton />
    </nav>
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
  const { label, active = false, disabled = false, onPress, children } = props
  return (
    <button
      type="button"
      className="strip__button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

// Clearing takes two taps: the first arms the button, the second clears. A stray palm on
// the strip cannot wipe the board, and Undo brings everything back if it was a mistake.
function ClearButton() {
  const editor = useEditor()
  const [armed, armed_set] = useState(false)
  const empty = useValue('empty', () => editor.getCurrentPageShapeIds().size === 0, [editor])

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => armed_set(false), clear_confirm_ms)
    return () => window.clearTimeout(timer)
  }, [armed])

  const press = () => {
    if (!armed) return armed_set(true)
    editor.deleteShapes([...editor.getCurrentPageShapeIds()])
    armed_set(false)
  }

  return (
    <div className="strip__clear">
      <button
        type="button"
        className="strip__button"
        data-armed={armed}
        aria-label={armed ? 'Clear the board now' : 'Clear the board'}
        disabled={empty}
        onClick={press}
      >
        {icon_clear}
      </button>
      {armed && <span className="strip__confirm">Tap again to clear the board</span>}
    </div>
  )
}
