// The board's chat, opened from one button at the top right of the canvas. It slides over the
// right of the canvas without stopping it: the sketch keeps its camera, the iPad keeps
// drawing, and the stage keeps rendering the image agents fetch. An answer not yet read here
// is a violet square on the button. Each device remembers whether its chat was open.

import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Role } from '../shared/constants'
import { icon_chat } from './icons'
import { ChatSize, use_chat_width } from './chat_resize'

export const chat_drawer_id = 'board-chat'

// Stored under the key the retired view tabs used. Only 'chat' opens the chat: any other
// choice, such as the retired Side by side or Agent canvas, opens the canvas and is written
// over.
export function use_chat_open(role: Role): [boolean, (open: boolean) => void] {
  const key = `tldraw-sync.view.${role}`
  const [open, open_set] = useState(() => chat_stored(key))
  const choose = useCallback(
    (next: boolean) => {
      open_set(next)
      chat_store(key, next)
    },
    [key],
  )
  return [open, choose]
}

function chat_stored(key: string): boolean {
  try {
    const stored = window.localStorage.getItem(key)

    if (stored === 'chat') return true

    if (stored !== null && stored !== 'sketch') chat_store(key, false)

    return false
  } catch {
    return false
  }
}

function chat_store(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(key, open ? 'chat' : 'sketch')
  } catch {
    // Private browsing may refuse storage; the choice still holds for this visit.
  }
}

type ButtonProps = { open: boolean; unread: number; onToggle: () => void }

export function ChatButton({ open, unread, onToggle }: ButtonProps) {
  return (
    <div className="chat-toggle">
      <button
        type="button"
        className="chat-toggle__button"
        aria-expanded={open}
        aria-controls={chat_drawer_id}
        onClick={onToggle}
      >
        {icon_chat}
        <span>Chat</span>
        {unread > 0 && (
          <>
            <span className="chat-toggle__unread" data-testid="chat-unread" />
            <span className="visually-hidden">
              , {unread} new {unread === 1 ? 'answer' : 'answers'}
            </span>
          </>
        )}
      </button>
    </div>
  )
}

type DrawerProps = { role: Role; open: boolean; onClose: () => void; children: ReactNode }

export function ChatDrawer({ role, open, onClose, children }: DrawerProps) {
  const width = use_chat_width(role)

  if (!open) return null

  const key_down = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return

    event.preventDefault()
    onClose()
  }
  return (
    <aside id={chat_drawer_id} className="drawer" aria-label="Chat" onKeyDown={key_down}>
      {children}
      <ChatSize {...width} controls={chat_drawer_id} />
    </aside>
  )
}
