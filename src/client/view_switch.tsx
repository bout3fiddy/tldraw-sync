// The switch of an interactive drawing: its controls, floating on the drawing's top edge (or
// under its bottom edge when the top has no room) and going away with it. It is there only
// for a revision whose views differ, and only while the current revision is on show. It has
// no header: each control says in words what it changes.
// When it would cover the drawing, in a narrow window or zoomed far out, it folds into one
// button on the canvas's bottom edge, which opens the same controls over it.
//
// A choice changes the drawing on this screen only (`interactive_state.tsx`). The switch never
// moves the camera, and never takes the pen's ink: the Pencil writes straight through it, and
// only a finger, a mouse or the keyboard chooses. Tab reaches it after the canvas, arrows
// change a choice or a step, Space or Enter flips a toggle, and Escape returns to the canvas.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useEditor, useValue, type Editor } from 'tldraw'
import { assert } from '../shared/assert'
import { scene_controls_count_max } from '../shared/constants'
import type { SceneControl, ViewState } from '../shared/scene_controls'
import { icon_check_small, icon_fold_open, icon_step_back, icon_step_next } from './icons'
import { use_view_choice, type ViewChoice } from './interactive_state'
import type { SceneEnvelope } from './interactive_scene'
import { use_print } from './print_engine'

// Room kept clear of the board's own instruments: the title and Chat along the top, and the
// tool strip down the left. The switch keeps this far above the drawing it belongs to.
const top_clear_px = 80
const left_clear_px = 80
const edge_px = 16
const gap_px = 12

// The key and tldraw's notice along the canvas's foot.
const bottom_clear_px = 76

// Zoomed this far out, the switch would dwarf the drawing it changes, so it folds.
const width_ratio_max = 2

// What the switch says after each choice, so a screen reader hears where it went.
const scope_words = 'Changes this drawing on this screen only.'

type Size = { w: number; h: number }
type Place = { kind: 'hidden' } | { kind: 'folded' } | { kind: 'inline'; left: number; top: number }

export function ViewSwitch() {
  const editor = useEditor()
  const choice = use_view_choice()
  const print = use_print()
  const current = print?.view?.revision === choice?.revision && print?.showing_previous === false

  if (choice === null || print === null || !current) return null

  return (
    <SwitchPlaced key={`${choice.session} ${choice.revision}`} editor={editor} choice={choice} />
  )
}

function SwitchPlaced({ editor, choice }: { editor: Editor; choice: ViewChoice }) {
  const measure = useRef<HTMLDivElement>(null)
  const envelope = choice.envelope

  // One camera subscription per envelope. Measuring the controls during an animated fit
  // must not replace the subscription that caused the measurement.
  const seen = useValue('switch envelope', () => envelope_seen(editor, envelope), [
    editor,
    envelope,
  ])
  const room = switch_room(seen)
  const size = use_size(measure)
  const place = switch_place(seen, size)
  const words = use_announcement(choice)
  return (
    <>
      <div
        className="switch switch--measure"
        ref={measure}
        style={{ maxWidth: room }}
        aria-hidden="true"
      >
        <SwitchRows choice={choice} idle />
      </div>
      {place.kind === 'inline' && (
        <SwitchFrame
          editor={editor}
          style={{ left: place.left, top: place.top, maxWidth: room }}
          onEscape={() => canvas_focus(editor)}
        >
          <SwitchRows choice={choice} idle={false} />
        </SwitchFrame>
      )}
      {place.kind === 'folded' && <SwitchFolded editor={editor} choice={choice} />}
      <p className="visually-hidden" role="status">
        {words}
      </p>
    </>
  )
}

// The drawing's corners on the screen, or null when none of it is in view.
function envelope_seen(editor: Editor, envelope: SceneEnvelope | null) {
  if (envelope === null) return null

  const screen = editor.getViewportScreenBounds()
  const near = editor.pageToViewport({ x: envelope.x, y: envelope.y })
  const far = editor.pageToViewport({ x: envelope.x + envelope.w, y: envelope.y + envelope.h })
  const away = far.x < 0 || far.y < 0 || near.x > screen.w || near.y > screen.h
  assert(far.x >= near.x && far.y >= near.y, 'a drawing has no negative extent on screen')
  return away ? null : { screen, near, far, left: Math.max(near.x, left_clear_px) }
}

