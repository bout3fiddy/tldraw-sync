// The Agent canvas as the server, the pages and the command line pass it around. Human ink
// lives in the sync room. The canvas is a separate, read-only document that an external agent
// publishes whole, as native tldraw records. Nothing here runs a model.

import type { SceneControlJson, ViewState, ViewTap } from './scene_controls'

// The page every canvas record belongs to.
export const cleaned_page_id = 'page:page'

// A native tldraw record, as far as this app reads one.
export type CanvasRecord = { id: string; typeName: string }

// Where one published canvas came from. Revisions only grow, across restarts too.
export type CleanedProvenance = {
  revision: number
  source_hash: string | null
  agent: string
  summary: string
  published_at_ms: number
  restored_from: number | null
  shapes_count: number

  // True for a revision published in a retired format. It is shown as it was and can be
  // restored, but it has no scene for an agent to edit.
  legacy: boolean
}

// What a page polls: small, without records.
export type CleanedStatus = {

  // The current revision, or 0 before anything was published.
  revision: number

  // The hash of the ink as it is now.
  sketch_hash: string
  current: CleanedProvenance | null

  // True when the sketch has changed since the current canvas was made from it.
  stale: boolean

  // Prior revisions that can be restored, oldest first.
  history: CleanedProvenance[]
}

// The full canvas: the status and the native tldraw records of the current revision.
export type CleanedDocument = CleanedStatus & { records: CanvasRecord[] }

// The page-space rectangle the stage rendered, and how image pixels map onto it.
export type SketchBounds = { x: number; y: number; w: number; h: number }

// A coherent reading of one board for an agent: the sketch as it is, and what the Agent canvas
// holds. A proposal made from it names the same session, sketch and revision.
export type SketchSnapshot = {

  // The board session the sketch belongs to, and whether that board still has no name, so
  // the agent is asked for a title.
  session: string
  title_wanted: boolean
  document_hash: string
  records: CanvasRecord[]
  bounds: SketchBounds | null
  image_padding: number
  agent_revision: number
  agent_history: CleanedProvenance[]
  agent_source_hash: string | null

  // The scene behind the current revision, as an agent may send it again, with what the
  // board filled in. Null when nothing is published, or when the current revision is a
  // legacy one, which is shown but has no scene to edit.
  scene: Array<Record<string, unknown>> | null

  // The controls of that scene, as an agent may send them again with it: empty when it has
  // none. A scene sent back without the controls its elements name is refused, not trimmed.
  scene_controls: SceneControlJson[]
  canvas_legacy: boolean
}

// One view of the current revision, for a page that shows the controls (`path_cleaned_view`).
// The view state belongs to the page: asking for a view changes nothing on the board. Without
// a state, or for a revision with no controls, it is the view at rest, whose records are those
// `CleanedDocument` serves to every page. `taps` are what a tap on a shown shape sets.
export type CanvasView = {
  revision: number
  controls: SceneControlJson[]
  state: ViewState
  states_count: number
  records: CanvasRecord[]
  taps: ViewTap[]
}

// A draft the stage is asked to render: the records a publish of the same proposal would
// save. `id` is null when there is nothing to render.
export type PreviewJob = { id: string | null; records?: CanvasRecord[] }
