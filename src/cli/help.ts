// The help is the documentation, for people and for agents alike. It is layered: the top level
// says what the board is and how to get the drawing; each command's help has the detail.

import {
  board_name_length_max,
  port_default,
  proposal_size_bytes_max,
  view_state_size_bytes_max,
} from '../shared/constants'
import { message_length_max, text_code_points_max, whiteboard_protocol } from '../shared/whiteboard'
import { scene_capabilities_format } from './scene_capabilities'
import { scene_schema_text } from './scene_prompt'

export const commands = [
  'start',
  'fetch',
  'status',
  'stop',
  'serve',
  'cleanup-restore',
  'session-list',
  'session-create',
  'session-rename',
  'whiteboard-link', 'whiteboard-poll', 'whiteboard-ack',
  'whiteboard-snapshot', 'whiteboard-preview', 'whiteboard-publish',
  'whiteboard-scene', 'whiteboard-edit',
] as const

// Every board command takes this; it is described once here and named in each command's help.
const session_option_text =
  '  --session <id>  Work on this board (see session-list); without it, the oldest remaining board'
export type Command = (typeof commands)[number]

const protocol = String(whiteboard_protocol)
const state_bytes = String(view_state_size_bytes_max)

export const help_top = `tldraw-sync: draw on an iPad, see it on the Mac, let agents fetch it.

Usage: tldraw-sync <command> [options]

Commands:
  start    Start the board in the background, or show the one already running
  fetch    Save the current drawing as a PNG and print its path
  status   Show whether the board is running, its addresses and what is connected
  stop     Stop the board
  serve    Run the board in this terminal instead of the background

Linked whiteboards (one board per pih session; credentials stay in the private binding file.
The person sends their sketch with an optional note; the agent answers in the conversation or
draws a freeform scene on the board's Agent canvas):
  whiteboard-link      Start or reopen a bound board and its pairing stage
  whiteboard-poll      Read outstanding durable requests
  whiteboard-ack       Mark a request received, working, updated or failed
  whiteboard-snapshot  Read a coherent sketch, the scene on the Agent canvas and its format
  whiteboard-preview   Render a draft scene exactly as it would be published; publish nothing
  whiteboard-publish   Publish a scene as the entire Agent canvas
  whiteboard-scene     Read a native board's shared scene, each record with its hash
  whiteboard-edit      Change a native board's shared scene in one step the iPad can undo

Boards (each is a separate board, listed in the side rail and opened by its own address):
  session-list    List the boards, their ids, names and addresses
  session-create  Make a new, empty board
  session-rename  Rename a board

History:
  cleanup-restore  Bring back an earlier revision of a board's Agent canvas

Options:
  --json       Print one JSON object on stdout (every command)
  --quiet, -q  Print one bare value on stdout, for piping
  --help, -h   Show help for a command
  --version    Show the version
  --session    The board a board command works on (default: the oldest remaining board)

For agents:
  The user sketches on an iPad while talking to you. When they mention their drawing,
  sketch, diagram or board, run

    tldraw-sync fetch --json

  and read the PNG at "path" with your image tool. The drawing is context for whatever they
  are asking. If the command fails, do what "next_action" says. More: tldraw-sync fetch --help

  Drawing back onto a board needs a linked board. Your host links it and hands you its
  requests; then run tldraw-sync whiteboard-snapshot --help for the scene format.

  The user may keep several boards. When they name one, find its id with
  tldraw-sync session-list --json and add --session <id> to each command. Without it, every
  command works on the oldest remaining board.

Exit codes:
  0  success
  1  usage error, or a failure the message explains
  2  the board is not running: run \`tldraw-sync start\`
  3  the board is empty: ask the user to draw on the iPad
  4  the image is not ready yet: run the command again
  5  a scene conflicts with a newer sketch or canvas: take a new snapshot

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

const help_snapshot = `Usage: tldraw-sync whiteboard-snapshot --binding <file>
    [--out <directory>] [--no-open] --json

