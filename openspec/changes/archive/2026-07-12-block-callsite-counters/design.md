## Context

The SWC WASM plugin (`vitiate-swc-plugin`) instruments JS/TS during Vite's module transform. It
places a hit-counter (`__vitiate_cov[id]++`) at the *entry* of each block (if-consequent, else,
ternary arms, loop bodies, switch cases, function entry, catch/finally, logical-op RHS) plus the
synthesized not-taken and loop-exit edges added by `not-taken-loop-exit-edges`. It does **not**
instrument anything *within* an already-entered block: straight-line statements and, critically,
call sites carry no counter of their own. `foo(); bar(); baz()` is one edge regardless of how the
three calls behave.

jazzer.js instruments V8 basic blocks, which split at call/exception edges, giving 2-3x finer
coverage on large targets. This change adds two optional, independently-toggled instrumentation
axes that approach that granularity, and gates the on-by-default decision on a benchmark rather
than assuming finer is better (more counters trivially inflate the raw edge count without
necessarily improving discovery).

Both axes reuse the existing `edge_id` machinery (`lib.rs:97-121`): a FNV-1a fold over
`(file_path, span.lo, span.hi, EdgeKind discriminant)` with a murmur3 `fmix64` finalizer, reduced
`% coverage_map_size`. Adding a new `EdgeKind` discriminant yields collision-free ids for free,
and every counter routed through `make_counter_expr` (`lib.rs:132-157`) is automatically counted
into the per-file `__vitiate_edge_count` collision-pressure total. The coverage map is a `u8`
byte-map; the observer, AFL bucketing, feedback history, and `MapIndexesMetadata` scheduler
scoring all auto-scale to `map_len`, so no engine or napi change is required.

## Goals / Non-Goals

**Goals:**

- Add call-site counters: control reaching each call/`new` site becomes a distinct edge.
- Add statement-block counters: straight-line code splits into per-statement edges that fire only
  on normal completion of the preceding statement.
- Keep both strictly opt-in (default off) and byte-identical to today's output when disabled.
- Preserve program semantics exactly (evaluation order, `this` binding, short-circuiting,
  hoisting, TDZ).
- Make the flags env-togglable so the benchmark can A/B four arms from one build.
- Decide the on-by-default question empirically via a four-arm benchmark diff.

**Non-Goals:**

- CmpLog on switch discriminants or case labels (separate magic-value-dispatch change).
- Instrumenting tagged templates as call sites (`TaggedTpl` is not a `CallExpr`; deferred).
- After-call "normal return" counters distinct from before-call counters for ordinary calls
  (statement-block counters already capture return-vs-throw at statement granularity).
- Raising the default `coverageMapSize` (the existing collision-pressure warning is the
  proportionate mechanism if `+block` on a large target approaches the load threshold).
- Worker env-propagation of the flags (unlike `coverageMapSize`, these affect only transform-time
  emission and carry no cross-process runtime contract; the env getter is for togglability and
  test parity, read where the SWC options are built).

## Decisions

### 1. Two new `EdgeKind` discriminants

Extend `EdgeKind` (`lib.rs:39-61`) with `Call = 4` and `StmtBlock = 5`. Because the discriminant
is folded into the hash, a call counter, a block-entry counter, and a statement-block counter at
coincident spans never alias. `Cmp = 3` already keeps CmpLog site ids in a separate sub-space.

### 2. Call-site counters via whole-call before-wrapping

Generalize `wrap_with_counter` (`lib.rs:160-168`) to take an `EdgeKind` (it currently hard-codes
`Block`). A new `visit_mut_call_expr` and `visit_mut_new_expr`, gated on `config.trace_calls`,
replace the call expression with `(__vitiate_cov[id]++, <call>)` keyed on the call's span with
kind `Call`.

- **Wrap the entire call, never just the callee.** `(c++, obj.method(x))` preserves the `obj`
  receiver; `(c++, obj.method)(x)` would strip `this`. The member call is evaluated as a unit
  inside the sequence, so `this`, argument order, and short-circuiting are unchanged.
