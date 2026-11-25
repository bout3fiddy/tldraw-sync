// What an external agent is told when it takes a cleanup snapshot. The app never calls a model:
// the agent that ran the command reads the sketch and writes down what it means, as a semantic
// diagram, and the command line typesets that diagram. The prompt is strict about meaning:
// copy every word and connection exactly, invent nothing. On layout it asks for one thing,
// where each item sat in the sketch, because the person drawing put things beside and above
// each other on purpose. The tool keeps that arrangement and owns the look: black ink only.

import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern } from '../shared/board_session'
import {
  board_title_length_max,
  diagram_depth_max,
  diagram_edges_count_max,
  diagram_label_length_max,
  diagram_nodes_count_max,
  proposal_summary_length_max,
} from '../shared/constants'
import { diagram_format } from '../shared/cleanup_types'

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
     "at": [<left>, <top>, <width>, <height>], "parent": "<id of the group that holds it>"?,
     "strokes": ["<stroke id>", ...]?}
  ],
  "edges": [ 0 to ${diagram_edges_count_max} of:
    {"id", "from": "<node id>", "to": "<node id>", "direction": "forward" | "both" | "none",
     "label": "<the exact words>"?, "strokes": ["<stroke id>", ...]?}
  ]
}
  Nodes and edges may carry "origin": "sketch" (default) or "agent". Cross-origin edges are valid.
  Ids are 1 to 40 letters, digits, _ or -, unique across nodes and edges. A box is any closed
  outline, an ellipse a circle or oval, text words with no outline, and a group either an
  outline drawn around other items or a heading with the items written under it; its label is
  the heading. "at" is the box around the item's ink in the sketch, in image pixels or page
  units, the same for every node: the tool keeps what is left of, right of, above and below
  what, and which items share a column or a row. Give it for every node, or for none, and then
  the tool arranges the diagram by its connections alone. "forward" has one arrowhead, at
  "to"; "both" has one at each end; "none" is a plain line. A label is at most
  ${diagram_label_length_max} characters; "\\n" breaks a line. A text node needs a label. Groups
  nest at most ${diagram_depth_max} deep and never contain themselves. A connection joins two
  different nodes, neither inside the other; groups can be connected too, and connections may
  form cycles. There are no sizes, colours or styles: the tool sizes every item to its words
  and draws it all in black ink. No other fields are accepted.`

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
          `   The previous interpretation is ${facts.previous_path}. Edit it rather than start`,
          '   again: keep its ids, labels, groups and "at" for everything the sketch still shows',
          '   as it did, so those parts stay where they are; add, change or remove only what the',
          '   sketch added, changed or removed, with new ids for new items.',
        ]
  return [
    'Typeset this hand-drawn sketch as a clean diagram. Read what it means; invent nothing.',
    '',
    `1. Look at the sketch image ${facts.image_path}. Each stroke's id and page bounds are in`,
    `   ${facts.strokes_path}; the full pen records, if you need them, are in`,
    `   ${facts.records_path}. ${mapping}`,
    ...previous,
    '2. Write down what the sketch says: every box, circle, piece of writing and group, and',
    '   every connection between them, with which group holds which item. A sketch may be a',
    '   diagram, notes, lists, or all of them at once.',
    '   - Copy every written word exactly as drawn. Do not add, remove, merge, split, rename,',
    '     reword, correct, translate or explain anything. Invent no items or connections.',
    '   - Interpret the handwriting and the marks as best you can from their shapes and',
    '     positions. Do not ask the user to clarify. Write "?" for a word you cannot read.',
    '   - Keep every arrowhead: one is "forward" from tail to head, two are "both", none is',
    '     "none". Never add or drop one.',
    '   - Keep the arrangement. Give every node "at": the box around its ink in the sketch',
    '     image, in pixels. Things drawn side by side, one above the other, or in a column were',
    '     put there on purpose, and "at" is how the tool keeps them there.',
    '   - A heading over the items it introduces, underlined, larger or set apart, is a group',
    '     with the heading as its label and those items inside it. One line of a list, or one',
    '     sentence or note, is one text node; do not join lines or split one.',
    '   - Choose no sizes, colours or styles. The result is a black-and-white whiteboard,',
    '     whatever colours the sketch used. Do not write a shape proposal with coordinates.',
    '   - Where you can, list the stroke ids each item and connection came from.',
    `3. Write one JSON object to ${facts.diagram_path}, in this format:`,
    diagram_schema_text,
    `   Use "snapshot": "${facts.snapshot}" and "base_revision": ${facts.base_revision}.`,
    `   Use "session": "${facts.session}": the diagram belongs to this board and no other.`,
    ...title_lines(facts.title_wanted),
    `4. Run: tldraw-sync cleanup-compose --file ${facts.diagram_path} --json`,
    '   It lays the diagram out without publishing it. Compare "width_units" to "height_units"',
    '   with the shape of the sketch: a result several times wider or taller than the sketch',
    '   means some "at" is wrong or missing, so fix it before publishing.',
    `5. Run: tldraw-sync cleanup-publish${flag} --file ${facts.diagram_path} --json`,
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
