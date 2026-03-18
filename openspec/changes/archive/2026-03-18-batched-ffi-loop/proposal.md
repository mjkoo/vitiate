## Why

Every fuzzing iteration currently requires 3-4 JS-to-Rust FFI round-trips (`getNextInput`, `stashInput`, `reportResult`, plus N `traceCmp` calls), and each `getNextInput` allocates a new `Buffer`. Profiling against Jazzer.js shows vitiate is 2-6x slower on throughput-sensitive targets (ipuz: 2.2x, xd: 6x), and while not all of that gap is FFI overhead, reducing per-iteration boundary crossings is the most architecturally tractable improvement available. A batched callback model - where Rust drives N iterations and calls JS only for target execution - reduces the hot-path FFI crossings from ~4/iteration to ~1/iteration, while a pre-allocated input buffer eliminates the per-iteration `Buffer` allocation entirely.

## What Changes

- **New `runBatch` engine method**: Rust-driven mini-loop that accepts a JS callback for target execution, runs N iterations internally (mutation, coverage evaluation, map zeroing, CmpLog drain, shmem stash), and yields back to JS with a batch summary containing any interesting/solution inputs found.
- **Pre-allocated input buffer**: `Fuzzer` constructor allocates a reusable `Buffer` of `maxInputLen` bytes. `runBatch` writes into this buffer instead of allocating per call. The existing `getNextInput` API continues allocating a new Buffer per call (used only for calibration/stages/fallback, where allocation cost is negligible).
- **JS loop restructured**: The main fuzz loop alternates between `runBatch` calls (hot path, ~95%+ of iterations) and JS-side housekeeping (corpus persistence, progress reporting, signal checks, detector lifecycle). Calibration and stages remain JS-orchestrated initially, triggered when `runBatch` reports interesting inputs.
- **Existing per-iteration API preserved**: `getNextInput`/`reportResult` remain available for calibration, stages, and backwards compatibility. The batched path is an addition, not a replacement.

## Capabilities

### New Capabilities
- `batched-ffi-loop`: Rust-driven batched iteration loop with JS target callback, covering the `runBatch` engine method, batch result reporting, and input buffer reuse.

### Modified Capabilities
- `fuzz-loop`: Main loop restructured to call `runBatch` for the hot path, with JS-side housekeeping between batches. Per-iteration `getNextInput`/`reportResult` calls move to calibration/stage paths only.
- `fuzzing-engine`: New `runBatch` method added. Constructor accepts optional `Watchdog` and `ShmemHandle` ownership, allocates reusable input buffer. New `runTarget` and `stashInput` pass-through methods for calibration/stage use.
- `shared-memory-stash`: Stashing moves into the Rust batch loop (called before each target callback invocation) instead of being called from JS per-iteration.
- `progress-reporter`: Stats updates happen between batches rather than per-iteration. Batch size tuned to maintain ~3-second reporting cadence.

## Impact

- **vitiate-engine (Rust)**: New `run_batch` method on `Fuzzer`, pre-allocated input buffer in constructor, `getNextInput` unchanged. New `run_target` and `stash_input` pass-through methods for calibration/stage paths. Watchdog and ShmemHandle ownership moves into Fuzzer constructor.
- **vitiate-core (TypeScript)**: `loop.ts` main loop restructured around `runBatch`. Reporter update frequency changes from per-iteration check to per-batch. Detector `beforeIteration`/`endIteration` hooks are wrapped in the batch callback.
- **NAPI interface**: `Fuzzer` constructor takes optional `Watchdog` and `ShmemHandle` ownership. New `runBatch(targetFn, batchSize, timeoutMs)` method. New `BatchResult` return type.
- **Async targets**: `runBatch` requires synchronous target functions. Async fuzz targets must fall back to the existing per-iteration loop. This is acceptable because fuzz targets should be synchronous for performance.
- **No breaking changes to user-facing API**: `fuzz()` and `vitiateFuzz()` signatures unchanged. The batching is an internal optimization.
