// The help is the documentation, for people and for agents alike. It is layered: the top level
// says what the board is and how to get the drawing; each command's help has the detail.

import { board_name_length_max, port_default, proposal_size_bytes_max } from '../shared/constants'
import { diagram_schema_text } from './cleanup_prompt'

export const commands = [
  'start',
  'fetch',
  'status',
  'stop',
  'serve',
  'cleanup-snapshot',
  'cleanup-compose',
  'cleanup-publish',
  'cleanup-restore',
  'session-list',
  'session-create',
  'session-rename',
  'whiteboard-link', 'whiteboard-poll', 'whiteboard-ack',
  'whiteboard-snapshot', 'whiteboard-publish',
] as const

// Every board command takes this; it is described once here and named in each command's help.
const session_option_text =
  '  --session <id>  Work on this board (see session-list); without it, the default board'
export type Command = (typeof commands)[number]

export const help_top = `tldraw-sync: draw on an iPad, see it on the Mac, let agents fetch it.

Usage: tldraw-sync <command> [options]

Commands:
  start    Start the board in the background, or show the one already running
  fetch    Save the current drawing as a PNG and print its path
  status   Show whether the board is running, its addresses and what is connected
  stop     Stop the board
  serve    Run the board in this terminal instead of the background

Cleanup (an external agent reads the sketch; the tool typesets diagrams and writing on a
separate Cleaned canvas, and keeps pictures there as the pen strokes they were drawn with):
  cleanup-snapshot  Save the sketch image, stroke summaries and instructions for the agent
  cleanup-compose   Lay out a semantic diagram locally, without publishing it
  cleanup-publish   Lay out and publish a semantic diagram as the new cleaned diagram
  cleanup-restore   Bring back an earlier cleaned diagram

Linked whiteboards (one board per pih session; credentials stay in the private binding file):
  whiteboard-link      Start or reopen a bound board and its pairing stage
  whiteboard-poll      Read outstanding durable requests
  whiteboard-ack       Mark a request received, working, updated or failed
  whiteboard-snapshot  Read a coherent sketch and the unified agent graph
  whiteboard-publish   Compose and publish the entire Agent canvas

Boards (each is a separate board, listed in the side rail and opened by its own address):
  session-list    List the boards, their ids, names and addresses
  session-create  Make a new, empty board
  session-rename  Rename a board

Options:
  --json       Print one JSON object on stdout (every command)
  --quiet, -q  Print one bare value on stdout, for piping
  --help, -h   Show help for a command
  --version    Show the version
  --session    The board a board command works on (default: the default board)

For agents:
  The user sketches on an iPad while talking to you. When they mention their drawing,
  sketch, diagram or board, run

    tldraw-sync fetch --json

  and read the PNG at "path" with your image tool. The drawing is context for whatever they
  are asking. If the command fails, do what "next_action" says. More: tldraw-sync fetch --help

  When they ask you to clean up, tidy or redraw the sketch, run

    tldraw-sync cleanup-snapshot --json

  and follow its "prompt". More: tldraw-sync cleanup-snapshot --help

  The user may keep several boards. When they name one, find its id with
  tldraw-sync session-list --json and add --session <id> to each command. Without it, every
  command works on the default board.

Exit codes:
  0  success
  1  usage error, or a failure the message explains
  2  the board is not running: run \`tldraw-sync start\`
  3  the board is empty: ask the user to draw on the iPad
  4  the image is not ready yet: run \`tldraw-sync fetch\` again
  5  a cleanup conflicts with a newer sketch or cleanup: take a new snapshot

JSON:
  Success: {"status": "success", "code": ..., ...data}
  Failure: {"status": "failure", "code", "message", "next_action", "exit_code"}
  Branch on "status", then act on "next_action.action":
    run        run "next_action.command"
    retry      run "next_action.command" again
    ask_human  tell the user "next_action.message"; it needs their hands
    fix_usage  read "next_action.command" and correct the call

Quick start:
  tldraw-sync start     then scan the QR code with the iPad camera
  tldraw-sync fetch     after drawing
  tldraw-sync stop

Environment:
  BOARD_DATA_DIR  Where the board is saved (default: data/ in the repository)`

