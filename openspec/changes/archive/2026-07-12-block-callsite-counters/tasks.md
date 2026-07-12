## 1. Edge kinds + shared helper

- [x] 1.1 Add `Call` and `StmtBlock` variants to `EdgeKind` (discriminants 4 and 5) with the `discriminant()` accessor in `vitiate-swc-plugin/src/lib.rs`.
- [x] 1.2 Generalize `wrap_with_counter` to take an `EdgeKind` parameter (it currently hard-codes `Block`); update existing callers to pass `Block` so their output is unchanged.
- [x] 1.3 Add a test that `Block`/`Call`/`StmtBlock` yield distinct edge IDs at a shared span.

## 2. Config flags (default off)

- [x] 2.1 Add `trace_calls: bool` and `trace_stmt_blocks: bool` to `PluginConfig` (serde camelCase, `#[serde(default)]`, default false).
- [x] 2.2 Add `getTraceCalls()` / `getTraceStmtBlocks()` to `vitiate-core/src/config.ts` reading `VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS` (default false), mirroring `getCoverageMapSize`.
- [x] 2.3 Pass `traceCalls` / `traceStmtBlocks` into the SWC plugin options in `vitiate-core/src/plugin.ts` (~594-597).
- [x] 2.4 Add config tests for the two env getters (truthy env enables; unset defaults false).
- [x] 2.5 Unify the opt-in model with `coverageMapSize`: add `VitiatePluginOptions.traceCalls` / `traceStmtBlocks`; `setTraceCalls`/`setTraceStmtBlocks`/`resetTraceFlags` + module-state precedence (option > env > default) in `config.ts`; `plugin.ts` config hook resolves the options and propagates to `VITIATE_TRACE_*` for workers ONLY when the option is provided (external env survives). Tests: config precedence/reset + plugin-option resolution/propagation/override. Docs (plugin-options, environment-variables) reframed to plugin-option-primary; `vitest-plugin` delta spec added.

## 3. Call-site counters (Axis 1)

- [x] 3.1 Implement `visit_mut_call_expr` and `visit_mut_new_expr`, gated on `config.trace_calls`, wrapping the whole expression via `wrap_with_counter(span, EdgeKind::Call, expr)`.
- [x] 3.2 Skip `super(...)` (callee `Callee::Super`) and dynamic `import(...)` (callee `Callee::Import`); keep optional-chaining calls (wrap the whole call).
- [x] 3.3 Confirm the synthesized CmpLog IIFE / record call is never wrapped (it is built post-visit and not re-traversed); add a regression test.
- [x] 3.4 Add tests: ordinary call wrapped; method call preserves `this`; `new` wrapped; super/import skipped; optional-chaining call wrapped; disabled-by-default emits nothing.

## 4. Statement-block counters (Axis 2)

- [x] 4.1 In `visit_mut_stmts` (alongside the existing loop-exit insertion) and `visit_mut_module_items`, insert a `make_counter_stmt(span, EdgeKind::StmtBlock)` before each statement after the first, gated on `config.trace_stmt_blocks`.
- [x] 4.2 Skip the leading directive prologue and hoisted `FunctionDecl`s; stop inserting after the first terminator (`return`/`throw`/`break`/`continue`).
- [x] 4.3 Key each counter on the following statement's span with `EdgeKind::StmtBlock`.
- [x] 4.4 Add tests: straight-line split into per-statement edges; module-top-level covered; directive + hoisted decl stay first; insertion stops after a terminator; disabled-by-default emits nothing.

## 5. Snapshot / regression safety

- [x] 5.1 Add a test asserting that with both flags off the transform output for a call- and statement-heavy fixture is byte-identical to the pre-change output (no edge-id or shape drift for existing users).

## 6. E2E

- [x] 6.1 Add a `test/e2e-instrumented.test.ts` case: a call-heavy target instrumented with `VITIATE_TRACE_CALLS=1` reports more unique edges than the same target with the flag off; likewise for `VITIATE_TRACE_STMT_BLOCKS=1`.

## 7. Benchmark (efficacy gate)

- [x] 7.1 `node benchmarks/setup.mjs`, then run four arms (baseline / `VITIATE_TRACE_CALLS=1` / `VITIATE_TRACE_STMT_BLOCKS=1` / both) at `--mode smoke --fuzzer vitiate` to confirm 0 INVALID runs and that each flag raises edges vs baseline. DONE (`ab-granularity.mjs` / `ab-resume.mjs`): 0 invalid; edges scale baseline<call<block<both.
- [ ] 7.2 Run the four arms at `--mode full` (300s x 2 x 5 targets); diff the `results/*.json` on corpus size, crashes, time-to-plateau (from `fuzz_sample` JSONL), and execs/sec median. NOT RUN - recommended before any future decision to flip a default on; not required to ship since the default stays off (see 8.1).
- [x] 7.3 Record the diff under `benchmarks/results/` and note the outcome against architecture review item 16. DONE: `benchmarks/results/2026-07-12-ab-granularity-smoke.md`.

## 8. Decision + docs

- [x] 8.1 At the decision gate, flip the `PluginConfig` default to `true` only for the arm(s) that improve corpus/crash/time-to-plateau without an unacceptable throughput regression (< ~15% execs/sec drop); otherwise keep opt-in. DECISION: keep both opt-in (default off). Smoke showed no corpus/crash gain and a real throughput cost (block/both 10-27%; parse block -27% exceeds the gate). No default change.
- [x] 8.2 Document `traceCalls` / `traceStmtBlocks` (and the `VITIATE_TRACE_*` env vars) in `docs/src/content/docs/reference/plugin-options.md` and `reference/environment-variables.md`, and note the finer-granularity option in `concepts/how-it-works.md`.

## 9. Verification

- [x] 9.1 `cargo test -p vitiate-swc-plugin` and full `cargo test --workspace` green. DONE: 81 plugin + 363 engine tests pass.
- [x] 9.2 Rebuild the WASM plugin; core + instrumented e2e green; format/lint clean. DONE: wasm rebuilt (release); vitiate-core suite (1062) + instrumented e2e (4) green; `cargo clippy --workspace --all-targets -D warnings` clean, `cargo fmt --check` clean, eslint + prettier clean. (Full `turbo run test` examples pass-through and `docs:build` not separately re-run; docs edits are markdown-only with valid internal anchors and prettier-clean.)
