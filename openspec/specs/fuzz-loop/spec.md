## Requirements

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

### Requirement: Calibration loop in fuzz loop

When `reportResult()` returns `Interesting`, the fuzz loop SHALL enter a calibration loop before continuing to the next iteration. The calibration loop SHALL:

1. Re-run the target with the same input via `watchdog.runTarget(target, input, timeoutMs)` (or direct call if no timeout is configured).
2. Measure execution time for each re-run using `process.hrtime.bigint()`.
3. Call `fuzzer.calibrateRun(execTimeNs)` after each re-run.
4. Continue looping while `calibrateRun()` returns `true`.
5. If the target crashes or times out during a calibration run, break out of the loop immediately.
6. Call `fuzzer.calibrateFinish()` after the loop completes (whether normally or interrupted).

The calibration loop SHALL use the same watchdog and timeout configuration as the main iteration cycle. The calibration re-runs SHALL be identical to the normal target invocation - same input buffer, same timeout, same watchdog protection.

#### Scenario: Calibration runs after interesting result

- **WHEN** `reportResult()` returns `Interesting`
- **THEN** the fuzz loop SHALL re-run the target 3-7 additional times for calibration
- **AND** `calibrateRun()` SHALL be called after each re-run
- **AND** `calibrateFinish()` SHALL be called after the loop completes
- **AND** the next normal iteration SHALL not begin until calibration is complete

#### Scenario: Calibration uses watchdog protection

- **WHEN** the fuzz loop has a configured timeout and watchdog
- **AND** calibration re-runs the target
- **THEN** each calibration run SHALL use `watchdog.runTarget()` with the same timeout
- **AND** watchdog protection SHALL apply to calibration runs identically to normal iterations

#### Scenario: Calibration without watchdog

- **WHEN** the fuzz loop has no configured timeout (no watchdog)
- **AND** calibration re-runs the target
- **THEN** each calibration run SHALL call the target directly
- **AND** exceptions during the direct call SHALL cause calibration to break

#### Scenario: Crash during calibration breaks loop

- **WHEN** the target crashes during a calibration re-run
- **THEN** the calibration loop SHALL break immediately
- **AND** `calibrateFinish()` SHALL still be called
- **AND** the fuzz loop SHALL continue to the next normal iteration (the crash during calibration does not terminate the fuzz campaign)

#### Scenario: Timeout during calibration breaks loop

- **WHEN** the target times out during a calibration re-run
- **THEN** the calibration loop SHALL break immediately
- **AND** `calibrateFinish()` SHALL still be called

### Requirement: Detector lifecycle during calibration

The detector lifecycle hooks SHALL wrap target execution during calibration re-runs, using the same `endIteration(targetCompletedOk)` protocol as the main iteration cycle. For each calibration re-run:

1. Call `detectorManager.beforeIteration()` before executing the target.
2. Execute the target.
3. Call `detectorManager.endIteration(exitKind === ExitKind.Ok)`. If this returns a `VulnerabilityError`, upgrade to `ExitKind.Crash`.
4. If a crash or timeout occurs (including `VulnerabilityError`), break out of the calibration loop as specified by the base calibration requirement.

#### Scenario: Detector finding during calibration breaks loop

- **WHEN** the target is being re-run during calibration
- **AND** the target's execution triggers a `VulnerabilityError` (via module hook or `endIteration()`)
- **THEN** the calibration loop SHALL break immediately
- **AND** `calibrateFinish()` SHALL still be called
- **AND** the `VulnerabilityError` and input SHALL be passed to artifact writing

#### Scenario: Clean calibration with detectors active

- **WHEN** calibration re-runs the target multiple times
- **AND** no detector fires on any re-run
- **THEN** calibration SHALL complete normally
- **AND** `beforeIteration()`/`endIteration()` SHALL have been called for each re-run

#### Scenario: Non-interesting result skips calibration

- **WHEN** `reportResult()` returns a result that is NOT `Interesting` (e.g., not-interesting or Solution)
- **THEN** no calibration loop SHALL execute
- **AND** the fuzz loop SHALL proceed directly to crash handling (if Solution) or the next iteration

