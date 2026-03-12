## ADDED Requirements

### Requirement: Stage execution loop after calibration

After calibration completes normally (without crash or timeout) for an interesting input, the fuzz loop SHALL run a stage execution loop. If calibration was interrupted by a crash or timeout, the stage loop SHALL be skipped (the fuzz loop continues to the next normal iteration or terminates, per the base calibration spec).

The stage loop SHALL:

1. Call `fuzzer.beginStage()` to get the first stage candidate input.
2. If `beginStage()` returns `null`, skip the stage loop entirely.
3. For each non-null stage input:
   a. Stash the input to shmem via `shmemHandle?.stashInput(stageInput)` (if supervisor is active, which increments the generation counter).
   b. Record the start time via `process.hrtime.bigint()`.
   c. Execute the target with the same watchdog and timeout configuration as the main iteration cycle.
   d. If the target crashes or times out: call `fuzzer.abortStage(exitKind)` (which zeroes the coverage map, drains CmpLog, and increments counters), break out of the stage loop, and proceed to step 10 of the main iteration cycle using the stage input and caught error. Stage-discovered crashes are NOT minimized (see Scenario: Crash during stage is not minimized).
   e. If the target completes normally: compute `execTimeNs`, call `fuzzer.advanceStage(ExitKind.Ok, execTimeNs)` to get the next stage input.
4. Continue while `advanceStage()` returns a non-null `Buffer`.
5. After the stage loop completes (normally or via abort), resume the main fuzz iteration cycle.

The stage execution loop SHALL use the same three-branch target execution pattern used by the main iteration cycle and the calibration loop:
- **Branch 1 - Watchdog sync**: `watchdog.runTarget()` returns non-zero `exitKind` (sync crash/timeout).
- **Branch 2 - Watchdog async**: `watchdog.runTarget()` returns a Promise in `result`. Re-arm watchdog before `await`. On rejection, check `watchdog.didFire` to distinguish timeout from crash.
- **Branch 3 - No watchdog**: Direct `target(input)` call with try/catch, checking for Promise return.

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

#### Scenario: Crash during stage aborts and writes artifact

- **WHEN** the target throws during a stage execution
- **THEN** the stage loop SHALL call `fuzzer.abortStage(ExitKind.Crash)`
- **AND** break out of the stage loop
- **AND** the main loop SHALL write a crash artifact using the stage input that caused the crash
- **AND** the fuzz loop SHALL terminate

#### Scenario: Crash during stage is not minimized

- **WHEN** the target throws during a stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** the raw stage input SHALL be written as the crash artifact WITHOUT in-process minimization
- **AND** the minimization step that applies to normal-iteration crashes SHALL be skipped for stage crashes

#### Scenario: Timeout during stage aborts and writes artifact

- **WHEN** the watchdog fires during a stage execution
- **THEN** the stage loop SHALL call `fuzzer.abortStage(ExitKind.Timeout)`
- **AND** break out of the stage loop
- **AND** the main loop SHALL write a timeout artifact using the stage input
- **AND** the fuzz loop SHALL terminate

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
9. If `reportResult` returns `Interesting`: enter the calibration loop (see Requirement: Calibration loop in fuzz loop). If calibration completes normally, enter the stage execution loop (see Requirement: Stage execution loop after calibration). If the stage execution loop encounters a crash or timeout, the stage loop calls `abortStage()` and falls through to step 10 using the stage input and error.
10. If a crash or timeout needs artifact writing (either from `reportResult` returning `Solution` at step 8, or from a stage crash/timeout at step 9): for normal-iteration crashes where `reportResult` returned `Solution` and `exitKind` is `Crash`, attempt in-process crash minimization before writing the artifact. For stage-discovered crashes, skip minimization and write the raw stage input as the artifact. For timeouts (normal or stage), write the input as a timeout artifact without minimization. After writing the artifact, the loop terminates.

The shmem stash (step 2) SHALL occur whenever the `VITIATE_SUPERVISOR` environment variable is set, regardless of whether the supervisor was spawned by the CLI entry point or by the `fuzz()` test callback. The fuzz loop does not need to know which entry point spawned the supervisor - the `VITIATE_SUPERVISOR` env var is the sole indicator.

The loop SHALL terminate when any of these conditions is met:

- A crash or timeout is detected, including crashes/timeouts during stage execution.
- The time limit (`fuzzTime`) is reached.
- The iteration limit (`runs`) is reached.
- The process receives SIGINT.

For `runs` and the time limit, a value of 0 means unlimited (equivalent to no limit being set). The loop runs until a crash is found or SIGINT is received.

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

- **WHEN** the target throws an exception during a normal iteration and `reportResult` returns `Solution`
- **THEN** the fuzz loop invokes in-process minimization with the crashing input
- **AND** the minimized input is written as the crash artifact
- **AND** the loop terminates

#### Scenario: Timeout artifact is not minimized

- **WHEN** the watchdog fires (timeout) and `reportResult` returns `Solution`
- **THEN** the original input is written as the artifact without minimization
- **AND** the loop terminates

#### Scenario: Synchronous target exceeds timeout

- **WHEN** a synchronous target blocks longer than the configured timeout
- **THEN** the watchdog fires and the target execution is interrupted
- **AND** the caught exception is classified as `ExitKind.Timeout` (watchdog "fired" flag is set)
- **AND** the input is written as a timeout artifact
- **AND** the loop terminates

#### Scenario: Async target exceeds timeout

- **WHEN** an async target's promise does not resolve within the configured timeout
- **THEN** the watchdog fires and the pending execution is interrupted
- **AND** the caught exception is classified as `ExitKind.Timeout`
- **AND** the input is written as a timeout artifact
- **AND** the loop terminates

#### Scenario: Time limit reached

- **WHEN** the elapsed time exceeds the configured `fuzzTime`
- **THEN** the loop terminates and the test passes (no crash found)

#### Scenario: Iteration limit reached

- **WHEN** the iteration count reaches the configured `runs` limit
- **THEN** the loop terminates and the test passes (no crash found)

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