- **Before-counter semantics.** The counter fires when control reaches the call site (before
  argument evaluation). Combined with statement-block counters, a throwing call K leaves calls
  1..K-1's counters fired and K..N's un-fired - intra-block progress signal mirroring V8's
  block-split-at-call.
- **Guards:** skip `super(...)` (callee is `Callee::Super`) to avoid perturbing constructor
  `this`-init ordering; skip dynamic `import(...)` (callee is `Callee::Import`); keep
  optional-chaining calls (`a?.b()`) - wrapping the whole `OptChainExpr`/call is safe. The
  plugin's own synthesized CmpLog IIFE / record call (built post-visit in `visit_mut_expr`,
  `lib.rs:602-623`, and not re-traversed) must not be wrapped - verified by a regression test.

### 3. Statement-block counters via inter-statement insertion

Gated on `config.trace_stmt_blocks`, insert a `make_counter_stmt(span, StmtBlock)` between
consecutive statements. Integrate into the existing `visit_mut_stmts` (`lib.rs:580`, which already
inserts loop-exit counters) and mirror in `visit_mut_module_items` (`lib.rs:541`) so module
top-level code - the common case under Vite's ESM transform - is covered.

- **Directive prologue / hoisted decls stay first.** Do not insert before hoisted `FunctionDecl`s.
  Directive-prologue protection (`"use strict"`) is scoped to the module top level
  (`visit_mut_module_items`, where a prologue is canonical); the generic statement-list path
  (`visit_mut_stmts`: function/script bodies, nested blocks, loop/case bodies) passes
  `allow_directives = false`, so a leading string-literal statement there is treated as an ordinary
  first statement rather than a directive. This is safe because any real function/script-body
  directive is already demoted by the entry-counter / preamble the plugin prepends, so nothing
  meaningful is split; it also avoids over-broadly suppressing a counter after a leading
  string-literal statement in a nested block.
- **Stop after the first terminator.** After a `return` / `throw` / `break` / `continue` the rest
  of the list is unreachable; inserting counters there is dead code (harmless at runtime but trips
  terser dead-code warnings and wastes edge ids), so insertion halts at the first terminator.
- **Keyed on the following statement's span** with kind `StmtBlock`, so each inter-statement edge
  is stable and distinct from the block-entry (`Block`) and loop-exit (`LoopExit`) edges.
- Inserting an `ExprStmt` counter between `let` / `const` declarations is TDZ-safe (it neither
  reads nor declares the bindings).

### 4. Config flags, default off, unified with `coverageMapSize`

`PluginConfig` (`lib.rs:15-27`, serde camelCase, `#[serde(default)]`) gains
`trace_calls: bool` and `trace_stmt_blocks: bool`, both defaulting to `false`.

The user-facing opt-in follows the same model as `coverageMapSize`, not an env-only side channel:
`VitiatePluginOptions` gains `traceCalls?: boolean` / `traceStmtBlocks?: boolean` (the primary,
discoverable knob, set in `vitest.config.ts`). The plugin's `config` hook resolves each option via
`setTraceCalls` / `setTraceStmtBlocks` (main-process module state) and propagates it to
`VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS` so forks-pool workers - where no plugin hook
runs - transform with the same setting. `config.ts` `getTraceCalls()` / `getTraceStmtBlocks()`
resolve `module state ?? env ?? false`, mirroring `getCoverageMapSize`. `plugin.ts` passes the
resolved values into the SWC plugin options.

Unlike `coverageMapSize` (whose env var is internal-only and always overwritten), the `config` hook
only overwrites the trace env vars when the option is explicitly provided, so an externally-set
`VITIATE_TRACE_*` survives when no option is given - which keeps env-only A/B benchmarking working
without editing config. Precedence: explicit option > inherited env > default false. Default-off
means existing edge ids and coverage numbers are unchanged for all current users.

### 5. Map sizing / collision pressure

Default map stays 65,536 (`u8` byte-map). Both axes add distinct edge ids but stay well under the
map size on the benchmark targets. `__vitiate_edge_count` accounting is automatic (both route
through `make_counter_expr`), so the existing one-time `warnOnCoverageMapLoad` diagnostic
(`reporter.ts`, called from `loop.ts:703`) covers the large-target `+block` case and recommends a
larger `coverageMapSize` if the load threshold is approached. The default is not raised.

