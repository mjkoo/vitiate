## MODIFIED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL integrate detector lifecycle hooks around target execution. On each iteration:

1. Call `fuzzer.getNextInput()` to obtain the next mutated input.
2. If a `ShmemHandle` is available, stash the current input for crash recovery.
3. Call `detectorManager.beforeIteration()` to allow detectors to capture baseline state.
4. Execute the target function with the input, under watchdog protection if `timeoutMs > 0`.
5. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws (including `VulnerabilityError` from module-hook detectors), `Timeout` if the watchdog fired.
6. Call `detectorManager.endIteration(exitKind === ExitKind.Ok)`. If this returns a `VulnerabilityError` (only possible when the target completed normally), upgrade the result to `ExitKind.Crash` with the `VulnerabilityError` as the error. The `endIteration()` call guarantees that detector state is reset and the detector active flag is deactivated regardless of exit kind.
7. Call `fuzzer.reportResult(exitKind, execTimeNs)` which reads coverage, masks unstable edges, updates corpus, zeroes the map, and drains CmpLog.
8. If `reportResult` returns `Solution`, handle the crash: minimize (for JS crashes only, including `VulnerabilityError`), write the artifact, increment crash count, and check termination conditions (`stopOnCrash`, `maxCrashes`).
9. If `reportResult` returns `Interesting`, run calibration and then run stages (I2S, Generalization, Grimoire). Detector lifecycle hooks SHALL also wrap target execution during calibration re-runs and stage executions (see requirements below).
10. Every 1 000 iterations, yield to the event loop.

The shmem stash (step 2) SHALL occur whenever the `VITIATE_SUPERVISOR` environment variable is set, regardless of whether the supervisor was spawned by the CLI entry point or by the `fuzz()` test callback. The fuzz loop does not need to know which entry point spawned the supervisor - the `VITIATE_SUPERVISOR` env var is the sole indicator.

The loop SHALL terminate when any of these conditions is met:

- A crash or timeout is detected AND not suppressed or replaced by dedup AND `stopOnCrash` is `true`.
- The crash counter reaches `maxCrashes` (when `maxCrashes` is non-zero) AND `stopOnCrash` is `false`.
- The time limit (`fuzzTimeMs`) is reached.
- The iteration limit (`runs`) is reached.
- The process receives SIGINT.

For `runs` and the time limit, a value of 0 means unlimited (equivalent to no limit being set). The loop runs until a termination condition is met.

The fuzz loop SHALL NOT import or call `setDetectorActive()` directly. All detector active flag management SHALL be handled internally by `DetectorManager.beforeIteration()` and `DetectorManager.endIteration()`.

#### Scenario: Normal iteration with no detector finding

- **WHEN** the target executes without throwing
- **AND** `detectorManager.endIteration(true)` returns `undefined`
- **THEN** `reportResult(ExitKind.Ok, execTimeNs)` SHALL be called
- **AND** the loop SHALL continue to the next iteration

#### Scenario: Target throws VulnerabilityError from module hook

- **WHEN** the target calls a hooked function (e.g., `child_process.exec`) during execution
- **AND** the hook throws a `VulnerabilityError`
- **THEN** the iteration SHALL be classified as `ExitKind.Crash`
- **AND** `detectorManager.endIteration(false)` SHALL be called
- **AND** detector state SHALL be reset (e.g., polluted prototypes restored)
- **AND** `reportResult(ExitKind.Crash, execTimeNs)` SHALL be called
- **AND** the `VulnerabilityError` SHALL be passed to artifact writing

#### Scenario: afterIteration detector throws VulnerabilityError

- **WHEN** the target executes without throwing
- **AND** `detectorManager.endIteration(true)` returns a `VulnerabilityError`
- **THEN** the iteration SHALL be upgraded from `ExitKind.Ok` to `ExitKind.Crash`
- **AND** `reportResult(ExitKind.Crash, execTimeNs)` SHALL be called
- **AND** the `VulnerabilityError` SHALL be passed to artifact writing

#### Scenario: Timeout calls endIteration for cleanup

- **WHEN** the watchdog fires and the iteration is classified as `ExitKind.Timeout`
- **THEN** `detectorManager.endIteration(false)` SHALL be called
- **AND** detector state SHALL be reset
- **AND** the timeout SHALL be handled as before (artifact written, no minimization)

#### Scenario: Detector findings are minimized

- **WHEN** a `VulnerabilityError` is produced (either thrown during execution or returned by `endIteration()`)
- **AND** `reportResult` returns `Solution`
- **THEN** the fuzz loop SHALL invoke crash minimization on the input
- **AND** the minimized input SHALL be verified to still trigger the same `VulnerabilityError` before writing the artifact

#### Scenario: Target throws

- **WHEN** the target throws an error during execution
- **THEN** the watchdog is disarmed
- **AND** the exception is classified as `ExitKind.Crash` (watchdog "fired" flag is not set)
- **AND** `detectorManager.endIteration(false)` SHALL be called
- **AND** detector state SHALL be reset
- **AND** `reportResult(ExitKind.Crash, execTimeNs)` is called with the measured execution time
- **AND** the error and input are captured for crash artifact writing

#### Scenario: JS crash is minimized before artifact writing

- **WHEN** the target throws an exception during a normal iteration and `reportResult` returns `Solution`
- **THEN** the fuzz loop invokes in-process minimization with the crashing input
- **AND** the minimized input is checked against the crash dedup map before writing

#### Scenario: Crash terminates loop when stopOnCrash is true

- **WHEN** `stopOnCrash` is `true`
- **AND** the target throws an exception and `reportResult` returns `Solution`
- **THEN** the dedup check is performed (but with an empty map on first crash, it always saves)
- **AND** the crash artifact is written
- **AND** the loop terminates

