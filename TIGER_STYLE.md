# Tiger Style

Modified from TigerBeetle's [TigerStyle][source] at revision
`a2a3c7064519e08233abe26c54a43fca2f9ad9bc`: condensed and adapted for managed languages and this
repository. Distributed under the Apache License 2.0; see `TIGER_STYLE_LICENSE`.

[source]: https://github.com/tigerbeetle/tigerbeetle/blob/a2a3c70/docs/TIGER_STYLE.md

Design goals, in order: safety, performance, developer experience. Simplicity comes from revision,
so think before building. Fix known showstoppers, such as unbounded work, latency spikes and
superlinear algorithms, while the context is fresh. Always say why a limit or design choice exists.

## Safety

- Use simple, explicit control flow and few abstractions. Do not recurse; use an explicit stack with
  a bound. Mark deliberately nonterminating service loops as such.
- Put a limit on everything: loops, queues, buffers, collections, retries, timers, pending promises,
  concurrent operations and input sizes. Name limits with units, decide what happens at capacity,
  and report overload as an explicit outcome instead of waiting or growing.
- JavaScript `number` is a float. Check that counts, sizes, indexes and clocks are safe integers in
  range before relying on exact arithmetic.
- Operating errors are expected: invalid input, I/O failure, timeouts, conflicts and damaged saved
  data. Handle each one explicitly with an actionable outcome, and test that handling. Validate
  untrusted input with ordinary errors; never use assertions for it.
- Assertion failures are programmer errors: the program's model is wrong. Stop safely. Never catch
  one to continue, retry or report success. Keep assertions in production builds.
- Assert internal arguments, results, preconditions, postconditions and invariants, averaging at
  least two meaningful assertions per function. Do not operate blindly on unchecked data.
  - Pair assertions on two paths, such as before a write and after reading it back.
  - Assert both the expected positive space and the forbidden negative space.
  - Split compound assertions. Express an implication as `if (a) assert(b)`.
  - Assert relations between constants at module load. Check discriminated unions exhaustively.
- Managed runtimes allocate implicitly, so static allocation cannot be promised. Size resources
  during design, bound everything that grows with input or time, prepare long-lived storage at
  startup and reuse it on measured hot paths. Release sockets, timers and files deterministically.
- Where practical, do not act directly inside external event handlers. Queue events with a bound and
  process them in batches at the program's own pace.
- State can change across `await`, timers and callbacks. Keep critical sections synchronous or
  revalidate preconditions after resuming. Route every promise, timer and handler failure to an
  explicit owner; leave no floating promises.
- Declare data at the smallest scope and check it close to its use. Do not keep a second mutable
  copy of state that can go stale; derive it, or key a cache to its source. Sharing a reference to a
  single owner is fine.
- Keep functions near 60 lines, as in NASA's Power of Ten; TigerStyle's hard limit is 70. Push `if`s
  up and `for`s down: parents own branching and state, and helpers compute changes purely.
- Prefer the simplest return type that still represents every required outcome. Never hide an
  ordinary error to remove a branch.
- Split compound conditions, consider each missing `else`, and state invariants positively.
- Pass options that matter, such as timeouts and encodings, explicitly rather than using defaults.
- Expose only the written length of a reused buffer. Enable the strictest compiler checks.

## Performance

- Safety comes first, but consider performance from the start: the largest wins come in design,
  before anything can be measured. Sketch network, disk, memory and CPU bandwidth and latency.
- Optimize the slowest resource first, weighted by how often it is used.
- Separate the control plane from the data plane. Batch work and avoid redundant copies.
- Be explicit on hot paths. Measure results where callers experience them.

## Naming and readability

- Get nouns and verbs right. Follow the repository naming convention and do not abbreviate.
- Put units and qualifiers last: `latency_ms_max`. An index plus one is a count; a count times its
  unit is a size. Show rounding intent with `Math.floor`, `Math.ceil` or an exactness assertion.
- Use an options object when arguments could be confused. Do not give one term several meanings.
- Comments are sentences that explain why, and tests state their goal and method. Commit messages
  explain the change. Use the formatter and 100-column lines.

## Dependencies and testing

- Every dependency and tool carries supply-chain, safety, performance and installation costs. Prefer
  the platform and existing tools; justify and pin each addition.
