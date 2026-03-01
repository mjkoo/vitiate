## MODIFIED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL implement the following cycle for each iteration:

1. Call `fuzzer.getNextInput()` to get a mutated input.
2. Stash the input to the cross-process shmem region via the shared-memory-stash capability.
3. Call `watchdog.runTarget(target, input, timeoutMs)` which internally arms the watchdog, calls the target at the NAPI C level, and disarms on return. If V8 TerminateExecution fires during the call, the C++ shim intercepts it and returns `exitKind=2` (timeout). If the target throws, it returns `exitKind=1` (crash). If the target returns a Promise, it returns `exitKind=0` with the Promise in `result`.
4. If `runTarget` returned a Promise: re-arm the watchdog, await the Promise, and disarm in a `finally` block. On catch, check `watchdog.didFire` to classify as `Timeout` vs `Crash`.
5. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws, `Timeout` if the watchdog fired.
6. Call `fuzzer.reportResult(exitKind)` which reads coverage, updates corpus, zeroes the map, and drains CmpLog.

The loop SHALL terminate when any of these conditions is met:

- A crash or timeout is detected (solution found).
- The time limit (`fuzzTime`) is reached.
- The iteration limit (`runs`) is reached.
- The process receives SIGINT.

#### Scenario: Input stashed before each execution

- **WHEN** the fuzz loop begins a new iteration
- **THEN** the current input is copied to the shmem region before the target is called
- **AND** the shmem generation counter is incremented

#### Scenario: Normal iteration

- **WHEN** the target executes without throwing
- **THEN** the watchdog is disarmed
- **AND** `reportResult(ExitKind.Ok)` is called
- **AND** the loop continues to the next iteration

#### Scenario: Target throws

- **WHEN** the target throws an error during execution
- **THEN** the watchdog is disarmed
- **AND** the exception is classified as `ExitKind.Crash` (watchdog "fired" flag is not set)
- **AND** the error and input are captured for crash artifact writing

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
- **AND** the parent writes the crash artifact
- **AND** the fuzz loop iteration cycle is not involved in crash handling (the parent handles it)
