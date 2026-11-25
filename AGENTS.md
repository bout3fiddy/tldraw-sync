# Working on tldraw-sync

Keep the README for people trying the board. Put behavior in code, examples in CLI help, and
invariants in executable tests. Don't add a design or status document by default.

- Follow [Tiger Style](https://github.com/tigerbeetle/tigerbeetle/blob/a2a3c70/docs/TIGER_STYLE.md).
  Bound input and work. Reject bad input without changing the board.
- Sketch belongs to the person drawing. External agents publish only to Cleaned. Check the source
  hash and cleaned revision before replacing anything. The app doesn't call a model.
- When a bug escapes, add a regression at the boundary that missed it. For visual defects, inspect
  the rendered board, not just its records. Keep a failing seed or fixture when useful.
- Run `bun test`, `bun run typecheck`, `bun run simulate`, and `bun run test:browser` for product
  changes. The browser check builds the app. Use temporary board data for tests.


Follow [Tiger Style](TIGER_STYLE.md).
