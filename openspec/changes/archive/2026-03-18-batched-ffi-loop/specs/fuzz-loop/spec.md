## MODIFIED Requirements

### Requirement: Core fuzzing iteration cycle

Integrate detector lifecycle hooks around target execution. The loop SHALL use the batched path (`runBatch`) for synchronous targets and fall back to the per-iteration path for asynchronous targets.

**Batched path (synchronous targets):**
1. Construct a batch callback wrapping detector lifecycle and target execution (see "Batch callback wrapper construction")
2. Compute adaptive batch size (see "Adaptive batch size calculation")
3. Call `fuzzer.runBatch(callback, batchSize, timeoutMs)`
4. On `exitReason === "completed"`: continue to next batch
5. On `exitReason === "interesting"`: write corpus entry to disk, run calibration loop, then run stage loop (unchanged from current behavior)
6. On `exitReason === "solution"`: check `solutionExitKind` - if Timeout (2), write artifact directly without replay or minimization. If Crash (1), replay `triggeringInput` against target (via `fuzzer.runTarget`) with detector hooks to obtain the Error object and classify crash type (JS crash vs detector finding), minimize (JS crashes and detector findings only), write artifact, increment crash count, check termination conditions
7. On `exitReason === "error"`: log error, check termination conditions
8. Yield to event loop via `setImmediate` between batches
9. Check termination conditions between batches: `stopOnCrash`, `maxCrashes`, time limit, iteration limit, SIGINT

**Per-iteration fallback path (asynchronous targets):**
On each iteration:
1. Call `fuzzer.getNextInput()` to obtain next mutated input
2. If `ShmemHandle` owned by Fuzzer, call `fuzzer.stashInput(input)` for crash recovery
3. Call `detectorManager.beforeIteration()` for baseline state capture
4. Execute target via `fuzzer.runTarget(target, input, timeoutMs)` for watchdog protection
5. Determine `ExitKind`: `Ok` (normal), `Crash` (throws), `Timeout` (watchdog fired)
6. Call `detectorManager.endIteration(exitKind === ExitKind.Ok)` - if returns `VulnerabilityError`, upgrade to `ExitKind.Crash`
7. Call `fuzzer.reportResult(exitKind, execTimeNs)` - reads coverage, masks unstable edges, updates corpus, zeroes map, drains CmpLog
8. If `reportResult` returns `Solution`: minimize (JS crashes only), write artifact, increment crash count, check termination
9. If `reportResult` returns `Interesting`: write corpus entry, run calibration then stages
10. Every 1,000 iterations, yield to event loop

**Common behavior (both paths):**
- Shmem stash occurs when `VITIATE_SUPERVISOR` env var is set (ShmemHandle created and passed to Fuzzer constructor)
- Loop terminates on: crash + `stopOnCrash=true`, `maxCrashes` reached, time limit, iteration limit, SIGINT
- For `fuzzExecs` and time limit: 0 = unlimited
- Fuzz loop SHALL NOT import/call `setDetectorActive()` directly - all management via `DetectorManager`

#### Scenario: Normal batch iteration with no detector finding
- **WHEN** `runBatch` completes a full batch and no iteration triggers a detector or produces novel coverage
- **THEN** `exitReason` is `"completed"`, no crash artifacts are written, and the loop proceeds to the next batch

#### Scenario: Target throws VulnerabilityError from module hook
- **WHEN** a detector module hook intercepts a vulnerability during target execution within a batch callback
- **THEN** the callback returns `ExitKind.Crash`, the batch evaluates it, and if novel the batch exits with `exitReason` of `"solution"`

#### Scenario: afterIteration detector throws VulnerabilityError
- **WHEN** `detectorManager.endIteration(true)` returns a `VulnerabilityError` within a batch callback
- **THEN** the callback returns `ExitKind.Crash`, the batch evaluates it, and if novel the batch exits with `exitReason` of `"solution"`

#### Scenario: Timeout calls endIteration for cleanup
- **WHEN** the watchdog fires during a batch callback
- **THEN** V8 terminates execution, the batch disarms the watchdog, evaluates coverage with `ExitKind.Timeout`, and exits with `exitReason` of `"solution"` if novel

#### Scenario: Detector findings are minimized
- **WHEN** a batch returns `exitReason === "solution"` and replay classifies it as a `VulnerabilityError`
- **THEN** the fuzz loop minimizes the input before writing the crash artifact

