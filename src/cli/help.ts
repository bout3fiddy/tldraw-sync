// The help is the documentation, for people and for agents alike. It is layered: the top level
// says what the board is and how to get the drawing; each command's help has the detail.

import { port_default } from '../shared/constants'

export const commands = ['start', 'fetch', 'status', 'stop', 'serve'] as const
export type Command = (typeof commands)[number]

export const help_top = `tldraw-sync: draw on an iPad, see it on the Mac, let agents fetch it.

Usage: tldraw-sync <command> [options]

Commands:
  start    Start the board in the background, or show the one already running
  fetch    Save the current drawing as a PNG and print its path
  status   Show whether the board is running, its addresses and what is connected
  stop     Stop the board
  serve    Run the board in this terminal instead of the background

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

Exit codes:
  0  success
  1  usage error, or a failure the message explains
  2  the board is not running: run \`tldraw-sync start\`
  3  the board is empty: ask the user to draw on the iPad
  4  the image is not ready yet: run \`tldraw-sync fetch\` again

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
            "pen_connected", "stage_connected", "shapes_count", "document_hash"}

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
}
