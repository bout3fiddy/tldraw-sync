// The tool column of the iPad's sketch: the drawing tools, down the left edge of the pane.
// Talking with the agent is the chat's, one tab away, so nothing else is fixed to the tools.

import { ToolStrip } from './tool_strip'

type Props = { editable: boolean }

export function ToolSide({ editable }: Props) {
  return (
    <div className="toolside">
      <div className="toolside__set">
        <ToolStrip editable={editable} />
      </div>
    </div>
  )
}
