// The tool column of the iPad's sketch: the drawing tools, and fixed to them a place for the
// agent's two buttons. The place is measured from the strip itself, so the buttons stay beside
// the brushes wherever the strip goes: down the left edge, or along the bottom of a stacked
// pane. The buttons belong to the page around the canvas, which puts them here.

import { useEffect, useRef } from 'react'
import { useEditor } from 'tldraw'
import { ToolStrip } from './tool_strip'

type Props = { editable: boolean; onSlot: (slot: HTMLElement | null) => void }

export function ToolSide({ editable, onSlot }: Props) {
  const editor = useEditor()
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = slot.current

    if (element === null) return

    // tldraw hears every key pressed inside its canvas frame and takes Escape, Space and Tab
    // for its own. A key pressed on the agent's buttons or their list is theirs alone.
    const claim = (event: KeyboardEvent) => editor.markEventAsHandled(event)
    element.addEventListener('keydown', claim)
    element.addEventListener('keyup', claim)
    onSlot(element)
    return () => {
      element.removeEventListener('keydown', claim)
      element.removeEventListener('keyup', claim)
      onSlot(null)
    }
  }, [editor, onSlot])

  return (
    <div className="toolside">
      <div className="toolside__set">
        <ToolStrip editable={editable} />
        <div ref={slot} className="toolside__slot" />
      </div>
    </div>
  )
}