#### Scenario: Target throws
- **WHEN** the target throws a non-`VulnerabilityError` exception within a batch callback
- **THEN** the callback returns `ExitKind.Crash` and the batch evaluates the input as a potential solution

#### Scenario: JS crash is minimized before artifact writing
- **WHEN** a batch returns `exitReason === "solution"` and replay classifies it as a JS crash (non-timeout, non-detector)
- **THEN** the fuzz loop minimizes the input before writing the crash artifact

#### Scenario: Crash terminates loop when stopOnCrash is true
- **WHEN** a solution is found and `stopOnCrash` is enabled
- **THEN** the loop writes the artifact and terminates after processing the batch result

#### Scenario: Crash continues loop when stopOnCrash is false
- **WHEN** a solution is found and `stopOnCrash` is disabled
- **THEN** the loop writes the artifact and continues to the next batch

#### Scenario: Duplicate crash suppressed by dedup
- **WHEN** a solution matches a previously seen crash (by dedup criteria)
- **THEN** no new artifact is written

#### Scenario: Duplicate crash with smaller input replaces artifact
- **WHEN** a solution matches a previously seen crash but has a smaller input
- **THEN** the existing artifact is replaced with the smaller input

#### Scenario: Timeout artifact is not minimized or replayed
- **WHEN** a batch returns `exitReason === "solution"` with `solutionExitKind === 2` (Timeout)
- **THEN** the artifact is written directly without replay or minimization

#### Scenario: maxCrashes limit terminates loop
- **WHEN** the total crash count reaches `maxCrashes` after processing a batch result
- **THEN** the loop terminates

#### Scenario: Time limit reached
- **WHEN** elapsed time exceeds the configured time limit between batches
- **THEN** the loop terminates

#### Scenario: Iteration limit reached
- **WHEN** total executions exceed `fuzzExecs` between batches
- **THEN** the loop terminates

#### Scenario: Native crash during target execution
- **WHEN** a native crash (SIGSEGV, etc.) occurs during a batch callback
- **THEN** the parent supervisor recovers the crashing input from shared memory (stashed by the Fuzzer before each callback)

#### Scenario: Execution time measured for each iteration
- **WHEN** iterations execute within `runBatch`
- **THEN** per-iteration execution time is measured in Rust using `std::time::Instant`, excluding mutation and evaluation overhead

#### Scenario: Input stashed under CLI supervisor
- **WHEN** `VITIATE_SUPERVISOR=1` and a `ShmemHandle` is passed to the Fuzzer constructor
- **THEN** the Fuzzer stashes input to shared memory before each `runBatch` callback invocation internally

#### Scenario: Input stashed under Vitest supervisor
- **WHEN** `VITIATE_SUPERVISOR=vitest` and a `ShmemHandle` is passed to the Fuzzer constructor
- **THEN** the Fuzzer stashes input to shared memory before each `runBatch` callback invocation internally

#### Scenario: No shmem without supervisor
- **WHEN** `VITIATE_SUPERVISOR` is not set
- **THEN** no `ShmemHandle` is created and the Fuzzer constructor receives no shmem handle

#### Scenario: Interesting result triggers calibration then stages
- **WHEN** `runBatch` returns `exitReason === "interesting"`
- **THEN** the fuzz loop writes the corpus entry, runs the calibration loop (re-executing target via `fuzzer.runTarget`, calling `calibrateRun`/`calibrateFinish`), then runs the stage loop (executing stage inputs via `fuzzer.runTarget`, calling `beginStage`/`advanceStage`), before continuing to the next batch

#### Scenario: SIGINT with accumulated crashes
- **WHEN** SIGINT is received between batches and crashes have been found
- **THEN** the loop terminates gracefully, printing the final summary including all crash artifacts

#### Scenario: Co-occurring module-hook crash and prototype pollution
- **WHEN** both a module-hook vulnerability and a prototype pollution are detected within the same batch callback
- **THEN** the first detected vulnerability is reported

#### Scenario: Crash solution replayed for error classification
- **WHEN** `runBatch` returns `exitReason === "solution"` with `solutionExitKind === 1` (Crash) and `triggeringInput`
- **THEN** the fuzz loop replays the input against the target (via `fuzzer.runTarget` with detector hooks) to obtain the Error object for crash classification and artifact metadata

#### Scenario: Timeout solution skips replay
- **WHEN** `runBatch` returns `exitReason === "solution"` with `solutionExitKind === 2` (Timeout)
- **THEN** the fuzz loop writes the timeout artifact directly without replaying the input

### Requirement: Async target support