Saves a coherent snapshot of the bound board in a new private folder under --out: the sketch
image (sketch.png), its pen records (sketch.json), a summary of each stroke (strokes.json), and
scene.json, a scene proposal ready to edit. scene.json holds what the Agent canvas shows now,
already tied to this snapshot: its "session", "snapshot" and "base_revision". A sketch with
nothing on it still has a snapshot: its image is a blank page and "shapes_count" is 0.

A request from the board's chat is a message in the person's words. When it carries the sketch
("include_sketch" absent or true), take this snapshot, read the sketch and decide what they
asked for; when it is words alone, answer them without a snapshot. If they are talking with
you, publish nothing. If they asked for something drawn, edit scene.json, look at it with
whiteboard-preview, then publish it with whiteboard-publish. Either way, end the request with
whiteboard-ack --state updated --message "<your answer>": that answer is what the chat shows.

Scene (JSON, not code):
${scene_schema_text}

Provenance: "snapshot" is the hash of the sketch you were shown. "agent_source_hash" is the
sketch the canvas was last made from, and each "sketch" element in scene.json says which
sketch its strokes were copied from. "canvas.legacy" is true when the canvas shows a revision
published in a retired format: it is shown and kept in the history, but has no scene to edit,
so scene.json starts empty.

Views: scene.json keeps the scene whole, with any "controls" its elements name, so it
publishes again as it is. "scene_controls" lists them and "states_count" counts the views
they choose between. capabilities.json, also given as "capabilities", lists the formats,
styles, controls and limits the board accepts, as data; its "format" is
"${scene_capabilities_format}".

Output:
  --json   {"status": "success", "code": "snapshot_saved", "session", "title_wanted",
            "image_path", "records_path", "strokes_path", "strokes_truncated", "scene_path",
            "capabilities_path", "snapshot", "base_revision", "agent_revision",
            "agent_history", "agent_source_hash", "canvas", "shapes_count", "bounds", "image",
            "mapping", "scene_controls", "states_count", "schema", "capabilities", "prompt",
            "preview_command", "publish_command"}

Failure codes:
  not_running      exit 2: the board daemon is not running
  stage_closed     exit 4: the Mac page is not open and could not be opened
  image_not_ready  exit 4: the Mac page did not render in time; try again
  sketch_busy      exit 4: the sketch kept changing; try again

Example:
  tldraw-sync whiteboard-snapshot --binding /private/binding.json --json`

const help_preview = `Usage: tldraw-sync whiteboard-preview --binding <file> --file <scene.json>
    [--state <json>] [--out <image.png>] [--no-open] --json

Renders the scene in --file exactly as whiteboard-publish would publish it, and saves the
picture. Nothing is published: the Agent canvas, its revision and the sketch stay as they are,
and nothing appears on the board. The board checks the draft as it checks a publish, so a
draft that would be refused is refused here, for the same reason. "records_hash" names the
records that were drawn; publishing the same file while nothing has changed returns the same
hash.

The Mac stage draws the picture, in the browser, with the same code that shows the canvas. It
is opened if it is not, unless --no-open is given.

Options:
  --state <json>  Draw one view of a scene with controls: a JSON object of control ids and
                  values, at most ${state_bytes} bytes. A control left out keeps its value at
                  rest. Without it, the view at rest is drawn: the one a publish saves.

Output:
  --json   {"status": "success", "code": "preview_saved", "session", "image_path",
            "records_hash", "shapes_count", "base_revision", "snapshot", "view", "state",
            "states_count", "image", "published": false}
  "view" is "selected" with --state and "rest" without. "state" is the value of every
  control in the view drawn, and "base_revision" the canvas revision the draft builds on.

Failure codes:
  invalid_state      exit 1: the message names the control or value; fix --state
  invalid_scene      exit 1: the message names the field; fix the scene
  scene_too_large    exit 1: the scene is over ${proposal_size_bytes_max} bytes
  scene_unreadable   exit 1: the scene is not a readable regular file
  sketch_changed     exit 5: the sketch changed; take a new snapshot
  revision_conflict  exit 5: the canvas changed; take a new snapshot
  session_mismatch   exit 5: the scene names another board
  stage_closed       exit 4: the Mac page is not open and could not be opened
  preview_not_ready  exit 4: the Mac page did not draw the draft in time; try again