#### Scenario: Async target during calibration

- **WHEN** the target is async and a calibration re-run returns a Promise
- **THEN** the calibration loop SHALL await the Promise before calling `calibrateRun()`
- **AND** the timing measurement SHALL include the full async execution time

#### Scenario: Crash during calibration resets detector state

- **WHEN** the target crashes during a calibration re-run
- **THEN** `detectorManager.endIteration(false)` SHALL be called
- **AND** detector state SHALL be reset before the next iteration

### Requirement: Stage execution loop after calibration

After calibration completes normally (without crash or timeout) for an interesting input, the fuzz loop SHALL run a stage execution loop. If calibration was interrupted by a crash or timeout, the stage loop SHALL be skipped (the fuzz loop continues to the next normal iteration or terminates, per the base calibration spec).

The stage loop SHALL:

1. Call `fuzzer.beginStage()` to get the first stage candidate input.
2. If `beginStage()` returns `null`, skip the stage loop entirely.
3. For each non-null stage input:
   a. Stash the input to shmem via `shmemHandle?.stashInput(stageInput)` (if supervisor is active, which increments the generation counter).
   b. Record the start time via `process.hrtime.bigint()`.
   c. Execute the target with the same watchdog and timeout configuration as the main iteration cycle.
   d. If the target crashes or times out: call `fuzzer.abortStage(exitKind)` (which zeroes the coverage map, drains CmpLog, and increments counters), break out of the stage loop, and proceed to step 10 of the main iteration cycle using the stage input and caught error. Stage-discovered crashes are NOT minimized (see Scenario: Crash during stage is not minimized). The dedup check in step 10 applies to stage crashes identically to main-loop crashes.
   e. If the target completes normally: compute `execTimeNs`, call `fuzzer.advanceStage(ExitKind.Ok, execTimeNs)` to get the next stage input.
4. Continue while `advanceStage()` returns a non-null `Buffer`.
5. After the stage loop completes (normally or via abort), resume the main fuzz iteration cycle.

The stage execution loop SHALL use the same three-branch target execution pattern used by the main iteration cycle and the calibration loop:
- **Branch 1 - Watchdog sync**: `watchdog.runTarget()` returns non-zero `exitKind` (sync crash/timeout).
- **Branch 2 - Watchdog async**: `watchdog.runTarget()` returns a Promise in `result`. Re-arm watchdog before `await`. On rejection, check `watchdog.didFire` to distinguish timeout from crash.
- **Branch 3 - No watchdog**: Direct `target(input)` call with try/catch, checking for Promise return.

#### Scenario: Crash during stage aborts and writes artifact

- **WHEN** the target throws during a stage execution
- **THEN** the stage loop SHALL call `fuzzer.abortStage(ExitKind.Crash)`
- **AND** break out of the stage loop
- **AND** the main loop SHALL apply the dedup check and write a crash artifact using the stage input (unless suppressed by dedup)
- **AND** the loop terminates or continues per step 10 of the core iteration cycle (based on `stopOnCrash` and dedup outcome)

#### Scenario: Crash during stage is not minimized

- **WHEN** the target throws during a stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** the raw stage input SHALL be written as the crash artifact WITHOUT in-process minimization
- **AND** the minimization step that applies to normal-iteration crashes SHALL be skipped for stage crashes

#### Scenario: Timeout during stage aborts and writes artifact

- **WHEN** the watchdog fires during a stage execution
- **THEN** the stage loop SHALL call `fuzzer.abortStage(ExitKind.Timeout)`
- **AND** break out of the stage loop
- **AND** the main loop SHALL write a timeout artifact using the stage input (fail open, no dedup)
- **AND** the loop terminates or continues per step 10 of the core iteration cycle (based on `stopOnCrash`)

#### Scenario: Stage loop runs after calibration when CmpLog data available

- **WHEN** `reportResult()` returns `Interesting`
- **AND** calibration completes normally
- **AND** `beginStage()` returns a non-null input
- **THEN** the fuzz loop SHALL execute the stage input against the target
- **AND** call `advanceStage()` after each execution
- **AND** continue until `advanceStage()` returns `null`

