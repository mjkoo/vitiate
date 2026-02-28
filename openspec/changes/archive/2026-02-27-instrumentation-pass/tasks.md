## 1. Plugin Infrastructure

- [x] 1.1 Add plugin configuration struct to `vitiate-instrument` - `PluginConfig` with fields: `coverage_map_size` (u32, default 65536), `trace_cmp` (bool, default true), `coverage_global_name` (String, default `"__vitiate_cov"`), `trace_cmp_global_name` (String, default `"__vitiate_trace_cmp"`). Deserialize from SWC plugin config JSON via serde.
- [x] 1.2 Update `TransformVisitor` to hold config, file path (from plugin metadata, fallback `"unknown"`), and a hash helper for edge ID computation.
- [x] 1.3 Implement edge ID hash function - FNV-1a or multiply-xorshift over (file_path, span.lo, span.hi), output taken modulo `coverage_map_size`. Must be deterministic.
- [x] 1.4 Implement `process_transform` to deserialize config from metadata, extract filename, construct `TransformVisitor` with config and file path, and run the visitor.

## 2. Module Preamble

- [x] 2.1 Implement `visit_mut_module` - insert `var __vitiate_cov = globalThis.__vitiate_cov;` and `var __vitiate_trace_cmp = globalThis.__vitiate_trace_cmp;` as first statements in the module body, using configured global names.
- [x] 2.2 Add `test_inline!` test: module preamble is inserted before existing statements.
- [x] 2.3 Add `test_inline!` test: empty module gets preamble only.

## 3. Edge Coverage - Statements

- [x] 3.1 Implement helper to build AST for `__vitiate_cov[ID]++` as a statement (ExprStmt containing UpdateExpr or AssignExpr).
- [x] 3.2 Implement helper to build AST for `(__vitiate_cov[ID]++, expr)` as a comma expression (SeqExpr).
- [x] 3.3 Implement `visit_mut_if_stmt` - ensure consequent is a block (wrap if single stmt), prepend counter. If alternate exists and is not a block, wrap it. If alternate exists, prepend counter to it. Do NOT synthesize an alternate if none exists.
- [x] 3.4 Add `test_inline!` test: if/else - both branches get counters.
- [x] 3.5 Add `test_inline!` test: if without else - consequent gets counter, no alternate synthesized.
- [x] 3.6 Add `test_inline!` test: if without braces - consequent wrapped in block.
- [x] 3.7 Implement `visit_mut_cond_expr` - wrap consequent and alternate with comma expressions.
- [x] 3.8 Add `test_inline!` test: ternary - both arms wrapped.
- [x] 3.9 Implement `visit_mut_switch_case` - prepend counter to each case's statement list (including empty fall-through cases).
- [x] 3.10 Add `test_inline!` test: switch with cases and default.
- [x] 3.11 Add `test_inline!` test: switch with empty fall-through case.

## 4. Edge Coverage - Loops

- [x] 4.1 Implement `visit_mut_for_stmt` - ensure body is a block, prepend counter.
- [x] 4.2 Implement `visit_mut_while_stmt` - ensure body is a block, prepend counter.
- [x] 4.3 Implement `visit_mut_do_while_stmt` - ensure body is a block, prepend counter.
- [x] 4.4 Implement `visit_mut_for_in_stmt` - ensure body is a block, prepend counter.
- [x] 4.5 Implement `visit_mut_for_of_stmt` - ensure body is a block, prepend counter.
- [x] 4.6 Add `test_inline!` test: for loop body gets counter.
- [x] 4.7 Add `test_inline!` test: while loop without braces - body wrapped in block.
- [x] 4.8 Add `test_inline!` test: for-of loop body gets counter.

## 5. Edge Coverage - Logical Operators & Functions

- [x] 5.1 Implement `visit_mut_bin_expr` for logical operators (`&&`, `||`, `??`) - wrap right-hand side with comma expression containing counter.
- [x] 5.2 Add `test_inline!` test: logical AND - rhs wrapped.
- [x] 5.3 Add `test_inline!` test: nullish coalescing - rhs wrapped.
- [x] 5.4 Add `test_inline!` test: chained logical operators - each rhs wrapped with distinct counter.
- [x] 5.5 Implement `visit_mut_catch_clause` - prepend counter to catch body.
- [x] 5.6 Add `test_inline!` test: try/catch - catch body gets counter.
- [x] 5.7 Implement `visit_mut_function` - prepend counter to function body (covers function declarations, function expressions, arrow functions with block bodies, methods).
- [x] 5.8 Add `test_inline!` test: function declaration - body gets counter.
- [x] 5.9 Add `test_inline!` test: arrow function with block body - body gets counter.
- [x] 5.10 Add `test_inline!` test: arrow function with expression body - NOT modified.

## 6. Comparison Tracing

- [x] 6.1 Implement `visit_mut_bin_expr` for comparison operators (`===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`) - replace with `__vitiate_trace_cmp(left, right, cmpId, "op")` call expression. Skip if `config.trace_cmp` is false.
- [x] 6.2 Ensure `visit_mut_bin_expr` correctly distinguishes logical operators (edge counter) from comparison operators (trace wrapper) - a single node gets one or the other, never both.
- [x] 6.3 Add `test_inline!` test: strict equality wrapped with trace_cmp.
- [x] 6.4 Add `test_inline!` test: less-than wrapped with trace_cmp.
- [x] 6.5 Add `test_inline!` test: comparison inside logical expression - both trace wrappers and edge counter present, no double instrumentation.
- [x] 6.6 Add `test_inline!` test: arithmetic operators NOT wrapped.
- [x] 6.7 Add `test_inline!` test: trace_cmp disabled via config - comparisons untouched.

## 7. Integration Tests

- [x] 7.1 Add `test_inline!` test: nested constructs - if inside for inside function - all get counters at correct positions.
- [x] 7.2 Add `test_inline!` test: full example from design doc - function with if/else, comparison tracing, and preamble, verifying complete output shape.

## 8. Napi traceCmp Stub

- [x] 8.1 Create `vitiate-napi/src/trace.rs` with `trace_cmp(left, right, cmp_id, op)` napi function - dispatch on op string to perform the correct JS comparison using napi value APIs, return boolean result.
- [x] 8.2 Wire up `trace.rs` module in `vitiate-napi/src/lib.rs`.
- [x] 8.3 Add Rust unit tests for `trace_cmp` operator dispatch logic.
- [x] 8.4 Add `traceCmp` tests to `vitiate-napi/test/smoke.mjs` - verify correct results for each operator (`===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`) with various value types (numbers, strings, mixed types).
- [x] 8.5 Verify auto-generated `index.d.ts` includes `traceCmp` export.

## 9. Build Verification

- [x] 9.1 `cargo test -p vitiate-instrument` passes all tests.
- [x] 9.2 `cargo build-wasip1 -p vitiate-instrument` produces a valid `.wasm` artifact.
- [x] 9.3 `cargo test -p vitiate-napi` passes with new `traceCmp` tests.
- [x] 9.4 `pnpm run test` in `vitiate-napi` passes smoke test including `traceCmp`.
