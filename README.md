# tldraw-sync

A personal drawing board for studying system design. Draw on an iPad with an Apple Pencil,
present the whole drawing on a Mac, and let any AI agent fetch the latest drawing as an image.

Everything runs on the Mac, over the local network. There is no cloud service and no model
call anywhere in the app.

## Start

```bash
bun install
bun start
```

`bun start` builds the client, starts the one server, and prints a QR code.

- **iPad.** Point the camera at the QR code. The board opens ready to draw. Add it to the Home
  Screen once and it becomes a one-tap, full-screen app.
- **Mac.** Open `http://localhost:5173`. It shows the whole drawing, fitted to the window.
- **Agent.** Fetch `http://localhost:5173/api/drawing.png`.

## The three surfaces

### iPad: the workspace

A canvas and one tool strip: pen, eraser, four inks, undo, redo, clear. Only the Pencil
draws, so a resting palm never leaves a mark; two fingers pan and zoom. Clearing takes two
taps and can be undone.

### Mac: the stage

The whole drawing, always. It does not follow the iPad's zoom, so someone watching a call
keeps seeing the full picture while you work on a detail. Until an iPad connects, it shows
the QR code.

The stage also renders the image agents fetch, so keep it open in a browser window.

### Agent: the fetch

| Endpoint | Returns |
|---|---|
| `GET /api/drawing.png` | The latest drawing as a PNG |
| `GET /api/drawing.json` | The shapes as JSON |

The image is rendered a moment after the pen rests, so a fetch is normally an instant read.
A fetch never returns an out-of-date image. If the drawing has changed and the image has not
caught up, the fetch waits up to three seconds for it; if the stage is not open, it fails
with a message saying so.

| Status | Meaning |
|---|---|
| `200` | The PNG of the current drawing |
| `404` | The board is empty |
| `503` | The image is behind the drawing: open the stage, or retry in a moment |

## How it works

One Bun process on one port serves the built client, runs the tldraw sync room, saves the
board to `data/`, and serves the image.

```
src/
  shared/       constants, assertions, the document hash, the clock interface
  server/       board (the state machine), storage, HTTP edge, QR pairing, entry point
  client/       draw page, stage page, tool strip, image uploader
  simulation/   deterministic simulator: virtual clock, faulty disk, simulated devices
```

**Freshness by content.** The stage uploads each image with a hash of the records it
rendered. The server serves an image only while that hash equals the hash of its own
document. Correctness does not depend on clocks or message order.

**Durability.** The board is saved one second after the pen rests, and at most five seconds
after the first unsaved change. Files are checksummed and replaced atomically. A damaged
board file stops the server with a message; it is never silently replaced by an empty board.

**Restarts.** On every start the sync clock jumps forward and is saved before any device
connects, so a device that remembers a lost timeline reloads the document in full.

## Tests

```bash
bun test              # everything, about a second
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

## Style

The code follows [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md),
adapted to TypeScript. `src/tiger_style.test.ts` enforces the mechanical parts: 100-column
lines, 70-line functions, snake_case file names, and an average of two assertions per
function in the server and shared code. Every limit is a named constant in
`src/shared/constants.ts`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | The one port |
| `BOARD_DATA_DIR` | `./data` | Where the board and image are saved |

## Limits

- The board is one shared canvas on the local network, with no accounts and no password.
  Anyone on the same network can open it. Do not run it on a network you do not trust.
- The board holds pen strokes. Pasted images are not supported.
- tldraw's licence allows unlicensed use over plain HTTP, which is how this runs. Serving it
  over HTTPS on a public host would need a licence key.
