## Why

Throughput reached parity with jazzer.js at the 2026-07-12 re-baseline, leaving coverage
*granularity* as the last known fuzzing-effectiveness gap (architecture review item 16). The SWC
plugin instruments only branch decision points: each basic block gets exactly one entry counter,
so straight-line code inside an already-entered block - including every call site - contributes
zero additional coverage signal. A block like `a(); b(); c()` is a single edge. jazzer.js
instruments V8 basic blocks, which split at calls and exception edges, so it records 2-3x finer
coverage on large targets (benchmark `parse`: vitiate 690 unique edges vs jazzer 2264 V8 blocks).
That is an apples-to-oranges granularity gap, not proof of a discovery gap - but finer
instrumentation gives the feedback more signal to distinguish inputs, and closing it is the
single remaining structural lever versus jazzer.

The `not-taken-loop-exit-edges` change already listed "per-statement basic-block counters" as an
explicit non-goal deferred to a larger change. This is that change.

## What Changes

Two independent, finer-grained counter kinds are added to the SWC plugin, each behind its own
opt-in flag (both default off), so a benchmark can isolate each axis's contribution before either
ships on by default:

- **Call-site counters (`EdgeKind::Call`).** A new `visit_mut_call_expr` / `visit_mut_new_expr`
  wraps each call in a before-counter (`(__vitiate_cov[id]++, callExpr)`), so control reaching
  each call site is a distinct edge. `super(...)` and dynamic `import(...)` are skipped;
  optional-chaining calls are wrapped whole (preserving `this`).
- **Statement-block counters (`EdgeKind::StmtBlock`).** A counter is inserted between consecutive
  statements in every statement list (`visit_mut_stmts` + `visit_mut_module_items`), so
  straight-line code splits into per-statement edges and each counter fires only if the preceding
  statement completed normally (capturing call-return-vs-throw boundaries). Directive prologues
  and hoisted `FunctionDecl`s are kept at the top; insertion stops after the first terminator.
- **Config flags.** `PluginConfig` gains `traceCalls` / `traceStmtBlocks` (default false). These are
  exposed as first-class `VitiatePluginOptions.traceCalls` / `traceStmtBlocks` plugin options
  resolved in `config.ts` (`getTraceCalls` / `getTraceStmtBlocks` = option module state ?? env ??
  false) and propagated to `VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS` for workers, mirroring
  `coverageMapSize`. The env vars still work directly (for A/B benchmarking without editing config);
  an explicit option takes precedence.

Both counter kinds route through the existing `edge_id` / `make_counter_expr` path, so they get
collision-free ids (the `EdgeKind` discriminant is folded into the hash) and automatic
`__vitiate_edge_count` collision-pressure accounting for free. Nothing in the engine, napi
surface, coverage-map size, or downstream feedback/scheduler changes.

## Capabilities

### Modified Capabilities

- `edge-coverage`: adds optional call-site and statement-block instrumentation and two new
  `EdgeKind` discriminants; both are off by default and preserve all existing edges byte-for-byte
  when disabled.

### New Capabilities

_None._

## Impact

- **Crates:** `vitiate-swc-plugin` (two new `EdgeKind` variants, `wrap_with_counter` generalized
  to take a kind, `visit_mut_call_expr` / `visit_mut_new_expr`, statement-block insertion in
  `visit_mut_stmts` / `visit_mut_module_items`, two new `PluginConfig` fields).
- **npm packages:** `@vitiate/core` (`VitiatePluginOptions.traceCalls` / `traceStmtBlocks`; `config.ts`
  `get`/`setTraceCalls` / `get`/`setTraceStmtBlocks` + `resetTraceFlags`; `plugin.ts` resolves the
  options, propagates them to env for workers, and passes them into the SWC plugin options).
- **Defaults unchanged (with one coverage-quality fix):** with both flags off (the default), no
  new counters are emitted. Edge ids are unchanged for existing users **except** that a
  short-circuit / ternary / arrow / short-circuit-assign counter whose value is a comparison now
  keys on the arm's real span instead of collapsing to `id(file, 0, 0)` (previously all such
  comparison-valued arms aliased to one coverage slot). This corrects a pre-existing aliasing bug
  in the default configuration; the shifted ids self-heal on the next `merge`/`optimize` like any
  span change.
- **When enabled:** coverage numbers rise (more instrumented edges); edge counts stay well below
  the default 65,536 slots on the benchmark targets, but the existing collision-pressure warning
  covers the large-target `+block` case. No coverage-map size change.
- **No new toolchain or build targets.**
- **Benchmark-gated:** a four-arm A/B (baseline / +call / +block / +both) decides whether either
  default flips to on; the flags ship regardless as opt-in instrumentation controls.
