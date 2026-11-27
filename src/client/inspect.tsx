// Looking at one shape of the agent's print, and taking it into the sketch. A tap with a finger,
// or a click that does not drag, on the print chooses its shape: the whole top-level shape,
// with anything grouped in it. A card under it says whose it is and offers the two things to do
// with it. While the pen or eraser is held the Pencil never chooses: it writes, over the print
// as over paper. With both put down, the Pencil points, and chooses as a finger does.
//
// A click with a mouse also reaches the pen, which marks a dot. When the click chose a shape
// that dot is taken back, so choosing never leaves ink behind.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useEditor, useValue, type Editor, type TLEventInfo, type TLShapeId } from 'tldraw'
import { assert } from '../shared/assert'
import type { ViewTap } from '../shared/scene_controls'
import { icon_chat_small, icon_pen_small } from './icons'
import { use_view_choice, type ViewChoice } from './interactive_state'
import { print_key, use_print, type Print } from './print_engine'
import { sketch_hash, take_into_sketch, type TakeOutcome } from './take_apply'
import { take_tools } from './take_tools'
import { pointer_tool } from './tool_strip'

// A press that moves further than this, or lasts longer, is a stroke or a drag, not a tap.
const tap_slop_px = 8
const tap_duration_ms_max = 500

// How near the print a tap still counts, on the screen.
const hit_margin_px = 10

// Room kept between the card, its shape and the screen's edges.
const card_gap_px = 10
const outline_px = 6
const edge_px = 16
const card_width_px = 500

// A print shape under a tap, before anything the tap left on the sketch is taken back: the
// top-level shape, the view of the print it is in, and what a tap on it sets, if anything.
type Hit = { id: string; revision: number; key: string; tap: ViewTap | null }

type Chosen = Hit & { sketch_hash: string }

type Props = {
  onOutcome: (outcome: TakeOutcome) => void
  onAsk: (words: string) => void
}

export function Inspect({ onOutcome, onAsk }: Props) {
  const editor = useEditor()
  const print = use_print()
  const [chosen, chosen_set] = useState<Chosen | null>(null)
  use_print_taps(editor, print, chosen_set)

  // A choice outlives nothing it was made from: a new revision, or a print without the shape.
  const view = print?.view ?? null
  const stale = chosen !== null && (view === null || !chosen_alive(view, chosen))
  useEffect(() => {
    if (stale) chosen_set(null)
  }, [stale])

  if (chosen === null || print === null || view === null || stale) return null

  const take = () => {
    const outcome = take_into_sketch(
      editor,
      view.editor,
      {
        roots: [chosen.id],
        replace: false,
        revision_seen: chosen.revision,
        revision_now: print.revision_current,
        sketch_hash_seen: chosen.sketch_hash,
      },
      take_tools,
    )
    chosen_set(null)
    onOutcome(outcome)
  }
  const ask = () => {
    chosen_set(null)
    onAsk(ask_words(view.editor, chosen))
  }
  return (
    <InspectCard
      editor={editor}
      print={print}
      chosen={chosen}
      onTake={take}
      onAsk={ask}
      onClose={() => chosen_set(null)}
    />
  )
}

// On the stage the hand owns the entire gesture. Only a release still in its pointing state
// (no drag, long press or pinch) can activate a published shortcut. No sketch history or take.
export function StageTap() {
  const editor = useEditor()
  const choice = use_view_choice()
  const view = use_print()?.view

  useEffect(() => {
    if (!view || !choice || choice.taps.length === 0) return

    let pointer: number | null = null
    const press = (event: TLEventInfo) => {
      if (event.type !== 'pointer' || event.button !== 0) return

      if (event.name === 'pointer_down') {
        pointer = editor.isIn('hand.idle') ? event.pointerId : null
        return
      }

      if (event.name !== 'pointer_up' || event.pointerId !== pointer) return

      pointer = null

      if (!editor.isIn('hand.pointing') || editor.inputs.isPinching) return

      const point = editor.screenToPage(event.point)
      const hit = print_hit(view.editor, point, editor.getZoomLevel())
      const tap = hit && tap_find(choice, view.key, hit.chain)

      if (tap) {
        editor.cancelDoubleClick()
        choice.choose(tap.control, tap.value)
      }
    }

    editor.on('before-event', press)
    return () => {
      editor.off('before-event', press)
    }
  }, [editor, choice, view])
  return null
}

