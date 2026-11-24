// The shapes of the cleanup flow's JSON, shared by the server, the pages and the command line.
// Human ink lives in the sync room; a cleaned diagram is a separate, read-only document that an
// external agent publishes whole. Nothing here runs a model: an agent outside the app does that.

// The proposal format an agent writes. The version is part of the name, so a future format can
// be told apart rather than misread.
export const proposal_format = 'tldraw-sync.cleanup.v1'

// The page every cleaned record belongs to, on the cleaned canvas.
export const cleaned_page_id = 'page:page'

export const proposal_kinds = ['text', 'rectangle', 'ellipse', 'arrow'] as const
export type ProposalKind = (typeof proposal_kinds)[number]

export const proposal_colors = [
  'black',
  'grey',
  'blue',
  'light-blue',
  'violet',
  'light-violet',
  'red',
  'light-red',
  'orange',
  'yellow',
  'green',
  'light-green',
  'white',
] as const
export type ProposalColor = (typeof proposal_colors)[number]

// The first colour and the first size are the defaults.
export const proposal_sizes = ['m', 's', 'l', 'xl'] as const
export type ProposalSize = (typeof proposal_sizes)[number]

// One validated shape. Optional fields have been filled with their defaults.
export type ProposalShape =
  | {
      kind: 'text'
      id: string
      x: number
      y: number
      text: string
      w: number | null
      color: ProposalColor
      size: ProposalSize
    }
  | {
      kind: 'rectangle' | 'ellipse'
      id: string
      x: number
      y: number
      w: number
      h: number
      text: string
      color: ProposalColor
      size: ProposalSize
    }
  | {
      kind: 'arrow'
      id: string
      from: string
      to: string
      text: string
      color: ProposalColor
      size: ProposalSize
    }

// A validated proposal: what an agent asked to publish, tied to the sketch it saw.
export type Proposal = {
  snapshot: string
  base_revision: number
  agent: string
  summary: string
  shapes: ProposalShape[]
}

// Where one published diagram came from. Revisions only grow, across restarts too.
export type CleanedProvenance = {
  revision: number
  source_hash: string
  agent: string
  summary: string
  published_at_ms: number
  restored_from: number | null
  shapes_count: number
}

// What a page polls: small, without records.
export type CleanedStatus = {

  // The current revision, or 0 before anything was published.
  revision: number

  // The hash of the ink as it is now.
  sketch_hash: string
  current: CleanedProvenance | null

  // True when the sketch has changed since the current cleaned diagram was made from it.
  stale: boolean

  // Prior revisions that can be restored, oldest first.
  history: CleanedProvenance[]
}

// The full cleaned document: the status and the native tldraw records of the current revision.
export type CleanedDocument = CleanedStatus & { records: Array<{ id: string; typeName: string }> }

// The page-space rectangle the stage rendered, and how image pixels map onto it.
export type SketchBounds = { x: number; y: number; w: number; h: number }

export type SketchSnapshot = {
  document_hash: string
  records: Array<{ id: string; typeName: string }>
  bounds: SketchBounds | null
  image_padding: number
  cleaned_revision: number
}
