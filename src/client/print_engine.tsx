// The agent's print, made ready to lie under the person's ink on the one canvas. Each published
// revision is loaded into a hidden, read-only editor of its own, never the sync room, and each
// of its top-level shapes is exported in its authored colours. The canvas shows
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
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Tldraw, type Atom, type Editor, type TLPageId, type TLShapeId } from 'tldraw'
import { AssertionError, assert } from '../shared/assert'
import { cleaned_page_id, type CanvasRecord, type CleanedDocument } from '../shared/canvas_types'
import { canvas_records_count_max } from '../shared/constants'
import { asset_urls, components_quiet } from './board_store'
import { print_svg_box, print_svg_markup, type PrintBox } from './print_svg'
import { canvas_store } from './print_store'
import {
  timeline_arrived,
  timeline_empty,
  timeline_step,
  type Arrival,
  type Timeline,
  type TimelineEvent,
} from './print_timeline'
import { print_records, print_subtree_hash, print_tree, type PrintTree } from './take_plan'

export type PrintShape = {
  id: string
  type: string
  box: PrintBox

  // The exported picture, and the key a taken copy of this shape carries.
  markup: string
  key: string
}

// The records of one view of the current revision, chosen on this page (`interactive_state`).
// `key` names the view; the print shows it only while `revision` is the current revision.
export type PrintChoice = { revision: number; key: string; records: CanvasRecord[] }

export type PrintView = {
  revision: number

  // The revision and the view drawn: the revision alone for its view at rest.
  key: string
  document: CleanedDocument
  editor: Editor
  shapes: PrintShape[]
  bounds: PrintBox | null

  // Shapes that could not be drawn, so the board can say so rather than hide them.
  failed: number
}

export type PrintExtent = Pick<PrintView, 'revision' | 'bounds'>

