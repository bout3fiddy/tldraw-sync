// A page is one role, the pen or the stage, on one board at a time. The address names the board,
// so a page can be reloaded, bookmarked, or opened beside another on a different board, and the
// server never has to know which board anyone is looking at. Switching boards changes the
// address and mounts the new board afresh: nothing of one board's canvas carries to the next.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  board_draw_path,
  board_label,
  board_page_parse,
  board_stage_path,
  type BoardSession,
} from '../shared/board_session'
import type { Role } from '../shared/constants'
import { use_sessions } from './board_sessions'
import { DrawPage } from './draw_page'
import { Notice } from './notice'
import { SessionShell } from './session_rail'
import { StagePage } from './stage_page'

export function App({ role, initial }: { role: Role; initial: string | null }) {
  const [board, board_set] = useState(initial)
  const sessions = use_sessions()

  // Back and forward move between boards as they do between pages.
  useEffect(() => {
    const pop = () => {
      const parsed = board_page_parse(window.location.pathname)

      if (parsed !== null && parsed.role === role) board_set(parsed.id)
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [role])

  const choose = useCallback(
    (id: string) => {
      if (id === board) return

      const pathname = role === 'draw' ? board_draw_path(id) : board_stage_path(id)
      window.history.pushState(null, '', pathname)
      board_set(id)
    },
    [board, role],
  )

  const active = board ?? sessions.list?.[0]?.id ?? null
  const session = sessions.list?.find((candidate) => candidate.id === active) ?? null

  // A page which actually had this board open returns to its role's default address. A
  // stale bookmark still explains the missing board; it never silently opens another canvas.
  const last_known = useRef<string | null>(null)
  useEffect(() => {
    const previous = last_known.current
    last_known.current = session === null ? null : board

    if (session !== null || board === null || previous !== board) return

    if (board_page_parse(window.location.pathname)?.id !== board) return

    window.history.replaceState(null, '', role === 'draw' ? '/draw' : '/')
    board_set(null)
  }, [board, role, session])

  const title = session === null ? 'Board' : `${board_label(session)} · Board`
  useEffect(() => {
    window.document.title = title
  }, [title])

  return (
    <SessionShell
      role={role}
      sessions={sessions}
      active={active}
      title={session === null ? null : board_label(session)}
      onChoose={choose}
    >
      {board_content(role, active, session, sessions.list === null, sessions.failed)}
    </SessionShell>
  )
}

function board_content(
  role: Role,
  board: string | null,
  session: BoardSession | null,
  listing: boolean,
  failed: boolean,
) {
  if (listing) {
    return <Notice text={failed ? 'The Mac is not answering.' : 'Opening the board'} />
  }

  if (board === null) return null

  if (session === null) {
    return <Notice text="There is no such board. Open the list of boards to choose one." />
  }

  // Each board is mounted afresh: its sketch, canvas, chat and draft are its own.
  const title = board_label(session)

  if (role === 'draw') return <DrawPage key={board} session={board} title={title} />

  return <StagePage key={board} session={board} title={title} />
}