// How wide the switch may be where it rests: from its left edge to the canvas's right edge.
// Its controls wrap into lines within that.
function switch_room(seen: ReturnType<typeof envelope_seen>): number {
  const room = seen === null ? 0 : Math.floor(seen.screen.w - edge_px - seen.left)
  return Math.max(room, 0)
}

// Where the switch goes: on the drawing's top edge, or else under its bottom edge, wherever it
// fits clear of the board's instruments; folded when it would cover the drawing, or dwarf it;
// nowhere when the drawing is off screen.
function switch_place(seen: ReturnType<typeof envelope_seen>, size: Size | null): Place {
  if (seen === null || size === null) return { kind: 'hidden' }

  const { screen, near, far, left } = seen
  const above = near.y - gap_px - size.h
  const below = far.y + gap_px
  const wide =
    left + size.w > screen.w - edge_px || size.w > Math.max(far.x - near.x, 1) * width_ratio_max
  assert(size.w >= 0 && size.h >= 0, 'a measured switch has a size')

  if (wide) return { kind: 'folded' }

  if (above >= top_clear_px) return { kind: 'inline', left, top: above }

  if (below + size.h <= screen.h - bottom_clear_px) return { kind: 'inline', left, top: below }

  return { kind: 'folded' }
}

// The switch's own size, measured on an unseen copy of its inline form laid out in `room`. A
// control too wide for the room overflows it, and the overflow is measured too.
function use_size(ref: React.RefObject<HTMLDivElement>): Size | null {
  const [size, size_set] = useState<Size | null>(null)
  useLayoutEffect(() => {
    const element = ref.current

    if (element === null) return

    const read = () => {
      const w = Math.ceil(Math.max(element.offsetWidth, element.scrollWidth))
      const h = Math.ceil(Math.max(element.offsetHeight, element.scrollHeight))
      size_set((last) => (last?.w === w && last.h === h ? last : { w, h }))
    }

    // ResizeObserver reports the initial box and subsequent reflows before paint.
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

// The words for the last choice made here: the control, its value and where that is among its
// values. Nothing is said for the view a revision opens in.
function use_announcement(choice: ViewChoice): string {
  const [words, words_set] = useState('')
  const last = useRef<ViewState>(choice.state)
  useEffect(() => {
    const before = last.current
    last.current = choice.state
    const changed = choice.scene.controls.find((control) => {
      return before[control.id] !== choice.state[control.id]
    })

    if (changed === undefined) return

    const index = changed.options.findIndex((o) => o.value === choice.state[changed.id])
    const option = changed.options[index]
    assert(option !== undefined, 'a chosen value is one of its control')
    const count = `${index + 1} of ${changed.options.length}`
    words_set(`${changed.label}, ${option.label}, ${count}. ${scope_words}`)
  }, [choice.state, choice.scene])
  return words
}

type FrameProps = {
  editor: Editor
  className?: string
  style?: React.CSSProperties
  id?: string

  // What Escape does here: by default, return to the canvas.
  onEscape: () => void
  children: React.ReactNode
}

// The switch's frame. A press of the Pencil goes through it to the canvas, as if the switch
// were not there; a finger or a mouse reaches its buttons. Keys typed in it go no further.
// tldraw listens for keys on its container, below the page's own handlers, and would take
// Escape to put the pen down: each key but Tab is marked as handled before it gets there.
function SwitchFrame(props: FrameProps) {
  const { editor, className = 'switch', style, id, onEscape, children } = props
  const frame = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = frame.current
    assert(element !== null, 'the frame is mounted')
    const mark = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') editor.markEventAsHandled(event)
    }
    element.addEventListener('keydown', mark)
    element.addEventListener('keyup', mark)
    return () => {
      element.removeEventListener('keydown', mark)
      element.removeEventListener('keyup', mark)
    }
  }, [editor])
  const key_down = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Tab') return

    event.stopPropagation()

    if (event.key !== 'Escape' || event.defaultPrevented) return

    event.preventDefault()
    onEscape()
  }
  return (
    <div
      ref={frame}
      id={id}
      className={className}
      role="group"
      aria-label="Views of this drawing"
      style={style}
      onPointerDownCapture={(event) => pen_through(event, frame.current)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={key_down}
    >
      {children}
    </div>
  )
}

