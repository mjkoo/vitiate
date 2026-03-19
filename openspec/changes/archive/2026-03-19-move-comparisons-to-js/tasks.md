## 1. Engine: Replace traceCmp with traceCmpRecord

- [x] 1.1 Add `CmpLogOperator::from_id(u32) -> Option<CmpLogOperator>` in `cmplog.rs`, mapping IDs 0-7 to the corresponding operator enum variants. Note: IDs 6 (`<=`) and 7 (`>=`) intentionally map to `Less` and `Greater` respectively - the "or equal" distinction is not needed for I2S mutations. Remove `CmpLogOperator::from_op()` and its tests (it will have no callers)
- [x] 1.2 Rename `trace_cmp` to `trace_cmp_record` in `trace.rs`, change return type from `Result<bool>` to bare `()` (not `Result<()>` - bare void guarantees napi-rs can never convert an `Err` into a JS exception), replace `op: String` parameter with `operator_id: u32`, use `CmpLogOperator::from_id()` instead of `from_op()`. The function MUST NOT propagate errors to JS - an internal closure catches all errors and silently discards them (the record call precedes the comparison in the IIFE body, so a throw would skip the comparison)
- [x] 1.3 Delete `eval_comparison`, `call_js_comparison`, and `KNOWN_OPS` from `trace.rs`
- [x] 1.4 Update or remove existing `trace_cmp` unit tests: rename to `trace_cmp_record`, change assertions from boolean return to void, replace string operator args with integer IDs, remove `from_op` tests, add test for invalid operator ID (should not panic/throw)

## 2. SWC Plugin: Emit IIFE-wrapped comparisons

- [x] 2.1 Add `comparison_op_id(op: BinaryOp) -> u8` function mapping each comparison operator to its numeric ID (0-7)
- [x] 2.2 Change `trace_cmp_global_name` default from `"__vitiate_trace_cmp"` to `"__vitiate_trace_cmp_record"` in `PluginConfig::default()`
- [x] 2.3 Rewrite `make_trace_cmp_call` to emit an IIFE: `((l, r) => (__vitiate_trace_cmp_record(l, r, cmpId, opId), l OP r))(left, right)` - the arrow function parameters `l` and `r` isolate operands from re-entrant instrumentation (nested comparisons, same-module function calls). Pass a numeric literal for operator ID instead of a string
- [x] 2.4 Update `visit_mut_module` and `visit_mut_script` preamble emission: when `trace_cmp` is enabled, ensure the `var __vitiate_trace_cmp_record = globalThis.__vitiate_trace_cmp_record;` declaration is emitted (no temporary variable declarations are needed - the IIFE parameters provide operand isolation)
- [x] 2.5 Update all SWC plugin tests: preamble assertions (no temp var declarations), trace_cmp output shape assertions (IIFE format), comparison-inside-logical tests, and full example tests to match the new IIFE format and `__vitiate_trace_cmp_record` name

## 3. Core: Update runtime globals

- [x] 3.1 Change `globalThis.__vitiate_trace_cmp` to `globalThis.__vitiate_trace_cmp_record` in `globals.ts`, update the global type declaration from `(...) => boolean` to `(...) => void`, change the `op: string` parameter to `operatorId: number`
- [x] 3.2 In fuzzing mode, assign `globalThis.__vitiate_trace_cmp_record = traceCmpRecord` (importing the renamed napi function)
- [x] 3.3 In regression mode, assign `globalThis.__vitiate_trace_cmp_record = () => {}` (no-op, no comparison evaluation)
- [x] 3.4 Remove the `ops` lookup table and comparison-evaluating closure from regression mode setup
- [x] 3.5 Update `traceCmpGlobalName` default in `plugin.ts` from `"__vitiate_trace_cmp"` to `"__vitiate_trace_cmp_record"`
- [x] 3.6 Update test files that reference the old global name: `setup.test.ts`, `loop.test.ts`, `integration.test.ts`, `plugin.test.ts`

## 4. Integration testing

- [x] 4.1 Run the full test suite (`pnpm test`) and fix any remaining failures from the renamed globals, changed signatures, or new output format
- [x] 4.2 Run e2e fuzz tests (`pnpm test:e2e`) to verify the full pipeline still finds planted bugs
- [x] 4.3 Run all lints and checks from `lefthook.yml`: eslint, clippy, prettier, cargo fmt, cargo deny, cargo autoinherit, cargo msrv