### 6. Capture short-circuit / ternary arm spans before descending

`visit_mut_cond_expr`, `visit_mut_bin_expr` (logical RHS), `visit_mut_assign_expr` (short-circuit
RHS) and `visit_mut_arrow_expr` (expression body) capture the arm/RHS span *before*
`visit_mut_children_with`, matching `visit_mut_if_stmt`. This is required because the descent may
replace the sub-expression with a `DUMMY_SP`-spanned node - the CmpLog IIFE for a comparison
(default mode) or the `(counter, call)` sequence for a call (`+call`). Capturing the span after the
descent would key the `Block` counter on `id(file, 0, 0)`, aliasing all such arms to one coverage
slot. This corrects a pre-existing default-mode aliasing bug for comparison-valued arms and keeps
`+call`'s arm counters distinct. Identifier/literal arms are unaffected (their spans do not move),
so existing edge ids for those change nowhere.

## Benchmark plan (efficacy gate)

Four arms, one build, toggled by env (no per-arm rebuild - the SWC transform runs at Vite
transform time in the fuzzing process, which inherits env):

1. **baseline** - both flags off (current behavior)
2. **+call** - `VITIATE_TRACE_CALLS=1`
3. **+block** - `VITIATE_TRACE_STMT_BLOCKS=1`
4. **+both** - both set

Procedure: `node benchmarks/setup.mjs` once, then per arm `VITIATE_TRACE_*=... node run-bench.mjs
--fuzzer vitiate --mode full` (300s x 2 x 5 xword targets), each a separate invocation with a
fresh transform (clear the in-repo Vite cache between arms if it persists). Diff the four
`results/*.json`.

Efficacy metrics (raw `edges` is instrumentation-defined and NOT comparable across arms - reported
but not the verdict):

- **corpus size** (`finalCorpusSize`) - richer corpus at equal wall time.
- **crashes found** - granularity-independent, the primary honest signal; keep/add a
  findable-defect target (e.g. the flatted prototype-pollution canary) since the xword targets
  rarely crash.
- **time-to-plateau** - from the `fuzz_sample` JSONL time-series (~3s cadence, `results/raw/`).
- **execs/sec median** - the cost side; each counter is one typed-array increment, so watch for
  throughput regression (especially `+block` on call-heavy code).
- **jazzer `cov`** - already produced alongside, used only as a fixed external reference anchor.

Decision gate: flip a `PluginConfig` default to `true` only for the arm(s) that improve
corpus/crash/time-to-plateau **without** an unacceptable throughput regression (proposed threshold
< ~15% execs/sec drop). Otherwise the flag ships opt-in. The renderer's hardcoded
`["vitiate","jazzer"]` pairing is left untouched (arms are separate `--fuzzer vitiate` runs
diffed manually); generalizing it to N vitiate arms is an optional follow-up.

## Risks / Trade-offs

- **Throughput cost of `+block`.** Per-statement counters on call/statement-dense code add the
  most array-increment overhead; the benchmark's execs/sec column is the guardrail and the reason
  the default is gated.
- **Collision pressure on large targets with `+block`.** Mitigated by the existing
  `__vitiate_edge_count` warning; documented remedy is a larger `coverageMapSize`.
- **`this`-binding / evaluation-order regressions from call wrapping.** Mitigated by wrapping the
  whole call and by explicit unit tests for member calls, optional chaining, `new`, and the
  super/import skips.
- **Dead statement-block counters** after non-terminator control flow the plugin can't prove
  (e.g. a call that always throws) - harmless unused slots, same class as the existing dead
  loop-exit counter after `while(true){}`.
- **Edge-id churn only when enabled.** With flags off, ids are unchanged. When enabled, ids shift
  as with any instrumentation change; only `merge`/`optimize` control files persist ids and they
  already self-heal (span-sensitive).

## Migration

None at runtime. Both flags default off, so upgrading changes nothing until a user (or the
benchmark) opts in. Enabling a flag shifts edge ids for that run, and cached `merge`/`optimize`
control files recompute on the next merge - identical to the behavior after any source edit that
moves spans.
