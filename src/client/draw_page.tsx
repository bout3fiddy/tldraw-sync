// The iPad workspace: a canvas and a tool strip. Everything else tldraw offers is hidden. Tabs
// switch to the Agent canvas or to the board's chat, while the sketch stays mounted behind.

import { useCallback, useState } from 'react'
import { AgentActions } from './agent_actions'
import { DefaultSizeStyle, Tldraw, type Editor } from 'tldraw'
import { use_pair_token } from './board_pair'
import { asset_urls, components_quiet, use_board_store } from './board_store'
import { ChatPane } from './chat_pane'
import { use_board_chat } from './chat_state'
import { CleanedPane } from './cleaned_pane'
import { use_cleaned, type CleanedState } from './cleaned_state'
import { Notice } from './notice'
import { ToolSide } from './tool_side'
import { use_view, ViewPanes, ViewTabs } from './views'

export function DrawPage({ session, title }: { session: string; title: string }) {
  const board = use_board_store('draw', session)
  const [view, view_choose] = use_view('draw')
  const cleaned = use_cleaned(session)
  const linked = cleaned.status?.linked === true
  const [editor, setEditor] = useState<Editor | null>(null)
  const token = use_pair_token(session)
  const online = board.status === 'synced-remote' && board.connectionStatus !== 'offline'
  const viewing = view === 'chat'
  const talk = use_board_chat({ session, token, linked, online, editor, viewing })

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
            <ToolSide editable={linked} />
          </Tldraw>
        }
        cleaned={<AgentPane cleaned={cleaned} onHead={head_set} />}
        chat={
          <ChatPane
            role="draw"
            title={title}
            linked={linked}
            online={online}
            paired={token !== null}
            {...talk}
            onOpenCanvas={() => view_choose('cleaned')}
          />
        }
      />
      <ViewTabs
        view={view}
        linked={linked}
        stale={!!cleaned.status?.stale}
        unread={talk.unread}
        onChoose={view_choose}
      />
      <AgentActions editor={editor} cleaned={cleaned} online={online}
        head={head} showSketch={() => view_choose('sketch')} />
      {!linked && !online && (
        <Notice floating text="Lost the Mac. Keep drawing: strokes sync when it is back." />
      )}
    </main>
  )
}

// The Agent canvas under a head of its own, where its one action goes.
type AgentPaneProps = { cleaned: CleanedState; onHead: (head: HTMLElement | null) => void }

function AgentPane({ cleaned, onHead }: AgentPaneProps) {
  return (
    <div className="agent-pane">
      <div ref={onHead} className="agent-pane__head" />
      <div className="agent-pane__canvas">
        <CleanedPane cleaned={cleaned} />
      </div>
    </div>
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
