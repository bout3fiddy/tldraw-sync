// What an external agent is told when it takes a cleanup snapshot. The app never calls a model:
// the agent that ran the command reads this, does the tidying itself, and publishes the result
// as a small structured proposal. The prompt is strict on purpose: tidy, never reinterpret.

import { assert } from '../shared/assert'
import {
  proposal_shapes_count_max,
  proposal_summary_length_max,
  proposal_text_length_max,
} from '../shared/constants'
import { proposal_colors, proposal_format, proposal_sizes } from '../shared/cleanup_types'

export type PromptFacts = {
  readonly image_path: string
  readonly records_path: string
  readonly proposal_path: string
  readonly snapshot: string
  readonly base_revision: number

  // How image pixels map onto page units, when the stage reported the bounds it rendered.
  readonly mapping: { readonly x0: number; readonly y0: number; readonly ppu: number } | null
}

// The schema, in the words the help and the prompt both use.
export const proposal_schema_text = `{
  "format": "${proposal_format}",
  "snapshot": "<snapshot token from cleanup-snapshot>",
  "base_revision": <base_revision from cleanup-snapshot>,
  "agent": "<your name, optional>",
  "summary": "<one line, optional, at most ${proposal_summary_length_max} characters>",
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

// What a cleaned diagram can hold, and what it cannot. The prompt, the help and the README say
// the same thing: content outside this subset is reported, never approximated or dropped.
export const proposal_subset_text = `A cleaned diagram can hold only:
  - words, as text or as the label of a box, a circle or an arrow
  - boxes, as rectangles, and circles or ovals, as ellipses
  - an arrow with exactly one arrowhead, joining two different boxes, circles or texts
It cannot hold anything else. That includes a plain line without an arrowhead, a line with
arrowheads at both ends, a line or arrow with a free end or to or from another arrow, an
arrow from a shape to itself, dashed or dotted strokes, freehand ink, other outlines
(diamonds, triangles, cylinders, clouds), tables, images, fills and rotation.
There is no way to draw a line that is not an arrow: never turn one into an arrow.`

export function cleanup_prompt(facts: PromptFacts): string {
  assert(facts.base_revision >= 0, 'a base revision is never negative')
  assert(facts.snapshot.length > 0, 'a prompt names its snapshot')
  const mapping =
    facts.mapping === null
      ? 'Use the page coordinates of the original records.'
      : `Page coordinates from image pixels: x = ${round(facts.mapping.x0)} + pixel_x / ` +
        `${round(facts.mapping.ppu)}, y = ${round(facts.mapping.y0)} + pixel_y / ` +
        `${round(facts.mapping.ppu)}.`
  return [
    'Tidy this hand-drawn sketch into a clean diagram. Tidy only.',
    '',
    `1. Look at the sketch image ${facts.image_path}. Its original pen records are in`,
    `   ${facts.records_path}. ${mapping}`,
    '2. Redraw exactly what is there, where it is: the same boxes, circles, words and arrows.',
    '   Do not add, remove, merge, split, rename, reword, correct, or explain anything.',
    '   Copy handwriting word for word. Write "?" for a word you cannot read.',
    '3. Check that the whole sketch can be redrawn before writing anything.',
    ...proposal_subset_text.split('\n').map((line) => `   ${line}`),
    '   Draw an arrow only where the sketch shows an arrowhead, pointing the way it was drawn.',
    '   If any part of the sketch is outside this list, or you cannot tell what a mark is or',
    '   which way an arrow points, STOP. Do not publish. Do not leave the part out, guess, or',
    '   draw the nearest thing. Tell the user which parts cannot be represented or are',
    '   ambiguous, and let them decide. A diagram that loses or changes meaning is worse',
    '   than no diagram.',
    '4. Straighten and align, nothing more: snap near-equal sizes and positions together.',
    `5. Write one JSON object to ${facts.proposal_path}, in this format:`,
    proposal_schema_text,
    `   Use "snapshot": "${facts.snapshot}" and "base_revision": ${facts.base_revision}.`,
    `6. Run: tldraw-sync cleanup-publish --file ${facts.proposal_path} --json`,
    '   On "sketch_changed" or "revision_conflict", start again from',
    '   tldraw-sync cleanup-snapshot --json. Never change the sketch itself.',
  ].join('\n')
}

function round(value: number): string {
  assert(Number.isFinite(value), 'a mapping value is a number')
  return String(Math.round(value * 1000) / 1000)
}