If target returns a Promise, the loop SHALL use the per-iteration fallback path instead of `runBatch`. The loop awaits the Promise before disarming the watchdog. Watchdog enforces timeouts for both sync and async uniformly in the per-iteration path.

The loop SHALL detect async targets during the first iteration: if the target function returns a Promise, set a flag and use the per-iteration path for all subsequent iterations.

#### Scenario: Async target completes normally
- **WHEN** an async target returns a resolved Promise
- **THEN** the per-iteration loop awaits it and reports `ExitKind.Ok`

#### Scenario: Async target rejects
- **WHEN** an async target returns a rejected Promise
- **THEN** the per-iteration loop reports `ExitKind.Crash`

#### Scenario: Async target detected on first iteration
- **WHEN** the first target execution returns a Promise
- **THEN** the loop switches to the per-iteration fallback path permanently for this fuzz run

### Requirement: Periodic event loop yield

Yield to the Node.js event loop between batches using `setImmediate` wrapped in a Promise. The adaptive batch size (see "Adaptive batch size calculation") ensures yields occur frequently enough for timers and signal handlers to fire. In the per-iteration fallback path, yield every N iterations (default 1000) as before.

#### Scenario: Event loop not starved during batched execution
- **WHEN** the fuzz loop runs with batched execution
- **THEN** `setImmediate` is called between each batch, allowing pending timers and I/O callbacks to execute

#### Scenario: Event loop not starved during per-iteration fallback
- **WHEN** the fuzz loop runs with the per-iteration path (async target)
- **THEN** `setImmediate` is called every 1,000 iterations

## ADDED Requirements

### Requirement: Batch callback wrapper construction

The fuzz loop SHALL construct a batch callback function that wraps detector lifecycle hooks around target execution. The callback signature SHALL be `(inputBuffer: Buffer, inputLength: number) => number` and it SHALL:

1. Create a zero-copy view of the input: `inputBuffer.subarray(0, inputLength)`
2. Call `detectorManager.beforeIteration()`
3. Execute the target function with the input view
4. If target completes normally: call `detectorManager.endIteration(true)`. If a `VulnerabilityError` is returned, return `1` (ExitKind.Crash)
5. If target throws: call `detectorManager.endIteration(false)`. Return `1` (ExitKind.Crash). All target exceptions are crashes regardless of exception type.
6. If no error or vulnerability: return `0` (ExitKind.Ok)

#### Scenario: Callback wraps detectors around target
- **WHEN** the batch callback is invoked
- **THEN** `beforeIteration()` is called before the target and `endIteration()` is called after, with the correct `targetCompletedOk` argument

#### Scenario: Callback converts VulnerabilityError to ExitKind.Crash
- **WHEN** `endIteration` returns a `VulnerabilityError`
- **THEN** the callback returns 1 (ExitKind.Crash) instead of throwing

#### Scenario: Callback treats all target exceptions as crashes
- **WHEN** the target throws a non-`VulnerabilityError` exception
- **THEN** the callback calls `endIteration(false)` and returns 1 (ExitKind.Crash)

### Requirement: Adaptive batch size calculation

The fuzz loop SHALL compute the batch size dynamically based on recent throughput to maintain responsive stats reporting and signal handling. The formula SHALL be:

```
batchSize = clamp(floor(recentExecsPerSec * targetBatchDurationSeconds), 16, 1024)
```

Where:
- `recentExecsPerSec` is obtained from `fuzzer.stats.execsPerSec` (computed as `totalExecs / elapsedSeconds` since Fuzzer creation)
- `targetBatchDurationSeconds` is the desired wall-clock time per batch (default: the reporter's update interval, approximately 3 seconds)

The clamp ensures a minimum batch of 16 (always some FFI reduction) and a maximum of 1024 (bounded event loop blocking).

On the first batch (before throughput data is available from `fuzzer.stats`), use the minimum batch size of 16.

#### Scenario: Fast target gets large batch size
- **WHEN** the target executes at 10,000 exec/s
- **THEN** the batch size is 1024 (clamped from 30,000)

#### Scenario: Slow target gets small batch size
- **WHEN** the target executes at 10 exec/s
- **THEN** the batch size is 30 (floor of 10 * 3)

#### Scenario: First batch uses minimum size
- **WHEN** the fuzz loop has no throughput history
- **THEN** the first batch uses a batch size of 16

#### Scenario: Very slow target uses minimum batch size
- **WHEN** the target executes at 1 exec/s
- **THEN** the batch size is 16 (clamped from 3)
