// The list of boards, down the left edge, like the conversations of a chat app: a new board at
// the top, then every board, the one on screen marked. It stays out of the way of the canvas.
// Closed, it is one small button in the corner; open, it lies over the board until a board is
// chosen or the canvas is touched. On a wide screen it can be pinned open beside the board.
//
// Every board is a real link, so a board opens in a tab or window of its own with the usual
// modifier click, and two boards can be watched side by side.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { assert } from '../shared/assert'
import {
  board_default_id,
  board_draw_path,
  board_label,
  board_name_clean,
  board_stage_path,
  type BoardSession,
} from '../shared/board_session'
import { board_name_length_max, type Role } from '../shared/constants'
import { session_create, session_rename, type SessionsState } from './board_sessions'
import { icon_boards, icon_close, icon_pin, icon_plus, icon_rename } from './icons'

type ShellProps = {
  role: Role
  sessions: SessionsState
  active: string
  onChoose: (id: string) => void
  children: ReactNode
}

const rail_id = 'board-rail'
const wide_query = '(min-width: 1200px)'

export function SessionShell({ role, sessions, active, onChoose, children }: ShellProps) {
  const wide = use_media(wide_query)
  const [pinned, pinned_set] = use_stored_flag(`tldraw-sync.rail.${role}`)
  const [open, open_set] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const docked = wide && pinned
  const shown = docked || open

  const close = useCallback(() => {
    open_set(false)
    pinned_set(false)
    window.requestAnimationFrame(() => toggle.current?.focus())
  }, [pinned_set])

  // In the drawer, choosing a board hands the screen straight back to the pen.
  const choose = useCallback(
    (id: string) => {
      onChoose(id)

      if (!docked) open_set(false)
    },
    [docked, onChoose],
  )

  const mode = docked ? 'docked' : open ? 'open' : 'closed'
  return (
    <div className="shell" data-rail={mode}>
      <div className="shell__board">{children}</div>
      {!shown && (
        <button
          ref={toggle}
          type="button"
          className="rail-toggle"
          aria-expanded={false}
          aria-controls={rail_id}
          aria-label="Boards"
          title="Boards"
          onClick={() => open_set(true)}
        >
          {icon_boards}
        </button>
      )}
      {shown && !docked && <div className="rail-scrim" onPointerDown={close} />}
      {shown && (
        <Rail
          role={role}
          sessions={sessions}
          active={active}
          docked={docked}
          wide={wide}
          onChoose={choose}
          onPin={() => pinned_set(!pinned)}
          onClose={close}
        />
      )}
    </div>
  )
}

type RailProps = {
  role: Role
  sessions: SessionsState
  active: string
  docked: boolean
  wide: boolean
  onChoose: (id: string) => void
  onPin: () => void
  onClose: () => void
}

function Rail({ role, sessions, active, docked, wide, onChoose, onPin, onClose }: RailProps) {
  const rail = useRef<HTMLElement>(null)
  const [creating, creating_set] = useState(false)
  const [problem, problem_set] = useState<string | null>(null)

  // Opened as a drawer, the list takes the focus, on the board shown, and Escape gives it back.
  useEffect(() => {
    if (docked) return

    const element = rail.current
    const target =
      element?.querySelector<HTMLElement>('[aria-current="page"]') ??
      element?.querySelector<HTMLElement>('.rail__new')
    target?.focus()
  }, [docked])

  const create = async () => {
    if (creating) return

    creating_set(true)
    problem_set(null)
    const outcome = await session_create()
    creating_set(false)

    if (outcome.kind === 'full') return problem_set('There are as many boards as there can be.')

    if (outcome.kind === 'failed') return problem_set('The Mac did not answer. Try again.')

    sessions.merge(outcome.session)
    onChoose(outcome.session.id)
  }

  return (
    <aside
      id={rail_id}
      ref={rail}
      className="rail"
      aria-label="Boards"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !docked) onClose()
      }}
    >
      <RailHeader docked={docked} wide={wide} onPin={onPin} onClose={onClose} />
      <button type="button" className="rail__new" disabled={creating} onClick={() => void create()}>
        {icon_plus}
        <span>New board</span>
      </button>
      {problem !== null && (
        <p className="rail__problem" role="status">
          {problem}
        </p>
      )}
      <RailList role={role} sessions={sessions} active={active} onChoose={onChoose} />
    </aside>
  )
}

type HeaderProps = { docked: boolean; wide: boolean; onPin: () => void; onClose: () => void }

// Pinning is offered only where there is room to keep the list beside the board.
function RailHeader({ docked, wide, onPin, onClose }: HeaderProps) {
  return (
    <header className="rail__header">
      <h2 className="rail__title">Boards</h2>
      {wide && (
        <button
          type="button"
          className="rail__icon"
          aria-pressed={docked}
          aria-label="Keep the list open"
          title="Keep the list open"
          onClick={onPin}
        >
          {icon_pin}
        </button>
      )}
      <button
        type="button"
        className="rail__icon"
        aria-label="Close the list of boards"
        title="Close"
        onClick={onClose}
      >
        {icon_close}
      </button>
    </header>
  )
}

