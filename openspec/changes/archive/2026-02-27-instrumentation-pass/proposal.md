## Why

The fuzzing engine (`vitiate-napi`) is complete and tested — it can mutate inputs, evaluate
coverage feedback, detect crashes, and manage a corpus. But there is no coverage feedback to
evaluate. The engine reads a coverage map that is always zero because nothing writes to it.

The missing piece is compile-time instrumentation: an SWC WASM plugin that transforms
JavaScript source code to insert coverage counters and comparison tracing hooks at every
branch point. Without this, the fuzzer is blind — it mutates inputs randomly with no
guidance from the target's control flow. This is the component that turns random mutation
into coverage-guided fuzzing.

Additionally, the napi bridge has no function for comparison tracing. The instrumentation
will emit `__vitiate_trace_cmp` calls, so the runtime needs something to call — even if
the actual value-profile feedback loop isn't wired up to LibAFL yet.

## What Changes

- **Implement the SWC instrumentation plugin** (`vitiate-instrument`). The existing stub
  `TransformVisitor` is replaced with a real visitor that inserts edge coverage counters at
  every branch point and wraps comparison operators with tracing calls. The plugin accepts
  configuration (coverage map size, global names, trace-cmp toggle) via SWC's plugin config
  JSON.
- **Add `traceCmp` to the napi bridge** (`vitiate-napi`). A new `trace.rs` module exports a
  passthrough comparison function that performs the comparison and returns the boolean result.
  It does not feed operands to LibAFL in this iteration — full CmpLog integration is a
  separate change.
- **Add comprehensive SWC fixture tests** for every instrumented construct (if/else, ternary,
  switch, loops, logical operators, catch, functions, comparisons, nested constructs).
- **Add smoke test coverage** for the new `traceCmp` napi export.

## Capabilities

### New Capabilities

- `edge-coverage`: SWC plugin inserts `__vitiate_cov[EDGE_ID]++` at every branch point in
  the source code, producing the coverage feedback that LibAFL's `MaxMapFeedback` reads.
- `comparison-tracing`: SWC plugin wraps comparison operators (`===`, `!==`, `<`, `>`,
  `<=`, `>=`, `==`, `!=`) with `__vitiate_trace_cmp(left, right, id, op)` calls that
  report operands for value-profile-guided mutation.
- `trace-cmp-bridge`: Napi bridge exports `traceCmp()` for the TypeScript runtime to
  delegate comparison tracing calls to. Passthrough-only in this iteration.

### Modified Capabilities

_None — existing `coverage-map` and `fuzzing-engine` specs are unaffected._

## Impact

- **Crates:** `vitiate-instrument` goes from stub to full implementation. `vitiate-napi`
  gains a new `trace.rs` module with one exported function.
- **Dependencies:** `vitiate-instrument` may need a hash crate (or inline FNV-1a) for edge
  ID computation. No new workspace-level dependencies expected.
- **npm packages:** `vitiate-napi` gains a `traceCmp` TypeScript type export. The
  `vitiate-instrument` WASM artifact changes from identity transform to real instrumentation.
- **Build:** No new build targets or toolchain requirements. The `wasm32-wasip1` target is
  already configured.
