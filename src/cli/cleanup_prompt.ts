// What an external agent is told when it takes a cleanup snapshot. The app never calls a model:
// the agent that ran the command reads the sketch and writes down what it means, as a semantic
// diagram, and the command line typesets that diagram. The prompt is strict about meaning and
// silent about layout: copy every word and connection exactly, invent nothing, place nothing.

import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern } from '../shared/board_session'
import {
  board_title_length_max,
  diagram_depth_max,
  diagram_edges_count_max,
  diagram_label_length_max,
  diagram_nodes_count_max,
  proposal_shapes_count_max,
  proposal_summary_length_max,
  proposal_text_length_max,
} from '../shared/constants'
import {
  diagram_format,
  proposal_colors,
  proposal_format,
  proposal_sizes,
} from '../shared/cleanup_types'

export type PromptFacts = {
  readonly image_path: string
  readonly records_path: string
  readonly strokes_path: string
  readonly diagram_path: string

  // The diagram behind the current cleaned revision, when there is one to reuse.
  readonly previous_path: string | null
  readonly snapshot: string
  readonly base_revision: number

  // The board session the sketch belongs to, and whether that board still needs a name.
  readonly session: string
  readonly title_wanted: boolean

  // How image pixels map onto page units, when the stage reported the bounds it rendered.
  readonly mapping: { readonly x0: number; readonly y0: number; readonly ppu: number } | null
}

// The semantic schema, in the words the help, the README and the prompt all use.
export const diagram_schema_text = `{
  "format": "${diagram_format}",
  "snapshot": "<snapshot token from cleanup-snapshot>",
  "base_revision": <base_revision from cleanup-snapshot>,
  "agent": "<your name, optional>",
  "summary": "<one line, optional, at most ${proposal_summary_length_max} characters>",
  "session": "<session from cleanup-snapshot>",
  "title": "<a few words, optional: only when cleanup-snapshot asks for one>",
  "flow": "right" | "down",   optional, default "right": the way most connections run
  "nodes": [ 1 to ${diagram_nodes_count_max} of:
    {"id", "kind": "box" | "ellipse" | "text" | "group", "label": "<the exact words>",
     "parent": "<id of the group drawn around it>"?, "strokes": ["<stroke id>", ...]?}
  ],
  "edges": [ 0 to ${diagram_edges_count_max} of:
    {"id", "from": "<node id>", "to": "<node id>", "direction": "forward" | "both" | "none",
     "label": "<the exact words>"?, "strokes": ["<stroke id>", ...]?}
  ]
}
  Ids are 1 to 40 letters, digits, _ or -, unique across nodes and edges. A box is any closed
  outline, an ellipse a circle or oval, text a few words with no outline, and a group an
  outline drawn around other items. "forward" has one arrowhead, at "to"; "both" has one at
  each end; "none" is a plain line. A label is at most ${diagram_label_length_max} characters;
  "\\n" breaks a line. A text node needs a label. Groups nest at most ${diagram_depth_max} deep and
  never contain themselves. A connection joins two different nodes, neither inside the other;
  groups can be connected too, and connections may form cycles. There are no coordinates or
  sizes: the tool lays the diagram out. No other fields are accepted.`

