// The Mac presentation view: the whole drawing, fitted to the window, and nothing else.
// Until an iPad is connected it also shows how to connect one.

import { useCallback, useEffect, useState } from 'react'
import { Tldraw, useEditor, useValue, type Editor } from 'tldraw'
import { board_query } from '../shared/board_session'
import type { Layer } from '../shared/whiteboard'
import { LayerChoice } from './agent_actions'
import { path_pairing } from '../shared/constants'
import { asset_urls, components_quiet, use_board_store } from './board_store'
import { CleanedPane } from './cleaned_pane'
import { use_cleaned } from './cleaned_state'
import { Notice } from './notice'
import { stage_mount } from './stage_mount'
import { use_view, ViewPanes, ViewTabs } from './views'

type Pairing = { url: string; modules: string[] }

// The sketch canvas stays mounted whichever view is chosen: it renders the image agents fetch.
export function StagePage({ session }: { session: string }) {
  const board = use_board_store('stage', session)
  const [view, view_choose] = use_view('stage')
  const [layer, choose] = useState<Layer>('interpretation')
  const cleaned = use_cleaned(session, layer)
  const linked = cleaned.status?.linked === true
  const [pair, showPair] = useState(false)
  const pairing = use_pairing(session)
  const mount = useCallback((editor: Editor) => stage_mount(editor, session), [session])
  if (board.status === 'loading') return <Notice text="Opening the board" />
  if (board.status === 'error') {
    const text = 'The board is not answering. Start it with “tldraw-sync start”, then reload.'
    return <Notice text={text} />
  }

  return (
    <main className="board board--stage" data-linked={linked}>
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
            <StageGuide pairing={pairing} />
          </Tldraw>
        }
        cleaned={<CleanedPane cleaned={cleaned} ideas={layer === 'ideas'} />}
      />
      <ViewTabs view={view} linked={linked} stale={layer !== 'ideas' && !!cleaned.status?.stale}
        onChoose={view_choose} />
      {linked && <footer className="agent-rail">
        {view !== 'sketch' && <LayerChoice layer={layer} choose={choose} />}
        <button aria-expanded={pair} onClick={() => showPair(!pair)}>Pair iPad</button>
        {pair && pairing && <aside className="pair-inset"><QrCode modules={pairing.modules} />
          <p>Scan for sketchboard controls</p></aside>}
      </footer>}
      {board.connectionStatus === 'offline' && (
        <Notice
          floating
          text="The board has stopped. Start it again with “tldraw-sync start”."
        />
      )}
    </main>
  )
}

// Shown only while it is useful: large on an empty board, tucked in a corner once there is
// a drawing, and gone the moment a pen connects.
function StageGuide({ pairing }: { pairing: Pairing | null }) {
  const editor = useEditor()
  const pen_connected = useValue(
    'pen connected',
    () => editor.getCollaborators().some((collaborator) => collaborator.userName === 'draw'),
    [editor],
  )
  const empty = useValue('empty', () => editor.getCurrentPageShapeIds().size === 0, [editor])

  if (pen_connected) {
    return empty ? <p className="guide guide--hint">Draw on your iPad. It appears here.</p> : null
  }
  if (pairing === null) return null
  return (
    <aside className={empty ? 'guide guide--card' : 'guide guide--corner'}>
      <QrCode modules={pairing.modules} />
      <div className="guide__text">
        <p className="guide__title">{empty ? 'Scan with your iPad to draw' : 'Scan to draw'}</p>
        {empty && <p className="guide__address">{pairing.url}</p>}
      </div>
    </aside>
  )
}

// Each board has a QR code of its own, which leads the iPad to that board.
function use_pairing(session: string): Pairing | null {
  const [pairing, pairing_set] = useState<Pairing | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`${path_pairing}?${board_query(session)}`, { headers: { 'x-board-stage': 'qr' } })
      .then((response) => (response.ok ? (response.json() as Promise<Pairing>) : null))
      .then((loaded) => {
        if (!cancelled) pairing_set(loaded)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session])
  return pairing
}

// One path for all dark modules. Crisp edges keep the squares exact, which scanners need.
function QrCode({ modules }: { modules: string[] }) {
  const quiet = 2
  const size = modules.length + quiet * 2
  let path = ''
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === '1') path += `M${x + quiet} ${y + quiet}h1v1h-1z`
    }
  })
  return (
    <svg
      className="guide__code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
    >
      <title>QR code for the draw page</title>
      <path d={path} fill="currentColor" />
    </svg>
  )
}
