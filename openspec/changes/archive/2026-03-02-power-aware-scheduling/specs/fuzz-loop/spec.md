## MODIFIED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL implement the following cycle for each iteration:

1. Call `fuzzer.getNextInput()` to get a mutated input.
2. Stash the input to the cross-process shmem region via the shared-memory-stash capability, if a shmem handle is available.
3. Record the start time via `process.hrtime.bigint()`.
4. Call `watchdog.runTarget(target, input, timeoutMs)` which internally arms the watchdog, calls the target at the NAPI C level, and disarms on return. If V8 TerminateExecution fires during the call, the C++ shim intercepts it and returns `exitKind=2` (timeout). If the target throws, it returns `exitKind=1` (crash). If the target returns a Promise, it returns `exitKind=0` with the Promise in `result`.
5. If `runTarget` returned a Promise: re-arm the watchdog, await the Promise, and disarm in a `finally` block. On catch, check `watchdog.didFire` to classify as `Timeout` vs `Crash`.
6. Record the end time and compute `execTimeNs` as the elapsed nanoseconds (as a `number`, converted from BigInt via `Number()`).
7. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws, `Timeout` if the watchdog fired.
8. Call `fuzzer.reportResult(exitKind, execTimeNs)` which reads coverage, masks unstable edges, updates corpus, zeroes the map, and drains CmpLog.
9. If `reportResult` returns `Interesting`: enter the calibration loop (see Requirement: Calibration loop in fuzz loop).
10. If `reportResult` returns `Solution` and `exitKind` is `Crash`, attempt in-process crash minimization before writing the artifact. Pass the watchdog, target, input, and timeout to the minimizer. Write the minimized (or original, on failure) input as the crash artifact.

The shmem stash (step 2) SHALL occur whenever the `VITIATE_SUPERVISOR` environment variable is set, regardless of whether the supervisor was spawned by the CLI entry point or by the `fuzz()` test callback. The fuzz loop does not need to know which entry point spawned the supervisor - the `VITIATE_SUPERVISOR` env var is the sole indicator.

The loop SHALL terminate when any of these conditions is met:

- A crash or timeout is detected (solution found).
- The time limit (`fuzzTime`) is reached.
- The iteration limit (`runs`) is reached.
- The process receives SIGINT.

For `runs` and the time limit, a value of 0 means unlimited (equivalent to no limit being set). The loop runs until a crash is found or SIGINT is received.

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

#### Scenario: Normal iteration

- **WHEN** the target executes without throwing
- **THEN** the watchdog is disarmed
- **AND** `reportResult(ExitKind.Ok, execTimeNs)` is called with the measured execution time
- **AND** the loop continues to the next iteration

#### Scenario: Target throws

- **WHEN** the target throws an error during execution
- **THEN** the watchdog is disarmed
- **AND** the exception is classified as `ExitKind.Crash` (watchdog "fired" flag is not set)
- **AND** `reportResult(ExitKind.Crash, execTimeNs)` is called with the measured execution time
- **AND** the error and input are captured for crash artifact writing

#### Scenario: JS crash is minimized before artifact writing

- **WHEN** the target throws an exception and `reportResult` returns `Solution`
- **THEN** the fuzz loop invokes in-process minimization with the crashing input
- **AND** the minimized input is written as the crash artifact
- **AND** the loop terminates (solution found)

#### Scenario: Timeout artifact is not minimized

- **WHEN** the watchdog fires (timeout) and `reportResult` returns `Solution`
- **THEN** the original input is written as the artifact without minimization
- **AND** the loop terminates (solution found)

#### Scenario: Synchronous target exceeds timeout

- **WHEN** a synchronous target blocks longer than the configured timeout
- **THEN** the watchdog fires and the target execution is interrupted
- **AND** the caught exception is classified as `ExitKind.Timeout` (watchdog "fired" flag is set)
- **AND** the input is written as a timeout artifact
- **AND** the loop terminates (solution found)

#### Scenario: Async target exceeds timeout

- **WHEN** an async target's promise does not resolve within the configured timeout
- **THEN** the watchdog fires and the pending execution is interrupted
- **AND** the caught exception is classified as `ExitKind.Timeout`
- **AND** the input is written as a timeout artifact
- **AND** the loop terminates (solution found)

#### Scenario: Time limit reached

- **WHEN** the elapsed time exceeds the configured `fuzzTime`
- **THEN** the loop terminates and the test passes (no crash found)

#### Scenario: Iteration limit reached

- **WHEN** the iteration count reaches the configured `runs` limit
- **THEN** the loop terminates and the test passes (no crash found)

#### Scenario: Native crash during target execution

- **WHEN** a native addon crashes with SIGSEGV during target execution
- **THEN** the process dies immediately (no JS exception is thrown)
- **AND** the parent supervisor reads the last stashed input from shmem
- **AND** the parent writes the raw crash artifact without minimization
- **AND** the fuzz loop iteration cycle is not involved in crash handling (the parent handles it)

#### Scenario: Execution time measured for each iteration

- **WHEN** the target executes (sync or async)
- **THEN** the fuzz loop SHALL measure execution time using `process.hrtime.bigint()` before and after the target call
- **AND** the elapsed nanoseconds SHALL be converted to a `number` via `Number()` and passed to `reportResult()` as `execTimeNs`

## ADDED Requirements

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

#### Scenario: Non-interesting result skips calibration

- **WHEN** `reportResult()` returns a result that is NOT `Interesting` (e.g., not-interesting or Solution)
- **THEN** no calibration loop SHALL execute
- **AND** the fuzz loop SHALL proceed directly to crash handling (if Solution) or the next iteration

#### Scenario: Async target during calibration

- **WHEN** the target is async and a calibration re-run returns a Promise
- **THEN** the calibration loop SHALL await the Promise before calling `calibrateRun()`
- **AND** the timing measurement SHALL include the full async execution time
