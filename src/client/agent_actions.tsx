// The iPad's one dealing with the Agent canvas besides reading it: copying it into the sketch.
// Replacing the sketch is a human-only step, offered at the head of the Agent canvas it copies
// from, in one step that Undo takes back. Talking with the agent is the chat's.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from 'tldraw'
import { cleaned_page_id, type CleanedDocument } from '../shared/canvas_types'
import type { CleanedState } from './cleaned_state'
import { Notice } from './notice'
import { replace_sketch } from './replace_sketch'

type Props = {
  editor: Editor | null
  cleaned: CleanedState
  online: boolean

  // The head of the Agent canvas, while that canvas is on screen.
  head: HTMLElement | null
  showSketch: () => void
}

// Long enough to read one line; short enough not to sit on the board.
const notice_ms = 4000

// A line about something the person just did, shown for a moment and then taken away.
function use_notice(): [string, (text: string) => void] {
  const [notice, notice_set] = useState('')
  useEffect(() => {
    if (notice === '') return

    const timer = window.setTimeout(() => notice_set(''), notice_ms)
    return () => window.clearTimeout(timer)
  }, [notice])
  return [notice, notice_set]
}

// Whether a published canvas holds anything to copy into the sketch: a shape placed on its
// page, which is what `replace_sketch` pastes, with whatever a group among them holds. An
// empty canvas is a valid revision with nothing to copy, and a canvas never published has no
// revision at all.
function copyable(document: CleanedDocument | null): document is CleanedDocument {
  if (!document?.current) return false

  const records = document.records as Array<{ typeName: string; parentId?: string }>
  return records.some((r) => r.typeName === 'shape' && r.parentId === cleaned_page_id)
}

// Only the person drawing replaces the sketch, in one step that Undo takes back. The step is
// offered only when there is something to copy, so it is never offered where it can only fail.
export function AgentActions({ editor, cleaned, online, head, showSketch }: Props) {
  const [notice, notice_show] = use_notice()
  const possible = online && copyable(cleaned.document)
  const replace = () => {
    if (!editor || !online || !copyable(cleaned.document)) return

    const ok = replace_sketch(editor, cleaned.document)
    notice_show(ok ? 'Sketch replaced. Undo restores your ink.' : 'Could not replace the sketch.')

    if (ok) showSketch()
  }
  return (
    <>
      {head !== null &&
        createPortal(
          <button type="button" className="cleaned__replace" disabled={!possible} onClick={replace}>
            Replace sketchboard
          </button>,
          head,
        )}
      {notice !== '' && <Notice floating text={notice} />}
    </>
  )
}
