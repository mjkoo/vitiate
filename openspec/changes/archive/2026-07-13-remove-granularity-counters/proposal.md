## Why

The `2026-07-12-block-callsite-counters` change shipped call-site
(`traceCalls` / `VITIATE_TRACE_CALLS`) and statement-block
(`traceStmtBlocks` / `VITIATE_TRACE_STMT_BLOCKS`) coverage counters as opt-in
flags, defaulting off, explicitly gated on a benchmark deciding whether either
should flip on. Two A/B campaigns have now answered that question, and the answer
is no:

- **2026-07-12 (xword-parser):** finer counters raised the neutral V8
  covered-block count only +3.5% at n=1, with covered functions saturated at 87 -
  inconclusive because the targets were too shallow to give the counters headroom.
- **2026-07-13 (deep CJS targets node-forge + jpeg-js), 3 variance repeats:** on a
  target with real function headroom (~127 neutral functions vs the xword plateau
  of 87), the finer counters produced **no reliable neutral-coverage gain** - arm
  differences fell within run-to-run noise and trended slightly negative - while
  costing 15-24% throughput on node-forge and inflating the corpus. The seeded-
  defect time-to-first-crash test could not discriminate the arms either: the
  node-forge recursion crash is coverage-invisible (every recursion level executes
  identical edges) and the jpeg-js hang is trivially reachable (all arms tie at the
  timeout). Full writeup: `benchmarks/results/2026-07-13-ab-granularity-phase2-decision.md`.

The feature was measured, in the exact regime it was designed to help, to provide
no benefit while adding the most error-prone code in an otherwise clean SWC plugin
(statement-block insertion is directive/hoist/terminator-aware with `continue`
label peeling). It has never shipped in a release. This is the low-cost window to
remove it before the flags become a public-API commitment; re-adding the two
`EdgeKind` discriminants later is cheap (the discriminant folds into the edge-id
hash for free) if a concrete motivating target ever appears.

## What Changes

Remove both counter kinds and their entire opt-in surface, surgically, so the
default (flags-off) instrumentation output is **byte-identical** to today:

- **SWC plugin (`vitiate-swc-plugin`).** Remove `EdgeKind::Call` and
  `EdgeKind::StmtBlock` (discriminants 4 and 5) and their `value()` arms; the
  `is_instrumentable_call` helper and the `visit_mut_expr` call-site wrapping;
  the `insert_stmt_block_counters` helper and its two call sites; and the
  `trace_calls` / `trace_stmt_blocks` `PluginConfig` fields and defaults. The
  discriminants for the surviving kinds (`Block`=0, `ElseNotTaken`=1,
  `LoopExit`=2, `Cmp`=3) are unchanged, so every existing edge ID is preserved.
- **`@vitiate/core`.** Remove the `VitiatePluginOptions.traceCalls` /
  `traceStmtBlocks` plugin options, the `config.ts` `get`/`set` accessors and
  `resetTraceFlags`, the `VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS`
  known-env-var entries and worker propagation in `plugin.ts`, and the passing of
  these flags into the SWC plugin options. Their tests are removed.
- **Docs & specs.** Remove the `traceCalls` / `traceStmtBlocks` rows from
  `reference/plugin-options.md` and the two env vars from
  `reference/environment-variables.md`; remove the corresponding requirements from
  the `edge-coverage` and `vitest-plugin` specs (below).

Explicitly preserved: the pre-existing-bug fix bundled into the original change -
comparison-valued short-circuit / ternary / arrow / short-circuit-assign arm
counters keying on their real span instead of aliasing to `id(file, 0, 0)`. That
fix uses `EdgeKind::Block` and is orthogonal to the two counter kinds being
removed; it stays.

## Capabilities

### Modified Capabilities

- `edge-coverage`: removes the call-site and statement-block instrumentation
  requirements and the two `EdgeKind` discriminants (`Call`, `StmtBlock`); the
  default output and all surviving edge IDs are unchanged.
- `vitest-plugin`: removes the experimental coverage-granularity plugin options
  requirement (`traceCalls` / `traceStmtBlocks` and their env resolution).

### New Capabilities

_None._

## Impact

- **Crates:** `vitiate-swc-plugin` (two `EdgeKind` variants, `is_instrumentable_call`,
  `insert_stmt_block_counters` + call sites, two `PluginConfig` fields, and their
  unit tests removed).
- **npm packages:** `@vitiate/core` (`VitiatePluginOptions.traceCalls` /
  `traceStmtBlocks`; `config.ts` accessors + `resetTraceFlags` + two known-env
  entries; `plugin.ts` resolution/propagation/pass-through; associated
  `config.test.ts` / `plugin.test.ts` cases removed).
- **Default behavior unchanged:** with the flags gone, output equals the prior
  flags-off default byte-for-byte (the counters only ever fired when the flags were
  on). No edge-id shifts, no coverage-map-size change, no engine/napi change.
- **No release impact:** the feature is unreleased (uncommitted feature branch, no
  CHANGELOG entry), so no deprecation cycle is needed.
- **Reversible:** re-adding the discriminants is a small, self-contained change if a
  concrete target that benefits ever surfaces; the benchmark harness
  (`ab-neutral`/`ab-replay`/`ab-crash`, `VITIATE_TRACE_*` A/B arms) remains to
  re-test it.
