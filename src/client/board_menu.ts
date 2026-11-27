// The board's own menu: the actions for the board on screen, beside Rename and Delete in the
// list of boards. The draw page puts its sketch actions there, clearing and replacing the
// sketch, so they are deliberate choices and never controls on the canvas.

import { createContext, useContext, useEffect } from 'react'

export type BoardMenuItem = {
  label: string
  run: () => void
  disabled: boolean
}

export const BoardMenuContext = createContext<(items: readonly BoardMenuItem[]) => void>(() => {})

// Offers `items` for as long as the caller is mounted. The list must be memoised by its caller.
export function use_board_menu(items: readonly BoardMenuItem[]): void {
  const offer = useContext(BoardMenuContext)
  useEffect(() => {
    offer(items)
    return () => offer([])
  }, [offer, items])
}
