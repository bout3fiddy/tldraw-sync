// The iPad workspace: one canvas, where the person's ink lies over the agent's print in one
// camera, with the drawing tools floating at the left, and Chat at the top
// right. No band runs across the top: every instrument floats over the canvas.
// Everything else tldraw offers is hidden. There are no layers to switch between: the chat
// slides over the canvas, and the canvas never stops. Only a drawing the agent made
// interactive brings its own switch, which changes that drawing on this iPad alone.

import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { atom, DefaultSizeStyle, useValue, type Atom, type Editor } from 'tldraw'
import { use_pair_token } from './board_pair'
import { PrintNotice, use_notice } from './print_notice'
import { use_board_menu, type BoardMenuItem } from './board_menu'
import { use_board_store } from './board_store'
import { ChatButton, ChatDrawer, use_chat_open } from './chat_drawer'
import { composer_field_id } from './chat_composer'
import { ChatPane } from './chat_pane'
import { use_board_chat } from './chat_state'
import { use_cleaned } from './cleaned_state'
import { Inspect } from './inspect'
import { use_interactive, use_print_choice, ViewChoiceProvider } from './interactive_state'
import { Notice } from './notice'
import { PrintProvider, use_print, type Print, type PrintExtent } from './print_engine'
import { Surface } from './surface'
import { camera_fit, ink_box } from './surface_fit'
import { sketch_hash, take_into_sketch, type TakeOutcome } from './take_apply'
import { take_tools } from './take_tools'
import { pen_ink_set, ToolStrip } from './tool_strip'
import { ViewSwitch } from './view_switch'

export function DrawPage({ session, title }: { session: string; title: string }) {
  const board = use_board_store('draw', session)
  const cleaned = use_cleaned(session)
  const linked = cleaned.status?.linked === true
  const [editor, editor_set] = useState<Editor | null>(null)
  const token = use_pair_token(session)
  const online = board.status === 'synced-remote' && board.connectionStatus !== 'offline'
  const [chat_open, chat_open_set] = use_chat_open('draw')
  const talk = use_board_chat({ session, token, linked, online, editor, viewing: chat_open })
  const extent = useMemo(() => atom<PrintExtent | null>('print extent', null), [])
  const [notice, notice_show] = use_notice()
  const mount = useCallback((value: Editor) => {
    draw_mount(value)
    editor_set(value)
    return () => editor_set(null)
  }, [])

  const ask = (words: string) => chat_ask(talk.composer, words, () => chat_open_set(true))
  const show_canvas = use_show_canvas({ editor, extent, chat_open, chat_open_set })

  // The view of an interactive drawing chosen on this iPad, and the print of it.
  const choice = use_interactive(session, cleaned.document)
  const print_choice = use_print_choice(choice)

  if (board.status === 'loading') return <Notice text="Opening the board" />

  if (board.status === 'error') {
    return <Notice text="The board is not answering. Start it on your Mac, then reload." />
  }

  return (
    <main className="board board--draw" data-linked={linked} data-chat={chat_open}>
      <ViewChoiceProvider value={choice}>
        <PrintProvider document={cleaned.document} choice={print_choice} extent={extent}>
          <Surface store={board.store} onMount={mount}>
            <ToolStrip />
            <Inspect onOutcome={(outcome) => notice_show(take_notice(outcome))} onAsk={ask} />
            <ViewSwitch />
          </Surface>
          <PrintNotice notice={notice} />
          <SketchMenu editor={editor} onNotice={notice_show} />
        </PrintProvider>
      </ViewChoiceProvider>
      <div className="corner">
        <ChatButton
          open={chat_open}
          unread={talk.unread}
          onToggle={() => chat_open_set(!chat_open)}
        />
      </div>
      <ChatDrawer role="draw" open={chat_open} onClose={() => chat_open_set(false)}>
        <ChatPane
          role="draw"
          title={title}
          linked={linked}
          online={online}
          paired={token !== null}
          {...talk}
          onOpenCanvas={show_canvas}
        />
      </ChatDrawer>
      {!linked && !online && (
        <Notice floating text="Lost the Mac. Keep drawing: strokes sync when it is back." />
      )}
    </main>
  )
}

type ShowCanvasInput = {
  editor: Editor | null
  extent: Atom<PrintExtent | null>
  chat_open: boolean
  chat_open_set: (open: boolean) => void
}

// An answer that drew on the canvas leads back to it: the chat closes and the print is
// brought into view, because the person asked. The fit waits for the closed chat to be laid
// out, so it is planned for the canvas at its full width.
function use_show_canvas({ editor, extent, chat_open, chat_open_set }: ShowCanvasInput) {
  const [fit_pending, fit_pending_set] = useState(false)

  useLayoutEffect(() => {
    if (!fit_pending || chat_open) return

    fit_pending_set(false)
    const box = extent.get()?.bounds ?? null

    if (editor !== null && box !== null) camera_fit(editor, box)
  }, [fit_pending, chat_open, editor, extent])

  return () => {
    chat_open_set(false)
    fit_pending_set(true)
  }
}

