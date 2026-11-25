// The strip's own icons, drawn on one 24-unit grid with one stroke weight so they read as a
// set. tldraw's icon font is not loaded, because its interface is hidden.

import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const icon_pen = (
  <Icon>
    <path d="M4.5 19.5l1.2-4.6L15.9 4.7a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L9.1 18.3z" />
    <path d="M14 6.6l3.4 3.4" />
  </Icon>
)

export const icon_eraser = (
  <Icon>
    <path
      d={'M8.2 19.5l-4-4a1.6 1.6 0 0 1 0-2.3l8.6-8.6a1.6 1.6 0 0 1 2.3 0l5 5'
        + 'a1.6 1.6 0 0 1 0 2.3l-7.6 7.6z'}
    />
    <path d="M8.7 9.3l6.9 6.9M8.2 19.5h11.3" />
  </Icon>
)

export const icon_undo = (
  <Icon>
    <path d="M8.5 5.5L4.5 9.5l4 4" />
    <path d="M4.5 9.5h9.2a5.3 5.3 0 0 1 0 10.6h-3.2" />
  </Icon>
)

export const icon_redo = (
  <Icon>
    <path d="M15.5 5.5l4 4-4 4" />
    <path d="M19.5 9.5h-9.2a5.3 5.3 0 0 0 0 10.6h3.2" />
  </Icon>
)

// The list of boards: a page with its side rail drawn in.
export const icon_boards = (
  <Icon>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9.5 4.7v14.6M5.8 8.5h1.4M5.8 11.5h1.4" />
  </Icon>
)

export const icon_plus = (
  <Icon>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
)

export const icon_close = (
  <Icon>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
)

// Keep the list open beside the board: a pin.
export const icon_pin = (
  <Icon>
    <path d="M9 4.5h6l-1 5 3 3H7l3-3z" />
    <path d="M12 12.5v7" />
  </Icon>
)

export const icon_clear = (
  <Icon>
    <path d="M6.5 3.5h7.6l3.9 3.9v13.1h-11.5z" />
    <path d="M13.9 3.7v3.9h3.9" />
  </Icon>
)