#### Scenario: Stage loop skipped when no CmpLog data

- **WHEN** `reportResult()` returns `Interesting`
- **AND** calibration completes normally
- **AND** `beginStage()` returns `null`
- **THEN** the fuzz loop SHALL skip the stage loop entirely
- **AND** proceed to the next main iteration

#### Scenario: Stage loop skipped after calibration crash

- **WHEN** `reportResult()` returns `Interesting`
- **AND** calibration encounters a crash or timeout
- **THEN** the stage execution loop SHALL NOT run
- **AND** the fuzz loop SHALL handle the calibration crash per the base calibration spec

#### Scenario: Stage uses watchdog protection

- **WHEN** the fuzz loop has a configured timeout and watchdog
- **AND** the stage execution loop is running
- **THEN** each stage execution SHALL use `watchdog.runTarget()` with the same timeout
- **AND** watchdog protection SHALL apply to stage executions identically to normal iterations

#### Scenario: Async target during stage execution

- **WHEN** the target is async and a stage execution returns a Promise
- **THEN** the stage loop SHALL re-arm the watchdog before `await`
- **AND** await the Promise
- **AND** disarm the watchdog in a `finally` block
- **AND** on rejection, check `watchdog.didFire` to classify as Timeout vs Crash

#### Scenario: Stage inputs stashed to shmem

- **WHEN** the fuzz loop runs under a supervisor (`VITIATE_SUPERVISOR=1`)
- **AND** the stage execution loop is running
- **THEN** each stage input SHALL be stashed to shmem before target execution
- **AND** the shmem generation counter SHALL be incremented

#### Scenario: Stage without watchdog

- **WHEN** the fuzz loop has no configured timeout (no watchdog)
- **AND** the stage execution loop is running
- **THEN** each stage execution SHALL call the target directly
- **AND** if the target returns a Promise, the stage loop SHALL await it
- **AND** exceptions during the call SHALL trigger `abortStage(ExitKind.Crash)`

### Requirement: Detector lifecycle during stage execution

The detector lifecycle hooks SHALL wrap target execution during stage iterations (I2S, Generalization, Grimoire), using the same `endIteration(targetCompletedOk)` protocol as the main iteration cycle. For each stage execution:

1. Call `detectorManager.beforeIteration()` before executing the target with the stage input.
2. Execute the target.
3. Call `detectorManager.endIteration(exitKind === ExitKind.Ok)`. If this returns a `VulnerabilityError`, upgrade to `ExitKind.Crash`.
4. If a crash or timeout occurs (including `VulnerabilityError`), call `fuzzer.abortStage(exitKind)`, break out of the stage loop, and proceed to artifact writing. Stage-discovered detector findings SHALL NOT be minimized (same as stage-discovered crashes).

#### Scenario: Detector finding during stage aborts stage

- **WHEN** a stage execution triggers a `VulnerabilityError` (via module hook or `endIteration()`)
- **THEN** `fuzzer.abortStage(ExitKind.Crash)` SHALL be called
- **AND** the stage loop SHALL break
- **AND** the raw stage input SHALL be written as a `crash-{hash}` artifact WITHOUT minimization

#### Scenario: Clean stage execution with detectors active

- **WHEN** the stage loop executes multiple inputs
- **AND** no detector fires on any stage execution
- **THEN** the stage SHALL complete normally
- **AND** `beforeIteration()`/`endIteration()` SHALL have been called for each stage execution

#### Scenario: Crash during stage resets detector state

- **WHEN** the target crashes during a stage execution
- **THEN** `detectorManager.endIteration(false)` SHALL be called
- **AND** detector state SHALL be reset before abort handling

### Requirement: Detector lifecycle during minimization

The detector lifecycle hooks SHALL wrap target execution during crash input minimization, using the same `endIteration(targetCompletedOk)` protocol as the main iteration cycle. For each minimization attempt:

1. Call `detectorManager.beforeIteration()` before executing the target with the candidate input.
2. Execute the target.
3. Call `detectorManager.endIteration(exitKind === ExitKind.Ok)`. If this returns a `VulnerabilityError`, the candidate still triggers the finding - the minimization succeeded for this candidate.
4. Determine whether the candidate reproduces the original crash (same error type / `VulnerabilityError`). If so, the candidate replaces the current best; if not, the candidate is discarded.

Minimization re-executes the target potentially many times with progressively smaller inputs. The detector lifecycle must be active on each attempt so that:
- `VulnerabilityError` findings from `endIteration()` are re-detected (confirming the minimized input still triggers the detector).
- Prototype state is restored after every attempt via `resetIteration()`, preventing pollution from one minimization attempt from affecting the next.

#### Scenario: Minimization attempt with detector finding

- **WHEN** a minimization candidate is executed
- **AND** the target completes normally
- **AND** `detectorManager.endIteration(true)` returns a `VulnerabilityError`
- **THEN** the candidate SHALL be considered a successful reproduction of the finding
- **AND** detector state SHALL be reset via `resetIteration()`

#### Scenario: Minimization attempt with target crash

- **WHEN** a minimization candidate is executed
- **AND** the target throws
- **THEN** `detectorManager.endIteration(false)` SHALL be called
- **AND** detector state SHALL be reset via `resetIteration()`
- **AND** the crash SHALL be evaluated as a reproduction of the original crash

#### Scenario: Minimization attempt with no reproduction

- **WHEN** a minimization candidate is executed
- **AND** the target completes normally
- **AND** `detectorManager.endIteration(true)` returns `undefined`
- **THEN** the candidate SHALL be discarded (the finding was not reproduced)
- **AND** detector state SHALL be reset via `resetIteration()`

#### Scenario: Detector state is clean between minimization attempts

- **WHEN** multiple minimization candidates are tried in sequence
- **THEN** `beforeIteration()`/`endIteration()` SHALL have been called for each attempt
- **AND** prototype state SHALL be restored between attempts (no pollution leaks from one attempt to the next)

### Requirement: Detector lifecycle initialization and teardown

The fuzz loop SHALL initialize the `DetectorManager` before entering the iteration loop and tear it down after exiting. Specifically:

1. After constructing the `Fuzzer` but before the first `getNextInput()`, call `detectorManager.setup()`.
2. After the iteration loop exits (normally or due to termination condition), call `detectorManager.teardown()`.

#### Scenario: Setup before first iteration

- **WHEN** the fuzz loop begins
- **THEN** `detectorManager.setup()` SHALL be called before any target execution
- **AND** module hooks installed by detectors SHALL be active for all iterations

#### Scenario: Teardown after loop exit

- **WHEN** the fuzz loop exits (due to time limit, run limit, `stopOnCrash`, or `maxCrashes`)
- **THEN** `detectorManager.teardown()` SHALL be called
- **AND** module hooks SHALL be restored to their original state

### Requirement: DetectorManager construction in fuzz loop

The fuzz loop SHALL construct a `DetectorManager` from the resolved `FuzzOptions.detectors` configuration. The detector tokens from `detectorManager.getTokens()` SHALL be included in the `FuzzerConfig` passed to the `Fuzzer` constructor, so they are available to the mutation engine from the first iteration.

#### Scenario: Detector tokens passed to Fuzzer

- **WHEN** the fuzz loop constructs the `Fuzzer`
- **AND** detectors are active
- **THEN** `detectorManager.getTokens()` SHALL be called before `Fuzzer` construction
- **AND** the returned tokens SHALL be passed as `detectorTokens` in `FuzzerConfig`

### Requirement: Seed loading

Before the fuzz loop begins, the system SHALL load all available seed inputs and add them to the fuzzer via `addSeed()`:

1. Read all files from the seed directory (`<dataDir>/testdata/<hashdir>/seeds/`).
2. Read all files from the crash directory (`<dataDir>/testdata/<hashdir>/crashes/`).
3. Read all files from the timeout directory (`<dataDir>/testdata/<hashdir>/timeouts/`).
4. Read all files from the cached corpus directory (`<dataDir>/corpus/<hashdir>/`).
5. Add each file's contents as a seed via `fuzzer.addSeed()`.

