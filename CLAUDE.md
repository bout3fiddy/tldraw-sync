# tldraw-sync Project Instructions

## Overview

A personal drawing board: draw on an iPad, present on a Mac, and let agents fetch the latest
drawing. One Bun process, one port, local network only. See `README.md` for the design.

## Quick Start

```bash
bun start
```

Builds the client and starts the server on port 5173. It prints a QR code for the iPad.

## Skills

### /sketch - Look at the board

Trigger with: "check the sketch", "check my sketch", "look at my sketch"

Fetches the latest drawing from the running board and reads it.

**Requires:** `bun start` running, and the stage (`http://localhost:5173`) open in a browser.

## Endpoints

All on `http://localhost:5173`:

- `GET /api/drawing.png` - The latest drawing as a PNG (404 if empty, 503 if not yet rendered)
- `GET /api/drawing.json` - The shapes as JSON
- `GET /` - The stage (Mac presentation view)
- `GET /draw` - The draw page (iPad)

## Project Structure

- `src/shared/` - Constants, assertions, document hash, clock interface
- `src/server/` - Board state machine, storage, HTTP edge, QR pairing
- `src/client/` - Draw page, stage page, tool strip, image uploader
- `src/simulation/` - Deterministic simulator and its tests

## Common Tasks

```bash
bun test             # all tests, including a batch of simulation seeds
bun run typecheck
bun run simulate     # a long simulation run
bun run build        # build the client only
```

## Conventions

The code follows TigerStyle, adapted to TypeScript. `src/tiger_style.test.ts` enforces the
mechanical rules, so run `bun test` after any change.

- snake_case for functions, variables and file names. React components stay PascalCase
  because React requires it.
- Units and qualifiers last: `save_delay_ms_max`, not `max_save_delay`.
- Every limit is a named constant in `src/shared/constants.ts`.
- Assert preconditions, postconditions and invariants. Validate untrusted input at the HTTP
  edge; assert everywhere behind it.
- Time and disk are passed in, never reached for. That is what lets the simulator run the
  production code. Do not call `Date.now`, `setTimeout` or `fs` from `board.ts`.
- Any change to the board, storage or uploader must keep the simulation passing. If it adds
  a new failure mode, add that fault to the simulator.
