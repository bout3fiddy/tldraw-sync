# Tiger Style

Adapted from TigerBeetle's [TigerStyle][source] for use across repository languages. Upstream
revision for reference: `a2a3c7064519e08233abe26c54a43fca2f9ad9bc`. Distributed under the Apache
License 2.0; see `TIGER_STYLE_LICENSE`.

[source]: https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/TIGER_STYLE.md

Choose safety first, then performance, then developer experience.

- Make control flow and ownership explicit. Bound queues, allocations, concurrency and retries;
  decide what happens at capacity. Keep state close to its use.
- Handle external failures as ordinary outcomes. Assert internal invariants at both ends of a
  transition, with critical checks active in production. Test either side of every boundary and
  exercise recovery, not just success.
- Estimate latency and bandwidth across network, disk, memory and CPU before optimizing. Separate
  setup from repeated work; batch accesses, reuse storage and avoid unnecessary copies. Measure the
  result where callers experience it.
- Choose domain names with units. Distinguish indexes from counts, and document rounding. Explain
  why a limit or design choice matters. Prefer interfaces with few possible states.
- Use the project's formatter, strict compiler checks and naming conventions. In managed code,
  translate Zig's static allocation discipline into bounded growth and predictable resource use.
  Scrutinize new dependencies and fix known defects while the reasoning is fresh.

## Repository guidance

Status: Customized. Host inspection and baseline checks completed on 2026-11-24.

### Architecture and ownership

- TypeScript with strict compiler checks, React 18, Bun 1.3.5, Vite 5, and tldraw 4.2.3.
- `src/server/board.ts` owns the sync state machine. Pass time and disk explicitly through
  deterministic interfaces; keep networking in `src/server/http.ts` and filesystem I/O in storage.
- `src/client/` owns Pencil input, read-only presentation, and bounded image rendering/upload.
  `src/cli/` owns process discovery and structured command outcomes, not model invocation.
- This is a local-network tool without authentication. Preserve the trusted-network warning; never
  add cloud model calls, execute agent-supplied code, or log private drawing contents.

### Safety, resources, errors, and concurrency

- Treat HTTP bodies, CLI inputs, agent proposals, and saved files as untrusted. Validate complete
  inputs before mutation; return actionable ordinary errors for invalid input and conflicts.
- Keep internal invariants checked with the production `assert` helper. Assertion failures are fatal
  at the server boundary; do not turn invariant failures into silent success.
- Put named limits with explicit units in `src/shared/constants.ts`. Bound payloads, shapes,
  sessions, fetch waiters, timers, render sizes, and retries; reject overload explicitly.
- Preserve separate ownership of human ink and agent output. Agent cleanup must never mutate ink.
  Tie proposals to their source snapshot and guard concurrent replacement; publish atomically.
- Content hashes, not timestamps, determine image freshness. An image and its supplied records must
  describe the same snapshot. Never serve stale data as current.
- Preserve checksummed atomic persistence and restart clock behavior. Corruption must stop startup,
  not discard a drawing. Test interrupted saves and restart recovery through injected disk/time.
- Prefer bounded reusable state in repeated processing. Managed allocation is allowed where useful;
  synchronous disk writes are deliberate to avoid interleaved commits in this personal tool.

### Executable gates and evidence

Run from the repository root:

- `bun test`: behavioral tests, deterministic simulations, and mechanical Tiger Style checks.
- `bun run typecheck`: strict TypeScript, including unused and unchecked-index checks.
- `bun run build`: production browser bundle.
- `bun run simulate`: an additional 1000 simulation seeds; preserve and replay failing seeds with
  `SEED=<seed> bun test simulation` and optionally `TRACE=1`.
- For changed browser journeys, run a real Playwright check against the exact candidate; browser,
  loopback, and process checks require the host when sandbox facilities are unavailable.
- `document_check` formats/checks edited Markdown. No standalone lint script exists: mechanical
  source lint lives in `src/tiger_style.test.ts`; semantic checking is TypeScript's responsibility.

Baseline evidence: 45 tests passed (742 expectations), typecheck passed, and production build
passed. Repository checks enforce 100-column lines, snake_case source filenames, a 70-line function
ceiling, and an average of two meaningful assertions in server/shared functions. The 70-line limit
is the existing executable allowance over the approximately 60-line review target. Keep these gates;
do not add meaningless assertions or weaken checks to obtain a pass.
