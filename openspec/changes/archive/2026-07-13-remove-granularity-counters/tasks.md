## 1. SWC plugin (vitiate-swc-plugin/src/lib.rs)

- [x] 1.1 Remove `EdgeKind::Call` and `EdgeKind::StmtBlock` variants and their `value()` match arms (keep Block=0, ElseNotTaken=1, LoopExit=2, Cmp=3 unchanged)
- [x] 1.2 Remove the `trace_calls` / `trace_stmt_blocks` fields from `PluginConfig` and their `Default` impl entries
- [x] 1.3 Remove `is_instrumentable_call` and the `trace_calls`-guarded call-site wrapping block in `visit_mut_expr`
- [x] 1.4 Remove `insert_stmt_block_counters` (and orphaned `is_directive`/`is_terminator` helpers) and its two `trace_stmt_blocks`-guarded call sites in the statement / module-item visitors
- [x] 1.5 Update/remove doc comments that reference the removed kinds/flags; leave the comparison-valued arm span fix (real `right_span`/`cons_span`/`alt_span` with `EdgeKind::Block`) untouched
- [x] 1.6 Remove the `#[cfg(test)]` unit tests that exercise call-site / statement-block instrumentation; `cargo test` (66 pass) + `cargo clippy` + `cargo fmt` clean

## 2. Core config + plugin (vitiate-core/src)

- [x] 2.1 config.ts: remove `traceCalls` / `traceStmtBlocks` from the options schema, the `get`/`set` accessors, `resetTraceFlags`, and the two `VITIATE_TRACE_*` entries from the known-env-var allowlist
- [x] 2.2 plugin.ts: remove reading the two options in `config()`, setting the two `VITIATE_TRACE_*` env vars for workers, and passing `traceCalls` / `traceStmtBlocks` into the SWC plugin options
- [x] 2.3 Remove the trace-flag test cases from config.test.ts and plugin.test.ts

## 3. Docs

- [x] 3.1 reference/plugin-options.md: remove the `traceCalls` / `traceStmtBlocks` rows
- [x] 3.2 reference/environment-variables.md: remove `VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS`

## 4. Verify

- [x] 4.1 Build all packages (`pnpm build`) green; regenerated `.d.ts` no longer exposes the two options (grep clean)
- [x] 4.2 Confirm default (flags-off) instrumentation output is byte-identical: swc-plugin snapshot tests (66) + instrumentation e2e suite pass unchanged
- [x] 4.3 Full suite green (core unit + e2e + instrumented; engine `cargo test` 363; swc-plugin 66); eslint + clippy (-D warnings) + fmt clean
- [x] 4.4 `openspec validate remove-granularity-counters --strict` passes
