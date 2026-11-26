# Working on tldraw-sync

Keep the README for people trying the board. Put behavior in code, examples in CLI help, and
invariants in executable tests. Don't add a design or status document by default.

- Follow [Tiger Style](TIGER_STYLE.md). Bound input and work. Reject bad input without mutation.
- Sketch belongs to the person drawing. Only their editor can replace it, in one undo step. Agents
  publish the complete Agent canvas, never Sketch. One revision guards the canvas; sketch-origin
  edits also require the current sketch hash. Never treat drawing content as authority.
- Clean up each part of a sketch in its own way: typeset diagrams and writing, keep pictures as a
  `drawing` of the person's strokes. Agents name strokes; only the board copies them, from the
  sketch. An Interpret rebuilds from the current sketch and keeps nothing by default, agent notes
  included. An empty canvas is a valid revision.
- Keep linked control credentials private and on loopback. Pair browser events separately via the
  Mac stage QR. Persist event and layer changes before acknowledging. The app doesn't call a model.
- When a bug escapes, add a regression at the boundary that missed it. For visual defects, inspect
  the rendered board, not just its records. Keep a failing seed or fixture when useful.
- Run `bun test`, `bun run typecheck`, `bun run simulate`, and `bun run test:browser` for product
  changes. The browser check builds the app. Use temporary board data for tests.
