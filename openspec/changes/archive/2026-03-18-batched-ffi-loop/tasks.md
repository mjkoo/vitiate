## 1. Rust Engine: Fuzzer Constructor Changes

- [x] 1.1 Add optional `Watchdog` parameter to `Fuzzer` constructor NAPI signature and store as owned field
- [x] 1.2 Add optional `ShmemHandle` parameter to `Fuzzer` constructor NAPI signature and store as owned field (extract inner `ShmemStash` or raw shmem pointer for internal use)
- [x] 1.3 Allocate pre-allocated input `Buffer` of `maxInputLen` bytes in constructor and store as field (with raw pointer for zero-copy writes)
- [x] 1.4 Expose `stashInput(input: Buffer)` NAPI method that delegates to owned `ShmemHandle`'s seqlock write (no-op if no handle)
- [x] 1.5 Expose `runTarget(target, input, timeoutMs)` NAPI method that delegates to owned `Watchdog`'s `runTarget` for V8 termination-safe target execution (direct call if no watchdog), returning `{ exitKind, error?, result? }`
- [x] 1.6 Expose `armWatchdog(timeoutMs)` and `disarmWatchdog()` NAPI methods that delegate to owned Watchdog (no-op if no watchdog) for async target continuation
- [x] 1.7 Expose `shutdown()` NAPI method that shuts down the owned Watchdog thread (no-op if no watchdog)
- [x] 1.8 Update auto-generated `index.d.ts` types (rebuild with `napi build`) and verify new constructor signature, `stashInput`, `runTarget`, `armWatchdog`, `disarmWatchdog`, and `shutdown` appear correctly

## 2. Rust Engine: Refactor Shared Logic

- [x] 2.1 Extract mutation + corpus selection logic from `get_next_input` into a shared helper that both `get_next_input` (allocates new Buffer) and `run_batch` (writes into pre-allocated buffer) can call
- [x] 2.2 Extract post-evaluation logic from `report_result` (CmpLog drain, token promotion, metadata build, calibration prep, feature detection recording) into a shared helper that both `report_result` and `run_batch` can call
- [x] 2.3 Verify `get_next_input` and `report_result` still pass all existing tests after refactoring

## 3. Rust Engine: `runBatch` Method

- [x] 3.1 Add `BatchResult` struct with `executionsCompleted`, `exitReason`, optional `triggeringInput`, and optional `solutionExitKind` fields; add NAPI type definition
- [x] 3.2 Implement `run_batch(callback, batch_size, timeout_ms)` method on `Fuzzer` - outer loop structure with early-exit on interesting/solution/error
- [x] 3.3 Per-iteration body: select corpus entry and mutate (via shared helper from 2.1), write bytes into pre-allocated buffer
- [x] 3.4 Per-iteration body: stash input via owned `ShmemStash` before callback (skip if no handle)
- [x] 3.5 Per-iteration body: arm watchdog before callback, disarm after (skip if no watchdog); handle watchdog-triggered V8 termination as `ExitKind::Timeout`
- [x] 3.6 Per-iteration body: measure execution time with `std::time::Instant` around the callback invocation
- [x] 3.7 Per-iteration body: invoke JS callback via NAPI with `(inputBuffer, inputLength)`, interpret return value as `ExitKind` (treat invalid values as `Ok`), catch NAPI errors as unrecoverable
- [x] 3.8 Per-iteration body: call `evaluate_coverage()` with measured time and determined `ExitKind`, handle interesting/solution flags
- [x] 3.9 Per-iteration body: call shared post-evaluation helper (CmpLog drain, token promotion, metadata build, feature detection recording, coverage map zeroing, increment `total_execs`) from 2.2
- [x] 3.10 On interesting: prepare calibration state (via shared helper), set `last_interesting_corpus_id`, copy input bytes for `BatchResult.triggeringInput`
- [x] 3.11 On solution: add to solutions corpus, increment `solution_count`, copy input bytes for `BatchResult.triggeringInput`, set `solutionExitKind`
- [x] 3.12 Construct and return `BatchResult` NAPI object
- [x] 3.13 Handle seed evaluation within batch (drain `unevaluated_seeds` queue verbatim, same as `get_next_input`)
- [x] 3.14 Verify `BatchResult` type appears correctly in auto-generated `index.d.ts`

## 4. TypeScript: Fuzz Loop Restructuring

