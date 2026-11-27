// The key at the foot of the canvas: whose ink is whose, which revision of the agent's print is
// shown, and a line about what the person just did. A new revision says so here for a moment,
// with the one before a press away; looking at it never restores or publishes anything. On the
// draw page each name also brings its layer into view, the only thing here that moves a camera.

import { useEffect, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import { use_print, type Print } from './print_engine'
import type { PrintBox } from './print_svg'
import { box_seen, camera_fit, ink_box } from './surface_fit'

// Long enough to read one line; short enough not to sit on the board.
const notice_ms = 4000

// A line about something the person just did, shown for a moment and then taken away.
export function use_notice(): [string, (text: string) => void] {
  const [notice, notice_set] = useState('')
  useEffect(() => {
    if (notice === '') return

    const timer = window.setTimeout(() => notice_set(''), notice_ms)
    return () => window.clearTimeout(timer)
  }, [notice])
  return [notice, notice_set]
}

type KeyProps = {
  editor: Editor | null
  notice: string
  linked: boolean

  // The stage presents: its key says, and offers nothing to press.
  interactive: boolean
}

type Words = { ink: string; agent: string | null; action: string | null }

export function BoardKey({ editor, notice, linked, interactive }: KeyProps) {
  const print = use_print()
  const print_box = print?.view?.bounds ?? null
  const seen_text = useValue('key seen', () => layers_seen(editor, print_box), [editor, print_box])
  const seen = {
    ink: seen_text[0] === '1',
    ink_any: seen_text[1] === '1',
    print: seen_text[2] === '1',
  }
  const words = key_words(print, linked)
  const state = print?.showing_previous ? 'previous' : print?.arrived ? 'arrived' : 'calm'
  const act = () => (print?.showing_previous ? print.show_current() : print?.show_previous())
  const fit = (box: PrintBox | null) => {
    if (editor !== null && box !== null) camera_fit(editor, box)
  }
  return (
    <div className="key" data-state={state} role="status">
      <KeyItem
        layer="ink"
        text={words.ink}
        away={!seen.ink}
        interactive={interactive && editor !== null && seen.ink_any}
        onPress={() => fit(editor === null ? null : ink_box(editor))}
      />
      {words.agent !== null && (
        <KeyItem
          layer="agent"
          text={words.agent}
          away={!seen.print}
          interactive={interactive && print_box !== null}
          onPress={() => fit(print_box)}
        />
      )}
      {words.action !== null && interactive && (
        <button type="button" className="key__action" onClick={act}>
          {words.action}
        </button>
      )}
      {notice !== '' && <span className="key__notice">{notice}</span>}
    </div>
  )
}

type ItemProps = {
  layer: 'ink' | 'agent'
  text: string
  away: boolean
  interactive: boolean
  onPress: () => void
}

// One layer's name. Pressed, it brings that layer into view; out of view, it says so.
function KeyItem({ layer, text, away, interactive, onPress }: ItemProps) {
  const content = (
    <>
      <span className="key__swatch" aria-hidden="true" />
      <span>{text}</span>
      {away && <span className="key__away"> · out of view</span>}
    </>
  )

  if (!interactive) {
    return (
      <span className="key__item" data-layer={layer}>
        {content}
      </span>
    )
  }

  return (
    <button
      type="button"
      className="key__item"
      data-layer={layer}
      title="Bring into view"
      onClick={onPress}
    >
      {content}
    </button>
  )
}

function key_words(print: Print | null, linked: boolean): Words {
  const current = print?.revision_current ?? 0
  const shown = print?.view?.revision ?? current
  const failed = print?.view?.failed ?? 0
  const missing = failed > 0 ? ` · ${failed} not shown` : ''

  if (print?.showing_previous) {
    return {
      ink: 'Your ink',
      agent: `Agent · showing revision ${shown}${missing}`,
      action: `Back to revision ${current}`,
    }
  }

  if (print?.arrived) {
    const previous = print.revision_previous
    return {
      ink: 'Your ink, untouched',
      agent: `Agent · revision ${current}, just now${missing}`,
      action: previous === null ? null : `Show revision ${previous}`,
    }
  }

  if (current === 0) {
    return { ink: 'Your ink', agent: linked ? 'Agent · nothing yet' : null, action: null }
  }

  return { ink: 'Your ink', agent: `Agent · revision ${current}${missing}`, action: null }
}

// Whether the ink is in view, whether there is any, and whether the print is in view, as
// three digits: a string, so the key redraws only when one of them changes.
function layers_seen(editor: Editor | null, print_box: PrintBox | null): string {
  if (editor === null) return '101'

  const ink = ink_box(editor)
  const flags = [
    ink === null || box_seen(editor, ink),
    ink !== null,
    print_box === null || box_seen(editor, print_box),
  ]
  return flags.map((flag) => (flag ? '1' : '0')).join('')
}
