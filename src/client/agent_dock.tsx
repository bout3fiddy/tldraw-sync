// The agent's two instruments: one opens the note, one lists what became of each request.
// While the sketch is on screen they are fixed to its drawing tools, the note button first.
// With only the Agent canvas showing there are no tools, and they wait in the band above it.
// Each carries a dot when there is something to come back to: a note not yet sent, or news
// not yet read. The list opens only when the bell is pressed. While the note is open it is
// the only thing that can be pressed: a press on either button then only puts the note away.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { icon_bell, icon_chat } from './icons'
import { composer_id } from './notify_composer'
import {
  inbox_entry_stale,
  inbox_state_label,
  inbox_subject_label,
  type InboxEntry,
} from './notify_inbox'

const inbox_id = 'agent-inbox'

// Where the two buttons are put: the place kept for them beside the drawing tools, or the
// band above the views. `null` is the moment before the sketch has made its place.
export type DockHome = HTMLElement | 'band' | null

type DockProps = {
  home: DockHome
  composing: boolean
  draft: boolean
  entries: readonly InboxEntry[]
  listing: boolean
  hint: string
  latest_event_id: string | null
  trigger: RefObject<HTMLButtonElement>
  bell: RefObject<HTMLButtonElement>
  onCompose: () => void
  onList: (open: boolean) => void
}

export function AgentDock(props: DockProps) {
  const { home, composing, draft, entries, listing, onList } = props
  const unread = inbox_unread(entries)
  const bell_label = unread.length > 0 ? `Notifications, ${unread.length} unread` : 'Notifications'
  const dock = (
    <div className="dockside" data-place={home === 'band' ? 'band' : 'tools'}>
      <div className="dock" role="group" aria-label="Agent requests">
        <DockButton
          button={props.trigger}
          label={draft ? 'Agent note, draft saved' : 'Agent note'}
          title="Agent note"
          expanded={composing}
          controls={composer_id}
          dot={draft}
          onPress={props.onCompose}
        >
          {icon_chat}
        </DockButton>
        <DockButton
          button={props.bell}
          label={bell_label}
          title="Notifications"
          expanded={listing}
          controls={inbox_id}
          dot={unread.length > 0}
          onPress={() => onList(!listing)}
        >
          {icon_bell}
        </DockButton>
      </div>
      {listing && (
        <InboxPanel
          entries={entries}
          hint={props.hint}
          latest_event_id={props.latest_event_id}
          onDismiss={() => onList(false)}
        />
      )}
    </div>
  )
  return (
    <>
      {home === null ? null : home === 'band' ? dock : createPortal(dock, home)}
      <p className="visually-hidden" role="status">
        {inbox_news(entries)}
      </p>
    </>
  )
}

type DockButtonProps = {
  button: RefObject<HTMLButtonElement>
  label: string
  title: string
  expanded: boolean
  controls: string
  dot: boolean
  onPress: () => void
  children: ReactNode
}

function DockButton(props: DockButtonProps) {
  return (
    <button
      ref={props.button}
      type="button"
      className="dock__button"
      aria-label={props.label}
      title={props.title}
      aria-haspopup="dialog"
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={props.onPress}
    >
      {props.children}
      {props.dot && <span className="dock__dot" />}
    </button>
  )
}

const inbox_unread = (entries: readonly InboxEntry[]) => entries.filter((entry) => entry.unread)

// Read out to a screen reader while the list stays closed: the newest change not yet seen.
export function inbox_news(entries: readonly InboxEntry[]): string {
  let newest: InboxEntry | null = null

  for (const entry of inbox_unread(entries)) {
    if (newest === null || entry.changed_at_ms >= newest.changed_at_ms) newest = entry
  }

  if (newest === null) return ''

  const title = `${inbox_subject_label(newest.subject)}: ${inbox_state_label(newest.state)}`
  return newest.detail === '' ? title : `${title}. ${newest.detail}`
}

type PanelProps = {
  entries: readonly InboxEntry[]
  hint: string
  latest_event_id: string | null
  onDismiss: () => void
}

function InboxPanel({ entries, hint, latest_event_id, onDismiss }: PanelProps) {
  const panel = useRef<HTMLElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  // The list takes the focus it was asked for, and gives the screen back when the pen or a
  // finger lands anywhere else. The press itself is left alone: it still draws. Escape is
  // heard by the page, wherever the focus is.
  useEffect(() => {
    panel.current?.focus()
    const press = (event: PointerEvent) => {
      const inside = event.target instanceof Element && event.target.closest('.inbox, .dock')

      if (!inside) dismiss.current()
    }
    window.addEventListener('pointerdown', press, true)
    return () => window.removeEventListener('pointerdown', press, true)
  }, [])

  const newest_first = [...entries].reverse()
  return (
    <section
      ref={panel}
      id={inbox_id}
      className="inbox"
      role="dialog"
      aria-label="Notifications"
      tabIndex={-1}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h2 className="inbox__title">Notifications</h2>
      {hint !== '' && <p className="inbox__hint">{hint}</p>}
      {entries.length === 0 ? (
        <p className="inbox__empty">Nothing sent from this board yet.</p>
      ) : (
        <ol className="inbox__list">
          {newest_first.map((entry) => (
            <InboxRow
              key={entry.key}
              entry={entry}
              stale={inbox_entry_stale(entry, latest_event_id)}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

// One request: what it was, how far it got, when that was last seen, and the agent's words.
function InboxRow({ entry, stale }: { entry: InboxEntry; stale: boolean }) {
  const changed = new Date(entry.changed_at_ms)
  return (
    <li className="inbox__row" data-state={entry.state} data-subject={entry.subject}>
      <span className="inbox__mark" aria-hidden="true" />
      <div className="inbox__text">
        <p className="inbox__subject">{inbox_subject_label(entry.subject)}</p>
        <p className="inbox__state">
          {inbox_state_label(entry.state)}
          {stale && ', last known'}
        </p>
        {entry.detail !== '' && <p className="inbox__detail">{entry.detail}</p>}
      </div>
      <time className="inbox__time" dateTime={changed.toISOString()}>
        {time_text(changed, new Date())}
      </time>
    </li>
  )
}

// Today, the time is enough. For an older row the day matters more than the minute.
function time_text(changed: Date, now: Date): string {
  if (changed.toDateString() === now.toDateString()) {
    return changed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return changed.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
