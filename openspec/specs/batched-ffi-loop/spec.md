## Purpose

The batched-ffi-loop capability provides a high-performance batched execution path for the fuzzing engine. Instead of crossing the JS/Rust FFI boundary for every iteration, `runBatch()` executes multiple iterations in a tight Rust-internal loop, calling a JS callback once per iteration for target execution. This reduces per-iteration FFI overhead and enables Rust-side timing, watchdog management, and shmem stashing.

## Requirements

### Requirement: Batched iteration execution

The `Fuzzer` SHALL provide a `runBatch(callback, batchSize, timeoutMs)` method that executes up to `batchSize` fuzzing iterations in a tight Rust-internal loop, calling `callback` once per iteration for target execution.

For each iteration within the batch:
1. Select corpus entry and apply mutation pipeline (same as `getNextInput`)
2. Write mutated bytes into the pre-allocated input buffer
3. Stash the input via the owned `ShmemHandle` (if present)
4. Arm the owned `Watchdog` with `timeoutMs` (if present)
5. Record start time via `std::time::Instant`
6. Call `callback(inputBuffer, inputLength)`
7. Disarm the watchdog (if present)
8. Record elapsed time
9. Determine `ExitKind` from callback return value or exception
10. Call shared `evaluate_coverage()` helper (same as `reportResult`)
11. Drain CmpLog accumulator, extract tokens, build metadata
12. If interesting: record for feature auto-detection (same as `reportResult`'s `features.record_interesting()` call)
13. Zero coverage map
14. Increment `total_execs` and `state.executions`
15. If evaluation returns interesting or solution: exit batch immediately

The method SHALL return a `BatchResult` object. Seed evaluation (unevaluated seeds queue) SHALL proceed normally within the batch - seeds are returned verbatim without mutation, same as `getNextInput`.

#### Scenario: Batch completes without interesting inputs
- **WHEN** `runBatch` is called with `batchSize=64` and no iteration produces new coverage or a crash
- **THEN** `BatchResult.executionsCompleted` equals 64 and `BatchResult.exitReason` equals `"completed"`

#### Scenario: Batch exits early on interesting input
- **WHEN** an iteration within the batch produces new coverage
- **THEN** the batch stops immediately, `BatchResult.exitReason` equals `"interesting"`, `BatchResult.triggeringInput` contains a copy of the input bytes, and calibration state is prepared for the new corpus entry

#### Scenario: Batch exits early on solution
- **WHEN** an iteration within the batch results in `ExitKind.Crash` or `ExitKind.Timeout` that evaluates as a solution
- **THEN** the batch stops immediately, `BatchResult.exitReason` equals `"solution"`, `BatchResult.triggeringInput` contains a copy of the input bytes, and the input is added to the solutions corpus

#### Scenario: Batch exits early on callback error
- **WHEN** the callback throws an uncaught JavaScript exception
- **THEN** the batch stops immediately, `BatchResult.exitReason` equals `"error"`, `BatchResult.triggeringInput` contains a copy of the current input bytes, the watchdog is disarmed, and the coverage map is zeroed

#### Scenario: Watchdog timeout during batch callback
- **WHEN** the watchdog fires during a callback invocation (target exceeds `timeoutMs`)
- **THEN** V8 terminates the callback's execution, the batch evaluates coverage with `ExitKind.Timeout`, and exits with `exitReason` of `"solution"` if the timeout input is novel

#### Scenario: Batch with unevaluated seeds
- **WHEN** `runBatch` is called while the unevaluated seeds queue is non-empty
- **THEN** seeds are returned verbatim (no mutation) within the batch, same as `getNextInput`, and each seed is evaluated for coverage

#### Scenario: Empty batch size
- **WHEN** `runBatch` is called with `batchSize=0`
- **THEN** returns immediately with `executionsCompleted=0` and `exitReason="completed"`

#### Scenario: Auto-seed within batch
- **WHEN** `runBatch` is called with an empty corpus and no seeds added
- **THEN** the auto-seed mechanism injects default seeds (same as `getNextInput`), which are evaluated for coverage within the batch

#### Scenario: runBatch during active stage
- **WHEN** `runBatch` is called while `stage_state` is not `None`
- **THEN** the batch proceeds normally with corpus selection and mutation; the active stage state is unaffected (stages are advanced separately by JS via `beginStage`/`advanceStage`)

### Requirement: Callback contract

The `runBatch` callback SHALL be a synchronous JavaScript function with signature `(inputBuffer: Buffer, inputLength: number) => number`.

- The callback receives the pre-allocated input buffer and the number of valid bytes
- The callback SHALL return an `ExitKind` value: 0 (Ok), 1 (Crash)
- The callback MUST NOT retain a reference to `inputBuffer` after returning; the buffer's contents will be overwritten on the next iteration
- The callback SHALL catch all target exceptions and return 1 (ExitKind.Crash). The callback itself SHOULD NOT throw. If an infrastructure-level error bypasses the callback's try/catch (e.g., NAPI failure, V8 out-of-memory), the batch loop SHALL catch it and treat it as an unrecoverable error.
- The callback MUST be synchronous; async callbacks (returning Promise) are not supported and will produce undefined behavior

#### Scenario: Callback returns Ok
- **WHEN** the callback returns 0
- **THEN** the batch loop evaluates coverage with `ExitKind.Ok` and continues to the next iteration (unless coverage is novel)

#### Scenario: Callback returns Crash
- **WHEN** the callback returns 1
- **THEN** the batch loop evaluates coverage with `ExitKind.Crash`; if the input is novel, it is recorded as a solution and the batch exits early

#### Scenario: Infrastructure error during callback
- **WHEN** an infrastructure-level error bypasses the callback's try/catch (e.g., NAPI failure)
- **THEN** the batch loop catches the error, disarms the watchdog, zeroes the coverage map, and returns with `exitReason: "error"`

#### Scenario: Callback returns invalid ExitKind
- **WHEN** the callback returns a value other than 0 or 1 (e.g., 5, -1, or NaN)
- **THEN** the batch loop SHALL treat it as `ExitKind.Ok` (0)

### Requirement: Pre-allocated input buffer

The `Fuzzer` SHALL allocate a reusable `Buffer` of `maxInputLen` bytes during construction. The `runBatch` method SHALL write mutated input bytes into this buffer for each iteration, avoiding per-iteration Buffer allocation.

- The buffer is allocated once in the constructor and reused across all `runBatch` calls
- The buffer's contents are valid only for the duration of a single callback invocation
- The `triggeringInput` field in `BatchResult` SHALL be a newly allocated copy of the input bytes, not a view into the pre-allocated buffer

#### Scenario: Buffer reused across iterations
- **WHEN** `runBatch` is called with `batchSize=100`
- **THEN** the same Buffer object is passed to every callback invocation (zero per-iteration Buffer allocations within the batch)

#### Scenario: Triggering input is an independent copy
- **WHEN** `runBatch` exits early with an interesting or solution input
- **THEN** `BatchResult.triggeringInput` is a separate Buffer whose contents remain valid after subsequent `runBatch` calls

### Requirement: BatchResult return type

The `runBatch` method SHALL return a `BatchResult` object with the following fields:
- `executionsCompleted` (number): Count of iterations completed in this batch (including the triggering iteration, if any)
- `exitReason` (string): One of `"completed"`, `"interesting"`, `"solution"`, `"error"`
- `triggeringInput` (Buffer, optional): Copy of the input that caused early exit; present when `exitReason` is not `"completed"`
- `solutionExitKind` (number, optional): The `ExitKind` that triggered the solution (1=Crash, 2=Timeout); present when `exitReason` is `"solution"`. Allows JS to skip replay for timeouts and make minimization decisions without re-executing the input.

#### Scenario: BatchResult for completed batch
- **WHEN** a batch of 256 iterations completes without interesting inputs or solutions
- **THEN** `executionsCompleted` is 256, `exitReason` is `"completed"`, and `triggeringInput` is undefined

#### Scenario: BatchResult for interesting early exit
- **WHEN** a batch exits on iteration 12 due to new coverage
- **THEN** `executionsCompleted` is 12, `exitReason` is `"interesting"`, and `triggeringInput` is a Buffer containing the interesting input bytes

#### Scenario: BatchResult for crash solution early exit
- **WHEN** a batch exits on iteration 5 due to a crash
- **THEN** `executionsCompleted` is 5, `exitReason` is `"solution"`, `triggeringInput` is a Buffer containing the crashing input bytes, and `solutionExitKind` is 1 (Crash)

#### Scenario: BatchResult for timeout solution early exit
- **WHEN** a batch exits on iteration 8 due to a watchdog timeout
- **THEN** `executionsCompleted` is 8, `exitReason` is `"solution"`, `triggeringInput` is a Buffer containing the timeout input bytes, and `solutionExitKind` is 2 (Timeout)

### Requirement: Internal shmem stash during batch

When the `Fuzzer` owns a `ShmemHandle`, the `runBatch` method SHALL stash the current input before each callback invocation using the same seqlock protocol as the existing `ShmemHandle.stashInput()`.

#### Scenario: Shmem stashed before each batch callback
- **WHEN** `runBatch` is called on a Fuzzer that owns a `ShmemHandle`
- **THEN** each callback invocation is preceded by a seqlock write of the current input to shared memory

#### Scenario: No shmem stash without handle
- **WHEN** `runBatch` is called on a Fuzzer constructed without a `ShmemHandle`
- **THEN** no shmem operations occur during the batch

### Requirement: Internal watchdog management during batch

When the `Fuzzer` owns a `Watchdog`, the `runBatch` method SHALL arm the watchdog before each callback invocation and disarm it after the callback returns or throws.

#### Scenario: Watchdog armed per callback
- **WHEN** `runBatch` is called on a Fuzzer that owns a `Watchdog` and `timeoutMs=1000`
- **THEN** the watchdog is armed with 1000ms before each callback and disarmed after each callback returns

#### Scenario: Watchdog disarmed on callback throw
- **WHEN** a callback throws an exception during a batch
- **THEN** the watchdog is disarmed before the batch returns

#### Scenario: No watchdog without handle
- **WHEN** `runBatch` is called on a Fuzzer constructed without a `Watchdog`
- **THEN** no watchdog arming or disarming occurs during the batch

### Requirement: Execution timing measured in Rust

The `runBatch` method SHALL measure per-iteration execution time using `std::time::Instant` in Rust, measuring only the callback invocation duration. This measured time SHALL be passed to the shared `evaluate_coverage()` helper and used for calibration state initialization (if the input is interesting).

#### Scenario: Timing excludes mutation overhead
- **WHEN** an iteration executes within `runBatch`
- **THEN** the recorded execution time reflects only the callback duration (target execution), excluding mutation, coverage evaluation, CmpLog processing, and shmem stash overhead
