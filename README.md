# tldraw-sync

A personal drawing board for studying system design. Draw on an iPad with an Apple Pencil,
present the whole drawing on a Mac, and let any AI agent fetch the latest drawing as an image.

Everything runs on the Mac, over the local network. There is no cloud service and no model
call anywhere in the app.

## Install

Needs [Bun](https://bun.sh).

```bash
git clone https://github.com/bout3fiddy/tldraw-sync.git
cd tldraw-sync
bun install
bun link
```

`bun link` puts the `tldraw-sync` command in `~/.bun/bin`, so it runs from any folder. Bun's
installer already adds that folder to your PATH. If `tldraw-sync` is not found, add this line
to `~/.zshrc` and open a new terminal:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

To update later, `git pull` in the clone. The next `tldraw-sync start` rebuilds what changed.

## Use

```bash
tldraw-sync start     # start the board in the background and show the QR code
tldraw-sync fetch     # save the current drawing as a PNG and print its path
tldraw-sync status    # what is running and what is connected
tldraw-sync stop      # save and stop
```

- **iPad.** Point the camera at the QR code. The board opens ready to draw. Add it to the Home
  Screen once and it becomes a one-tap, full-screen app.
- **Mac.** `start` opens the presentation page, which shows the whole drawing fitted to the
  window, and the QR code until an iPad connects.
- **Agents.** `tldraw-sync fetch --json`, then read the PNG at `path`.

`tldraw-sync --help` and `tldraw-sync <command> --help` have the detail.

## Agents

The command line is the whole agent interface: no skill files, no MCP server. Its help is
written for agents and goes one level deeper at a time: the top level says what the board is
and how to get the drawing, each command's help has its options, output and failure codes.

To let an agent in any folder find it, add one line to your global agent instructions, such as
`~/.claude/CLAUDE.md` for Claude Code or `~/.codex/AGENTS.md` for Codex:

```
When I mention my drawing, sketch or board, run `tldraw-sync --help` and follow it.
```

Every command takes `--json` and prints exactly one JSON object:

```json
{"status": "success", "code": "image_saved", "path": "/…/drawing.png", "document_hash": "…"}
{"status": "failure", "code": "board_empty", "message": "The board is empty.",
 "next_action": {"action": "ask_human", "message": "Draw something on the iPad, then ask again."},
 "exit_code": 3}
```

A failure always says what to do next: `run` a command, `retry`, `ask_human`, or `fix_usage`.
The exit codes are 0 success, 1 usage or other failure, 2 not running, 3 board empty, 4 image
not ready. `document_hash` changes whenever the drawing does, so an agent can tell whether it
has already seen it.

## The three surfaces

### iPad: the workspace

A canvas and one tool strip: pen, eraser, four inks, undo, redo, clear. Only the Pencil
draws, so a resting palm never leaves a mark; two fingers pan and zoom. Clearing takes two
taps and can be undone.

### Mac: the stage

The whole drawing, always. It does not follow the iPad's zoom, so someone watching a call
keeps seeing the full picture while you work on a detail. Until an iPad connects, it shows
the QR code.

The stage also renders the image agents fetch, so it is built to keep rendering while its
window is covered or minimised. If it is closed when the drawing changes, `fetch` opens it.

### Agent: the fetch

`fetch` never returns an out-of-date image. The image is rendered a moment after the pen
rests, so a fetch is normally an instant read; if the drawing has just changed, it waits for
the new image. Over HTTP, the same is `GET /api/drawing.png` on the board's port.

## How it works

One Bun process serves the built client, runs the tldraw sync room, saves the board, and
serves the image. `start` runs it in the background; `serve` runs it in the terminal.

```
src/
  cli/          the tldraw-sync command: help, output, starting and finding the board
  shared/       constants, assertions, the document hash, the clock interface
  server/       board (the state machine), storage, HTTP edge, QR pairing, process lock
  client/       draw page, stage page, tool strip, image uploader
  simulation/   deterministic simulator: virtual clock, faulty disk, simulated devices
```

**Port.** The board takes port 7357 when it is free and any free port otherwise. The QR code
always carries the port in use. While it runs, `data/server.json` names its process and port;
that is how the command finds it, and it keeps a second board off the same data.

**Freshness by content.** The stage uploads each image with a hash of the records it
rendered. The server serves an image only while that hash equals the hash of its own
document. Correctness does not depend on clocks or message order.

**Durability.** The board is saved one second after the pen rests, and at most five seconds
after the first unsaved change, and on stop. Files are checksummed and replaced atomically. A
damaged board file stops the server with a message; it is never silently replaced by an empty
board.

**Restarts.** On every start the sync clock jumps forward and is saved before any device
connects, so a device that remembers a lost timeline reloads the document in full.

**Hidden stage.** Browsers run no animation frames for a hidden page, and tldraw applies
incoming strokes on animation frames. While the stage is hidden, its frames come from a timer,
so the image stays current.

## Tests

```bash
bun test              # everything, a few seconds
bun run typecheck
bun run simulate      # 1000 more simulation seeds; args: [first seed] [count]
```

The simulator runs the production board and uploader against real tldraw sync clients, on a
virtual clock, with a seeded network and disk. It injects devices dropping off, the server
crashing, and the server crashing in the middle of a save, then checks four properties:

- **Fidelity.** A fetch never returns an image of anything but the current document.
- **Durability.** A restart restores exactly the last board written, and no change stays
  unsaved past the limit.
- **Convergence.** Once faults stop, every device and the disk hold the same document.
- **Liveness.** Once faults stop, a fetch succeeds.

A failing run prints its seed. Replay it exactly with `SEED=<seed> bun test simulation`, and
add `TRACE=1` to print every event.

The command line is tested the way an agent uses it: separate processes, JSON out, exit codes,
each test on a data directory of its own.

## Style

The code follows [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md),
adapted to TypeScript. `src/tiger_style.test.ts` enforces the mechanical parts: 100-column
lines, 70-line functions, snake_case file names, and an average of two assertions per function
in the server and shared code. Every limit is a named constant in `src/shared/constants.ts`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BOARD_DATA_DIR` | `data/` in the clone | Where the board, its image and its log are kept |

## Limits

- The board is one shared canvas on the local network, with no accounts and no password.
  Anyone on the same network can open it. Do not run it on a network you do not trust.
- The board holds pen strokes. Pasted images are not supported.
- `start` and `fetch` open the stage with `open` on macOS and `xdg-open` on Linux.
- tldraw's licence allows unlicensed use over plain HTTP, which is how this runs. Serving it
  over HTTPS on a public host would need a licence key.
