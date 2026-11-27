import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { board_label, type BoardSession } from '../shared/board_session'
import type { BoardMenuItem } from './board_menu'
import { session_delete } from './board_sessions'
import { icon_actions, icon_delete, icon_rename } from './icons'

type Props = {
  session: BoardSession

  // The board on screen's own actions, offered by its page; empty for every other board.
  extra: readonly BoardMenuItem[]
  onRename(): void
  onRemove(id: string): void
  onError(): void
  onExtra(): void
}

// The button is deliberately separate from the link. Secondary clicks, long presses and
// modifier clicks on that link keep the browser's normal navigation choices.
export function BoardActions({ session, extra, onRename, onRemove, onError, onExtra }: Props) {
  const [open, open_set] = useState(false)
  const [confirm, confirm_set] = useState<BoardSession | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const { busy, remove } = use_board_delete(button, onRemove, onError)
  const label = `Actions for ${board_label(session)}`

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
          extra={extra}
          trigger={button}
          onOutside={() => open_set(false)}
          onDismiss={dismiss}
          onRename={onRename}
          onExtra={(item) => {
            open_set(false)
            onExtra()
            item.run()
          }}
          onDelete={() => {
            open_set(false)
            confirm_set(session)
          }}
        />
      )}
      {confirm && (
        <DeleteDialog
          session={confirm}
          onConfirm={() => {
            confirm_set(null)
            void remove(confirm)
          }}
          onCancel={() => {
            confirm_set(null)
            button.current?.focus()
          }}
        />
      )}
    </>
  )
}

// Deletes a confirmed board: busy while the board answers, then focus goes where the row was.
function use_board_delete(
  button: RefObject<HTMLButtonElement>,
  onRemove: (id: string) => void,
  onError: () => void,
) {
  const [busy, busy_set] = useState(false)
  const remove = async (selected: BoardSession) => {
    const rail = button.current?.closest('aside')
    busy_set(true)
    const removed = await session_delete(selected)
    busy_set(false)

    if (removed) onRemove(selected.id)
    else onError()

    restore_focus(rail, removed ? null : button.current)
  }
  return { busy, remove }
}

// Once React removes the row, restore keyboard focus without stealing it from a new choice.
function restore_focus(rail: HTMLElement | null | undefined, button: HTMLButtonElement | null) {
  window.requestAnimationFrame(() => {
    if (document.activeElement !== document.body) return

    const next = button ?? rail?.querySelector<HTMLAnchorElement>('[aria-current="page"]')
    const target = next ?? rail?.querySelector<HTMLButtonElement>('.rail__new')
    target?.focus()
  })
}

type MenuProps = {
  session: BoardSession
  extra: readonly BoardMenuItem[]
  trigger: RefObject<HTMLButtonElement>
  onOutside(): void
  onDismiss(): void
  onRename(): void
  onExtra(item: BoardMenuItem): void
  onDelete(): void
}

function ActionMenu(props: MenuProps) {
  const { session, extra, trigger, onOutside, onDismiss, onRename, onExtra, onDelete } = props
  const menu = useRef<HTMLDivElement>(null)
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
      {extra.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          onClick={() => onExtra(item)}
        >
          {item.label}
        </button>
      ))}
      <button role="menuitem" tabIndex={-1} onClick={onDelete}>
        {icon_delete} Delete
      </button>
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
  const count = buttons.length
  const current = Array.prototype.indexOf.call(buttons, event.target) as number

  if (count === 0 || current < 0) return

  const step = key === 'ArrowUp' ? -1 : 1
  const next = key === 'Home' ? 0 : key === 'End' ? count - 1 : (current + count + step) % count
  buttons[next]!.focus()
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
