# Understand, then typeset beautifully

## Accepted outcome

Replace coordinate tracing with presentation-quality diagram composition. The external agent
interprets the sketch; the tool typesets that interpretation. Labels, entities, relationship
endpoints/directions, and nesting retain their meaning. Positions, sizes, spacing, label placement,
and connector paths may change substantially. Never invent domain concepts or improve the user's
architecture. Ordinary handwriting ambiguity is resolved best effort, without clarification prompts.
Human ink remains untouched; Sketch, Cleaned, and Side by side remain separate views.

## External agent and tool boundary

The application never launches or calls a model. An external agent receives the coherent image,
bounded stroke summaries, and the previous interpreted diagram when available. Summaries expose
stroke IDs and bounds without dumping every pen sample into the prompt. The agent returns a
versioned semantic diagram: stable entity IDs, labels, explicit containers/parent relationships,
connections, and optional flow hints. It does not choose final pixel coordinates. It should reuse
previous IDs and associate entities with source strokes where possible.

Keep the existing shape proposal format readable and publishable. Add a documented semantic format
and a deterministic `cleanup-compose` CLI operation. `cleanup-publish` accepts semantic input by
composing it locally before the existing validated HTTP publish. The composition library performs no
network, filesystem, model calls, or writes to the live board. Return actionable validation errors.
The compiled representation retains semantic metadata for snapshots, persistence, restore, and
subsequent recognition; do not lose styling or metadata during a restart.

## Composition and appearance

Use pinned `elkjs` 0.12.1 for compound directed layout, rather than inventing another graph-layout
algorithm. This dependency is justified by free rearrangement, nesting, cycles, ports, and routing.
Choose a single professional house style: readable sans-serif labels, restrained neutral surfaces
and accent colors, consistent outlines, uniform typography, compact padded containers, and a small
spacing scale. Empty space from the sketch is not a layout requirement. Generic unlabeled objects
stay generic; color must not invent domain meaning.

Text measurement/wrapping must conservatively size nodes and containers. Preserve word content; line
breaks may change. Use native tldraw shapes and bound connectors. Support plain, directed, and
bidirectional relationships without replacing one with another. Expose only the bounded styling and
routing controls needed for this composition, not arbitrary executable shape specifications. Avoid
label clipping, unintended overlap, unreadably small text, excessive whitespace, and arrows through
unrelated nodes. Do not claim universal crossing-free layout for arbitrary graphs.

Canonicalize graph input and reuse prior identities/order as layout hints so tiny edits do not
randomly permute the diagram. Full rearrangement remains allowed to satisfy presentation quality;
pixel pinning is not an invariant.

## Safety and acceptance

Bound input bytes, nodes, edges, labels, nesting depth, output shapes, layout work, and attempts.
Reject containment cycles and dangling references; ordinary directed graph cycles are valid. Keep
layout preparation outside the board's synchronous mutation section. Source-hash and cleaned
revision checks occur at publish, after all asynchronous work. Persist atomically before swapping
state. Retain existing history, corruption handling, restart behavior, and legacy CLI/API behavior.

Run strict types, production build, mechanical/harness lint, full Bun tests, 1000 simulation seeds,
and real Playwright journeys. Test invalid semantic inputs, layout determinism, topology/label/
containment preservation, bounds, cycles, failed saves, conflicting publishes, and persistence.
Review actual rendered screenshots at realistic screen sizes: JSON validity is not visual quality.
Use a synthetic regression matching the current live sketch's nested groups and connections. The
host will run Opus 5.5 medium against that live sketch and publish revision 4 or later only after
reviewed implementation and rendered evidence. Private sketch content stays out of Git.

## Execution

Opus 5.5 implements at medium effort with an independent reviewer. No database migration or
performance specialist is requested. Host owns dependency installation, check configuration,
external watcher updates, live board backups/restart, and final live publication. The old watcher is
stopped until the new semantic workflow is ready. No automatic remote publication is requested.
