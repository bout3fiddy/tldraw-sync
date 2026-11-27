// Three places on a board: the sketch, the Agent canvas, and the board's chat. The sketch
// canvas stays mounted in every view, so switching never interrupts the Pencil, loses the
// iPad's zoom or undo history, or stops the stage rendering the image agents fetch. The Agent
// canvas and the chat exist only while they are shown.

import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Role } from '../shared/constants'

export const views = [
  { id: 'sketch', label: 'Sketch' },
  { id: 'cleaned', label: 'Cleaned' },
  { id: 'chat', label: 'Chat' },
] as const
export type View = (typeof views)[number]['id']

// Each device remembers its own choice, so the iPad and the Mac can show different views. A
// choice this board no longer offers, such as the retired side-by-side view, opens the sketch
// and is written over.
export function use_view(role: Role): [View, (view: View) => void] {
  const key = `tldraw-sync.view.${role}`
  const [view, view_set] = useState<View>(() => view_stored(key))
  const view_choose = useCallback(
    (next: View) => {
      view_set(next)
      view_store(key, next)
    },
    [key],
  )
  return [view, view_choose]
}

function view_stored(key: string): View {
  try {
    const stored = window.localStorage.getItem(key)
    const known = views.find((view) => view.id === stored)?.id

    if (known !== undefined) return known

    if (stored !== null) view_store(key, 'sketch')

    return 'sketch'
  } catch {
    return 'sketch'
  }
}

function view_store(key: string, view: View): void {
  try {
    window.localStorage.setItem(key, view)
  } catch {
    // Private browsing may refuse storage; the choice still holds for this visit.
  }
}

type ViewTabsProps = {
  view: View
  linked?: boolean
  stale: boolean
  unread: number
  onChoose: (view: View) => void
}
const linked_labels = { sketch: 'Sketchboard', cleaned: 'Agent canvas', chat: 'Chat' }

// A tab list as the platform expects: one tab stop, arrow keys move between views.
const tab_keys: Record<string, (index: number) => number> = {
  ArrowLeft: (index) => (index + views.length - 1) % views.length,
  ArrowRight: (index) => (index + 1) % views.length,
  Home: () => 0,
  End: () => views.length - 1,
}

export function ViewTabs({ view, linked, stale, unread, onChoose }: ViewTabsProps) {
  const key_down = (event: KeyboardEvent<HTMLElement>) => {
    const step = tab_keys[event.key]

    if (step === undefined) return

    event.preventDefault()
    const next = step(views.findIndex((candidate) => candidate.id === view))
    onChoose(views[next]!.id)
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <nav
      className="tabs"
      role="tablist"
      aria-label="Views"
      onKeyDown={key_down}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {views.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          role="tab"
          className="tabs__tab"
          data-view={candidate.id}
          aria-selected={view === candidate.id}
          aria-controls={`view-${candidate.id}`}
          tabIndex={view === candidate.id ? 0 : -1}
          onClick={() => onChoose(candidate.id)}
        >
          {linked ? linked_labels[candidate.id] : candidate.label}
          {candidate.id === 'cleaned' && stale && (
            <>
              <span className="tabs__stale" title="The sketch changed since this was made" />
              <span className="visually-hidden">, out of date</span>
            </>
          )}
          {candidate.id === 'chat' && unread > 0 && (
            <>
              <span className="tabs__unread" data-testid="chat-unread" />
              <span className="visually-hidden">
                , {unread} new {unread === 1 ? 'answer' : 'answers'}
              </span>
            </>
          )}
        </button>
      ))}
    </nav>
  )
}

type ViewPanesProps = {
  view: View
  linked?: boolean
  sketch: ReactNode
  cleaned: ReactNode
  chat: ReactNode
}

export function ViewPanes({ view, linked, sketch, cleaned, chat }: ViewPanesProps) {
  return (
    <div className="views" data-view={view}>
      <section
        id="view-sketch"
        className="views__pane views__pane--sketch"
        aria-label={linked ? linked_labels.sketch : 'Sketch'}
        aria-hidden={view !== 'sketch'}
      >
        {sketch}
      </section>
      {view === 'cleaned' && (
        <section
          id="view-cleaned"
          className="views__pane views__pane--cleaned"
          aria-label={linked ? linked_labels.cleaned : 'Cleaned'}
        >
          {cleaned}
        </section>
      )}
      {view === 'chat' && (
        <section id="view-chat" className="views__pane views__pane--chat" aria-label="Chat">
          {chat}
        </section>
      )}
    </div>
  )
}
