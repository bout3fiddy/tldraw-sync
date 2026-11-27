// The agent's print, made ready to lie under the person's ink on the one canvas. Each published
// revision is loaded into a hidden, read-only editor of its own, never the sync room, and each
// of its top-level shapes is exported as tldraw draws it, repainted in violet. The canvas shows
// those pictures in the person's own camera; the hidden editor answers what is where, for
// inspecting and taking a shape.
//
// A new revision replaces the print only once its pictures are ready, so the print never
// blinks. Shapes it no longer has ghost for a moment. The revision before stays in memory for
// this visit, so it can be looked at again. Nothing here publishes, restores or moves a camera.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Tldraw, type Atom, type Editor, type TLPageId, type TLShapeId } from 'tldraw'
import { AssertionError, assert } from '../shared/assert'
import { cleaned_page_id, type CleanedDocument } from '../shared/canvas_types'
import { canvas_records_count_max } from '../shared/constants'
import { asset_urls, components_quiet } from './board_store'
import { print_svg_box, print_svg_markup, type PrintBox } from './print_svg'
import { canvas_store } from './print_store'
import { print_records, print_subtree_hash, print_tree, type PrintTree } from './take_plan'

export type PrintShape = {
  id: string
  type: string
  box: PrintBox

  // The repainted picture, and the key a taken copy of this shape carries.
  markup: string
  key: string
}

export type PrintView = {
  revision: number
  document: CleanedDocument
  editor: Editor
  shapes: PrintShape[]
  bounds: PrintBox | null

  // Shapes that could not be drawn, so the board can say so rather than hide them.
  failed: number
}

export type Print = {
  view: PrintView | null
  ghosts: PrintShape[]

  // The newest revision this page has, 0 before anything is published.
  revision_current: number
  revision_previous: number | null
  showing_previous: boolean

  // A newer revision replaced the print a moment ago.
  arrived: boolean
  show_previous: () => void
  show_current: () => void
}

// Long enough to see what left; short enough not to be mistaken for the print.
const ghost_ms = 2400

// How long the key says a revision is new, and offers the one before.
const arrival_ms = 12_000

const PrintContext = createContext<Print | null>(null)

export function use_print(): Print | null {
  return useContext(PrintContext)
}

type Held = { current: CleanedDocument | null; previous: CleanedDocument | null }

type ProviderProps = {
  document: CleanedDocument | null

  // The print's page bounds, for a stage that keeps the whole board in view.
  bounds: Atom<PrintBox | null>
  children: ReactNode
}

// The page's documents: the newest, and the one it replaced while this page was open. A
// moment without a document, while a newer one loads, keeps the print as it is.
function use_held(document: CleanedDocument | null) {
  const [held, held_set] = useState<Held>({ current: null, previous: null })
  const [showing_previous, showing_previous_set] = useState(false)
  useEffect(() => {

    // Nothing published yet: no print, and no hidden editor for it. An empty revision is a
    // revision, and is shown as one.
    if (document === null || document.current === null) return

    held_set((last) => {
      if (last.current?.revision === document.revision) return last

      return { current: document, previous: last.current }
    })
  }, [document])

  // Only a newer revision ends a look at the one before: a reloaded copy of the same revision
  // leaves the person where they chose to be.
  const revision_current = held.current?.revision ?? null
  useEffect(() => showing_previous_set(false), [revision_current])
  return { held, showing_previous, showing_previous_set }
}

export function PrintProvider({ document, bounds, children }: ProviderProps) {
  const { held, showing_previous, showing_previous_set } = use_held(document)
  const [view, view_set] = useState<PrintView | null>(null)
  const [ghosts, ghosts_set] = useState<PrintShape[]>([])
  const [arrived, arrived_set] = useState(false)

  const wanted = showing_previous && held.previous !== null ? held.previous : held.current
  const shown = useRef<PrintView | null>(null)
  const ready = useCallback((next: PrintView) => {
    const last = shown.current

    if (last !== null && next.revision > last.revision) {
      const kept = new Set(next.shapes.map((shape) => shape.id))
      ghosts_set(last.shapes.filter((shape) => !kept.has(shape.id)))
      arrived_set(true)
    }

    shown.current = next
    view_set(next)
  }, [])

  useTimeout(ghosts.length > 0, ghost_ms, () => ghosts_set([]))
  useTimeout(arrived, arrival_ms, () => arrived_set(false))
  useEffect(() => {
    bounds.set(view?.bounds ?? null)
  }, [bounds, view])

  const print = useMemo<Print>(
    () => ({
      view: wanted === null ? null : view,
      ghosts,
      revision_current: held.current?.revision ?? 0,
      revision_previous: held.previous?.revision ?? null,
      showing_previous: showing_previous && held.previous !== null,
      arrived: arrived && !showing_previous,
      show_previous: () => showing_previous_set(true),
      show_current: () => showing_previous_set(false),
    }),
    [wanted, view, ghosts, held, showing_previous, arrived],
  )
  const benches = bench_documents(view, wanted)
  return (
    <PrintContext.Provider value={print}>
      {children}
      <div className="print-bench" aria-hidden="true">
        {benches.map((bench) => (
          <PrintBench
            key={bench.revision}
            document={bench}
            onReady={bench.revision === wanted?.revision ? ready : null}
          />
        ))}
      </div>
    </PrintContext.Provider>
  )
}