// Back to the canvas, holding whatever tool was held: the pen, unless it was put down.
function canvas_focus(editor: Editor): void {
  const container = editor.getContainer()
  assert(container instanceof HTMLElement, 'the canvas has a container')
  container.focus({ preventScroll: true })
}

// The Pencil writes through the switch: its press is handed to whatever lies under the
// switch, and the switch lets every press through until the Pencil lifts.
export function pen_through(event: ReactPointerEvent<HTMLElement>, frame: HTMLElement | null) {
  if (event.pointerType !== 'pen' || frame === null) return

  event.preventDefault()
  event.stopPropagation()
  const native = event.nativeEvent
  const target = native.target

  if (target instanceof Element && target.hasPointerCapture(native.pointerId)) {
    target.releasePointerCapture(native.pointerId)
  }

  frame.style.pointerEvents = 'none'
  const restore = () => {
    frame.style.pointerEvents = ''
    window.removeEventListener('pointerup', restore, true)
    window.removeEventListener('pointercancel', restore, true)
  }
  window.addEventListener('pointerup', restore, true)
  window.addEventListener('pointercancel', restore, true)
  const below = document.elementFromPoint(native.clientX, native.clientY)
  assert(below === null || !frame.contains(below), 'the press goes past the switch')
  below?.dispatchEvent(new PointerEvent('pointerdown', pointer_init(native)))
}

function pointer_init(native: PointerEvent): PointerEventInit {
  const { pointerId, pointerType, isPrimary, pressure, tiltX, tiltY, width, height } = native
  const { clientX, clientY, screenX, screenY, button, buttons } = native
  const { altKey, ctrlKey, metaKey, shiftKey } = native
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId,
    pointerType,
    isPrimary,
    pressure,
    tiltX,
    tiltY,
    width,
    height,
    clientX,
    clientY,
    screenX,
    screenY,
    button,
    buttons,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
  }
}

// The switch folded into one button on the canvas's bottom edge, naming the first control and
// its value. Pressed, it opens every control above it.
function SwitchFolded({ editor, choice }: { editor: Editor; choice: ViewChoice }) {
  const [open, open_set] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel_id = useId()
  const first = choice.scene.controls[0]
  assert(first !== undefined, 'an interactive scene has a control')
  const more = choice.scene.controls.length - 1
  const close = () => {
    open_set(false)
    button.current?.focus()
  }
  return (
    <div className="switch-fold">
      {open && (
        <SwitchFrame
          editor={editor}
          className="switch switch--panel"
          id={panel_id}
          onEscape={close}
        >
          <SwitchRows choice={choice} idle={false} />
        </SwitchFrame>
      )}
      <SwitchFrame
        editor={editor}
        className="switch switch--folded"
        onEscape={() => (open ? close() : canvas_focus(editor))}
      >
        <button
          ref={button}
          type="button"
          className="switch__fold"
          aria-expanded={open}
          aria-controls={panel_id}
          onClick={() => open_set(!open)}
        >
          <span className="switch__swatch" aria-hidden="true" />
          <span className="switch__summary">
            <strong>{first.label}:</strong> {value_label(first, choice.state)}
            {more > 0 && <span className="switch__more"> · {more} more</span>}
          </span>
          <span className="switch__caret" data-open={open}>
            {icon_fold_open}
          </span>
        </button>
      </SwitchFrame>
    </div>
  )
}

function value_label(control: SceneControl, state: ViewState): string {
  const option = control.options.find((candidate) => candidate.value === state[control.id])
  assert(option !== undefined, 'a state names a value of every control')
  return option.label
}

type RowsProps = { choice: ViewChoice; idle: boolean }

// One row for each control, in the scene's order. `idle` draws the rows for measuring only.
function SwitchRows({ choice, idle }: RowsProps) {
  const controls = choice.scene.controls
  assert(controls.length <= scene_controls_count_max, 'controls are bounded')
  const choose = (control: string, value: string) => {
    if (!idle) choice.choose(control, value)
  }
  return (
    <>
      {controls.map((control) => {
        const value = choice.state[control.id] ?? ''
        const props = { control, value, choose, idle }

        if (control.kind === 'toggle') return <ToggleRow key={control.id} {...props} />

        if (control.kind === 'steps') return <StepsRow key={control.id} {...props} />

        return <ChoiceRow key={control.id} {...props} />
      })}
    </>
  )
}

