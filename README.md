# tldraw-sync

A personal drawing board for studying system design. Draw on an iPad with an Apple Pencil, present
the whole drawing on a Mac, and let any AI agent fetch the latest drawing as an image.

Everything runs on the Mac, over the local network. There is no cloud service and no model call
anywhere in the app.

## Install

Needs [Bun](https://bun.sh).

```bash
git clone https://github.com/bout3fiddy/tldraw-sync.git
cd tldraw-sync
bun install
bun link
```

`bun link` puts the `tldraw-sync` command in `~/.bun/bin`, so it runs from any folder. Bun's
installer already adds that folder to your PATH. If `tldraw-sync` is not found, add this line to
`~/.zshrc` and open a new terminal:

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

tldraw-sync cleanup-snapshot   # sketch PNG, records and tidy-only instructions for an agent
tldraw-sync cleanup-publish    # publish an agent's cleaned diagram to the Cleaned canvas
tldraw-sync cleanup-restore    # bring back an earlier cleaned diagram
```

- **iPad.** Point the camera at the QR code. The board opens ready to draw. Add it to the Home
  Screen once and it becomes a one-tap, full-screen app.
- **Mac.** `start` opens the presentation page, which shows the whole drawing fitted to the window,
  and the QR code until an iPad connects.
- **Agents.** `tldraw-sync fetch --json`, then read the PNG at `path`.

`tldraw-sync --help` and `tldraw-sync <command> --help` have the detail.

## Agents

The command line is the whole agent interface: no skill files, no MCP server. Its help is written
for agents and goes one level deeper at a time: the top level says what the board is and how to get
the drawing, each command's help has its options, output and failure codes.

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

A failure always says what to do next: `run` a command, `retry`, `ask_human`, or `fix_usage`. The
exit codes are 0 success, 1 usage or other failure, 2 not running, 3 board empty, 4 image not ready,
5 cleanup conflict. `document_hash` changes whenever the drawing does, so an agent can tell whether
it has already seen it.

## Cleanup: the Sketch and Cleaned canvases

The board has two canvases. **Sketch** is the human ink, drawn on the iPad. **Cleaned** is a tidy
diagram of it, made by an external agent: text, rectangles, ellipses and arrows bound between them,
as native tldraw shapes. Both pages have three tabs: Sketch, Cleaned, and Side by side. Each device
remembers its own choice.

The app never runs a model. The agent you already use reads a snapshot through the command line,
does the tidying itself, and publishes the result as a small JSON proposal. A proposal is data,
never code, and is checked completely before anything changes.

- **Ink is never touched.** The cleaned diagram is a separate document. Publishing or restoring it
  cannot change a stroke.
- **Coherent snapshots.** The PNG and the records in a snapshot are always the same drawing. The
  server hands out the records only for the document the image showed.
- **No lost or crossed updates.** A publish names the snapshot it was made from and the cleaned
  revision it replaces. If either has changed, it is refused with exit 5 and nothing changes. It is
  published whole or not at all: the new diagram is written to disk before it replaces the old one,
  so a failed write leaves the previous diagram in place.
- **Provenance and staleness.** The Cleaned tab shows the revision, the agent, the source sketch and
  the time. When the sketch changes afterwards it says so, and the Cleaned tab gets a red dot.
- **Undo.** The last 8 earlier revisions are kept. `cleanup-restore`, or Restore on the Cleaned tab,
  brings one back as a new revision. It names the current revision, so it can never overwrite a
  newer publish.
- **Persistence.** Both canvases survive restarts. Boards saved by earlier versions open unchanged,
  with no cleaned diagram yet.

The Cleaned canvas is read-only. Switching tabs never unmounts the sketch, so the Pencil, the iPad's
zoom and undo, and the stage's rendering of the fetched image carry on in every view. Side by side
stacks the two canvases on a screen held upright.

### A complete agent run

An agent asked to "clean up my sketch" runs:

```bash
tldraw-sync cleanup-snapshot --json
```

```json
{
  "status": "success",
  "code": "snapshot_saved",
  "path": "/tmp/tldraw-sync/cleanup/sketch.png",
  "records_path": "/tmp/tldraw-sync/cleanup/sketch.json",
  "proposal_path": "/tmp/tldraw-sync/cleanup/proposal.json",
  "snapshot": "5f0c1e9a2b7d4c36",
  "document_hash": "5f0c1e9a2b7d4c36",
  "base_revision": 0,
  "shapes_count": 14,
  "bounds": { "x": 112, "y": 80, "w": 940, "h": 520 },
  "image": { "width_px": 2008, "height_px": 1168 },
  "mapping": { "x0": 80, "y0": 48, "ppu": 2 },
  "prompt": "Tidy this hand-drawn sketch into a clean diagram. Tidy only. …",
  "publish_command": "tldraw-sync cleanup-publish --file …/proposal.json --json"
}
```

It reads the PNG and follows `prompt`, which is strict. Redraw exactly what is there, in place. Add,
remove, rename, reword and reinterpret nothing. Copy handwriting word for word, and write `?` for an
illegible word. Page coordinates follow from the image as `x = x0 + pixel_x / ppu`, and likewise for
y.

The prompt also tells the agent to check first that the whole sketch fits
[what a cleaned diagram can hold](#what-a-cleaned-diagram-can-hold). If any part does not, or a mark
is ambiguous, the agent stops and tells you which part, instead of publishing a diagram that drops
or changes it. In particular, a plain line is never turned into an arrow.

When everything fits, it writes `proposal.json`:

```json
{
  "format": "tldraw-sync.cleanup.v1",
  "snapshot": "5f0c1e9a2b7d4c36",
  "base_revision": 0,
  "agent": "claude-code",
  "summary": "Checkout: the API writes orders to the database.",
  "shapes": [
    { "kind": "text", "id": "title", "x": 120, "y": 80, "text": "Checkout", "size": "l" },
    { "kind": "rectangle", "id": "api", "x": 120, "y": 200, "w": 200, "h": 100, "text": "API" },
    {
      "kind": "ellipse",
      "id": "db",
      "x": 600,
      "y": 200,
      "w": 180,
      "h": 100,
      "text": "Orders DB",
      "color": "blue"
    },
    { "kind": "arrow", "id": "writes", "from": "api", "to": "db", "text": "writes" }
  ]
}
```

and publishes it:

```bash
tldraw-sync cleanup-publish --file /tmp/tldraw-sync/cleanup/proposal.json --json
```

```json
{
  "status": "success",
  "code": "published",
  "revision": 1,
  "shapes_count": 4,
  "stage_url": "http://localhost:7357"
}
```

If the sketch changed in the meantime, the answer is `sketch_changed`. If another cleanup was
published first, it is `revision_conflict`. Both exit 5, and `next_action` says to take a new
snapshot. An invalid proposal fails with `invalid_proposal` and the path of the first problem, such
as `shapes[3].to: An arrow binds to a text, rectangle or ellipse.`

The proposal is read from a regular file, or from stdin with `--file -`, and may be at most 512 KiB.
Reading stops at the first byte past the limit and fails with `proposal_too_large`, without waiting
for the end of the input, so an endless or growing input costs no more than the limit. A directory,
a pipe or a device given as the file fails with `proposal_unreadable`.

To undo, read `cleaned_revision` from `tldraw-sync status --json`, then:

```bash
tldraw-sync cleanup-restore --base-revision 1 --json   # the most recent earlier revision
```

### Proposal schema

- `format`: `"tldraw-sync.cleanup.v1"`.
- `snapshot` and `base_revision`: as printed by `cleanup-snapshot`.
- `agent` and `summary`: optional. A short name, and one line of at most 280 characters.
- `shapes`: 1 to 400 shapes, each with a unique `id` of 1 to 40 letters, digits, `_` or `-`.
  - `text`: `x`, `y`, `text`, and an optional `w`. Without `w`, the text sizes itself.
  - `rectangle` and `ellipse`: `x`, `y`, `w`, `h`, and an optional `text` label.
  - `arrow`: `from` and `to`, the ids of two different non-arrow shapes, and an optional `text`
    label. It points from `from` to `to`.
  - Every shape may set `color` (one of tldraw's colours, default black) and `size` (`s`, `m`, `l`
    or `xl`, default `m`).

Coordinates are page units, with `x`, `y` the top-left corner. Text is at most 2000 characters, and
`\n` breaks a line. Unknown fields are refused. `tldraw-sync cleanup-publish --help` has the exact
rules.

### What a cleaned diagram can hold

A cleaned diagram can hold only:

- words, as text or as the label of a box, a circle or an arrow
- boxes, as rectangles, and circles or ovals, as ellipses
- an arrow with exactly one arrowhead, joining two different boxes, circles or texts

It cannot hold anything else. That includes a plain line without an arrowhead, a line with
arrowheads at both ends, a line or arrow with a free end or to or from another arrow, an arrow from
a shape to itself, dashed or dotted strokes, freehand ink, other outlines (diamonds, triangles,
cylinders, clouds), tables, images, fills and rotation.

The board cannot see what the agent left out, so this rule is carried by the prompt and the help,
not enforced by the server: a sketch with anything outside the list is reported to you, not
published. Nothing is approximated, and nothing is silently dropped.

Over HTTP, the same flow is `GET /api/drawing.png`, then
`GET /api/sketch.json?document_hash=<hash>`, which answers 409 if the sketch moved on. Publish with
`POST /api/cleaned.json` and restore with `POST /api/cleaned/restore`, both as `application/json`.
Pages read `GET /api/cleaned/status` and `GET /api/cleaned.json`. The original
`GET /api/drawing.png` and `GET /api/drawing.json` answer exactly as before.

## The three surfaces

### iPad: the workspace

A canvas and one tool strip: pen, eraser, four inks, undo, redo, clear. Only the Pencil draws, so a
resting palm never leaves a mark; two fingers pan and zoom. Clearing takes two taps and can be
undone.

### Mac: the stage

The whole drawing, always. It does not follow the iPad's zoom, so someone watching a call keeps
seeing the full picture while you work on a detail. Until an iPad connects, it shows the QR code.

The stage also renders the image agents fetch, so it is built to keep rendering while its window is
covered or minimised. If it is closed when the drawing changes, `fetch` opens it.

### Agent: the fetch

`fetch` never returns an out-of-date image. The image is rendered a moment after the pen rests, so a
fetch is normally an instant read; if the drawing has just changed, it waits for the new image. Over
HTTP, the same is `GET /api/drawing.png` on the board's port.

## How it works

One Bun process serves the built client, runs the tldraw sync room, saves the board, and serves the
image. `start` runs it in the background; `serve` runs it in the terminal.

```
src/
  cli/          the tldraw-sync command: help, output, starting and finding the board, cleanup
  shared/       constants, assertions, the document hash, the clock interface, cleanup types
  server/       board (the state machine), storage, HTTP edge, QR pairing, process lock,
                cleanup proposals and the cleaned diagram
  client/       draw page, stage page, tool strip, image uploader, view tabs, cleaned canvas
  simulation/   deterministic simulator: virtual clock, faulty disk, simulated devices
tests/          browser journeys for Playwright
```

**Port.** The board takes port 7357 when it is free and any free port otherwise. The QR code always
carries the port in use. While it runs, `data/server.json` names its process and port; that is how
the command finds it, and it keeps a second board off the same data.

**Freshness by content.** The stage uploads each image with a hash of the records it rendered. The
server serves an image only while that hash equals the hash of its own document. Correctness does
not depend on clocks or message order.

**Durability.** The board is saved one second after the pen rests, and at most five seconds after
the first unsaved change, and on stop. Files are checksummed and replaced atomically. A damaged
board file stops the server with a message; it is never silently replaced by an empty board. The
cleaned diagram and its kept revisions live in `cleaned.state`. It is written on every publish or
restore, before the new state is served, and a damaged one stops the server the same way: that
covers a failed checksum, content that is not the expected JSON object, and a revision, current
diagram and history that do not agree. The page bounds of the latest image live in `drawing.frame`,
labelled with the image they belong to.

**Restarts.** On every start the sync clock jumps forward and is saved before any device connects,
so a device that remembers a lost timeline reloads the document in full.

**Hidden stage.** Browsers run no animation frames for a hidden page, and tldraw applies incoming
strokes on animation frames. While the stage is hidden, its frames come from a timer, so the image
stays current.

## Tests

```bash
bun test              # everything, a few seconds
bun run typecheck
bun run simulate      # 1000 more simulation seeds; args: [first seed] [count]
bun run build && npx playwright test   # the browser journey; needs Playwright and Chromium
```

The simulator runs the production board and uploader against real tldraw sync clients, on a virtual
clock, with a seeded network and disk. It injects devices dropping off, the server crashing, and the
server crashing in the middle of a save, then checks four properties:

- **Fidelity.** A fetch never returns an image of anything but the current document.
- **Durability.** A restart restores exactly the last board written, and no change stays unsaved
  past the limit.
- **Convergence.** Once faults stop, every device and the disk hold the same document.
- **Liveness.** Once faults stop, a fetch succeeds.

A failing run prints its seed. Replay it exactly with `SEED=<seed> bun test simulation`, and add
`TRACE=1` to print every event.

The command line is tested the way an agent uses it: separate processes, JSON out, exit codes, each
test on a data directory of its own.

The cleanup tests feed proposals mistakes and seeded random damage. They inject a crash in the
middle of a publish and check that the previous diagram survives, in memory and after a restart.
They cover both conflicts, restores and damaged files, and run a seeded sequence of all of these
against a model. Replay one with `SEED=<seed> bun test cleaned`.

`tests/cleanup.e2e.ts` is the browser journey. It draws on the draw page while the stage renders,
then snapshots and publishes through the command line and switches tabs. It draws side by side until
the cleanup is stale, and checks that a refused publish leaves the diagram in place. Finally it
restarts the board and restores from the page. Playwright is not a dependency of this repository, so
run it where it is installed. Specs are named `*.e2e.ts` because `bun test` also collects
`*.spec.ts`.

## Style

The code follows
[TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md), adapted to
TypeScript. `src/tiger_style.test.ts` enforces the mechanical parts: 100-column lines, 70-line
functions, snake_case file names, and an average of two assertions per function in the server and
shared code. Every limit is a named constant in `src/shared/constants.ts`.

## Configuration

| Variable         | Default              | Purpose                                         |
| ---------------- | -------------------- | ----------------------------------------------- |
| `BOARD_DATA_DIR` | `data/` in the clone | Where the board, its image and its log are kept |

## Limits

- The board is one shared canvas on the local network, with no accounts and no password. Anyone on
  the same network can open it. Do not run it on a network you do not trust.
- The board holds pen strokes. Pasted images are not supported.
- The Cleaned canvas is read-only: change it by publishing a new proposal or restoring. Cleanup
  covers text, rectangles, ellipses and one-headed arrows bound at both ends only. A sketch with
  anything else, such as a plain line, is reported by the agent instead of being cleaned.
- `start` and `fetch` open the stage with `open` on macOS and `xdg-open` on Linux.
- tldraw's licence allows unlicensed use over plain HTTP, which is how this runs. Serving it over
  HTTPS on a public host would need a licence key.