// Taps on the print: each chooses the shape under it, or sets the view its shape names.
function use_print_taps(
  editor: Editor,
  print: Print | null,
  chosen_set: (chosen: Chosen | null) => void,
): void {
  const choice = use_view_choice()
  const latest = useRef({ print, choice })
  latest.current = { print, choice }
  const hit = useCallback(
    (point: { x: number; y: number }): Hit | null => {
      const view = latest.current.print?.view

      if (view === undefined || view === null) return null

      const found = print_hit(view.editor, point, editor.getZoomLevel())

      if (found === null) return null

      const tap = tap_find(latest.current.choice, view.key, found.chain)
      return { id: found.top, revision: view.revision, key: view.key, tap }
    },
    [editor],
  )

  // The sketch hash a take is guarded by is read only after the tap's own dot is gone: it is
  // the sketch as the person sees it, not with a mark the choice is about to take back. A tap
  // on a shape that sets a view sets it here, on this page only, and chooses nothing.
  const choose = useCallback(
    (found: Hit | null) => {
      if (found?.tap != null) {
        const choice = latest.current.choice
        const shown = choice !== null && found.key === choice_print_key(choice)

        if (shown) choice.choose(found.tap.control, found.tap.value)

        chosen_set(null)
        return
      }

      chosen_set(found === null ? null : { ...found, sketch_hash: sketch_hash(editor) })
    },
    [editor, chosen_set],
  )
  use_taps(editor, hit, choose)
}

// A choice is of one view of one revision: a change of either lets it go, so a take only ever
// copies a shape that is on screen.
function chosen_alive(view: NonNullable<Print['view']>, chosen: Chosen): boolean {
  const shape = view.editor.getShape(chosen.id as TLShapeId)
  return view.revision === chosen.revision && view.key === chosen.key && shape !== undefined
}

// The print's name for the view a choice shows.
function choice_print_key(choice: ViewChoice): string {
  return print_key(choice.revision, choice.at_rest ? null : choice.key)
}

// What a tap on a shape sets: the tap of the shape itself or of the nearest group round it,
// and only in the view the taps were projected for.
function tap_find(choice: ViewChoice | null, key: string, chain: readonly string[]) {
  if (choice === null || key !== choice_print_key(choice)) return null

  assert(chain.length > 0, 'a hit names a shape')

  for (const id of chain) {
    const tap = choice.taps.find((candidate) => candidate.shape_id === id)

    if (tap !== undefined) return tap
  }

  return null
}

type PrintHit = { top: string; chain: string[] }

// The top-level print shape under a page point, and the shapes from the one hit up to it, or
// null.
function print_hit(print: Editor, point: { x: number; y: number }, zoom: number): PrintHit | null {
  assert(zoom > 0, 'a zoom is positive')
  const shape = print.getShapeAtPoint(point, {
    hitInside: true,
    hitLabels: true,
    hitLocked: true,
    hitFrameInside: true,
    margin: hit_margin_px / zoom,
  })

  if (shape === undefined) return null

  const ancestors = print.getShapeAncestors(shape)
  const top = ancestors[0] ?? shape
  assert(top.parentId === print.getCurrentPageId(), 'a chosen shape is top-level')
  const chain = [shape.id, ...ancestors.map((ancestor) => ancestor.id).reverse()]
  assert(chain.at(-1) === top.id, 'the chain ends at the top-level shape')
  return { top: top.id, chain }
}

function ask_words(print: Editor, chosen: Chosen): string {
  const shape = print.getShape(chosen.id as TLShapeId)
  const text = shape === undefined ? '' : (print.getShapeUtil(shape).getText(shape) ?? '').trim()
  const name = text === '' ? `the ${shape?.type ?? 'shape'}` : `“${text.slice(0, 80)}”`
  return `About ${name} in revision ${chosen.revision}: `
}

// A press that may be a tap, and whether it also reached the tool held when it began.
type Tap = { id: number; x: number; y: number; at_ms: number; reached: boolean; tool: string }

// A mouse press of the pen that began on the print, marked so that a tap can take back its
// dot. Once the press is over, the mark either takes the dot back, or holds the press's ink
// as one step: one Undo per press, and never a step with nothing in it.
type PenPress = { id: number; mark: string }

// What a tap asks: which print shape is under it, and then, once the tool's dot is taken back,
// to choose it.
type TapHandlers = {
  hit: (point: { x: number; y: number }) => Hit | null
  choose: (found: Hit | null) => void
}

