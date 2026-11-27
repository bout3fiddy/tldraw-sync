// The Mac presentation view: the one canvas, the person's ink over the agent's print, fitted
// to the window. It only presents: nothing on it can be drawn on or taken. Until an iPad is
// connected it also shows how to connect one.

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { atom, useEditor, useValue, type Atom, type Editor } from 'tldraw'
import { board_query } from '../shared/board_session'
import { path_pairing } from '../shared/constants'
import { BoardKey } from './board_key'
import { use_board_store } from './board_store'
import { ChatButton, ChatDrawer, use_chat_open } from './chat_drawer'
import { ChatPane } from './chat_pane'
import { use_board_chat, use_stage_token } from './chat_state'
import { use_cleaned } from './cleaned_state'
import { icon_pair } from './icons'
import { Notice } from './notice'
import { PreviewBench } from './preview_bench'
import { StageTap } from './inspect'
import { use_interactive, use_print_choice, ViewChoiceProvider } from './interactive_state'
import { PrintProvider, type PrintExtent } from './print_engine'
import { ViewSwitch } from './view_switch'
import { stage_mount } from './stage_mount'
import { Surface } from './surface'

type Pairing = { url: string; modules: string[] }
const offline_notice = 'The board has stopped. Start it again with “tldraw-sync start”.'

// The sketch canvas stays mounted while the chat is open: it renders the image agents fetch.
// On a linked board the stage also draws an agent's drafts, out of sight, when asked, and
// holds the board's chat, read and sent with the pairing it hands the iPad.
export function StagePage({ session, title }: { session: string; title: string }) {
  const board = use_board_store('stage', session)
  const [chat_open, chat_open_set] = use_chat_open('stage')
  const cleaned = use_cleaned(session)
  const linked = cleaned.status?.linked === true
  const pairing = use_pairing(session)
  const extent = useMemo(() => atom<PrintExtent | null>('print extent', null), [])
  const choice = use_interactive(session, cleaned.document)
  const print_choice = use_print_choice(choice)
  const following = useMemo(() => atom('stage following', true), [])
  const [editor, mount] = use_stage_editor(session, extent, following)

  const token = use_stage_token(session, linked)
  const online = board.status === 'synced-remote' && board.connectionStatus !== 'offline'
  const talk = use_board_chat({ session, token, linked, online, editor, viewing: chat_open })

  if (board.status === 'loading') return <Notice text="Opening the board" />

  if (board.status === 'error') {
    const text = 'The board is not answering. Start it with “tldraw-sync start”, then reload.'
    return <Notice text={text} />
  }

  return (
    <main className="board board--stage" data-linked={linked} data-chat={chat_open}>
      <ViewChoiceProvider value={choice}>
        <PrintProvider document={cleaned.document} extent={extent} choice={print_choice}>
          <Surface store={board.store} onMount={mount}>
            <StageGuide pairing={pairing} extent={extent} />
            <StageTap />
            <ViewSwitch />
          </Surface>
          <BoardKey editor={editor} notice="" linked={linked} interactive={false} />
        </PrintProvider>
      </ViewChoiceProvider>
      <StageFit following={following} editor={editor} />
      <div className="corner">
        {linked && <StagePair pairing={pairing} />}
        <ChatButton
          open={chat_open}
          unread={talk.unread}
          onToggle={() => chat_open_set(!chat_open)}
        />
      </div>
      <ChatDrawer role="stage" open={chat_open} onClose={() => chat_open_set(false)}>
        <ChatPane
          role="stage"
          title={title}
          linked={linked}
          online={online}
          paired={token !== null}
          {...talk}
          onOpenCanvas={() => chat_open_set(false)}
        />
      </ChatDrawer>
      {linked && <PreviewBench session={session} />}
      {board.connectionStatus === 'offline' && <Notice floating text={offline_notice} />}
    </main>
  )
}

function StageFit({ following, editor }: { following: Atom<boolean>; editor: Editor | null }) {
  const follows_board = useValue(following)

  if (follows_board) return null

  const resume = () => {
    following.set(true)
    editor?.focus()
  }
  return (
    <button type="button" className="stage-fit" onClick={resume}>
      Fit board
    </button>
  )
}

// The stage's own sketch editor: it renders the image agents fetch, and is read when the
// sketch is added to a message sent from the Mac.
function use_stage_editor(
  session: string,
  print: Atom<PrintExtent | null>,
  following: Atom<boolean>,
): [Editor | null, (editor: Editor) => () => void] {
  const [editor, editor_set] = useState<Editor | null>(null)
  const mount = useCallback(
    (value: Editor) => {
      editor_set(value)
      const stop = stage_mount(value, session, print, following)
      return () => {
        stop()
        editor_set(null)
      }
    },
    [session, print, following],
  )
  return [editor, mount]
}

const pair_sheet_id = 'stage-pair'

// Pairing an iPad with a linked board: one instrument at the top right, beside Chat. Pressed,
// it shows the stage's QR on a sheet under it; pressed again, or Escape, puts the sheet away.
function StagePair({ pairing }: { pairing: Pairing | null }) {
  const [open, open_set] = useState(false)
  const key_down = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return

    event.preventDefault()
    open_set(false)
  }
  return (
    <div className="pair" onKeyDown={key_down}>
      <div className="pair__frame">
        <button
          type="button"
          className="pair__button"
          aria-expanded={open}
          aria-controls={pair_sheet_id}
          onClick={() => open_set(!open)}
        >
          {icon_pair}
          Pair iPad
        </button>
      </div>
      {open && (
        <aside id={pair_sheet_id} className="pair__sheet" aria-label="Pair iPad">
          {pairing === null ? (
            <p className="pair__caption">The pairing code has not loaded. Reload this page.</p>
          ) : (
            <>
              <QrCode modules={pairing.modules} />
              <p className="pair__caption">Scan for sketchboard controls</p>
            </>
          )}
        </aside>
      )}
    </div>
  )
}

// Shown only while it is useful: large on an empty board, tucked in a corner once there is
// a drawing, and gone the moment a pen connects.
type GuideProps = { pairing: Pairing | null; extent: Atom<PrintExtent | null> }

function StageGuide({ pairing, extent }: GuideProps) {
  const editor = useEditor()
  const pen_connected = useValue(
    'pen connected',
    () => editor.getCollaborators().some((collaborator) => collaborator.userName === 'draw'),
    [editor],
  )
  const empty = useValue(
    'empty board',
    () => editor.getCurrentPageShapeIds().size === 0 && extent.get()?.bounds == null,
    [editor, extent],
  )

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
