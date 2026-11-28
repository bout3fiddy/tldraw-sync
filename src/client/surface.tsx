// The one canvas: a dotted sheet, the agent's print, and the person's ink over it, in one
// camera. The ink is the sync room's tldraw canvas, as it comes. The print is drawn inside
// that canvas, under its shapes, from pictures of the agent's records (`print_engine.tsx`),
// so it pans and zooms with the ink exactly and no pen or eraser can reach it.

import { memo, useMemo, useRef, type ReactNode } from 'react'
import {
  Tldraw,
  useEditor,
  useValue,
  type Editor,
  type TLComponents,
  type TLGridProps,
  type TLStore,
} from 'tldraw'
import { assert } from '../shared/assert'
import { asset_urls, components_quiet } from './board_store'
import type { NativeViewChoice } from './native_view_choice'
import { use_print, type PrintShape } from './print_engine'
import { taken_key } from './take_plan'

type SurfaceProps = {
  store: TLStore
  onMount: (editor: Editor) => void | (() => void)

  // Which shapes this screen leaves out of the view it shows (`native_view_choice.tsx`).
  visibility: NativeViewChoice['visibility']
  children?: ReactNode
}

export function Surface({ store, onMount, visibility, children }: SurfaceProps) {
  return (
    <section className="surface" aria-label="Canvas">
      <Tldraw
        store={store}
        hideUi
        assetUrls={asset_urls}
        components={surface_components}
        onMount={onMount}
        getShapeVisibility={visibility}
      >
        {children}
      </Tldraw>
    </section>
  )
}

// The sheet's dots are 24 page units apart, as drawn at full size. Zoomed in or out they
// double or halve to avoid dense clusters. Only the grid fades with zoom (see styles.css).
const dot_spacing_units = 24
const dot_gap_px_min = 24
const dot_gap_px_max = 48
const dot_radius_px = 1.15
const dot_steps_max = 64

let dot_grids_count = 0

export function dot_gap_px(zoom: number): number {
  assert(zoom > 0 && Number.isFinite(zoom), 'a zoom is positive')
  let gap = dot_spacing_units * zoom

  for (let step = 0; step < dot_steps_max && gap < dot_gap_px_min; step += 1) gap *= 2

  for (let step = 0; step < dot_steps_max && gap >= dot_gap_px_max; step += 1) gap /= 2

  return gap
}

function DotGrid({ x, y, z }: TLGridProps) {
  const id = useMemo(() => `surface-dots-${(dot_grids_count += 1)}`, [])
  const gap = dot_gap_px(z)
  const offset = (value: number) => ((((value * z) % gap) + gap) % gap) - gap / 2
  return (
    <svg className="tl-grid surface__dots" aria-hidden="true">
      <defs>
        <pattern
          id={id}
          width={gap}
          height={gap}
          x={offset(x)}
          y={offset(y)}
          patternUnits="userSpaceOnUse"
        >
          <circle className="surface__dot" cx={gap / 2} cy={gap / 2} r={dot_radius_px} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  )
}

// The fade keys of every shape the person has taken from the print, as one string so the
// layer redraws only when a take is made or undone, not at every point of a stroke.
function taken_text(editor: Editor): string {
  const keys: string[] = []

  for (const shape of editor.getCurrentPageShapes()) {
    const key = taken_key(shape.meta)

    if (key !== null) keys.push(key)
  }

  return keys.sort().join('\n')
}

// The print, in page units, under the ink. It takes no press: it is looked at, and inspected
// through the board's own hit test.
function PrintLayer() {
  const editor = useEditor()
  const print = use_print()
  const text = useValue('taken', () => taken_text(editor), [editor])
  const taken = useMemo(() => new Set(text === '' ? [] : text.split('\n')), [text])
  const view = print?.view ?? null

  if (print === null) return null

  return (
    <div
      className="print"
      role="region"
      aria-label="Agent print"
      data-revision={view?.revision ?? 0}
      data-view={view?.key ?? ''}
      aria-busy={print.key_wanted !== null && print.key_wanted !== view?.key}
      data-showing={print.showing_previous ? 'previous' : 'current'}
      data-failed={view?.failed ?? 0}
    >
      {print.ghosts.map((shape) => (
        <PrintPicture key={`ghost ${shape.id}`} shape={shape} state="ghost" />
      ))}
      {view?.shapes.map((shape) => (
        <PrintPicture
          key={shape.id}
          shape={shape}
          state={taken.has(shape.key) ? 'taken' : 'shown'}
        />
      ))}
    </div>
  )
}

type PictureProps = { shape: PrintShape; state: 'shown' | 'taken' | 'ghost' }

const PrintPicture = memo(function PrintPicture({ shape, state }: PictureProps) {
  const html = useRef<{ __html: string } | null>(null)

  if (html.current?.__html !== shape.markup) html.current = { __html: shape.markup }

  const { x, y, w, h } = shape.box
  return (
    <div
      className="print__shape"
      data-print-shape={shape.id}
      data-shape-type={shape.type}
      data-state={state}
      style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
      dangerouslySetInnerHTML={html.current}
    />
  )
})

const surface_components: TLComponents = {
  ...components_quiet,
  Grid: DotGrid,
  OnTheCanvas: PrintLayer,
}