Examples:
  tldraw-sync whiteboard-preview --binding /private/binding.json --file scene.json --json
  tldraw-sync whiteboard-preview --binding /private/binding.json --file scene.json \\
    --state '{"<control id>":"<value>"}' --json`

const help_publish = `Usage: tldraw-sync whiteboard-publish --binding <file> --file <scene.json>
    --json

Publishes the scene in --file as the whole Agent canvas of the bound board, replacing what was
there in one step. It is accepted only if nobody published since the snapshot it names. A
scene with "basis": "sketch" is also accepted only while the sketch is unchanged since that
snapshot; a scene with "basis": "canvas" changes the canvas alone and is accepted after the
sketch has moved on. Otherwise nothing changes. The sketch itself is never modified.

A "sketch" element is published as the person's own pen strokes. With "basis": "sketch" the
board copies the strokes it names from the sketch as it is now, and refuses a stroke the
sketch does not have. With "basis": "canvas" it keeps the strokes the same element already
holds on the canvas. An empty "elements" list publishes an empty canvas. A scene with
"controls" is published whole; a page that does not choose a view shows the view at rest.

The file may be at most ${proposal_size_bytes_max} bytes. See tldraw-sync whiteboard-snapshot --help
for the scene format.

Output:
  --json   {"status": "success", "code": "published", "session", "revision", "shapes_count",
            "records_hash", "title_applied"}
  "title_applied" is true when the scene's title named a board that had no name.

Failure codes:
  invalid_scene      exit 1: the message names the field or stroke; fix the scene
  scene_too_large    exit 1: the scene is over the size limit
  scene_unreadable   exit 1: the scene is not a readable regular file
  sketch_changed     exit 5: the sketch changed; take a new snapshot
  revision_conflict  exit 5: the canvas changed; take a new snapshot
  session_mismatch   exit 5: the scene names another board

Example:
  tldraw-sync whiteboard-publish --binding /private/binding.json --file scene.json --json`

const help_scene = `Usage: tldraw-sync whiteboard-scene --binding <file> [--out <file>] --json

Reads the shared scene of a native board: every page, shape and binding as tldraw records,
the sha-256 "hashes" of each record's bytes, and "base_sequence", the board's revision count.
An edit names both, so it lands only on what was read. The file is private to this Mac.

Output:
  --json  {"status": "success", "code": "scene_read", "session", "base_sequence",
           "records_count", "scene_path"}

Failure codes:
  not_native  the board has an Agent canvas: use whiteboard-snapshot and whiteboard-publish`

const help_edit = `Usage: tldraw-sync whiteboard-edit --binding <file> --file <edit.json> --json

Applies one edit to a native board's shared scene, whole or not at all, saved before it is
acknowledged. The person sees it at once and can take it back with one Undo on the iPad.
Any record may be changed, the person's own strokes included; keep each record's type and id.
Nothing is laid out, recoloured or restacked: records land exactly as written.

The edit file:
  {"base_sequence": n,                     from whiteboard-scene
   "adds": [record, …],                    new shapes or bindings, id "shape:new-<key>" or
                                           "binding:new-<key>"; others in the edit may name them
   "updates": [{"record": record, "base_hash": hash}, …]   whole records, as read, changed
   "deletes": [{"id": id, "base_hash": hash}, …],          with every child and binding
   "request_id": "…"}                      optional: 8 to 64 of A-Z a-z 0-9 - _

Without a request_id the file's bytes name the request, so running the same file again is a
retry: the board answers with the revision it already made. A different edit needs a fresh
scene read; an edit of records changed since is refused, and nothing is written.

Output:
  --json  {"status": "success", "code": "edit_written" | "edit_replayed" | "edit_unchanged",
           "sequence", "minted": [{"placeholder", "id"}, …], "request_id"}

Failure codes:
  conflict           exit 5: records changed since they were read; read the scene again
  diverged           exit 5: the scene changed while writing; read the scene again
  replay_expired     exit 5: the request may have run and is too old to check; read again
  request_id_reused  exit 1: that request id named a different edit
  invalid_request    exit 1: the edit does not parse; "message" says where
  invalid_records    exit 1: a record does not fit the tldraw schema
  not_native         exit 1: the board has an Agent canvas

