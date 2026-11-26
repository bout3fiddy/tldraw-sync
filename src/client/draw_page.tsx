// The iPad workspace: a canvas and a tool strip. Everything else tldraw offers is hidden. Tabs
// switch to the cleaned diagram, or show it beside the sketch while drawing continues.

import { useCallback, useState } from 'react'
import { AgentActions } from './agent_actions'
import { DefaultSizeStyle, Tldraw, type Editor } from 'tldraw'
import { asset_urls, components_quiet, use_board_store } from './board_store'
import { CleanedPane } from './cleaned_pane'
import { use_cleaned } from './cleaned_state'
import { Notice } from './notice'
import { ToolSide } from './tool_side'
import { use_view, ViewPanes, ViewTabs } from './views'

export function DrawPage({ session }: { session: string }) {
  const board = use_board_store('draw', session)
  const [view, view_choose] = use_view('draw')
  const cleaned = use_cleaned(session)
  const linked = cleaned.status?.linked === true
  const [editor, setEditor] = useState<Editor | null>(null)

  // Where the agent's two buttons go while the sketch is on screen: beside its tools.
  const [tools, tools_set] = useState<HTMLElement | null>(null)

  // Where the one action on the Agent canvas goes while that canvas is on screen: its head.
  const [head, head_set] = useState<HTMLElement | null>(null)
  const mount = useCallback((value: Editor) => {
    draw_mount(value)
    setEditor(value)
  }, [])
  if (board.status === 'loading') return <Notice text="Opening the board" />
  if (board.status === 'error') {
    return <Notice text="The board is not answering. Start it on your Mac, then reload." />
  }

  return (
    <main className="board board--draw" data-linked={linked}>
      <ViewPanes
        linked={linked}
        view={view}
        sketch={
          <Tldraw
            store={board.store}
            hideUi
            assetUrls={asset_urls}
            components={components_quiet}
            onMount={mount}
          >
            <ToolSide editable={linked} onSlot={tools_set} />
          </Tldraw>
        }
        cleaned={
          <div className="agent-pane">
            <div ref={head_set} className="agent-pane__head" />
            <div className="agent-pane__canvas">
              <CleanedPane cleaned={cleaned} />
            </div>
          </div>
        }
      />
      <ViewTabs view={view} linked={linked} stale={!!cleaned.status?.stale}
        onChoose={view_choose} />
      <AgentActions editor={editor} session={session}
        cleaned={cleaned} view={view} online={board.connectionStatus !== 'offline'}
        tools={tools} head={head} showSketch={() => view_choose('sketch')} />
      {!linked && board.connectionStatus === 'offline' && (
        <Notice floating text="Lost the Mac. Keep drawing: strokes sync when it is back." />
      )}
    </main>
  )
}

function draw_mount(editor: Editor): void {
  // The nib is a width on the screen, not on the page: a stroke written zoomed far out is
  // stored that much wider, so it is as heavy to the writer as one written at full size, and
  // stays that heavy on the stage and in the image agents read.
  editor.user.updateUserPreferences({ colorScheme: 'light', isDynamicSizeMode: true })
  editor.setCurrentTool('draw')
  // The fine nib suits handwriting: a note stays legible at the size it was written.
  editor.setStyleForNextShapes(DefaultSizeStyle, 's')
  editor.updateInstanceState({
    isGridMode: true,
    // With a Pencil in play, only the Pencil draws. A resting palm or a finger never leaves
    // a mark; two fingers still pan and zoom.
    isPenMode: window.navigator.maxTouchPoints > 0,
  })
}