type ListProps = {
  role: Role
  sessions: SessionsState
  active: string
  onChoose: (id: string) => void
}

// Newest first, as a chat app lists its conversations.
function RailList({ role, sessions, active, onChoose }: ListProps) {
  if (sessions.list === null) {
    const text = sessions.failed ? 'The Mac is not answering.' : 'Loading the boards'
    return (
      <p className="rail__problem" role="status">
        {text}
      </p>
    )
  }

  const newest_first = [...sessions.list].reverse()
  return (
    <nav className="rail__nav" aria-label="All boards">
      <ul className="rail__list">
        {newest_first.map((session) => (
          <RailItem
            key={session.id}
            role={role}
            session={session}
            active={session.id === active}
            onChoose={onChoose}
            onRenamed={sessions.merge}
          />
        ))}
      </ul>
    </nav>
  )
}

type ItemProps = {
  role: Role
  session: BoardSession
  active: boolean
  onChoose: (id: string) => void
  onRenamed: (session: BoardSession) => void
}

function RailItem({ role, session, active, onChoose, onRenamed }: ItemProps) {
  const [editing, editing_set] = useState(false)
  const [problem, problem_set] = useState<string | null>(null)
  const label = board_label(session)
  const href = role === 'draw' ? board_draw_path(session.id) : board_stage_path(session.id)

  if (editing) {
    return (
      <li className="rail__item">
        <RenameField
          session={session}
          onDone={(renamed) => {
            editing_set(false)
            problem_set(renamed === 'failed' ? 'Not renamed: the Mac did not answer.' : null)

            if (renamed !== null && renamed !== 'failed') onRenamed(renamed)
          }}
        />
      </li>
    )
  }

  return (
    <li className="rail__item" data-active={active}>
      <a
        className="rail__link"
        href={href}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => {

          // A plain click switches here; a modifier click opens the board in its own tab.
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return

          if (event.altKey) return

          event.preventDefault()
          onChoose(session.id)
        }}
      >
        <span className={session.name === null ? 'rail__name rail__name--untitled' : 'rail__name'}>
          {label}
        </span>
        {session.name === null && session.id !== board_default_id && (
          <span className="rail__meta">{created_text(session.created_at_ms)}</span>
        )}
        {problem !== null && <span className="rail__meta rail__meta--problem">{problem}</span>}
      </a>
      <button
        type="button"
        className="rail__rename"
        aria-label={`Rename ${label}`}
        title="Rename"
        onClick={() => editing_set(true)}
      >
        {icon_rename}
      </button>
    </li>
  )
}

type Renamed = BoardSession | 'failed' | null

// Enter or leaving the field saves; Escape, or a name left empty or unchanged, keeps the old.
function RenameField({ session, onDone }: { session: BoardSession; onDone: (r: Renamed) => void }) {
  const [draft, draft_set] = useState(session.name ?? '')
  const done = useRef(false)

  const finish = async (save: boolean) => {
    if (done.current) return

    done.current = true
    const name = save ? board_name_clean(draft, board_name_length_max) : null

    if (name === null || name === session.name) return onDone(null)

    const outcome = await session_rename(session.id, name)
    assert(outcome.kind === 'failed' || outcome.session.id === session.id, 'renamed in place')
    onDone(outcome.kind === 'renamed' ? outcome.session : 'failed')
  }

  return (
    <form
      className="rail__rename-form"
      onSubmit={(event) => {
        event.preventDefault()
        void finish(true)
      }}
    >
      <input
        className="rail__input"
        aria-label="Board name"
        value={draft}
        maxLength={board_name_length_max}
        autoFocus
        enterKeyHint="done"
        placeholder="Name this board"
        onChange={(event) => draft_set(event.target.value)}
        onBlur={() => void finish(true)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return

          event.stopPropagation()
          void finish(false)
        }}
      />
    </form>
  )
}

// When an unnamed board was made, which is what tells unnamed boards apart.
function created_text(created_at_ms: number): string {
  const created = new Date(created_at_ms)
  const today = new Date().toDateString() === created.toDateString()
  const time = created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  if (today) return `Today, ${time}`

  return `${created.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

function use_media(query: string): boolean {
  const [matches, matches_set] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const change = () => matches_set(media.matches)
    media.addEventListener('change', change)
    change()
    return () => media.removeEventListener('change', change)
  }, [query])
  return matches
}

// A choice this device remembers, like the view.
function use_stored_flag(key: string): [boolean, (value: boolean) => void] {
  const [value, value_set] = useState(() => {
    try {
      return window.localStorage.getItem(key) === 'true'
    } catch {
      return false
    }
  })
  const store = useCallback(
    (next: boolean) => {
      value_set(next)

      try {
        window.localStorage.setItem(key, String(next))
      } catch {
        // Private browsing may refuse storage; the choice still holds for this visit.
      }
    },
    [key],
  )
  return [value, store]
}
