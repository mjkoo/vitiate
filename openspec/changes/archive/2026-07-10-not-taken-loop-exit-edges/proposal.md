## Why

A 2026-07-09 re-baseline against jazzer.js found throughput at parity, leaving coverage
granularity as the dominant fuzzing-effectiveness gap (design review item C1). The SWC plugin
places a hit-counter only on the *taken* side of each branch and loop, so two inputs that
differ only in an un-taken branch, or in whether a loop ran zero times, look identical to the
feedback. This structurally halves meaningful branch coverage relative to AFL/libFuzzer, which
record both sides of every branch, and it weakens corpus admission.

Because closing C1 roughly doubles the number of instrumented edges, it also makes the edge-id
hash quality matter (design review item C5): today `edge_id` truncates a 64-bit FNV-1a to
`u32` and reduces `% 65536`, keeping only FNV's weakly-mixed low 16 bits, and collisions are
silent. This change addresses C1 and C5 together, as the review prescribes.

## What Changes

- **Synthesize not-taken branch edges.** When an `if` has no `else`, insert a synthetic
  `else { __vitiate_cov[id]++ }` so "condition false" is distinguishable from "branch not
  reached." (Reverses the prior explicit non-synthesis requirement.)
- **Synthesize loop-exit edges.** For every loop (`for`, `while`, `do-while`, `for-in`,
  `for-of`), insert a counter as the statement immediately after the loop, distinguishing
  "reached the loop but ran zero iterations / exited" from "never reached the loop."
- **Edge-kind discriminant.** Fold an edge-kind (`Block` / `ElseNotTaken` / `LoopExit` /
  `Cmp`) into the edge-id hash so edges sharing a source span never alias.
- **Hash mixing (C5).** Add a murmur3 `fmix64` avalanche finalizer over the full 64-bit hash
  before reducing `% coverage_map_size`, so the reduction no longer depends on FNV's weak low
  bits.
- **Collision-pressure warning (C5).** The plugin injects a per-file counter total into a
  `__vitiate_edge_count` global; the runtime prints a one-time warning at campaign start when
  the instrumented-edge count is large relative to the coverage-map size, so collisions are no
  longer silent.

## Capabilities

### Modified Capabilities

- `edge-coverage`: not-taken `if` and loop-exit edges are now instrumented; edge-id
  computation gains an edge-kind discriminant and an avalanche finalizer.
- `comparison-tracing`: comparison IDs follow the updated edge-id scheme (edge-kind
  discriminant + finalizer), keeping them aligned with coverage edge IDs.
- `progress-reporter`: adds a one-time coverage-map-load (collision-pressure) warning at
  campaign start.

### New Capabilities

_None._

## Impact

- **Crates:** `vitiate-swc-plugin` (new `EdgeKind`, finalizer, synthetic else, loop-exit
  insertion via `visit_mut_stmts` / `visit_mut_module_items`, per-file edge-count injection).
- **npm packages:** `@vitiate/core` (`globals.ts` declares/reads `__vitiate_edge_count`;
  `reporter.ts` adds `warnOnCoverageMapLoad`; `loop.ts` calls it at campaign start).
- **Edge ids change** for all targets (finalizer + discriminant). Nothing persists edge ids
  across the hash change except `merge`/`optimize` control files, which are already
  span-sensitive (any source edit shifts ids); stale entries self-heal on the next merge.
- **Coverage numbers rise** (roughly 2x meaningful branch edges); no coverage-map size change
  and edge counts stay far below the default 65,536 slots for typical targets.
- **No new toolchain or build targets.**
