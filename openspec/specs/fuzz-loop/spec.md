## ADDED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL implement the following cycle for each iteration:

1. Call `fuzzer.getNextInput()` to get a mutated input.
2. Stash the input to the cross-process shmem region via the shared-memory-stash capability, if a shmem handle is available.
3. Call `watchdog.runTarget(target, input, timeoutMs)` which internally arms the watchdog, calls the target at the NAPI C level, and disarms on return. If V8 TerminateExecution fires during the call, the C++ shim intercepts it and returns `exitKind=2` (timeout). If the target throws, it returns `exitKind=1` (crash). If the target returns a Promise, it returns `exitKind=0` with the Promise in `result`.
4. If `runTarget` returned a Promise: re-arm the watchdog, await the Promise, and disarm in a `finally` block. On catch, check `watchdog.didFire` to classify as `Timeout` vs `Crash`.
5. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws, `Timeout` if the watchdog fired.
6. Call `fuzzer.reportResult(exitKind)` which reads coverage, updates corpus, zeroes the map, and drains CmpLog.

The shmem stash (step 2) SHALL occur whenever the `VITIATE_SUPERVISOR` environment variable is set, regardless of whether the supervisor was spawned by the CLI entry point or by the `fuzz()` test callback. The fuzz loop does not need to know which entry point spawned the supervisor — the `VITIATE_SUPERVISOR` env var is the sole indicator.

The loop SHALL terminate when any of these conditions is met:

- A crash or timeout is detected (solution found).
- The time limit (`fuzzTime`) is reached.
- The iteration limit (`runs`) is reached.
- The process receives SIGINT.

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

### Requirement: Seed loading

Before the fuzz loop begins, the system SHALL load all available seed inputs and add them to the fuzzer via `addSeed()`:

1. Read all files from the seed corpus directory (`testdata/fuzz/{testName}/`).
2. Read all files from the cached corpus directory (`.vitiate-corpus/{testName}/`).
3. Add each file's contents as a seed via `fuzzer.addSeed()`.

If no seeds are available, the fuzzer's auto-seed mechanism provides default starting inputs.

#### Scenario: Seeds from corpus directories

- **WHEN** the seed corpus contains 3 files and the cached corpus contains 5 files
- **THEN** 8 seeds are added to the fuzzer before the loop begins

#### Scenario: No seeds available

- **WHEN** neither corpus directory exists
- **THEN** the fuzzer auto-seeds with its default set and the loop begins normally

### Requirement: Async target support

The fuzz loop SHALL support async target functions. If the target returns a Promise, the loop SHALL await it before disarming the watchdog and calling `reportResult()`. The watchdog enforces timeouts for both sync and async targets uniformly — there SHALL be no separate async-specific timeout mechanism.

#### Scenario: Async target completes normally

- **WHEN** the target returns a Promise that resolves within the timeout
- **THEN** the watchdog is disarmed
- **AND** `reportResult(ExitKind.Ok)` is called after resolution

#### Scenario: Async target rejects

- **WHEN** the target returns a Promise that rejects
- **THEN** the watchdog is disarmed
- **AND** `reportResult(ExitKind.Crash)` is called with the rejection reason captured

### Requirement: Periodic event loop yield

The fuzz loop SHALL yield to the event loop periodically to prevent starvation. The yield SHALL occur every N iterations (default 1000) using `setImmediate` wrapped in a Promise.

#### Scenario: Event loop not starved

- **WHEN** the fuzz loop runs for 10000 iterations
- **THEN** `setImmediate` is called at least 9 times (every 1000 iterations)
- **AND** other pending microtasks and I/O callbacks have an opportunity to execute

### Requirement: Interesting input persistence

When `reportResult()` returns `Interesting`, the system SHALL write the input to the cached corpus directory so it persists across fuzzing sessions.

#### Scenario: Interesting input saved

- **WHEN** `reportResult()` returns `Interesting`
- **THEN** the input buffer is written to `.vitiate-corpus/{testName}/{hash}`
- **AND** subsequent fuzzing sessions can load it as a seed