// Taps on the canvas, told apart from strokes and pinches. Listened to on the way down, before
// tldraw handles the same press, and answered once tldraw is done with it.
function use_taps(editor: Editor, hit: TapHandlers['hit'], choose: TapHandlers['choose']): void {
  useEffect(() => {
    const container = editor.getContainer()
    const pressed = new Set<number>()
    let candidate: Tap | null = null
    let pen_press: PenPress | null = null

    const pen_press_end = (pointer: number): PenPress | null => {
      if (pen_press === null || pen_press.id !== pointer) return null

      const ended = pen_press
      pen_press = null
      return ended
    }
    const down = (event: PointerEvent) => {
      pressed.add(event.pointerId)
      candidate = tap_start(editor, event, pressed.size)

      if (pen_press === null && pen_press_on_print(editor, candidate, hit)) {
        const mark = editor.markHistoryStoppingPoint('pen press on the print')
        pen_press = { id: event.pointerId, mark }
      }
    }
    const move = (event: PointerEvent) => {
      if (candidate === null || candidate.id !== event.pointerId) return

      if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > tap_slop_px) {
        candidate = null
      }
    }
    const up = (event: PointerEvent) => {
      pressed.delete(event.pointerId)
      const tap = tap_end(candidate, event)
      candidate = null
      const press = pen_press_end(event.pointerId)

      if (tap === null && press === null) return

      const point = editor.screenToPage({ x: event.clientX, y: event.clientY })
      window.setTimeout(() => {
        const taken_back = tap !== null && tap_finish(editor, tap, press, point, { hit, choose })

        if (press !== null && !taken_back) pen_press_keep(editor, press)
      }, 0)
    }

    // A cancelled press leaves nothing: tldraw takes back its stroke, and the mark goes too.
    const cancel = (event: PointerEvent) => {
      pressed.delete(event.pointerId)
      candidate = null
      const press = pen_press_end(event.pointerId)

      if (press !== null) window.setTimeout(() => editor.bailToMark(press.mark), 0)
    }
    const listeners = [
      ['pointerdown', down],
      ['pointermove', move],
      ['pointerup', up],
      ['pointercancel', cancel],
    ] as const

    for (const [name, listener] of listeners) container.addEventListener(name, listener, true)

    return () => {
      for (const [name, listener] of listeners) container.removeEventListener(name, listener, true)
    }
  }, [editor, hit, choose])
}

function tap_start(editor: Editor, event: PointerEvent, pressed_count: number): Tap | null {
  if (pressed_count > 1 || event.button !== 0) return null

  const tool = editor.getCurrentToolId()
  const pencil = event.pointerType === 'pen'

  // The Pencil writes and erases; only with both put down, as a pointer, does it choose.
  if (pencil && tool !== pointer_tool) return null

  const target = event.target

  if (!(target instanceof Element) || target.closest('.tl-canvas') === null) return null

  // In pen mode tldraw leaves a finger alone; otherwise the press also reaches the tool.
  const reached = pencil || !editor.getInstanceState().isPenMode
  const { pointerId: id, clientX: x, clientY: y, timeStamp: at_ms } = event
  assert(pencil || event.pointerType !== 'pen', 'only the Pencil is a pen')
  return { id, x, y, at_ms, reached, tool }
}

// Whether a press is the pen's, under a mouse, beginning on the print: the only press whose
// dot a tap may take back.
function pen_press_on_print(editor: Editor, tap: Tap | null, hit: TapHandlers['hit']): boolean {
  if (tap === null || !tap.reached || tap.tool !== 'draw') return false

  return hit(editor.screenToPage({ x: tap.x, y: tap.y })) !== null
}

// Keeps what a pen press drew as one step under its mark. tldraw holds the latest changes
// aside until the next mark, so a mark is made first to put them in the history, and the
// squash then folds them, with tldraw's own mark and that one, under the press's mark.
function pen_press_keep(editor: Editor, press: PenPress): void {
  const flushed = editor.markHistoryStoppingPoint('pen press kept')
  assert(flushed !== press.mark, 'a kept press is folded under its own mark')
  editor.squashToMark(press.mark)
}

// The press as a tap, if it ended where and soon after it began.
function tap_end(candidate: Tap | null, event: PointerEvent): Tap | null {
  if (candidate === null || candidate.id !== event.pointerId) return null

  if (event.timeStamp - candidate.at_ms > tap_duration_ms_max) return null

  return candidate
}

