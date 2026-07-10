## 1. Edge ID: mixing + edge-kind discriminant (C5 core)

- [x] 1.1 Add an `EdgeKind` enum (`Block`, `ElseNotTaken`, `LoopExit`, `Cmp`) with a `discriminant()` accessor in `vitiate-swc-plugin/src/lib.rs`.
- [x] 1.2 Rewrite `edge_id` to take an `EdgeKind`, fold the discriminant into the FNV-1a accumulator, apply a murmur3 `fmix64` finalizer over the full 64-bit hash, and reduce with a `u64` modulo.
- [x] 1.3 Thread `EdgeKind` through `make_counter_expr`/`make_counter_stmt`; route existing block-entry counters as `Block` and the CmpLog `cmpId` as `Cmp`.
- [x] 1.4 Update the hard-coded edge IDs in the existing plugin tests and add a test that `Block`/`ElseNotTaken`/`LoopExit`/`Cmp` yield distinct IDs at a shared span.

## 2. Not-taken else (C1a)

- [x] 2.1 In `visit_mut_if_stmt`, capture the consequent/alternate spans before `ensure_block`, and when `alt` is `None` synthesize `else { __vitiate_cov[id]++ }` using `EdgeKind::ElseNotTaken` on the consequent span.
- [x] 2.2 Update the `if_no_else` test (now expects a synthesized else + a distinct not-taken counter).

## 3. Loop-exit counters (C1b)

- [x] 3.1 Move `ensure_block` to run before `visit_mut_children_with` in the five loop visitors and `visit_mut_if_stmt` (pre-order normalization) so nested braceless loops land in a real statement list.
- [x] 3.2 Add a `loop_exit_span` helper that peels `Stmt::Labeled` to the underlying loop, and a shared `insert_loop_exit_counters` that inserts one `EdgeKind::LoopExit` counter after each loop.
- [x] 3.3 Implement `visit_mut_stmts` (block/function/switch-case/script bodies) and `visit_mut_module_items` (module top level) to call the shared inserter.
- [x] 3.4 Add tests: loop-exit for each loop kind; labeled loop keeps `continue outer`; nested braceless loops both instrumented; module-top-level loop instrumented.

## 4. Collision-pressure warning (C5 detection)

- [x] 4.1 Count coverage counters emitted per file (a `Cell<u32>` incremented in `make_counter_expr`) and inject `globalThis.__vitiate_edge_count = (globalThis.__vitiate_edge_count | 0) + N;` into the module/script preamble (explicitly parenthesized).
- [x] 4.2 Declare and read `__vitiate_edge_count` in `vitiate-core/src/globals.ts` (`getInstrumentedEdgeCount`).
- [x] 4.3 Add `warnOnCoverageMapLoad` to `vitiate-core/src/reporter.ts` and call it from `loop.ts` at campaign start; warn at >= 2% load, independent of quiet mode.
- [x] 4.4 Add reporter tests for the warning (fires above threshold, silent below, silent when unset).

## 5. Docs

- [x] 5.1 Update `docs/src/content/docs/concepts/how-it-works.md` (both-sides-of-branch model, edge-kind + finalizer, collision warning).
- [x] 5.2 Document the collision-pressure warning under `coverageMapSize` in `docs/src/content/docs/reference/plugin-options.md`.

## 6. Verification

- [x] 6.1 `cargo test -p vitiate-swc-plugin` and full `cargo test --workspace` green.
- [x] 6.2 Rebuild the WASM plugin; `turbo run test` (core + examples) green; format/lint/docs-build clean.
- [x] 6.3 Re-run `benchmarks/` and record the coverage lift (smoke: edges +60-101% across targets; full 300s x2 run pending).