- Test valid and invalid input, transitions between them and both sides of every limit.
- Exercise error handling, fault injection and recovery. Use seeded deterministic simulation for
  time, disk and network, and keep each failing seed as a regression.

## Repository guidance

Status: Customized. Host inspection and baseline checks completed on 2026-11-24.

### Architecture and ownership

- TypeScript with strict compiler checks, React 18, Bun 1.3.5, Vite 5, and tldraw 4.2.3.
- Semantic composition is specified in `DIAGRAM_COMPOSITION.md`. Pinned `elkjs` 0.12.1 provides
  compound graph layout; scrutinize graph limits and keep layout outside atomic publication. Pinned
  Playwright 1.57.0 supplies the real-browser gate, with host-installed matching Chromium.
- `src/server/board.ts` owns the sync state machine. Pass time and disk explicitly through
  deterministic interfaces; keep networking in `src/server/http.ts` and filesystem I/O in storage.
- `src/server/cleaned.ts` owns the separate cleaned document and bounded revision history.
  `cleanup_proposal.ts` validates the external shape schema; publish and restore use revision
  compare-and-swap. Persist before swapping the in-memory result; never write cleanup to the ink
  room.
- `src/client/` owns Pencil input, separate Sketch/Cleaned views, bounded rendering/upload, and
  single-flight cleaned-status polling. `src/cli/` owns process discovery, bounded proposal reading,
  coherent image/record snapshots, and structured outcomes, not model invocation.
- This is a local-network tool without authentication. Preserve the trusted-network warning; never
  add cloud model calls, execute agent-supplied code, or log private drawing contents.

### Safety, resources, errors, and concurrency

- Treat HTTP bodies, CLI inputs, agent proposals, and saved files as untrusted. Validate complete
  inputs before mutation; return actionable ordinary errors for invalid input and conflicts.
- Internal invariants use the production `assert` helper. Every `AssertionError`, including those
  from async continuations and timer callbacks, must reach `on_fatal`, which releases server state
  and exits with status 1. Never catch an assertion failure to continue.
- Name every limit with its unit. Shared limits live in `src/shared/constants.ts`; a limit used by
  one module may be a named constant beside its use. Bound payloads, shapes, sessions, fetch
  waiters, timers, render sizes, and retries; reject overload explicitly.
- For the agent-output feature, keep human ink and agent output in separate ownership. Agent cleanup
  must never mutate ink. Tie proposals to their source snapshot, guard concurrent replacement, and
  publish atomically.
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
- `bun run simulate [seed_first] [seeds_count]`: 1000 seeds of 500 steps by default. Replay a
  failure with the printed `SEED=<seed> STEPS=<steps> bun test simulation`, optionally `TRACE=1`.
- `bun run test:browser`: build and run real Playwright journeys against the exact candidate. On a
  cold host, install Chromium with `bunx playwright install chromium --only-shell`.
- `.pi/harness.json` keeps strict typecheck and build in the sandbox. Bun tests, simulation, and
  browser checks use the host because they need Bun, loopback, process control, or a browser. These
  remain required gates; moving their runner does not remove or replace them.
- The harness `document_check` tool (not a repository script) formats and checks edited Markdown. No
  standalone lint script exists: mechanical source lint lives in `src/tiger_style.test.ts`; semantic
  checking is TypeScript's responsibility.

Baseline evidence before cleanup: 45 tests passed (742 expectations), typecheck and build passed.
Integration evidence at `5fafd53`: 140 tests passed (11314 expectations), typecheck, production
build, 1000 simulation seeds, and the real Chromium CLI-to-canvas journey passed on the host. The
candidate also passed five consecutive full-suite runs after the refused-body lifecycle repair.
Harness lint introduced no findings versus the baseline; inherited formatting findings remain
outside this scope. For `src/**/*.{ts,tsx,css}`, `src/tiger_style.test.ts` enforces 100-column
lines, snake_case file names and TigerStyle's 70-line hard function limit. It also requires at least
two `assert` calls per function declaration or method on average across non-test `src/server` and
`src/shared` files. The approximately 60-line review target adapts NASA's Power of Ten rule 4. Keep
these gates; do not add meaningless assertions or weaken checks to obtain a pass.
