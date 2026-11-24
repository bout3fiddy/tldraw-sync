// The iPad workspace: a canvas and a tool strip. Everything else tldraw offers is hidden.

import { DefaultSizeStyle, Tldraw, type Editor } from 'tldraw'
import { asset_urls, components_quiet, use_board_store } from './board_store'
import { Notice } from './notice'
import { ToolStrip } from './tool_strip'

export function DrawPage() {
  const board = use_board_store('draw')
  if (board.status === 'loading') return <Notice text="Opening the board" />
  if (board.status === 'error') {
    return <Notice text="The board is not answering. Start it on your Mac, then reload." />
  }

  return (
    <main className="board">
      <Tldraw
        store={board.store}
        hideUi
        assetUrls={asset_urls}
        components={components_quiet}
        onMount={draw_mount}
      >
        <ToolStrip />
      </Tldraw>
      {board.connectionStatus === 'offline' && (
        <Notice floating text="Lost the Mac. Keep drawing: strokes sync when it is back." />
      )}
    </main>
  )
}

function draw_mount(editor: Editor): void {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
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