Example:
  tldraw-sync whiteboard-edit --binding /private/binding.json --file tidy.json --json`

export const help_commands: Record<Command, string> = {
  'whiteboard-link': `Usage: tldraw-sync whiteboard-link --protocol ${protocol}
    --owner <id> --out <absolute-file> [--native] --json

Starts the board if need be, links one board to the owner and saves its private binding file.
Linking again with the same owner and file returns the same board.

--native makes a new native board: one shared scene that the person and the agent both edit,
with whiteboard-scene and whiteboard-edit instead of the Agent canvas. An owner whose board
has an Agent canvas keeps it; --native then fails with not_native.`,
  'whiteboard-scene': help_scene,
  'whiteboard-edit': help_edit,
  'whiteboard-poll': `Usage: tldraw-sync whiteboard-poll --protocol ${protocol}
    --binding <file> --json

Lists the requests still waiting. Each is a "sketch_notify" from the board's chat, with the
person's words in "text" when they wrote some. "include_sketch" says what went with them:
  absent  the sketch as it was, named by "sketch_hash" (an earlier pad; the words are optional)
  true    the same: take a snapshot to see the sketch
  false   words alone: take no snapshot; "text" is never empty, and "sketch_hash" is only the
          board's sketch at that moment, for the record
A request publishes nothing by itself.

Example:
  {"events": [{"id": "…", "kind": "sketch_notify", "include_sketch": false,
               "text": "Say the gateway times out instead", "state": "queued", …}]}`,
  'whiteboard-ack': `Usage: tldraw-sync whiteboard-ack --binding <file> --event <id>
    --state <received|working|updated|failed> [--message <text>] --json

Moves a request on. received and working take an optional status line of up to
${message_length_max} characters. updated and failed end the request: their --message is the answer
shown to the person in the board's chat, in plain words, 1 to ${text_code_points_max} characters
(16 KiB). Say what you did or why it failed; say so when you drew on the Agent canvas. A
status line is never the answer. Repeating an acknowledgement changes nothing.

Example:
  tldraw-sync whiteboard-ack --binding /private/binding.json --event <id> --state updated \\
    --message "The lower path loses fewer orders. I drew both on the Agent canvas." --json`,
  'whiteboard-snapshot': help_snapshot,
  'whiteboard-preview': help_preview,
  'whiteboard-publish': help_publish,
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
            "shapes_count", "document_hash", "linked", "protocol", "agent_revision",
            "cleaned_revision", "cleaned_stale"}
  "agent_revision" and "cleaned_revision" are both the revision of the Agent canvas.

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

  'cleanup-restore': `Usage: tldraw-sync cleanup-restore [--session <id>] --base-revision <n>
                                   [--revision <n>] [--json]

Brings back an earlier revision of a board's Agent canvas as a new revision. The board keeps a
few earlier revisions, whatever format they were published in: one from before scenes is shown
exactly as it was. --base-revision must be the current revision ("agent_revision" in
\`tldraw-sync status --json\`), so a restore can never overwrite a newer publish. Without
--revision, the most recent earlier revision is restored.

Options:
${session_option_text}

Output:
  --json   {"status": "success", "code": "restored", "session", "revision", "restored_from"}

Failure codes:
  revision_conflict   exit 5: the canvas changed; read status and decide again
  nothing_to_restore  exit 1: that revision is not kept

Example:
  tldraw-sync cleanup-restore --base-revision 3 --json`,

  'session-list': `Usage: tldraw-sync session-list [--json | --quiet]

Lists every board, oldest first. The first one opens at / and /draw. The id "default" names
only the original board. Deleting a board retires its id; deleting the last leaves an empty
list. A board nobody has named is untitled; the first scene on a linked board may name it.

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
person names it.

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

Renames a board. A rename always wins: a later publish never replaces a name a person gave.

Output:
  --json   {"status": "success", "code": "session_renamed", "session"}

Failure codes:
  unknown_session  exit 1: no board has that id; run \`tldraw-sync session-list\`

Example:
  tldraw-sync session-rename --session 0123456789abcdef --name "Checkout flow" --json`,
}