export type Print = {
  view: PrintView | null
  ghosts: PrintShape[]

  // The newest revision this page has, 0 before anything is published.
  revision_current: number
  revision_previous: number | null
  showing_previous: boolean

  // A newer revision replaced the one this page held a moment ago (`print_timeline`). It is
  // said from when the page holds it, so `view` may still show the one before while it is drawn.
  arrived: boolean

  // The name of the print wanted on screen. It differs from `view.key` while a chosen view is
  // still being drawn.
  key_wanted: string | null
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

type Held = Timeline<CleanedDocument>

type ProviderProps = {
  document: CleanedDocument | null

  // A view of the current revision other than its rest, or null. An earlier revision is
  // always shown at rest.
  choice?: PrintChoice | null

  // A local choice changes the shown bounds, but only a new revision triggers stage follow.
  extent: Atom<PrintExtent | null>
  children: ReactNode
}

// The page's documents: the newest, and the one it replaced while this page was open, and
// whether a revision has just arrived. A moment without a document, while a newer one loads,
// keeps the print as it is.
function use_held(document: CleanedDocument | null) {
  const [held, held_step] = useReducer(
    (last: Held, event: TimelineEvent<CleanedDocument>) => timeline_step(last, event),
    undefined,
    () => timeline_empty<CleanedDocument>(),
  )
  useEffect(() => {

    // Nothing published yet: no print, and no hidden editor for it. An empty revision is a
    // revision, and is shown as one.
    if (document === null || document.current === null) return

    held_step({ kind: 'document', document })
  }, [document])

  // Each arrival is its own moment, ended only by its own timer: a revision arriving while the
  // one before is still new starts its own window.
  useTimeout(held.arrival, arrival_ms, (arrival: Arrival) => {
    held_step({ kind: 'expire', revision: arrival.revision })
  })
  return { held, held_step }
}

// One document to draw, and the name of what it shows.
type Printed = { key: string; document: CleanedDocument }

export function PrintProvider({ document, choice = null, extent, children }: ProviderProps) {
  const { held, held_step } = use_held(document)
  const showing_previous = held.showing_previous
  const { view, ghosts, ready } = use_shown(held)

  const wanted = useMemo(
    () => printed_wanted(held, showing_previous, choice),
    [held, showing_previous, choice],
  )

  useEffect(() => {
    extent.set(view === null ? null : { revision: view.revision, bounds: view.bounds })
  }, [extent, view])

  const print = useMemo<Print>(
    () => ({
      view: wanted === null ? null : view,
      ghosts,
      revision_current: held.current?.revision ?? 0,
      revision_previous: held.previous?.revision ?? null,
      showing_previous: showing_previous && held.previous !== null,
      arrived: timeline_arrived(held) !== null,
      key_wanted: wanted?.key ?? null,
      show_previous: () => held_step({ kind: 'show_previous' }),
      show_current: () => held_step({ kind: 'show_current' }),
    }),
    [wanted, view, ghosts, held, showing_previous, held_step],
  )
  const benches = bench_documents(view, wanted)
  return (
    <PrintContext.Provider value={print}>
      {children}
      <div className="print-bench" aria-hidden="true">
        {benches.map((bench) => (
          <PrintBench
            key={bench.key}
            printed={bench}
            onReady={bench.key === wanted?.key ? ready : null}
          />
        ))}
      </div>
    </PrintContext.Provider>
  )
}

// The view drawn last, and the ghosts an arrival leaves of the shapes it removed. `ready` takes
// each view as the bench finishes drawing it.
function use_shown(held: Held) {
  const [view, view_set] = useState<PrintView | null>(null)
  const [ghosts, ghosts_set] = useState<PrintShape[]>([])

  // The arrival the drawn print may still answer with ghosts, read when a view is ready.
  const arrival = useRef<Arrival | null>(null)
  arrival.current = held.arrival
  const ghosted = useRef<number | null>(null)
  const shown = useRef<PrintView | null>(null)
  const ready = useCallback((next: PrintView) => {
    const last = shown.current
    const moment = arrival.current

    // Only an arrival leaves ghosts, once, when the revision it replaced gives way to it on
    // screen. Looking back, returning, or a change of view is the person's own choice.
    const replaces =
      last !== null &&
      moment !== null &&
      ghosted.current !== moment.revision &&
      last.revision === moment.previous &&
      next.revision === moment.revision

    if (replaces) {
      const kept = new Set(next.shapes.map((shape) => shape.id))
      ghosts_set(last.shapes.filter((shape) => !kept.has(shape.id)))
      ghosted.current = moment.revision
    }

    shown.current = next
    view_set(next)
  }, [])

  useTimeout(ghosts.length > 0 ? ghosts : null, ghost_ms, () => ghosts_set([]))
  return { view, ghosts, ready }
}

// What the print should show: the revision before, at rest, when the person looks back;
// otherwise the current revision in the view chosen for it, or at rest. A choice made for any
// other revision is not applied.
function printed_wanted(
  held: Held,
  showing_previous: boolean,
  choice: PrintChoice | null,
): Printed | null {
  const previous = showing_previous && held.previous !== null
  const document = previous ? held.previous : held.current

  if (document === null) return null

  if (previous || choice === null || choice.revision !== document.revision) {
    return { key: print_key(document.revision, null), document }
  }

  assert(choice.records.length <= canvas_records_count_max, 'a chosen view is bounded')
  const records = choice.records
  return { key: print_key(document.revision, choice.key), document: { ...document, records } }
}

// The name of a print: its revision, and the view chosen of it unless it is at rest.
export function print_key(revision: number, view: string | null): string {
  assert(Number.isSafeInteger(revision) && revision >= 0, 'a revision is whole')
  assert(view === null || view.length > 0, 'a chosen view is named')
  return view === null ? String(revision) : `${revision} ${view}`
}

// The hidden editors to keep: the one behind the print on screen, which inspecting and taking
// read, and the one being drawn for the print wanted next. Never more than two, so a quick
// run of choices draws only the latest view.
function bench_documents(view: PrintView | null, wanted: Printed | null): Printed[] {
  const list: Printed[] = []

  if (view !== null) list.push({ key: view.key, document: view.document })

  if (wanted !== null && wanted.key !== view?.key) list.push(wanted)

  assert(list.length <= 2, 'two hidden print editors at most')
  return list
}

// Calls `done` with `moment` once `delay_ms` after it began, unless it is null. A different
// moment starts its own delay, so a newer one is never ended by the timer of the one it
// replaced, and `done` is told which moment ended.
function useTimeout<Moment>(
  moment: Moment | null,
  delay_ms: number,
  done: (moment: Moment) => void,
): void {
  assert(Number.isSafeInteger(delay_ms) && delay_ms > 0, 'a delay is whole and positive')
  const latest = useRef(done)
  latest.current = done
  useEffect(() => {
    if (moment === null) return

    const timer = window.setTimeout(() => latest.current(moment), delay_ms)
    return () => window.clearTimeout(timer)
  }, [moment, delay_ms])
}

type BenchProps = { printed: Printed; onReady: ((view: PrintView) => void) | null }

function PrintBench({ printed, onReady }: BenchProps) {
  const { key, document } = printed
  const store = useMemo(() => canvas_store(document.records), [document])
  const ready = useRef(onReady)
  ready.current = onReady
  const mount = useCallback(
    (editor: Editor) => {
      editor.user.updateUserPreferences({ colorScheme: 'light' })
      editor.updateInstanceState({ isReadonly: true })
      let stopped = false
      print_draw(editor, key, document, () => stopped)
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
    [key, document],
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
  key: string,
  document: CleanedDocument,
  stopped: () => boolean,
): Promise<PrintView | null> {
  assert(key.startsWith(String(document.revision)), 'a print is named by its revision')
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
  return { revision: document.revision, key, document, editor, shapes, bounds, failed }
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
