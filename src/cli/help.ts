// The help is the documentation, for people and for agents alike. It is layered: the top level
// says what the board is and how to get the drawing; each command's help has the detail.

import { port_default } from '../shared/constants'
import { proposal_size_bytes_max } from '../shared/constants'
import { diagram_schema_text, proposal_schema_text, proposal_subset_text } from './cleanup_prompt'

export const commands = [
  'start', 'fetch', 'status', 'stop', 'serve', 'cleanup-snapshot', 'cleanup-compose',
  'cleanup-publish', 'cleanup-restore',
] as const
export type Command = (typeof commands)[number]

export const help_top = `tldraw-sync: draw on an iPad, see it on the Mac, let agents fetch it.

Usage: tldraw-sync <command> [options]

Commands:
  start    Start the board in the background, or show the one already running
  fetch    Save the current drawing as a PNG and print its path
  status   Show whether the board is running, its addresses and what is connected
  stop     Stop the board
  serve    Run the board in this terminal instead of the background

Cleanup (an external agent reads the sketch; the tool typesets it on a separate Cleaned canvas):
  cleanup-snapshot  Save the sketch image, stroke summaries and instructions for the agent
  cleanup-compose   Lay out a semantic diagram locally, without publishing it
  cleanup-publish   Lay out and publish a semantic diagram as the new cleaned diagram
  cleanup-restore   Bring back an earlier cleaned diagram

Options:
  --json       Print one JSON object on stdout (every command)
  --quiet, -q  Print one bare value on stdout, for piping
  --help, -h   Show help for a command
  --version    Show the version

For agents:
  The user sketches on an iPad while talking to you. When they mention their drawing,
  sketch, diagram or board, run

    tldraw-sync fetch --json

  and read the PNG at "path" with your image tool. The drawing is context for whatever they
  are asking. If the command fails, do what "next_action" says. More: tldraw-sync fetch --help

  When they ask you to clean up, tidy or redraw the sketch, run

    tldraw-sync cleanup-snapshot --json

  and follow its "prompt". More: tldraw-sync cleanup-snapshot --help

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

  fetch: `Usage: tldraw-sync fetch [--out <file>] [--no-open] [--json | --quiet]

Saves the current drawing as a PNG and prints where. The image always shows the drawing as it
is now: if it has just changed, fetch waits for the new image rather than return an old one.

The Mac page renders the image. If the drawing has changed and that page is not open, fetch
opens it in the default browser and waits for it.

Options:
  --out <file>  Where to save the PNG (default: tldraw-sync/drawing.png in the system's
                temporary folder)
  --no-open     Fail with "stage_closed" instead of opening the Mac page

Output:
  default  a sentence with the path
  --quiet  the path
  --json   {"status": "success", "code": "image_saved", "path", "document_hash",
            "bytes_count"}

Reading the drawing:
  It is a hand-drawn whiteboard: boxes, arrows, handwriting, often a system design. Open the
  PNG with your image tool and use it as context for what the user is asking. If they asked
  nothing specific, say what is on the board and what looks unresolved.

  "document_hash" changes whenever the drawing changes. The same hash as last time means you
  have already seen this drawing.

Failure codes:
  not_running      exit 2: run \`tldraw-sync start\`
  board_empty      exit 3: nothing has been drawn; ask the user to draw on the iPad
  stage_closed     exit 4: the Mac page is not open and --no-open was given
  image_not_ready  exit 4: the Mac page did not render in time; fetch again

Examples:
  tldraw-sync fetch --json
  tldraw-sync fetch --out ./whiteboard.png`,

  status: `Usage: tldraw-sync status [--json | --quiet]

Reports whether the board is running, where, and what is connected to it.

Output:
  default  the addresses, whether the iPad and the Mac page are connected, the shape count
  --quiet  the iPad address
  --json   {"status": "success", "code": "running", "pid", "port", "draw_url", "stage_url",
            "pen_connected", "stage_connected", "shapes_count", "document_hash",
            "cleaned_revision", "cleaned_stale"}

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

  'cleanup-snapshot': `Usage: tldraw-sync cleanup-snapshot [--out <dir>] [--no-open] [--json]

