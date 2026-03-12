## MODIFIED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL implement the following cycle for each iteration:

1. Call `fuzzer.getNextInput()` to get a mutated input.
2. Stash the input to the cross-process shmem region via the shared-memory-stash capability, if a shmem handle is available.
3. Call `watchdog.runTarget(target, input, timeoutMs)` which internally arms the watchdog, calls the target at the NAPI C level, and disarms on return. If V8 TerminateExecution fires during the call, the C++ shim intercepts it and returns `exitKind=2` (timeout). If the target throws, it returns `exitKind=1` (crash). If the target returns a Promise, it returns `exitKind=0` with the Promise in `result`.
4. If `runTarget` returned a Promise: re-arm the watchdog, await the Promise, and disarm in a `finally` block. On catch, check `watchdog.didFire` to classify as `Timeout` vs `Crash`.
5. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws, `Timeout` if the watchdog fired.
6. Call `fuzzer.reportResult(exitKind)` which reads coverage, updates corpus, zeroes the map, and drains CmpLog.

The shmem stash (step 2) SHALL occur whenever the `VITIATE_SUPERVISOR` environment variable is set, regardless of whether the supervisor was spawned by the CLI entry point or by the `fuzz()` test callback. The fuzz loop does not need to know which entry point spawned the supervisor - the `VITIATE_SUPERVISOR` env var is the sole indicator.

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
