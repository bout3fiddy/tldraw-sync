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

// The styled proposal: the v1 shapes plus the few bounded styling and routing controls the
// composer needs, and optionally the semantic diagram it was composed from. The command line
// writes it from a diagram; v1 proposals stay valid and render exactly as before. In each list
// below the first option is the default, which is also what a v1 shape gets.
export const proposal_format_styled = 'tldraw-sync.cleanup.v2'
export const proposal_formats = [proposal_format, proposal_format_styled] as const
export type ProposalFormat = (typeof proposal_formats)[number]
export const proposal_fills = ['none', 'semi', 'solid'] as const
export type ProposalFill = (typeof proposal_fills)[number]
export const proposal_label_aligns = ['middle', 'start'] as const
export type ProposalLabelAlign = (typeof proposal_label_aligns)[number]
export const proposal_text_aligns = ['start', 'middle'] as const
export type ProposalTextAlign = (typeof proposal_text_aligns)[number]
export const proposal_arrowheads = ['end', 'both', 'none'] as const
export type ProposalArrowheads = (typeof proposal_arrowheads)[number]

// The renderer's look for a styled proposal. A proposal only names a style; the renderer owns
// what each style draws. 'plain' is the original crisp look: solid outlines, sans lettering.
// It is the default, so every revision published before styles existed renders as it did.
// 'markerboard' is what the composer gives each newly composed diagram: thin black ink on white,
// in tldraw's native, deterministic hand-drawn line and its upright handwritten draw face. It
// adds no records and no decoration, and a markerboard proposal may use no colour or tint.
export const proposal_styles = ['plain', 'markerboard'] as const
export type ProposalStyle = (typeof proposal_styles)[number]

// An arc is straight unless it bends; an elbow runs in right angles.
export const proposal_routes = ['arc', 'elbow'] as const
export type ProposalRoute = (typeof proposal_routes)[number]

// Where an arrow meets its shape, from (0, 0) at the top left to (1, 1) at the bottom right.
// Null aims at the center, and tldraw stops the arrow at the outline.
export type ProposalAnchor = { x: number; y: number }

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
      align: ProposalTextAlign
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
      fill: ProposalFill

      // Null draws the label in the outline's colour, as v1 does.
      label_color: ProposalColor | null
      label_align: ProposalLabelAlign
      label_valign: ProposalLabelAlign
      label_bold: boolean
    }
  | {
      kind: 'arrow'
      id: string
      from: string
      to: string
      text: string
      color: ProposalColor
      size: ProposalSize
      arrowheads: ProposalArrowheads
      route: ProposalRoute

      // How far an arc's middle stands off the straight line, in page units, as tldraw's bend.
      bend: number
      from_anchor: ProposalAnchor | null
      to_anchor: ProposalAnchor | null
    }

// A validated proposal: what an agent asked to publish, tied to the sketch it saw.
export type Proposal = {
  format: ProposalFormat
  snapshot: string
  base_revision: number
  agent: string
  summary: string
  shapes: ProposalShape[]
  style: ProposalStyle

  // The semantic diagram the shapes were composed from, kept for the next interpretation.
  diagram: Diagram | null
}

// The semantic diagram format an agent writes. It says what the sketch means: items, their
// exact words, which group holds which, and how they connect. It has no coordinates; the
// command line lays it out (cleanup-compose) and publishes the result as a styled proposal.
export const diagram_format = 'tldraw-sync.diagram.v1'

// A box, a circle or oval, free text, or a group drawn around other items.
export const diagram_node_kinds = ['box', 'ellipse', 'text', 'group'] as const
export type DiagramNodeKind = (typeof diagram_node_kinds)[number]

// A connection points from its "from" end to its "to" end, both ways, or neither way.
export const diagram_edge_directions = ['forward', 'both', 'none'] as const
export type DiagramEdgeDirection = (typeof diagram_edge_directions)[number]

// The way most connections run. The first is the default.
export const diagram_flows = ['right', 'down'] as const
export type DiagramFlow = (typeof diagram_flows)[number]

export type DiagramNode = {
  id: string
  kind: DiagramNodeKind
  label: string
  parent: string | null
  strokes: string[]
}

export type DiagramEdge = {
  id: string
  from: string
  to: string
  label: string
  direction: DiagramEdgeDirection
  strokes: string[]
}

// A validated diagram, in the order the agent listed it.
export type Diagram = { flow: DiagramFlow; nodes: DiagramNode[]; edges: DiagramEdge[] }

// A validated semantic proposal: a diagram tied to the sketch it was read from.
export type DiagramProposal = {
  snapshot: string
  base_revision: number
  agent: string
  summary: string
  diagram: Diagram
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

  // The semantic diagram behind the current cleaned revision, when it was composed from one.
  // An agent reuses its ids, so the same things keep their identity across revisions.
  diagram_previous: Diagram | null
}
