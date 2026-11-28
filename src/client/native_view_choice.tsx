// The view one device shows of a native board's drawing (`native_views.ts`). Every view's
// shapes are ordinary records of the shared scene; a view only hides some of them on this
// screen. Choosing one writes nothing: it is kept in this page's memory, sent nowhere, works
// offline, and is let go on reload. So an edit made in one view is the same edit in every view,
// and a hidden shape comes back exactly as it was, with any edit made to it before.
//
// The canvas hides what a view leaves out (tldraw's `getShapeVisibility`): a hidden shape is
// not drawn, hit, selected or erased, a hidden group hides what it holds, and an arrow hides
// with the shape either end is bound to, as a legacy view did. A shape lost from view while
// selected is let go, so no action taken in one view reaches what that view does not show.
//
// A tap that no tool takes chooses what the tapped shape names: on the Mac stage, whose hand
// only looks, and on the iPad, a finger while the Pencil holds the tools. A press that a tool
// takes stays an edit. The image agents read is drawn in the view at rest, whatever this
// device shows, so it never depends on a choice made here.

import { useEffect, useMemo } from 'react'
import {
  atom,
  computed,
  react,
  TLDOCUMENT_ID,
  useEditor,
  useValue,
  type Computed,
  type Editor,
  type TLShape,
  type TLShapeId,
} from 'tldraw'
import { assert } from '../shared/assert'
import type { SceneTap, ViewState } from '../shared/scene_controls'
import type { SceneEnvelope } from './interactive_scene'
import {
  shape_view_marked,
  shape_view_read,
  shape_view_shown,
  view_after_choice,
  view_in_effect,
  views_controls_read,
  type ViewInEffect,
} from './native_views'
import { SwitchPlaced, type SwitchChoice } from './view_switch'

// A press that moves further than this, or lasts longer, is a drag or a hold, not a tap.
const tap_slop_px = 8
const tap_duration_ms_max = 500
const hit_margin_px = 10

export class NativeViewChoice {
  private readonly chosen = atom<ViewState>('native view chosen', {})
  private readonly rest_only = atom('native view rest only', false)
  private readonly effects = new WeakMap<Editor, Computed<ViewInEffect | null>>()

  // The view in effect on this editor, or null for a board whose drawing has no views.
  effect(editor: Editor): ViewInEffect | null {
    let effect = this.effects.get(editor)

    if (effect === undefined) {
      effect = computed('native view', () => {
        const controls = views_controls_read(editor.store.get(TLDOCUMENT_ID)?.meta)

        if (controls === null) return null

        return view_in_effect(controls, this.chosen.get(), this.rest_only.get())
      })
      this.effects.set(editor, effect)
    }

    return effect.get()
  }

  choose(editor: Editor, control: string, value: string): boolean {
    const effect = this.effect(editor)
    const next = effect === null ? null : view_after_choice(effect, control, value)

    if (next === null) return false

    this.chosen.set(next)
    assert(this.effect(editor)?.state[control] === value, 'the chosen view is in effect')
    return true
  }

  // Given to the canvas once, before it mounts. Re-run by the canvas whenever what it reads
  // changes: the shape, the document's controls, the choice, or an arrow's bindings.
  readonly visibility = (shape: TLShape, editor: Editor): 'hidden' | 'inherit' => {
    const effect = this.effect(editor)

    if (effect === null) return 'inherit'

    if (!shape_view_shown(shape_view_read(shape.meta, effect.controls), effect)) return 'hidden'

    if (shape.type === 'arrow' && arrow_end_hidden(editor, shape)) return 'hidden'

    return 'inherit'
  }

  // Runs `render` with the view at rest in effect. A render starts by choosing what it draws,
  // before it first waits (tldraw's export), so only that choice sees the rest view; the canvas
  // is drawn again only after this returns, with the device's own view back in effect.
  at_rest<T>(render: () => T): T {
    assert(!this.rest_only.get(), 'renders at rest do not nest')
    this.rest_only.set(true)

    try {
      return render()
    } finally {
      this.rest_only.set(false)
    }
  }
}

// An arrow is shown only where both shapes it is bound to are: a binding never dangles. An
// arrow bound to an arrow is left to that arrow's own conditions, so no judgement loops.
function arrow_end_hidden(editor: Editor, arrow: TLShape): boolean {
  assert(arrow.type === 'arrow', 'only an arrow has ends')

  for (const binding of editor.getBindingsFromShape(arrow, 'arrow')) {
    const end = editor.getShape(binding.toId)

    if (end !== undefined && end.type !== 'arrow' && editor.isShapeHidden(end)) return true
  }

  return false
}