export const help_commands: Record<Command, string> = {
  'whiteboard-link': `Usage: tldraw-sync whiteboard-link --protocol 2
    --owner <id> --out <absolute-file> --json`,
  'whiteboard-poll': 'Usage: tldraw-sync whiteboard-poll --protocol 2 --binding <file> --json',
  'whiteboard-ack': `Usage: tldraw-sync whiteboard-ack --binding <file> --event <id>
    --state <received|working|updated|failed> [--message <text>] --json`,
  'whiteboard-snapshot': `Usage: tldraw-sync whiteboard-snapshot --binding <file>
    [--layer canvas] [--out <directory>] --json

Saves a coherent snapshot of the bound board, as cleanup-snapshot does, in a new private folder
under --out: the sketch image, its pen records (sketch.json), a summary of each stroke, and
the complete graph of the Agent canvas when there is one. "prompt" says what each kind of
request asks for:

  An ordinary Notify request asks for no cleanup. Leave the sketch-origin items as they are
  and add, change or remove your own items ("origin": "agent") as its note asks.

  An Interpret request asks for a faithful copy of the sketch as it is now. Rebuild the graph
  from the current sketch alone: a diagram and writing are typeset, a picture is kept as a
  "drawing" of its own pen strokes, and what the sketch no longer shows is left out, earlier
  agent-origin notes included, unless the request's note asks for them.

A sketch with nothing on it still has a snapshot: its image is a blank page, "shapes_count"
is 0, and the prompt asks for an empty canvas ("nodes": [] and "edges": []).

Example:
  tldraw-sync whiteboard-snapshot --binding /private/binding.json --json`,
  'whiteboard-publish': `Usage: tldraw-sync whiteboard-publish --binding <file>
    [--layer canvas] --file <diagram.json> --json

Lays out the semantic diagram in --file, as cleanup-compose does, and publishes it as the
whole Agent canvas of the bound board, replacing what was there. The diagram names the
snapshot's "session", "snapshot" and "base_revision". A new reading of the sketch is accepted
only from a snapshot of the sketch as it is now. A publish that changes only agent-origin
items is accepted after the sketch has moved on, and keeps the drawings the canvas holds.

Keep the file where the snapshot put it: a "drawing" is sized from the sketch.json beside it,
and the board copies the strokes it names from the sketch itself. An empty diagram publishes
an empty canvas. See tldraw-sync cleanup-compose --help for the schema.

Output:
  --json   {"status": "success", "code": "published", "session", "layer", "revision"}

Failure codes:
  invalid_diagram    exit 1: the message names the field, stroke or file; fix the diagram
  invalid_proposal   exit 1: the board refused the composed diagram; the message says why
  sketch_changed     exit 5: the sketch changed; take a new snapshot
  revision_conflict  exit 5: the canvas changed; take a new snapshot
  session_mismatch   exit 5: the diagram names another board

Example:
  tldraw-sync whiteboard-publish --binding /private/binding.json --file diagram.json --json`,
  start: `Usage: tldraw-sync start [--port <n>] [--no-open] [--json | --quiet]

Starts the board in the background and returns once it is serving. If a board is already
running, it reports that one instead, so running start twice is safe.

The board takes port ${port_default} when it is free, and any free port otherwise. The QR code
always carries the port in use, and the board is saved in the same place whatever the port.

Start also opens the Mac page in the default browser, unless one is already open. That page
presents the drawing, shows the QR code until the iPad connects, and renders the image that
fetch returns.

Options:
  --port <n>  Use exactly this port, and fail if it is taken
  --no-open   Do not open the Mac page

Output:
  default  the QR code (in a terminal) and the addresses
  --quiet  the iPad address
  --json   {"status": "success", "code": "started" | "already_running", "pid", "port",
            "draw_url", "stage_url", "stage_opened", "log_file"}

Failure codes:
  not_installed   dependencies are missing; next_action says how to install them
  build_failed    the client did not build
  port_busy       --port was given and that port is taken
  start_failed    the board exited while starting; see "log_file"
  storage_damaged the saved board cannot be read; nothing was overwritten

Examples:
  tldraw-sync start
  tldraw-sync start --json
  tldraw-sync start --port 8080`,

  fetch: `Usage: tldraw-sync fetch [--session <id>] [--out <file>] [--no-open]
                         [--json | --quiet]

Saves the current drawing as a PNG and prints where. The image always shows the drawing as it
is now: if it has just changed, fetch waits for the new image rather than return an old one.

The Mac page renders the image. If the drawing has changed and that page is not open, fetch
opens it in the default browser and waits for it.

Options:
${session_option_text}
  --out <file>  Where to save the PNG (default: tldraw-sync/drawing.png in the system's
                temporary folder; tldraw-sync/sessions/<id>/drawing.png for another board)
  --no-open     Fail with "stage_closed" instead of opening the Mac page

Output:
  default  a sentence with the path
  --quiet  the path
  --json   {"status": "success", "code": "image_saved", "path", "session", "document_hash",
            "bytes_count"}

Reading the drawing:
  It is a hand-drawn whiteboard: boxes, arrows, handwriting, sometimes a picture. It is often a
  system design, but not always: read what is there. Open the PNG with your image tool and use
  it as context for what the user is asking. If they asked nothing specific, say what is on the
  board and what looks unresolved.

  "document_hash" changes whenever the drawing changes. The same hash as last time means you
  have already seen this drawing.

Failure codes:
  not_running      exit 2: run \`tldraw-sync start\`
  unknown_session  exit 1: no board has that id; run \`tldraw-sync session-list\`
  board_empty      exit 3: nothing has been drawn; ask the user to draw on the iPad
  stage_closed     exit 4: the Mac page is not open and --no-open was given
  image_not_ready  exit 4: the Mac page did not render in time; fetch again

Examples:
  tldraw-sync fetch --json
  tldraw-sync fetch --out ./whiteboard.png`,

  status: `Usage: tldraw-sync status [--session <id>] [--json | --quiet]

Reports whether the board is running, where, and what is connected to it.

Options:
${session_option_text}

Output:
  default  the addresses, whether the iPad and the Mac page are connected, the shape count
  --quiet  the iPad address
  --json   {"status": "success", "code": "running", "pid", "port", "session",
            "session_name", "draw_url", "stage_url", "pen_connected", "stage_connected",
            "shapes_count", "document_hash", "cleaned_revision", "cleaned_stale"}

Failure codes:
  not_running     exit 2: run \`tldraw-sync start\`
  not_responding  exit 1: a board process exists but does not answer

Examples:
  tldraw-sync status
  tldraw-sync status --json`,

  stop: `Usage: tldraw-sync stop [--json]

Saves the board and stops it. Stopping a board that is not running succeeds, so it is safe to
run twice. The drawing is kept: the next start shows it again.

Output:
  --json  {"status": "success", "code": "stopped" | "already_stopped"}

Failure codes:
  not_responding  a board process exists but does not answer; it was not stopped
  stop_timeout    the board did not exit in time

Examples:
  tldraw-sync stop`,

  serve: `Usage: tldraw-sync serve [--port <n>] [--json]

Runs the board in this terminal until Ctrl-C, printing its log. This is what start runs in the
background; use it to watch the board while working on it.

Options:
  --port <n>  Use exactly this port, and fail if it is taken`,

  'cleanup-snapshot': `Usage: tldraw-sync cleanup-snapshot [--session <id>] [--out <dir>]
                                    [--no-open] [--json]

Saves a coherent snapshot of the sketch for cleanup: the PNG and the original pen records of
the same drawing, a summary of each stroke (its id and page bounds, without the pen samples),
a snapshot token, the cleaned revision it builds on, and the semantic diagram behind that
revision when there is one, so its ids can be reused. It prints the instructions for the
agent doing the cleanup. No model is called: you, the agent, read the sketch and write what it
means as a semantic diagram; cleanup-publish lays it out and publishes it.

Read the sketch best effort, without asking the user to clarify: copy every word exactly,
keep every arrowhead, and invent nothing. The tool chooses every position and style.

Clean up each part of the sketch in its own way. A diagram and writing are typeset. A picture
(scenery, people, objects, a doodle, anything that is neither a diagram nor writing) is kept
as a "drawing": a node that lists the ids of its pen strokes, which the tool copies unchanged,
at the size and in the arrangement they were drawn. Never redraw a picture as boxes, ovals or
words, and never stand in for one with a symbol.

The snapshot names its board in "session", and the diagram must carry it: a board refuses a
diagram made from another board's snapshot. While the board has no name, "title_wanted" is
true and the prompt asks for a short "title"; an accepted publish names the board with it,
unless someone named the board first.

Options:
${session_option_text}
  --out <dir>  Where to save the files (default: tldraw-sync/cleanup in the system's
               temporary folder; tldraw-sync/sessions/<id>/cleanup for another board)
  --no-open    Fail with "stage_closed" instead of opening the Mac page

Output:
  --json   {"status": "success", "code": "snapshot_saved", "session", "title_wanted",
            "path", "records_path",
            "strokes_path", "strokes_truncated", "diagram_path", "previous_diagram_path",
            "proposal_path", "snapshot", "document_hash", "base_revision", "shapes_count",
            "bounds", "image", "mapping", "prompt", "publish_command"}

Failure codes:
  not_running      exit 2: run \`tldraw-sync start\`
  board_empty      exit 3: nothing has been drawn
  stage_closed     exit 4: the Mac page is not open and --no-open was given
  image_not_ready  exit 4: the Mac page did not render in time; try again
  sketch_busy      exit 4: the sketch kept changing; try again

Example:
  tldraw-sync cleanup-snapshot --json`,

  'cleanup-compose': `Usage: tldraw-sync cleanup-compose --file <diagram.json | -> [--out <file>]
                                    [--json]

Lays out a semantic diagram in the house style and saves the result as a styled shape proposal
(tldraw-sync.cleanup.v2, "style": "markerboard": a precise layout in thin black ink on white,
with hand-drawn outlines, open arrows and handwritten labels, and no colour), without
publishing it and without a running board. Earlier revisions keep their own look. The layout is
deterministic: the same diagram, in any item order, gives the same result. Labels, kinds,
groups, endpoints and arrowheads are copied exactly; positions, sizes and connector routes are
the tool's. When every node says where it sat in the sketch ("at"), the layout keeps that
arrangement: what was beside, above or below what, typeset and closed up to an even gap.
Otherwise items are arranged by their connections alone. cleanup-publish runs the same
composition before it publishes.

A "drawing" node is not typeset. It keeps part of the sketch as the pen strokes it names and
takes the box of those strokes, never scaled. Their size is read from the sketch.json that
cleanup-snapshot saved beside the diagram file (for a diagram on stdin, the one in the board's
default snapshot folder), which must be of the same snapshot. The board copies the strokes
from the sketch when it publishes. A diagram with no nodes composes to an empty canvas.

Diagram (JSON, not code):
${diagram_schema_text}

Options:
  --out <file>  Where to save the composed proposal (default: tldraw-sync/cleanup/composed.json
                in the system's temporary folder)

Output:
  --json   {"status": "success", "code": "composed", "path", "snapshot", "base_revision",
            "shapes_count", "width_units", "height_units", "route_conflicts_count"}
  "route_conflicts_count" counts connectors or labels predicted to cross an item they do not
  join, which the layout could not avoid. 0 is the usual answer.

Failure codes:
  invalid_diagram     exit 1: the message names the field, stroke or file; fix the diagram
  composition_failed  exit 1: the layout failed its own checks; report the diagram
  diagram_too_large   exit 1: the diagram is over ${proposal_size_bytes_max} bytes
  diagram_unreadable  exit 1: the diagram is not a readable regular file or stdin

Example:
  tldraw-sync cleanup-compose --file /tmp/tldraw-sync/cleanup/diagram.json --json`,

  'cleanup-publish': `Usage: tldraw-sync cleanup-publish [--session <id>]
                                   --file <diagram.json | -> [--json]

Publishes a complete cleaned diagram, replacing the current one in one step. It is accepted
only if the sketch is unchanged since the snapshot and nobody published since; otherwise
nothing changes. The sketch itself is never modified.

It goes to the board --session names, or else to the board the diagram's "session" names, or
else to the default board. A board accepts only a diagram made from its own snapshot.

Options:
${session_option_text}

The file is read from a regular file, or from stdin with --file -. It may be at most
${proposal_size_bytes_max} bytes. Reading stops at the first byte past that, without waiting for
the end of the input.

A semantic diagram ("format": "tldraw-sync.diagram.v1") is laid out here first, exactly as
cleanup-compose does, and the styled result is published together with the diagram, which the
next snapshot offers back for its ids. See tldraw-sync cleanup-compose --help for the schema.

A "drawing" in the diagram is published as the person's own pen strokes: the board copies the
strokes it names from the sketch as it is now, and refuses a stroke the sketch does not have.
Keep the diagram file beside the snapshot's sketch.json, which sizes the drawing.

A shape proposal ("format": "tldraw-sync.cleanup.v1"), the older format with coordinates and
colours chosen by the agent, is still accepted from scripts written for it. New cleanups write a
semantic diagram: only a diagram is drawn in the house style and keeps the sketch's arrangement.
Composed proposals (tldraw-sync.cleanup.v2) from cleanup-compose are accepted as they are.

Output:
  --json   {"status": "success", "code": "published", "session", "revision", "shapes_count",
            "title_applied", "stage_url"}
  "title_applied" is true when the diagram's title named a board that had no name.

Failure codes:
  invalid_diagram     exit 1: the message names the field; fix the diagram
  composition_failed  exit 1: the layout failed its own checks; report the diagram
  invalid_proposal    exit 1: the message names the field; fix the proposal
  proposal_too_large  exit 1: the proposal is over the size limit
  proposal_unreadable exit 1: the proposal is not a readable regular file or stdin
  sketch_changed      exit 5: the sketch changed; take a new snapshot
  revision_conflict   exit 5: another cleanup was published; take a new snapshot
  session_mismatch    exit 5: the diagram came from another board; snapshot this one
  unknown_session     exit 1: no board has that id; run \`tldraw-sync session-list\`
  not_running         exit 2: run \`tldraw-sync start\`

Example:
  tldraw-sync cleanup-publish --file /tmp/tldraw-sync/cleanup/proposal.json --json`,

  'cleanup-restore': `Usage: tldraw-sync cleanup-restore [--session <id>] --base-revision <n>
                                   [--revision <n>] [--json]

Brings back an earlier cleaned diagram as a new revision. The board keeps a few earlier
revisions. --base-revision must be the current cleaned revision ("cleaned_revision" in
\`tldraw-sync status --json\`), so a restore can never overwrite a newer publish. Without
--revision, the most recent earlier revision is restored.

Options:
${session_option_text}

Output:
  --json   {"status": "success", "code": "restored", "session", "revision", "restored_from"}

Failure codes:
  revision_conflict   exit 5: the cleaned diagram changed; read status and decide again
  nothing_to_restore  exit 1: that revision is not kept

Example:
  tldraw-sync cleanup-restore --base-revision 3 --json`,

  'session-list': `Usage: tldraw-sync session-list [--json | --quiet]

Lists every board, oldest first. The default board, id "default", is the board from before
there were several, at the addresses it always had. A board nobody has named is untitled; the
first cleanup of it may name it.

Output:
  default  one line per board: its id and name
  --quiet  the ids, one per line
  --json   {"status": "success", "code": "sessions", "sessions": [{"id", "name", "named_by",
            "created_at_ms", "stage_url"}]}
  "name" is null for an untitled board. "named_by" is "person", "agent" or null.

Example:
  tldraw-sync session-list --json`,

  'session-create': `Usage: tldraw-sync session-create [--name <name>] [--json | --quiet]

Makes a new, empty board and prints its id and address. Open the address in a browser to
present it; its own QR code leads the iPad to it. Without --name it is untitled until a
person names it, or its first cleanup does.

Options:
  --name <name>  Plain text on one line, at most ${board_name_length_max} characters

Output:
  --quiet  the new id
  --json   {"status": "success", "code": "session_created", "session", "stage_url"}

Failure codes:
  sessions_full  exit 1: the board holds as many boards as it can

Example:
  tldraw-sync session-create --name "Checkout flow" --json`,

  'session-rename': `Usage: tldraw-sync session-rename --session <id> --name <name> [--json]

Renames a board. A rename always wins: a later cleanup never replaces a name a person gave.

Output:
  --json   {"status": "success", "code": "session_renamed", "session"}

Failure codes:
  unknown_session  exit 1: no board has that id; run \`tldraw-sync session-list\`

Example:
  tldraw-sync session-rename --session 0123456789abcdef --name "Checkout flow" --json`,
}