export function cleanup_prompt(facts: PromptFacts): string {
  assert(facts.base_revision >= 0, 'a base revision is never negative')
  assert(facts.snapshot.length > 0, 'a prompt names its snapshot')
  assert(board_id_pattern.test(facts.session), 'a prompt names its board')
  const flag = facts.session === board_default_id ? '' : ` --session ${facts.session}`
  const mapping =
    facts.mapping === null
      ? 'Stroke bounds are in page units.'
      : `Page units from image pixels: x = ${round(facts.mapping.x0)} + pixel_x / ` +
        `${round(facts.mapping.ppu)}, y = ${round(facts.mapping.y0)} + pixel_y / ` +
        `${round(facts.mapping.ppu)}.`
  const previous =
    facts.previous_path === null
      ? []
      : [
          `   The previous interpretation is ${facts.previous_path}. Keep its ids for the same`,
          '   items, so they keep their identity; use new ids only for new items.',
        ]
  return [
    'Typeset this hand-drawn sketch as a clean diagram. Read what it means; invent nothing.',
    '',
    `1. Look at the sketch image ${facts.image_path}. Each stroke's id and page bounds are in`,
    `   ${facts.strokes_path}; the full pen records, if you need them, are in`,
    `   ${facts.records_path}. ${mapping}`,
    ...previous,
    '2. Write down what the sketch says: every box, circle, free text and group, and every',
    '   connection between them, with which group holds which item.',
    '   - Copy every written word exactly as drawn. Do not add, remove, merge, split, rename,',
    '     reword, correct, translate or explain anything. Invent no items or connections.',
    '   - Interpret the handwriting and the marks as best you can from their shapes and',
    '     positions. Do not ask the user to clarify. Write "?" for a word you cannot read.',
    '   - Keep every arrowhead: one is "forward" from tail to head, two are "both", none is',
    '     "none". Never add or drop one.',
    '   - Choose no positions, sizes, colours or styles: the tool lays the diagram out.',
    '   - Where you can, list the stroke ids each item and connection came from.',
    `3. Write one JSON object to ${facts.diagram_path}, in this format:`,
    diagram_schema_text,
    `   Use "snapshot": "${facts.snapshot}" and "base_revision": ${facts.base_revision}.`,
    `   Use "session": "${facts.session}": the diagram belongs to this board and no other.`,
    ...title_lines(facts.title_wanted),
    `4. Run: tldraw-sync cleanup-publish${flag} --file ${facts.diagram_path} --json`,
    '   It lays the diagram out, checks it, and publishes it to the Cleaned tab. On',
    '   "invalid_diagram", fix the field the message names and run it again. On',
    '   "sketch_changed", "revision_conflict" or "session_mismatch", start again from',
    `   tldraw-sync cleanup-snapshot${flag} --json. Never change the sketch itself.`,
  ].join('\n')
}

// Asked only while the board has no name. The board applies it on an accepted publish, and
// only if nobody named the board meanwhile: a person's name always wins.
function title_lines(title_wanted: boolean): string[] {
  if (!title_wanted) return []

  return [
    '   This board has no name yet. Also add "title": a few words, at most',
    `   ${board_title_length_max} characters on one line, saying what the sketch is about, in its`,
    '   own words where you can. It names the board unless someone names it first.',
  ]
}

function round(value: number): string {
  assert(Number.isFinite(value), 'a mapping value is a number')
  return String(Math.round(value * 1000) / 1000)
}

// The older shape proposal: coordinates chosen by the agent. It is still accepted, for agents
// and scripts written before semantic diagrams; new cleanups should write a diagram instead.
export const proposal_schema_text = `{
  "format": "${proposal_format}",
  "snapshot": "<snapshot token from cleanup-snapshot>",
  "base_revision": <base_revision from cleanup-snapshot>,
  "agent": "<your name, optional>",
  "summary": "<one line, optional, at most ${proposal_summary_length_max} characters>",
  "session": "<session from cleanup-snapshot; only the default board accepts none>",
  "shapes": [ 1 to ${proposal_shapes_count_max} of:
    {"kind": "text",      "id", "x", "y", "text", "w"?}
    {"kind": "rectangle", "id", "x", "y", "w", "h", "text"?}
    {"kind": "ellipse",   "id", "x", "y", "w", "h", "text"?}
    {"kind": "arrow",     "id", "from": "<shape id>", "to": "<shape id>", "text"?}
  ]
}
  Every shape may also have "color" (${proposal_colors.join(', ')}; default black)
  and "size" (${proposal_sizes.join(', ')}; default m). Ids are 1 to 40 letters, digits, _ or -,
  unique. x, y, w, h are page units; x, y is the top-left corner. Text is at most
  ${proposal_text_length_max} characters; "\\n" breaks a line. An arrow joins two non-arrow
  shapes, from its tail to its head. No other fields are accepted.`

// What a shape proposal can hold. Semantic diagrams hold more: plain and two-headed lines,
// and groups around other items.
export const proposal_subset_text = `A shape proposal can hold only:
  - words, as text or as the label of a box, a circle or an arrow
  - boxes, as rectangles, and circles or ovals, as ellipses
  - an arrow with exactly one arrowhead, joining two different boxes, circles or texts`