// Answers a tap, once tldraw is done with it. True when the pen's dot was taken back.
function tap_finish(
  editor: Editor,
  tap: Tap,
  press: PenPress | null,
  point: { x: number; y: number },
  handlers: TapHandlers,
): boolean {
  assert(press === null || tap.tool === 'draw', 'only the pen leaves a dot to take back')

  // A click of the eraser on the person's own ink erases it, and one of the pointer chooses
  // it: neither is a tap on the print.
  if (tap.reached && tap.tool !== 'draw') {
    const ink = editor.getShapeAtPoint(point, { margin: hit_margin_px / editor.getZoomLevel() })

    if (ink !== undefined) return false
  }

  const found = handlers.hit(point)

  // A tap beside the print lets go of any choice, and leaves what the tool did. So does a
  // click of the pen that began beside the print: its dot is the person's to keep, and no
  // card is laid over it.
  if (found === null || (tap.reached && tap.tool === 'draw' && press === null)) {
    handlers.choose(null)
    return false
  }

  if (press !== null) editor.bailToMark(press.mark)

  handlers.choose(found)
  return press !== null
}

type CardProps = {
  editor: Editor
  print: Print
  chosen: Chosen
  onTake: () => void
  onAsk: () => void
  onClose: () => void
}

function InspectCard({ editor, print, chosen, onTake, onAsk, onClose }: CardProps) {
  const view = print.view!
  const place = useValue('inspect place', () => card_place(editor, view.editor, chosen.id), [
    editor,
    view,
    chosen.id,
  ])
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => first.current?.focus({ preventScroll: true }), [chosen])
  use_escape_close(onClose)

  if (place === null) return null

  const current = !print.showing_previous && chosen.revision === print.revision_current
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

  // Other keys typed in the card go no further than the card.
  const key_down = (event: KeyboardEvent) => event.stopPropagation()
  return (
    <>
      <div className="inspect__outline" style={place.outline} aria-hidden="true" />
      <div
        className="inspect"
        role="dialog"
        aria-label="Agent shape"
        style={place.card}
        onPointerDown={stop}
        onKeyDown={key_down}
      >
        <p className="inspect__who">
          <span className="inspect__swatch" aria-hidden="true" />
          Drawn by the agent · revision {chosen.revision}
        </p>
        <p className="inspect__text">
          {current
            ? 'Your pen and eraser pass over it. Take a copy to make it yours.'
            : `An earlier revision. Go back to revision ${print.revision_current} to take a copy.`}
        </p>
        <div className="inspect__actions">
          <button
            ref={first}
            type="button"
            className="inspect__take"
            disabled={!current}
            onClick={onTake}
          >
            {icon_pen_small}
            Take into my sketch
          </button>
          <button type="button" className="inspect__ask" onClick={onAsk}>
            {icon_chat_small}
            Ask about this
          </button>
        </div>
      </div>
    </>
  )
}

// Escape puts the card away and nothing else. It is caught on the way down, before tldraw's
// listener on its container, which would otherwise cancel the held tool too and put the pen
// down: closing a card must leave the person holding what they held.
function use_escape_close(onClose: () => void): void {
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return

      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
}

type Place = { outline: React.CSSProperties; card: React.CSSProperties }

// The outline round the shape, and the card under it, or over it where there is no room
// below. Both follow the camera.
function card_place(editor: Editor, print: Editor, id: string): Place | null {
  const bounds = print.getShapePageBounds(id as TLShapeId)

  if (bounds === undefined) return null

  const near = editor.pageToViewport({ x: bounds.minX, y: bounds.minY })
  const far = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY })
  const screen = editor.getViewportScreenBounds()
  const outline = {
    left: near.x - outline_px,
    top: near.y - outline_px,
    width: far.x - near.x + 2 * outline_px,
    height: far.y - near.y + 2 * outline_px,
  }
  const width = Math.min(card_width_px, screen.w - 2 * edge_px)
  const left = Math.min(Math.max(edge_px, outline.left), screen.w - edge_px - width)
  const below = outline.top + outline.height + card_gap_px
  const room_below = screen.h - below > screen.h * 0.25
  const card: React.CSSProperties = room_below
    ? { left, width, top: Math.max(edge_px, below) }
    : { left, width, bottom: Math.max(edge_px, screen.h - outline.top + card_gap_px) }
  return { outline, card }
}