type Composer = ReturnType<typeof use_board_chat>['composer']

// Asking about a shape starts a note in the chat, and leaves it for the person to finish.
function chat_ask(composer: Composer, words: string, open: () => void) {
  const text = composer.text.trim() === '' ? words : `${composer.text}\n${words}`
  composer.change(text)
  open()
  window.requestAnimationFrame(() => document.getElementById(composer_field_id)?.focus())
}

// Feedback after an explicit take.
export function take_notice(outcome: TakeOutcome): string {
  if (outcome.kind === 'taken') return 'Copied into your sketch. Undo takes it back.'

  switch (outcome.reason) {
    case 'revision_changed':
      return 'The agent has a newer revision. Tap the shape again to take it.'
    case 'sketch_changed':
      return 'Your sketch changed. Tap the shape again to take it.'
    case 'unsupported':
      return 'This shape cannot be copied into your sketch.'
    case 'elbow_bound':
      return 'This arrow is joined to shapes outside it. Take those with it.'
    case 'too_many':
      return 'That is too much to copy at once.'
    case 'missing':
    case 'not_top_level':
      return 'That shape is no longer on the print.'
    case 'failed':
      return 'Could not copy it. Your sketch is unchanged.'
  }
}

type MenuProps = { editor: Editor | null; onNotice: (text: string) => void }

// The sketch's actions in the board's menu: clear the ink, or replace it with the whole print,
// each one step that Undo takes back.
function SketchMenu({ editor, onNotice }: MenuProps) {
  const print = use_print()
  const empty = useValue(
    'empty',
    () => editor === null || editor.getCurrentPageShapeIds().size === 0,
    [editor],
  )
  const view = print?.view ?? null
  const revision_current = print?.revision_current ?? 0
  const replace_possible = view !== null && view.shapes.length > 0 && !print?.showing_previous
  const items = useMemo<BoardMenuItem[]>(() => {
    const clear = () => {
      if (editor === null) return

      editor.markHistoryStoppingPoint('clear the sketch')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      onNotice('Ink cleared. Undo brings it back.')
    }
    const replace = () => {
      if (editor === null || view === null) return

      const ask = {
        roots: view.shapes.map((shape) => shape.id),
        replace: true,
        revision_seen: view.revision,
        revision_now: revision_current,
        sketch_hash_seen: sketch_hash(editor),
      }
      const outcome = take_into_sketch(editor, view.editor, ask, take_tools)
      const replaced = 'Sketch replaced. Undo restores your ink.'
      onNotice(outcome.kind === 'taken' ? replaced : take_notice(outcome))
    }
    const list = [{ label: 'Clear my ink', run: clear, disabled: empty || editor === null }]

    if (view !== null) {
      const label = `Replace my sketch with revision ${view.revision}`
      list.push({ label, run: replace, disabled: !replace_possible || editor === null })
    }

    return list.concat(view_actions(editor, print, empty))
  }, [editor, view, print, revision_current, empty, replace_possible, onNotice])
  use_board_menu(items)
  return null
}

// These actions change only this editor's view, never the board's records.
function view_actions(editor: Editor | null, print: Print | null, empty: boolean): BoardMenuItem[] {
  if (!editor) return []

  const fit_ink = () => {
    const box = ink_box(editor)

    if (box) camera_fit(editor, box)
  }
  const items = [{ label: 'Fit my ink', run: fit_ink, disabled: empty }]
  const bounds = print?.view?.bounds

  if (bounds) {
    items.push({
      label: 'Fit agent drawing',
      run: () => camera_fit(editor, bounds),
      disabled: false,
    })
  }

  if (print && print.revision_previous !== null) {
    const label = print.showing_previous
      ? `Back to revision ${print.revision_current}`
      : `Show revision ${print.revision_previous}`
    const run = print.showing_previous ? print.show_current : print.show_previous
    items.push({ label, run, disabled: false })
  }

  return items
}

function draw_mount(editor: Editor): void {

  // The nib is a width on the screen, not on the page: a stroke written zoomed far out is
  // stored that much wider, so it is as heavy to the writer as one written at full size, and
  // stays that heavy on the stage and in the image agents read.
  editor.user.updateUserPreferences({ colorScheme: 'light', isDynamicSizeMode: true })
  pen_ink_set(editor)
  editor.setCurrentTool('draw')

  // The fine nib suits handwriting: a note stays legible at the size it was written.
  editor.setStyleForNextShapes(DefaultSizeStyle, 's')
  editor.updateInstanceState({
    isGridMode: true,

    // With a Pencil in play, only the Pencil draws. A resting palm or a finger never leaves
    // a mark; two fingers still pan and zoom, and one finger inspects the agent's print.
    isPenMode: window.navigator.maxTouchPoints > 0,
  })
}
