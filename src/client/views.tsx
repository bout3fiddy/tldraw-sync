// Three ways to look at the board: the sketch, the cleaned diagram, or both side by side. The
// sketch canvas stays mounted in every view, so switching never interrupts the Pencil, loses
// the iPad's zoom or undo history, or stops the stage rendering the image agents fetch. The
// cleaned canvas exists only while it is shown.

import { useCallback, useState, type ReactNode } from 'react'
import type { Role } from '../shared/constants'

export const views = [
  { id: 'sketch', label: 'Sketch' },
  { id: 'cleaned', label: 'Cleaned' },
  { id: 'side', label: 'Side by side' },
] as const
export type View = (typeof views)[number]['id']

// Each device remembers its own choice, so the iPad and the Mac can show different views.
export function use_view(role: Role): [View, (view: View) => void] {
  const key = `tldraw-sync.view.${role}`
  const [view, view_set] = useState<View>(() => view_stored(key))
  const view_choose = useCallback(
    (next: View) => {
      view_set(next)

      try {
        window.localStorage.setItem(key, next)
      } catch {
        // Private browsing may refuse storage; the choice still holds for this visit.
      }
    },
    [key],
  )
  return [view, view_choose]
}

function view_stored(key: string): View {
  try {
    const stored = window.localStorage.getItem(key)
    return views.find((view) => view.id === stored)?.id ?? 'sketch'
  } catch {
    return 'sketch'
  }
}

type ViewTabsProps = { view: View; stale: boolean; onChoose: (view: View) => void }

export function ViewTabs({ view, stale, onChoose }: ViewTabsProps) {
  return (
    <nav
      className="tabs"
      role="tablist"
      aria-label="Views"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {views.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          role="tab"
          className="tabs__tab"
          aria-selected={view === candidate.id}
          onClick={() => onChoose(candidate.id)}
        >
          {candidate.label}
          {candidate.id === 'cleaned' && stale && (
            <span className="tabs__stale" title="The sketch changed since this cleanup" />
          )}
        </button>
      ))}
    </nav>
  )
}

type ViewPanesProps = { view: View; sketch: ReactNode; cleaned: ReactNode }

export function ViewPanes({ view, sketch, cleaned }: ViewPanesProps) {
  return (
    <div className="views" data-view={view}>
      <section
        className="views__pane views__pane--sketch"
        aria-label="Sketch"
        aria-hidden={view === 'cleaned'}
      >
        {sketch}
      </section>
      {view !== 'sketch' && (
        <section className="views__pane views__pane--cleaned" aria-label="Cleaned">
          {cleaned}
        </section>
      )}
    </div>
  )
}
