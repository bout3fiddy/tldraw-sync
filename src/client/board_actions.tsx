import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { board_default_id, board_label, type BoardSession } from '../shared/board_session'
import { session_delete } from './board_sessions'
import { icon_actions, icon_delete, icon_rename } from './icons'

type Props = {
  session: BoardSession
  onRename(): void
  onRemove(id: string): void
  onError(): void
}

// The button is deliberately separate from the link. Secondary clicks, long presses and
// modifier clicks on that link keep the browser's normal navigation choices.
export function BoardActions({ session, onRename, onRemove, onError }: Props) {
  const [open, open_set] = useState(false)
  const [confirm, confirm_set] = useState<BoardSession | null>(null)
  const [busy, busy_set] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const label = `Actions for ${board_label(session)}`

  const remove = async (selected: BoardSession) => {
    const rail = button.current?.closest('aside')
    confirm_set(null)
    busy_set(true)
    const removed = await session_delete(selected)
    busy_set(false)

    if (removed) onRemove(selected.id)
    else onError()

    restore_focus(rail, removed ? null : button.current)
  }

  const dismiss = () => {
    open_set(false)
    button.current?.focus()
  }

  return (
    <>
      <button
        type="button"
        className="rail__options"
        ref={button}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => open_set(!open)}
      >
        {icon_actions}
      </button>
      {open && (
        <ActionMenu
          session={session}
          trigger={button}
          onOutside={() => open_set(false)}
          onDismiss={dismiss}
          onRename={onRename}
          onDelete={() => {
            open_set(false)
            confirm_set(session)
          }}
        />
      )}
      {confirm && (
        <DeleteDialog
          session={confirm}
          onConfirm={() => void remove(confirm)}
          onCancel={() => {
            confirm_set(null)
            button.current?.focus()
          }}
        />
      )}
    </>
  )
}

// Once React removes the row, restore keyboard focus without stealing it from a new choice.
function restore_focus(rail: HTMLElement | null | undefined, button: HTMLButtonElement | null) {
  window.requestAnimationFrame(() => {
    if (document.activeElement !== document.body) return

    const next = button ?? rail?.querySelector<HTMLAnchorElement>('[aria-current="page"]')
    next?.focus()
  })
}

type MenuProps = {
  session: BoardSession
  trigger: RefObject<HTMLButtonElement>
  onOutside(): void
  onDismiss(): void
  onRename(): void
  onDelete(): void
}

function ActionMenu({ session, trigger, onOutside, onDismiss, onRename, onDelete }: MenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const permanent = session.id === board_default_id
  const explanation = 'permanent-board-note'
  useEffect(() => {
    menu.current?.querySelector('button')?.focus()
  }, [])
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target

      if (!(target instanceof Node) || menu.current?.contains(target)) return

      if (!trigger.current?.contains(target)) onOutside()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [onOutside, trigger])

  return (
    <div
      role="menu"
      className="rail__menu"
      aria-label={`Actions for ${board_label(session)}`}
      ref={menu}
      onKeyDown={(event) => menu_keys(event, onDismiss)}
    >
      <button role="menuitem" tabIndex={-1} onClick={onRename}>
        {icon_rename} Rename
      </button>
      <button
        role="menuitem"
        tabIndex={-1}
        disabled={permanent}
        onClick={onDelete}
        aria-describedby={permanent ? explanation : undefined}
      >
        {icon_delete} Delete
      </button>
      {permanent && <small id={explanation}>The default board is permanent.</small>}
    </div>
  )
}

function menu_keys(event: KeyboardEvent<HTMLDivElement>, dismiss: () => void) {
  const key = event.key

  if (key === 'Escape' || key === 'Tab') {
    if (key === 'Escape') event.preventDefault()

    event.stopPropagation()
    return dismiss()
  }

  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return

  event.preventDefault()
  const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')
  const first = buttons[0]!
  const last = buttons[buttons.length - 1]!
  const use_first = key === 'Home' || (key !== 'End' && event.target === last)
  const target = use_first ? first : last
  target.focus()
}

function DeleteDialog({
  session,
  onCancel,
  onConfirm,
}: {
  session: BoardSession
  onCancel(): void
  onConfirm(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const cancel = () => {
    dialog.current?.close()
    onCancel()
  }

  return (
    <dialog
      ref={dialog}
      className="rail__confirm"
      aria-labelledby="delete-title"
      aria-describedby="delete-description"
      onCancel={cancel}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h3 id="delete-title">Delete “{board_label(session)}”?</h3>
      <p id="delete-description">This deletes the board and its contents. It cannot be undone.</p>
      <div className="rail__confirm-buttons">
        <button className="rail__new" onClick={cancel} autoFocus>
          Cancel
        </button>
        <button className="rail__new" onClick={onConfirm}>
          {icon_delete} Delete board
        </button>
      </div>
    </dialog>
  )
}