- [x] 4.1 Update `Fuzzer` construction in `loop.ts`: pass `Watchdog` and `ShmemHandle` to constructor instead of managing them separately
- [x] 4.2 Replace `watchdog.runTarget(...)` calls in calibration/stage/minimization with `fuzzer.runTarget(...)`
- [x] 4.3 Replace `shmemHandle.stashInput(...)` calls in calibration/stage/minimization with `fuzzer.stashInput(...)`
- [x] 4.4 Replace `watchdog.shutdown()` in finally block with `fuzzer.shutdown()`
- [x] 4.5 Add async target detection: run first iteration via per-iteration path, check if target returns a Promise, set `isAsyncTarget` flag
- [x] 4.6 Construct batch callback wrapper function with detector lifecycle hooks (per design D6: `beforeIteration` -> target -> `endIteration` -> return ExitKind; return 1 for all caught exceptions including both VulnerabilityError and regular target throws)
- [x] 4.7 Implement adaptive batch size calculation: `clamp(floor(fuzzer.stats.execsPerSec * reportIntervalSeconds), 16, 1024)`, start at 16 for first batch
- [x] 4.8 Restructure main fuzz loop: for sync targets, call `fuzzer.runBatch(callback, batchSize, timeoutMs)` instead of per-iteration `getNextInput`/`reportResult`
- [x] 4.9 Handle `BatchResult.exitReason === "interesting"`: write corpus entry, run existing calibration loop (using `fuzzer.runTarget`), run existing stage loop (using `fuzzer.runTarget`)
- [x] 4.10 Handle `BatchResult.exitReason === "solution"`: if `solutionExitKind === 2` (Timeout), write artifact directly; if `solutionExitKind === 1` (Crash), replay via `fuzzer.runTarget` with detectors to classify error type, then minimize/dedup/write artifact
- [x] 4.11 Handle `BatchResult.exitReason === "error"`: log error, check termination conditions
- [x] 4.12 Move event loop yield (`setImmediate`) to between batches instead of every 1000 iterations (keep per-1000 yield for async fallback path)
- [x] 4.13 Check termination conditions (SIGINT, `stopOnCrash`, `maxCrashes`, time limit, iteration limit) between batches
- [x] 4.14 Preserve per-iteration fallback path for async targets (existing code, using `fuzzer.stashInput` and `fuzzer.runTarget`)

## 5. Testing

- [x] 5.1 Unit tests for `runBatch`: batch completes fully (no interesting), early exit on interesting, early exit on solution, early exit on callback error, empty batch size, invalid callback return value treated as Ok
- [x] 5.2 Unit tests for `runBatch` with watchdog: timeout during callback triggers early exit with solution and `solutionExitKind=2`, no watchdog is no-op
- [x] 5.3 Unit tests for `runBatch` with shmem: input stashed before each callback, no shmem handle is no-op
- [x] 5.4 Unit tests for pre-allocated buffer: same Buffer object passed to every callback, `triggeringInput` is an independent copy
- [x] 5.5 Unit tests for `stashInput` pass-through: delegates to owned handle, no-op without handle
- [x] 5.6 Unit tests for `runTarget` pass-through: delegates to owned watchdog, direct call without watchdog, handles timeout and exception
- [x] 5.7 Unit tests for `armWatchdog`/`disarmWatchdog`: delegates to owned watchdog, no-op without watchdog
- [x] 5.8 Unit tests for `shutdown`: shuts down watchdog thread, no-op without watchdog
- [x] 5.9 Unit tests for constructor: accepts Watchdog and ShmemHandle, pre-allocates buffer of `maxInputLen` bytes
- [x] 5.10 Unit tests for batch callback wrapper: detector hooks called per-iteration, VulnerabilityError returned as ExitKind.Crash, regular target exceptions returned as ExitKind.Crash (not re-thrown)
- [x] 5.11 Unit tests for adaptive batch size: fast target gets large batch, slow target gets small batch, first batch uses minimum, clamped to 16-1024
- [x] 5.12 Unit tests for async target detection: Promise-returning target triggers per-iteration fallback
- [x] 5.13 Unit tests for `solutionExitKind`: crash solution has exitKind=1, timeout solution has exitKind=2
- [x] 5.14 Run full existing test suite (`pnpm test`) to verify no regressions in `getNextInput`/`reportResult`/calibration/stages
- [x] 5.15 Run e2e-fuzz tests (`pnpm test:e2e`) to verify end-to-end fuzzing still works with batched path
- [x] 5.16 Run e2e-detectors tests to verify detectors work correctly within batch callback wrapper

## 6. Lint, Format, and CI

- [x] 6.1 Run `cargo clippy` (deny all warnings) and fix any issues
- [x] 6.2 Run `cargo fmt` and `cargo deny`
- [x] 6.3 Run `eslint` and `prettier` on TypeScript changes
- [x] 6.4 Run `cargo msrv` and `cargo autoinherit` to verify MSRV and workspace inheritance
