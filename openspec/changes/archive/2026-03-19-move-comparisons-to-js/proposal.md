## Why

The `eval_comparison()` function in `vitiate-engine/src/trace.rs` calls `env.run_script()` on every non-strict comparison (`<`, `>`, `<=`, `>=`, `==`, `!=`) to retrieve a cached JS function and execute it. Although the comparison function is cached on `globalThis`, V8 must hash the script source, look it up in its compilation cache, and bind it to the current context on every call. Profiling on the xword-parser PUZ target shows this accounts for 42% of wall time, making vitiate 25x slower than jazzer.js on targets with tight binary-parsing loops full of relational comparisons. The fix is to keep the comparison in JavaScript (where V8 can JIT-inline it) and reduce the native call to fire-and-forget cmplog recording only.

## What Changes

- **BREAKING**: The SWC plugin emits an IIFE (immediately invoked arrow function) that receives the operands as arguments, calls a record-only tracing function, then performs the original comparison in JS - instead of replacing the comparison with a `__vitiate_trace_cmp()` call that returns the result.
- **BREAKING**: The `@vitiate/engine` napi export changes from `traceCmp(left, right, cmpId, op) -> boolean` to `traceCmpRecord(left, right, cmpId, operatorId) -> void`. The `op` string parameter becomes a numeric `operatorId`. It only records operands for cmplog; it does not perform the comparison.
- The `__vitiate_trace_cmp` global is replaced by `__vitiate_trace_cmp_record`. In regression mode this is a no-op. In fuzz mode it delegates to the napi `traceCmpRecord`.
- The `eval_comparison()` function and its `call_js_comparison()` helper in `trace.rs` are deleted entirely.

## Capabilities

### New Capabilities

_None_ - this is a restructuring of existing capabilities, not new functionality.

### Modified Capabilities

- `comparison-tracing`: The SWC plugin's output format changes. Instead of replacing comparisons with a function call that returns the result, it emits an IIFE that records operands then evaluates the original comparison inline.
- `trace-cmp-bridge`: The napi function signature changes from `traceCmp(left, right, cmpId, op) -> boolean` to `traceCmpRecord(left, right, cmpId, operatorId) -> void`. The `op` string becomes a numeric `operatorId`. It no longer evaluates the comparison itself.
- `runtime-setup`: The global name changes from `__vitiate_trace_cmp` to `__vitiate_trace_cmp_record`, and its type changes from `(left, right, cmpId, op) => boolean` to `(left, right, cmpId, operatorId) => void`. Regression mode becomes a no-op function instead of a comparison evaluator.

## Impact

- **vitiate-swc-plugin** (`src/lib.rs`): `make_trace_cmp_call` rewritten to emit IIFE-wrapped comparison. `visit_mut_expr` updated to produce the new shape. Config field `trace_cmp_global_name` default changes.
- **vitiate-engine** (`src/trace.rs`): `trace_cmp` renamed to `trace_cmp_record`, return type changed to `()`. `eval_comparison`, `call_js_comparison`, `KNOWN_OPS` deleted.
- **vitiate-core** (`src/globals.ts`): `__vitiate_trace_cmp` replaced with `__vitiate_trace_cmp_record`. Fuzz mode points to napi `traceCmpRecord`. Regression mode becomes `() => {}`.
- **vitiate-core** (`src/types.ts` or global type declarations): Global type updated.
- **Tests**: SWC plugin snapshot tests, trace.rs unit tests, and e2e fuzz tests all need updating.
- **No user-facing API changes**: The `fuzz()` API, CLI, and vitest plugin configuration are unchanged. This is an internal instrumentation change.