// The hidden editors to keep: the one behind the print on screen, which inspecting and taking
// read, and the one being drawn for the print wanted next. Never more than two.
function bench_documents(view: PrintView | null, wanted: CleanedDocument | null) {
  const list: CleanedDocument[] = []

  if (view !== null) list.push(view.document)

  if (wanted !== null && wanted.revision !== view?.revision) list.push(wanted)

  assert(list.length <= 2, 'two hidden print editors at most')
  return list
}

function useTimeout(active: boolean, delay_ms: number, done: () => void): void {
  const latest = useRef(done)
  latest.current = done
  useEffect(() => {
    if (!active) return

    const timer = window.setTimeout(() => latest.current(), delay_ms)
    return () => window.clearTimeout(timer)
  }, [active, delay_ms])
}

type BenchProps = { document: CleanedDocument; onReady: ((view: PrintView) => void) | null }

function PrintBench({ document, onReady }: BenchProps) {
  const store = useMemo(() => canvas_store(document.records), [document])
  const ready = useRef(onReady)
  ready.current = onReady
  const mount = useCallback(
    (editor: Editor) => {
      editor.user.updateUserPreferences({ colorScheme: 'light' })
      editor.updateInstanceState({ isReadonly: true })
      let stopped = false
      print_draw(editor, document, () => stopped)
        .then((view) => {
          if (view !== null && !stopped) ready.current?.(view)
        })
        .catch((error: unknown) => {

          // An assertion is a fault in this page: it is raised where the page reports errors.
          window.setTimeout(() => {
            throw error
          }, 0)
        })
      return () => {
        stopped = true
      }
    },
    [document],
  )
  return (
    <Tldraw
      store={store}
      hideUi
      autoFocus={false}
      assetUrls={asset_urls}
      components={components_quiet}
      onMount={mount}
    />
  )
}

// Every top-level shape of one revision, drawn in page order. Null once the revision is gone.
async function print_draw(
  editor: Editor,
  document: CleanedDocument,
  stopped: () => boolean,
): Promise<PrintView | null> {
  await editor.fonts.loadRequiredFontsForCurrentPage()

  // Keyed by the records this editor holds, which is what a take copies and hashes.
  const tree = print_tree(print_records(editor))
  const roots = editor.getSortedChildIdsForParent(cleaned_page_id as TLPageId)
  assert(roots.length <= canvas_records_count_max, 'a print is bounded')
  const shapes: PrintShape[] = []
  let failed = 0

  for (const root of roots) {
    if (stopped()) return null

    const shape = await print_shape_draw(editor, tree, root)

    if (shape === null) failed += 1
    else shapes.push(shape)
  }

  const page = editor.getCurrentPageBounds()
  const bounds = page === undefined ? null : { x: page.x, y: page.y, w: page.w, h: page.h }
  assert(shapes.length + failed === roots.length, 'every top-level shape is accounted for')
  return { revision: document.revision, document, editor, shapes, bounds, failed }
}

async function print_shape_draw(
  editor: Editor,
  tree: PrintTree,
  root: TLShapeId,
): Promise<PrintShape | null> {
  try {
    const result = await editor.getSvgElement([root], {
      background: false,
      padding: 0,
    })

    if (result === undefined) return null

    // The export lives in a container tldraw takes away: work on a copy of it.
    const svg = result.svg.cloneNode(true) as SVGSVGElement
    const box = print_svg_box(svg)
    const markup = box === null ? null : print_svg_markup(svg)

    if (box === null || markup === null) return null

    const type = String(tree.shapes.get(root)?.type ?? '')
    return { id: root, type, box, markup, key: `${root} ${print_subtree_hash(tree, root)}` }
  } catch (error) {
    if (error instanceof AssertionError) throw error

    return null
  }
}
