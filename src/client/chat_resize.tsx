// Only this local preference changes during a resize. The editor and chat stay mounted.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { assert } from '../shared/assert'
import type { Role } from '../shared/constants'

const width_default_px = 440
const width_min_px = 320
const width_max_px = 720
const canvas_min_px = 360
const canvas_key_min_px = 660
const key_step_px = 24

function clamp(width: number, max: number): number {
  return Math.max(width_min_px, Math.min(max, Math.round(width)))
}

function read_width(key: string): number {
  try {
    const raw = localStorage.getItem(key)
    const width = Number(raw)

    if (Number.isSafeInteger(width) && width >= width_min_px && width <= width_max_px) return width
  } catch {
    // Private browsing may refuse storage.
  }

  return width_default_px
}

type Preference = { preferred: number; save: (width: number) => void }

export function use_chat_width(role: Role): Preference {
  const key = `tldraw-sync.chat-width.${role}`
  const [preferred, prefer] = useState(() => read_width(key))
  const save = (value: number) => {
    prefer(value)

    try {
      localStorage.setItem(key, String(value))
    } catch {
      // The drawer owner keeps the preference across closes during this visit.
    }
  }

  return { preferred, save }
}

// Measure the board, not the window: the docked list has already taken its share. A temporary
// clamp (including rotation) never replaces the person's preferred width in storage.
export function ChatSize({ preferred, save, controls }: Preference & { controls: string }) {
  const [preview, preview_set] = useState<number | null>(null)
  const [room, room_set] = useState(0)
  const handle = useRef<HTMLDivElement>(null)
  const maximum = clamp(room - canvas_min_px, width_max_px)
  const width = clamp(preview ?? preferred, maximum)

  useLayoutEffect(() => {
    const board = handle.current?.closest<HTMLElement>('.board')
    assert(board != null, 'the chat edge belongs to a board')
    const measure = () => room_set(board.clientWidth)
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(board)

    return () => {
      observer.disconnect()
      board.style.removeProperty('--drawer-width')
      delete board.dataset.narrowCanvas
    }
  }, [])

  useLayoutEffect(() => {
    const board = handle.current?.closest<HTMLElement>('.board')
    assert(board != null, 'the drawer shares its width with the canvas')
    board.style.setProperty('--drawer-width', `${width}px`)
    board.dataset.narrowCanvas = String(room - width <= canvas_key_min_px)
  }, [room, width])

  const commit = (value: number) => {
    save(value)
    preview_set(null)
  }
  const events = use_edge_events(width, maximum, preview_set, commit)

  return (
    <div
      ref={handle}
      className="chat-edge"
      role="separator"
      tabIndex={0}
      aria-label="Chat width"
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={width_min_px}
      aria-valuemax={maximum}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      {...events}
    />
  )
}

function use_edge_events(
  width: number,
  max: number,
  preview: (width: number | null) => void,
  commit: (width: number) => void,
) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const cancel = () => {
    drag.current = null
    preview(null)
  }
  const track = (event: PointerEvent<HTMLDivElement>, end: boolean) => {
    const start = drag.current

    if (start?.id !== event.pointerId) return

    event.stopPropagation()

    // A rotation or software keyboard may hide the edge mid-gesture.
    if (!event.currentTarget.offsetWidth) return cancel()

    const next = clamp(start.width + start.x - event.clientX, max)

    if (end) {
      if (next === start.width) return cancel()

      drag.current = null
      commit(next)
    } else {
      preview(next)
    }
  }

  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!event.isPrimary || event.button !== 0 || drag.current) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { id: event.pointerId, x: event.clientX, width }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => track(event, false),
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => track(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id === event.pointerId) cancel()
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      const next = {
        Home: width_min_px,
        End: max,
        ArrowLeft: width + key_step_px,
        ArrowRight: width - key_step_px,
      }[event.key]

      if (next === undefined || drag.current) return

      event.preventDefault()
      event.stopPropagation()
      commit(clamp(next, max))
    },
  }
}
