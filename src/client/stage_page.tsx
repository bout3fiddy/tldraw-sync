// The Mac presentation view: the whole drawing, fitted to the window, and nothing else.
// Until an iPad is connected it also shows how to connect one.

import { useEffect, useState } from 'react'
import { Tldraw, useEditor, useValue } from 'tldraw'
import { path_pairing } from '../shared/constants'
import { asset_urls, components_quiet, use_board_store } from './board_store'
import { Notice } from './notice'
import { stage_mount } from './stage_mount'

type Pairing = { url: string; modules: string[] }

export function StagePage() {
  const board = use_board_store('stage')
  if (board.status === 'loading') return <Notice text="Opening the board" />
  if (board.status === 'error') {
    return <Notice text="The board is not answering. Start it with “bun start”, then reload." />
  }

  return (
    <main className="board board--stage">
      <Tldraw
        store={board.store}
        hideUi
        assetUrls={asset_urls}
        components={components_quiet}
        onMount={stage_mount}
      >
        <StageGuide />
      </Tldraw>
      {board.connectionStatus === 'offline' && (
        <Notice floating text="The board has stopped. Start it again with “bun start”." />
      )}
    </main>
  )
}

// Shown only while it is useful: large on an empty board, tucked in a corner once there is
// a drawing, and gone the moment a pen connects.
function StageGuide() {
  const editor = useEditor()
  const pairing = use_pairing()
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

function use_pairing(): Pairing | null {
  const [pairing, pairing_set] = useState<Pairing | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(path_pairing)
      .then((response) => (response.ok ? (response.json() as Promise<Pairing>) : null))
      .then((loaded) => {
        if (!cancelled) pairing_set(loaded)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
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
