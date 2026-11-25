// A page is one role, the pen or the stage, on one board at a time. The address names the board,
// so a page can be reloaded, bookmarked, or opened beside another on a different board, and the
// server never has to know which board anyone is looking at. Switching boards changes the
// address and mounts the new board afresh: nothing of one board's canvas carries to the next.

import { useCallback, useEffect, useState } from 'react'
import {
  board_draw_path,
  board_label,
  board_page_parse,
  board_stage_path,
} from '../shared/board_session'
import type { Role } from '../shared/constants'
import { use_sessions } from './board_sessions'
import { DrawPage } from './draw_page'
import { Notice } from './notice'
import { SessionShell } from './session_rail'
import { StagePage } from './stage_page'

export function App({ role, initial }: { role: Role; initial: string }) {
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

  const session = sessions.list?.find((candidate) => candidate.id === board) ?? null
  const title = session === null ? 'Board' : `${board_label(session)} · Board`
  useEffect(() => {
    window.document.title = title
  }, [title])

  const known = sessions.list === null ? null : session !== null
  return (
    <SessionShell role={role} sessions={sessions} active={board} onChoose={choose}>
      {board_content(role, board, known, sessions.failed)}
    </SessionShell>
  )
}

// `known` is null until the list arrives. A board that does not answer still mounts, so the
// page says that the board is not answering, as it always did.
function board_content(role: Role, board: string, known: boolean | null, failed: boolean) {
  if (known === null && !failed) return <Notice text="Opening the board" />

  if (known === false) {
    return <Notice text="There is no such board. Open the list of boards to choose one." />
  }

  if (role === 'draw') return <DrawPage key={board} session={board} />

  return <StagePage key={board} session={board} />
}