// The switch, the taps and the release of hidden shapes, for a drawing with views.
export function NativeViews({ choice }: { choice: NativeViewChoice }) {
  const editor = useEditor()
  const effect = useValue('native view', () => choice.effect(editor), [editor, choice])
  const envelope = use_envelope(editor, choice)
  use_hidden_released(editor)
  use_taps(editor, choice)
  const switched = useMemo((): SwitchChoice | null => {
    if (effect === null) return null

    const choose = (control: string, value: string) => choice.choose(editor, control, value)
    return { controls: effect.controls, state: effect.state, envelope, choose }
  }, [editor, choice, effect, envelope])

  if (switched === null) return null

  const key = switched.controls.map((control) => control.id).join(' ')
  return <SwitchPlaced key={key} editor={editor} choice={switched} />
}

// Where the drawing's views lie on the page: the box round every shape a view shows or hides,
// whether or not this view shows it, so the switch stays put while the views change.
function use_envelope(editor: Editor, choice: NativeViewChoice): SceneEnvelope | null {
  const text = useValue(
    'native view envelope',
    () => {
      const effect = choice.effect(editor)

      if (effect === null) return ''

      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]

      for (const shape of editor.getCurrentPageShapes()) {
        const bounds = shape_view_marked(shape_view_read(shape.meta, effect.controls))
          ? editor.getShapePageBounds(shape)
          : undefined

        if (bounds === undefined) continue

        x0 = Math.min(x0, bounds.minX)
        y0 = Math.min(y0, bounds.minY)
        x1 = Math.max(x1, bounds.maxX)
        y1 = Math.max(y1, bounds.maxY)
      }

      return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0].join(' ') : ''
    },
    [editor, choice],
  )
  return useMemo(() => {
    if (text === '') return null

    const [x, y, w, h] = text.split(' ').map(Number) as [number, number, number, number]
    assert(w >= 0 && h >= 0, 'an envelope has no negative extent')
    return { x, y, w, h }
  }, [text])
}

// A shape a view hides is let go: never left selected, or open for typing, out of sight.
function use_hidden_released(editor: Editor): void {
  useEffect(
    () =>
      react('native hidden released', () => {
        const hidden = editor.getSelectedShapeIds().filter((id) => editor.isShapeHidden(id))

        if (hidden.length > 0) editor.deselect(...hidden)

        const editing = editor.getEditingShapeId()

        if (editing !== null && editor.isShapeHidden(editing)) editor.setEditingShape(null)
      }),
    [editor],
  )
}

type Press = { id: number; x: number; y: number; at_ms: number }

// Taps that no tool takes, told apart from drags and pinches, answered as they lift.
function use_taps(editor: Editor, choice: NativeViewChoice): void {
  useEffect(() => {
    const container = editor.getContainer()
    const pressed = new Set<number>()
    let press: Press | null = null

    const down = (event: PointerEvent) => {
      pressed.add(event.pointerId)
      press = tap_possible(editor, choice, event, pressed.size)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, at_ms: event.timeStamp }
        : null
    }
    const move = (event: PointerEvent) => {
      if (press === null || press.id !== event.pointerId) return

      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > tap_slop_px) press = null
    }
    const up = (event: PointerEvent) => {
      pressed.delete(event.pointerId)
      const tapped = press !== null && press.id === event.pointerId
      const quick = tapped && event.timeStamp - press!.at_ms <= tap_duration_ms_max
      press = null

      if (!quick) return

      const tap = tap_find(editor, choice, { x: event.clientX, y: event.clientY })

      if (tap !== null) choice.choose(editor, tap.control, tap.value)
    }
    const cancel = (event: PointerEvent) => {
      pressed.delete(event.pointerId)
      press = null
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
  }, [editor, choice])
}

// A press no tool takes: the stage's hand, or anything but the Pencil while the Pencil holds
// the tools. One press at a time, on the canvas itself, of a drawing with views.
function tap_possible(
  editor: Editor,
  choice: NativeViewChoice,
  event: PointerEvent,
  pressed_count: number,
): boolean {
  if (pressed_count > 1 || event.button !== 0 || choice.effect(editor) === null) return false

  const target = event.target

  if (!(target instanceof Element) || target.closest('.tl-canvas') === null) return false

  const hand = editor.getCurrentToolId() === 'hand'
  const beside_pen = editor.getInstanceState().isPenMode && event.pointerType !== 'pen'
  return hand || beside_pen
}

// What a tap at this point on the screen chooses: the tap of the shape shown there, or of the
// nearest group round it. Hidden shapes are never hit.
function tap_find(
  editor: Editor,
  choice: NativeViewChoice,
  screen: { x: number; y: number },
): SceneTap | null {
  const effect = choice.effect(editor)

  if (effect === null) return null

  const shape = editor.getShapeAtPoint(editor.screenToPage(screen), {
    hitInside: true,
    hitLabels: true,
    margin: hit_margin_px / editor.getZoomLevel(),
  })

  if (shape === undefined) return null

  assert(!editor.isShapeHidden(shape), 'a hidden shape is never hit')
  const chain: TLShapeId[] = [
    shape.id,
    ...editor
      .getShapeAncestors(shape)
      .map((a) => a.id)
      .reverse(),
  ]

  for (const id of chain) {
    const tap = shape_view_read(editor.getShape(id)?.meta, effect.controls).tap

    if (tap !== null) return tap
  }

  return null
}
