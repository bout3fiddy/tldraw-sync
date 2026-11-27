// The drawing tools, down the left edge under the hand that is not holding the Pencil: pen,
// eraser, undo and redo. Tapping the pen again lays out its four inks beside it. Clearing the
// sketch is in the board's menu, away from a resting palm. Both tools touch only the person's
// ink: the agent's print lies under the glass, out of their reach.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DefaultColorStyle, useEditor, useValue } from 'tldraw'
import { icon_eraser, icon_pen, icon_redo, icon_undo } from './icons'

// tldraw's own ink names, with the colours it draws them in, so a well matches its stroke.
const inks = [
  { name: 'black', label: 'Black ink', colour: '#1d1d1d' },
  { name: 'blue', label: 'Blue ink', colour: '#4465e9' },
  { name: 'red', label: 'Red ink', colour: '#e03131' },
  { name: 'green', label: 'Green ink', colour: '#099268' },
] as const

const inks_id = 'strip-inks'

export function ToolStrip() {
  const editor = useEditor()
  const tool = useValue('tool', () => editor.getCurrentToolId(), [editor])
  const ink = useValue('ink', () => editor.getStyleForNextShape(DefaultColorStyle), [editor])
  const undo_possible = useValue('undo', () => editor.getCanUndo(), [editor])
  const redo_possible = useValue('redo', () => editor.getCanRedo(), [editor])
  const [inks_open, inks_set] = useState(false)
  const strip = useRef<HTMLElement>(null)
  use_inks_dismiss(inks_open, strip, () => inks_set(false))

  const pen = () => {
    if (tool === 'draw') return inks_set(!inks_open)

    editor.setCurrentTool('draw')
    inks_set(false)
  }
  const eraser = () => {
    editor.setCurrentTool('eraser')
    inks_set(false)
  }
  const colour = inks.find((candidate) => candidate.name === ink)?.colour ?? inks[0].colour
  return (
    <div className="toolside">
      <nav
        ref={strip}
        className="strip"
        aria-label="Drawing tools"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="strip__pen">
          <StripButton label="Pen" active={tool === 'draw'} expanded={inks_open} onPress={pen}>
            {icon_pen}
            <span
              className="strip__nib"
              data-ink={ink}
              style={{ '--ink-well': colour } as React.CSSProperties}
            />
          </StripButton>
          {inks_open && <InkWells ink={ink} onChosen={() => inks_set(false)} />}
        </div>
        <StripButton label="Eraser" active={tool === 'eraser'} onPress={eraser}>
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

function InkWells({ ink, onChosen }: { ink: string; onChosen: () => void }) {
  const editor = useEditor()
  return (
    <div id={inks_id} className="strip__inks" role="group" aria-label="Inks">
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
            onChosen()
          }}
        />
      ))}
    </div>
  )
}

// The inks go away when anything else is pressed, or on Escape.
function use_inks_dismiss(open: boolean, strip: React.RefObject<HTMLElement>, close: () => void) {
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return

    const press = (event: PointerEvent) => {
      if (event.target instanceof Node && strip.current?.contains(event.target)) return

      latest.current()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current()
    }
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('keydown', key)
    }
  }, [open, strip])
}

type StripButtonProps = {
  label: string
  active?: boolean
  expanded?: boolean
  disabled?: boolean
  onPress: () => void
  children: ReactNode
}

function StripButton(props: StripButtonProps) {
  const { label, active = false, expanded, disabled = false, onPress, children } = props
  return (
    <button
      type="button"
      className="strip__button"
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      aria-controls={expanded === undefined ? undefined : inks_id}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  )
}