#### Scenario: Crash continues loop when stopOnCrash is false

- **WHEN** `stopOnCrash` is `false`
- **AND** the target throws an exception and `reportResult` returns `Solution`
- **AND** the crash is not suppressed by dedup
- **THEN** the crash artifact is written
- **AND** the crash counter is incremented
- **AND** the loop continues to the next iteration

#### Scenario: Duplicate crash suppressed by dedup

- **WHEN** the target throws and the computed dedup key matches an existing entry in the crash dedup map
- **AND** the new input is not smaller than the existing entry
- **THEN** no artifact SHALL be written
- **AND** the `duplicateCrashesSkipped` counter SHALL be incremented
- **AND** the crash counter SHALL NOT be incremented (suppressed crashes do not count toward `maxCrashes`)
- **AND** the loop continues to the next iteration (regardless of `stopOnCrash` - a suppressed duplicate is not a "new" crash)

#### Scenario: Duplicate crash with smaller input replaces artifact

- **WHEN** the target throws and the computed dedup key matches an existing entry in the crash dedup map
- **AND** the new input is smaller than the existing entry
- **THEN** the existing artifact SHALL be atomically replaced with the new (smaller) input via `replaceArtifact`
- **AND** the dedup map entry SHALL be updated with the new path and size
- **AND** the loop continues to the next iteration (the replacement is an improvement, not a new crash)

#### Scenario: Timeout artifact is not minimized

- **WHEN** the watchdog fires (timeout) and `reportResult` returns `Solution`
- **THEN** the original input is written as the artifact without minimization
- **AND** the dedup key is `undefined` (timeout), so the artifact is always written (fail open)

#### Scenario: maxCrashes limit terminates loop

- **WHEN** `stopOnCrash` is `false`
- **AND** `maxCrashes` is non-zero
- **AND** the crash counter reaches `maxCrashes`
- **THEN** a warning is printed to stderr
- **AND** the loop terminates

#### Scenario: Synchronous target exceeds timeout

- **WHEN** a synchronous target blocks longer than the configured timeout
- **THEN** the watchdog fires and the target execution is interrupted
- **AND** the caught exception is classified as `ExitKind.Timeout` (watchdog "fired" flag is set)
- **AND** the input is written as a timeout artifact (fail open, no dedup)

#### Scenario: Async target exceeds timeout

- **WHEN** an async target's promise does not resolve within the configured timeout
- **THEN** the watchdog fires and the pending execution is interrupted
- **AND** the caught exception is classified as `ExitKind.Timeout`
- **AND** the input is written as a timeout artifact (fail open, no dedup)

#### Scenario: Time limit reached

- **WHEN** the elapsed time exceeds the configured `fuzzTimeMs`
- **THEN** the loop terminates and the result reflects all crashes found during the campaign

#### Scenario: Iteration limit reached

- **WHEN** the iteration count reaches the configured `runs` limit
- **THEN** the loop terminates and the result reflects all crashes found during the campaign

#### Scenario: Native crash during target execution

- **WHEN** a native addon crashes with SIGSEGV during target execution (including during stage execution)
- **THEN** the process dies immediately (no JS exception is thrown)
- **AND** the parent supervisor reads the last stashed input from shmem (which may be a stage input if the crash occurred during a stage)
- **AND** the parent writes the raw crash artifact without minimization
- **AND** the fuzz loop iteration cycle is not involved in crash handling (the parent handles it)

#### Scenario: Execution time measured for each iteration

- **WHEN** the target executes (sync or async)
- **THEN** the fuzz loop SHALL measure execution time using `process.hrtime.bigint()` before and after the target call
- **AND** the elapsed nanoseconds SHALL be converted to a `number` via `Number()` and passed to `reportResult()` as `execTimeNs`

#### Scenario: Input stashed under CLI supervisor

- **WHEN** the fuzz loop runs under a CLI-spawned supervisor (`VITIATE_SUPERVISOR=1`)
- **THEN** each input is stashed to shmem before the target is called
- **AND** the shmem generation counter is incremented

#### Scenario: Input stashed under Vitest supervisor

- **WHEN** the fuzz loop runs under a Vitest-spawned supervisor (`VITIATE_SUPERVISOR=1`)
- **THEN** each input is stashed to shmem before the target is called
- **AND** the shmem generation counter is incremented
- **AND** the stashing behavior is identical to the CLI-supervised case

#### Scenario: No shmem without supervisor

- **WHEN** the fuzz loop runs without a supervisor (`VITIATE_SUPERVISOR` not set)
- **THEN** no shmem attachment is attempted
- **AND** the fuzz loop runs normally without input stashing

#### Scenario: Interesting result triggers calibration then stages

- **WHEN** `reportResult()` returns `Interesting`
- **AND** calibration completes normally
- **THEN** the fuzz loop SHALL run the stage execution loop
- **AND** the next normal iteration SHALL not begin until the stage is complete

#### Scenario: SIGINT with accumulated crashes

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzz loop has found N crashes before SIGINT is received
- **THEN** the loop terminates
- **AND** the `FuzzLoopResult` includes all N crashes found so far (`crashCount`, `crashArtifactPaths`)
- **AND** `duplicateCrashesSkipped` reflects the total number of suppressed duplicates

#### Scenario: Co-occurring module-hook crash and prototype pollution

- **WHEN** a target execution causes prototype pollution AND triggers a module-hook VulnerabilityError in the same iteration
- **AND** the module-hook VulnerabilityError propagates as `ExitKind.Crash`
- **THEN** `detectorManager.endIteration(false)` SHALL be called
- **AND** `resetIteration()` SHALL restore the polluted prototypes to their pre-iteration state
- **AND** the prototype pollution detector SHALL NOT be blinded for future iterations

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
