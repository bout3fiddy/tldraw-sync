# tldraw-sync Project Instructions

## Overview

A personal drawing board: draw on an iPad, present on a Mac, and let agents fetch the latest
drawing. One Bun process, local network only, driven by the `tldraw-sync` command. See
`README.md` for the design.

## Running it

```bash
bun src/cli/main.ts start    # or `tldraw-sync start` once `bun link` has run
bun src/cli/main.ts fetch --json
bun src/cli/main.ts stop
bun start                    # the board in the foreground, for watching its log
```

`tldraw-sync --help` is the reference for agents and people alike. To look at the user's
drawing, run `tldraw-sync fetch --json` and read the PNG at `path`.

Tests and experiments must not touch the board in daily use: set `BOARD_DATA_DIR` to a
scratch directory, and pass `--no-open` so no browser opens.

## Project Structure

- `src/cli/` - The `tldraw-sync` command: help, output, finding and starting the board
- `src/shared/` - Constants, assertions, document hash, clock interface
- `src/server/` - Board state machine, storage, HTTP edge, QR pairing, process lock
- `src/client/` - Draw page, stage page, tool strip, image uploader
- `src/simulation/` - Deterministic simulator, its tests, and the test pen

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
- The command line is for agents first. Every command keeps `--json` (one object on stdout),
  `--quiet`, the documented exit codes, and a `next_action` on every failure. A new failure
  gets a code, a full-sentence message, and a line in the command's help.
