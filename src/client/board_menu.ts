// The board's own menu: the actions for the board on screen, beside Rename and Delete in the
// list of boards. The draw page puts its sketch actions there, clearing and replacing the
// sketch, so they are deliberate choices and never controls on the canvas.

import { createContext, useContext, useEffect } from 'react'

export type BoardMenuItem = {
  label: string
  run: () => void
  disabled: boolean
}

type Menu = readonly BoardMenuItem[]
export const BoardMenuContext = createContext<(update: (items: Menu) => Menu) => void>(() => {})

// Offers `items` for as long as the caller is mounted. The list must be memoised by its caller.
export function use_board_menu(items: readonly BoardMenuItem[]): void {
  const offer = useContext(BoardMenuContext)
  useEffect(() => {
    offer((current) => current.concat(items))
    return () => offer((current) => current.filter((item) => !items.includes(item)))
  }, [offer, items])
}