type RowProps = {
  control: SceneControl
  value: string
  idle: boolean
  choose: (control: string, value: string) => void
}

// The value a key moves to among a control's values: arrows step, Home and End jump. Null
// for any other key, or a step past either end.
export function value_after_key(control: SceneControl, value: string, key: string) {
  const index = control.options.findIndex((option) => option.value === value)
  const last = control.options.length - 1
  assert(index >= 0, 'the value is one of the control')
  const moves: Record<string, number> = {
    ArrowRight: index + 1,
    ArrowDown: index + 1,
    ArrowLeft: index - 1,
    ArrowUp: index - 1,
    Home: 0,
    End: last,
  }
  const next = moves[key]

  if (next === undefined || next < 0 || next > last) return null

  return control.options[next]?.value ?? null
}

function RowLabel({ id, control }: { id: string; control: SceneControl }) {
  return (
    <span className="switch__label" id={id}>
      <span className="switch__swatch" aria-hidden="true" />
      {control.label}
    </span>
  )
}

// A choice between labelled values: one radio button each, the chosen one in ink with a tick.
// Arrows move the choice and the focus together.
function ChoiceRow({ control, value, idle, choose }: RowProps) {
  const label_id = useId()
  const keyed = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = value_after_key(control, value, event.key)

    if (next === null) return

    event.preventDefault()
    choose(control.id, next)
    const group = event.currentTarget
    window.requestAnimationFrame(() => {
      group.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus()
    })
  }
  return (
    <div className="switch__row" role="radiogroup" aria-labelledby={label_id} onKeyDown={keyed}>
      <RowLabel id={label_id} control={control} />
      {control.options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="switch__option"
            aria-checked={checked}
            tabIndex={checked && !idle ? 0 : -1}
            data-value={option.value}
            onClick={() => choose(control.id, option.value)}
          >
            {checked && icon_check_small}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// Steps in order: back, where it is, and on. Arrows step too.
function StepsRow({ control, value, idle, choose }: RowProps) {
  const label_id = useId()
  const index = control.options.findIndex((option) => option.value === value)
  const option = control.options[index]
  assert(option !== undefined, 'the value is one of the steps')
  const go = (key: string) => {
    const next = value_after_key(control, value, key)

    if (next !== null) choose(control.id, next)

    return next !== null
  }
  const keyed = (event: KeyboardEvent<HTMLDivElement>) => {
    if (go(event.key)) event.preventDefault()
  }
  const tab_index = idle ? -1 : 0
  return (
    <div className="switch__row" role="group" aria-labelledby={label_id} onKeyDown={keyed}>
      <RowLabel id={label_id} control={control} />
      <button
        type="button"
        className="switch__step"
        aria-label={`Back: ${control.label}`}
        disabled={index === 0}
        tabIndex={tab_index}
        onClick={() => go('ArrowLeft')}
      >
        {icon_step_back}
      </button>
      <span className="switch__now" aria-live="off">
        {option.label}
        <span className="switch__count">
          {index + 1} of {control.options.length}
        </span>
      </span>
      <button
        type="button"
        className="switch__step"
        aria-label={`Next: ${control.label}`}
        disabled={index === control.options.length - 1}
        tabIndex={tab_index}
        onClick={() => go('ArrowRight')}
      >
        {icon_step_next}
      </button>
    </div>
  )
}

// A toggle: one switch, named by its control, on or off.
function ToggleRow({ control, value, idle, choose }: RowProps) {
  const on = value === 'on'
  assert(on || value === 'off', 'a toggle is on or off')
  return (
    <div className="switch__row">
      <button
        type="button"
        role="switch"
        className="switch__toggle"
        aria-checked={on}
        tabIndex={idle ? -1 : 0}
        onClick={() => choose(control.id, on ? 'off' : 'on')}
      >
        <span className="switch__swatch" aria-hidden="true" />
        {control.label}
        <span className="switch__track" data-on={on} aria-hidden="true">
          <span className="switch__thumb" />
        </span>
      </button>
    </div>
  )
}
