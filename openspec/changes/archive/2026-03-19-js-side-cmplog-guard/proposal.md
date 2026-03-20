## Why

NAPI boundary crossing now accounts for ~29% of wall time in profiled benchmarks (`CallbackInfo::new` 9.6%, `napi_get_cb_info` 9.0%, `FunctionCallbackWrapper::Invoke` 7.2%, `GetFunctionTemplateData` 3.2%). Every instrumented comparison calls `trace_cmp_record` through the JS-to-Rust NAPI boundary. The per-site cap optimization eliminated serialization overhead, but every comparison - whether it produces a recorded entry or not - still pays the full V8 C++ callback dispatch cost just to cross into Rust.

## What Changes

- **Shared-memory slot buffer**: JS writes comparison operands (type tag + raw bytes) directly into a Rust-owned shared-memory slot buffer instead of calling the NAPI `traceCmpRecord`. Rust reads and processes entries in bulk during `drain()`, converting them into the same `CmpValues` entries as before. This eliminates per-comparison NAPI crossings entirely.
- **JS-side guard and serialization**: The comparison trace function becomes pure JS. It checks the shared write pointer (which doubles as the enabled/disabled flag) and a JS-local per-site count array, serializes operands (`typeof` + `DataView` writes), and writes to the slot buffer. No NAPI call occurs on the hot path.
- **SWC plugin updated**: The plugin emits calls to a new `__vitiate_cmplog_write` function (defined in `globals.ts`) instead of `__vitiate_trace_cmp_record`. The IIFE pattern for operand isolation is preserved.
- **NAPI `traceCmpRecord` removed**: The slot buffer replaces the NAPI function for all paths including colorization. The NAPI function is removed (or gated to `#[cfg(test)]`).

## Capabilities

### New Capabilities

- `cmplog-slot-buffer`: The shared-memory slot buffer protocol between JS and Rust for zero-NAPI comparison tracing. Covers buffer layout, JS write protocol, Rust bulk processing, and overflow handling.

### Modified Capabilities

- `runtime-setup`: Trace function initialization changes from binding to NAPI `traceCmpRecord` to setting up the slot buffer write function once during `initGlobals()`. The function is never swapped at runtime; enable/disable operates through the shared write pointer value.
- `trace-cmp-bridge`: The `@vitiate/engine` package replaces the `traceCmpRecord` export with slot buffer allocation exports (`cmplogGetSlotBuffer`, `cmplogGetWritePointer`). `enable()`/`disable()` set the shared write pointer (`0` for enabled, `0xFFFFFFFF` for disabled) - no function swap or JS signaling needed.
- `cmplog-feedback`: `drain()` gains a slot buffer processing step that deserializes entries and feeds them through existing `serialize_pair()` / `push()`.
- `comparison-tracing`: The SWC plugin emits calls to `__vitiate_cmplog_write` instead of `__vitiate_trace_cmp_record`, with updated preamble variables.

## Impact

- **vitiate-core/src/globals.ts**: `initGlobals()` allocates JS-local guard state, creates `DataView`/`Uint8Array` views over the shared slot buffer, and defines the `__vitiate_cmplog_write` function.
- **vitiate-engine/src/cmplog.rs**: `CmpLogState` gains a heap-allocated slot buffer and write pointer for shared memory. `drain()` gains bulk slot buffer processing. New NAPI exports for slot buffer and write pointer allocation.
- **vitiate-engine/src/trace.rs**: `trace_cmp_record` removed or gated to `#[cfg(test)]`.
- **vitiate-swc-plugin/src/lib.rs**: Updated global names in preamble and comparison IIFE.
- **vitiate-core/src/loop.test.ts**: Test helpers updated to use `__vitiate_cmplog_write` instead of `__vitiate_trace_cmp_record`.
- **No changes to**: mutation pipeline, corpus management, metadata consumers, REDQUEEN, I2S, or the fuzz loop. The optimization is within the trace-cmp call path.
- **Spec correction**: The `cmplog-feedback` "JS value serialization to CmpValues" requirement now lists `U64` alongside `U8`/`U16`/`U32` as a possible integer variant. This corrects the existing spec to match the implementation - `serialize_number_pair` already handles `U64` for values exceeding `u32::MAX`. No code change.