Where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root (default `.vitiate/`).

If no seeds are available, the fuzzer's auto-seed mechanism provides default starting inputs.

#### Scenario: Seeds from corpus directories

- **WHEN** the seed directory contains 2 files, the crash directory contains 1 file, and the cached corpus contains 5 files
- **THEN** 8 seeds are added to the fuzzer before the loop begins

#### Scenario: No seeds available

- **WHEN** neither the seed, crash, timeout, nor corpus directories exist
- **THEN** the fuzzer auto-seeds with its default set and the loop begins normally

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

### Requirement: Interesting input persistence

When `reportResult()` returns `Interesting`, the system SHALL persist the input according to the active path convention:

- **When `corpusOutputDir` is provided**: Write the input to `{corpusOutputDir}/{contentHash}` (flat layout) via `writeCorpusEntryToDir`.
- **When `libfuzzerCompat` is true and `corpusOutputDir` is not provided**: Do not write the input to disk. The in-memory corpus retains the input for the duration of the process.
- **Otherwise** (Vitest mode): Write the input to `<dataDir>/corpus/<hashdir>/<contentHash>` so it persists across fuzzing sessions.

#### Scenario: Interesting input saved to corpus dir (Vitest mode)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `libfuzzerCompat` is false
- **THEN** the input buffer is written to `<dataDir>/corpus/<hashdir>/<contentHash>`
- **AND** `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)`
- **AND** subsequent fuzzing sessions can load it as a seed

#### Scenario: Interesting input saved to corpus output dir (CLI with corpus dir)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `corpusOutputDir` is set to `./corpus/`
- **THEN** the input buffer is written to `./corpus/{contentHash}`

#### Scenario: Interesting input not written to disk (CLI without corpus dir)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `libfuzzerCompat` is true
- **AND** `corpusOutputDir` is not set
- **THEN** no file is written to disk
- **AND** the input is retained in the in-memory corpus for the remainder of the process

### Requirement: VITIATE_FUZZ_EXECS environment variable override

The `VITIATE_FUZZ_EXECS` environment variable SHALL override `FuzzOptions.fuzzExecs` when set. It accepts a non-negative integer value (plain count, no unit conversion). Invalid values (non-integer, negative, non-finite) SHALL produce a warning on stderr and be ignored, matching the `VITIATE_FUZZ_TIME` / `getFuzzTime()` error handling pattern.

The override SHALL be applied in `getCliOptions()` after parsing `VITIATE_FUZZ_OPTIONS`, following the same pattern as `getFuzzTime()` overriding `fuzzTimeMs`. This applies universally - both CLI and Vitest modes.

`VITIATE_FUZZ_EXECS` SHALL be added to the `KNOWN_VITIATE_ENV_VARS` set so that it does not trigger the unknown-env-var warning.

#### Scenario: VITIATE_FUZZ_EXECS overrides fuzzExecs

- **WHEN** `VITIATE_FUZZ_EXECS=50000` is set in the environment
- **AND** `fuzzExecs` is set to `100000` via `VITIATE_FUZZ_OPTIONS`
- **THEN** the fuzzer SHALL use `fuzzExecs: 50000` (env var takes precedence)

#### Scenario: VITIATE_FUZZ_EXECS with invalid value

- **WHEN** `VITIATE_FUZZ_EXECS=notanumber` is set in the environment
- **THEN** a warning SHALL be printed to stderr
- **AND** the env var SHALL be ignored (config or default value applies)

#### Scenario: VITIATE_FUZZ_EXECS with zero

- **WHEN** `VITIATE_FUZZ_EXECS=0` is set in the environment
- **THEN** the fuzzer SHALL use `fuzzExecs: 0` (unlimited)

#### Scenario: VITIATE_FUZZ_EXECS unset

- **WHEN** `VITIATE_FUZZ_EXECS` is not set in the environment
- **THEN** the `fuzzExecs` value from `VITIATE_FUZZ_OPTIONS` or the per-test options SHALL be used unchanged