Saves a coherent snapshot of the sketch for cleanup: the PNG and the original pen records of
the same drawing, a summary of each stroke (its id and page bounds, without the pen samples),
a snapshot token, the cleaned revision it builds on, and the semantic diagram behind that
revision when there is one, so its ids can be reused. It prints the instructions for the
agent doing the cleanup. No model is called: you, the agent, read the sketch and write what it
means as a semantic diagram; cleanup-publish lays it out and publishes it.

Read the sketch best effort, without asking the user to clarify: copy every word exactly,
keep every arrowhead, and invent nothing. The tool chooses every position and style.

Options:
  --out <dir>  Where to save the files (default: tldraw-sync/cleanup in the system's
               temporary folder)
  --no-open    Fail with "stage_closed" instead of opening the Mac page

Output:
  --json   {"status": "success", "code": "snapshot_saved", "path", "records_path",
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
(tldraw-sync.cleanup.v2), without publishing it and without a running board. The layout is
deterministic: the same diagram, in any item order, gives the same result. Labels, kinds,
groups, endpoints and arrowheads are copied exactly; positions, sizes and connector routes are
the tool's. cleanup-publish runs the same composition before it publishes.

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
  invalid_diagram     exit 1: the message names the field; fix the diagram
  composition_failed  exit 1: the layout failed its own checks; report the diagram
  diagram_too_large   exit 1: the diagram is over ${proposal_size_bytes_max} bytes
  diagram_unreadable  exit 1: the diagram is not a readable regular file or stdin

Example:
  tldraw-sync cleanup-compose --file /tmp/tldraw-sync/cleanup/diagram.json --json`,

  'cleanup-publish': `Usage: tldraw-sync cleanup-publish --file <diagram.json | -> [--json]

Publishes a complete cleaned diagram, replacing the current one in one step. It is accepted
only if the sketch is unchanged since the snapshot and nobody published since; otherwise
nothing changes. The sketch itself is never modified.

The file is read from a regular file, or from stdin with --file -. It may be at most
${proposal_size_bytes_max} bytes. Reading stops at the first byte past that, without waiting for
the end of the input.

A semantic diagram ("format": "tldraw-sync.diagram.v1") is laid out here first, exactly as
cleanup-compose does, and the styled result is published together with the diagram, which the
next snapshot offers back for its ids. See tldraw-sync cleanup-compose --help for the schema.

A shape proposal, the older format with coordinates chosen by the agent, is still accepted:
${proposal_schema_text}

${proposal_subset_text}
Composed proposals (tldraw-sync.cleanup.v2) from cleanup-compose are accepted as they are.

Output:
  --json   {"status": "success", "code": "published", "revision", "shapes_count", "stage_url"}

Failure codes:
  invalid_diagram     exit 1: the message names the field; fix the diagram
  composition_failed  exit 1: the layout failed its own checks; report the diagram
  invalid_proposal    exit 1: the message names the field; fix the proposal
  proposal_too_large  exit 1: the proposal is over the size limit
  proposal_unreadable exit 1: the proposal is not a readable regular file or stdin
  sketch_changed      exit 5: the sketch changed; take a new snapshot
  revision_conflict   exit 5: another cleanup was published; take a new snapshot
  not_running         exit 2: run \`tldraw-sync start\`

Example:
  tldraw-sync cleanup-publish --file /tmp/tldraw-sync/cleanup/proposal.json --json`,

  'cleanup-restore': `Usage: tldraw-sync cleanup-restore --base-revision <n> [--revision <n>]
                                   [--json]

Brings back an earlier cleaned diagram as a new revision. The board keeps a few earlier
revisions. --base-revision must be the current cleaned revision ("cleaned_revision" in
\`tldraw-sync status --json\`), so a restore can never overwrite a newer publish. Without
--revision, the most recent earlier revision is restored.

Output:
  --json   {"status": "success", "code": "restored", "revision", "restored_from"}

Failure codes:
  revision_conflict   exit 5: the cleaned diagram changed; read status and decide again
  nothing_to_restore  exit 1: that revision is not kept

Example:
  tldraw-sync cleanup-restore --base-revision 3 --json`,
}
