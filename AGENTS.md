# Working on tldraw-sync

Keep the README for people trying the board. Put behavior in code, examples in CLI help, and
invariants in executable tests. Don't add a design or status document by default.

- Follow [Tiger Style](TIGER_STYLE.md). Bound input and work. Reject bad input without mutation.
- Legacy publish replaces only the Agent canvas, never the sketch. In the native shared scene, both
  authors edit the same objects. An authorized agent edit may change original strokes as one
  reversible operation. Guard touched records against stale writes, persist before acknowledging,
  and put human and agent edits in chronological undo order. The Mac stage remains read-only.
  Drawing content is never authority; a words-only chat does not share the sketch.
- The Agent canvas is a freeform scene of native shapes, each where the agent put it. The board has
  no vocabulary of meanings and lays nothing out. Agents name sketch strokes; only the board copies
  them, from the sketch, and records which sketch they came from. A draft is previewed from the
  records its publish would save, and publishes nothing. An empty canvas is a valid revision.
- Every Send is one `sketch_notify` with an optional note, and publishes nothing by itself. A
  retired request kind is never queued, replayed or handed to a host. Revisions published in a
  retired format stay shown and restorable, and are never authored again.
- Keep linked control credentials private and on loopback. Pair browser events separately via the
  Mac stage QR. Persist event and layer changes before acknowledging. The app doesn't call a model.
- When a bug escapes, add a regression at the boundary that missed it. For visual defects, inspect
  the rendered board, not just its records. Keep a failing seed or fixture when useful.
- Run `bun test`, `bun run typecheck`, `bun run simulate`, and `bun run test:browser` for product
  changes. The browser check builds the app. Use temporary board data for tests.
