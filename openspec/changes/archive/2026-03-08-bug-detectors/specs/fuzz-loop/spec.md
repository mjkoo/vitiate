## MODIFIED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL integrate detector lifecycle hooks around target execution. On each iteration:

1. Call `fuzzer.getNextInput()` to obtain the next mutated input.
2. If a `ShmemHandle` is available, stash the current input for crash recovery.
3. Call `detectorManager.beforeIteration()` to allow detectors to capture baseline state.
4. Execute the target function with the input, under watchdog protection if `timeoutMs > 0`.
5. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws (including `VulnerabilityError` from module-hook detectors), `Timeout` if the watchdog fired.
6. If `ExitKind` is `Ok`, call `detectorManager.afterIteration()`. If this throws a `VulnerabilityError`, upgrade the result to `ExitKind.Crash` with the `VulnerabilityError` as the error.
7. Call `fuzzer.reportResult(exitKind, execTimeNs)` which reads coverage, masks unstable edges, updates corpus, zeroes the map, and drains CmpLog.
8. If `reportResult` returns `Solution`, handle the crash: minimize (for JS crashes only, including `VulnerabilityError`), write the artifact, increment crash count, and check termination conditions (`stopOnCrash`, `maxCrashes`).
9. If `reportResult` returns `Interesting`, run calibration and then run stages (I2S, Generalization, Grimoire). Detector lifecycle hooks SHALL also wrap target execution during calibration re-runs and stage executions (see requirements below).
10. Every 1 000 iterations, yield to the event loop.

#### Scenario: Normal iteration with no detector finding

- **WHEN** the target executes without throwing
- **AND** `detectorManager.afterIteration()` returns without throwing
- **THEN** `reportResult(ExitKind.Ok, execTimeNs)` SHALL be called
- **AND** the loop SHALL continue to the next iteration

#### Scenario: Target throws VulnerabilityError from module hook

- **WHEN** the target calls a hooked function (e.g., `child_process.exec`) during execution
- **AND** the hook throws a `VulnerabilityError`
- **THEN** the iteration SHALL be classified as `ExitKind.Crash`
- **AND** `reportResult(ExitKind.Crash, execTimeNs)` SHALL be called
- **AND** the `VulnerabilityError` SHALL be passed to artifact writing

#### Scenario: afterIteration detector throws VulnerabilityError

- **WHEN** the target executes without throwing
- **AND** `detectorManager.afterIteration()` throws a `VulnerabilityError`
- **THEN** the iteration SHALL be upgraded from `ExitKind.Ok` to `ExitKind.Crash`
- **AND** `reportResult(ExitKind.Crash, execTimeNs)` SHALL be called
- **AND** the `VulnerabilityError` SHALL be passed to artifact writing

#### Scenario: Timeout bypasses afterIteration

- **WHEN** the watchdog fires and the iteration is classified as `ExitKind.Timeout`
- **THEN** `detectorManager.afterIteration()` SHALL NOT be called
- **AND** the timeout SHALL be handled as before (artifact written, no minimization)

#### Scenario: Detector findings are minimized

- **WHEN** a `VulnerabilityError` is thrown (either during execution or in `afterIteration()`)
- **AND** `reportResult` returns `Solution`
- **THEN** the fuzz loop SHALL invoke crash minimization on the input
- **AND** the minimized input SHALL be verified to still trigger the same `VulnerabilityError` before writing the artifact

### Requirement: Detector lifecycle during calibration

The detector lifecycle hooks SHALL wrap target execution during calibration re-runs, identically to the main iteration cycle. For each calibration re-run:

1. Call `detectorManager.beforeIteration()` before executing the target.
2. Execute the target.
3. If the target returns normally (`ExitKind.Ok`), call `detectorManager.afterIteration()`. If this throws a `VulnerabilityError`, upgrade to `ExitKind.Crash`.
4. If a crash or timeout occurs (including `VulnerabilityError`), break out of the calibration loop as specified by the base calibration requirement.

#### Scenario: Detector finding during calibration breaks loop

- **WHEN** the target is being re-run during calibration
- **AND** the target's execution triggers a `VulnerabilityError` (via module hook or `afterIteration()`)
- **THEN** the calibration loop SHALL break immediately
- **AND** `calibrateFinish()` SHALL still be called
- **AND** the `VulnerabilityError` and input SHALL be passed to artifact writing

#### Scenario: Clean calibration with detectors active

- **WHEN** calibration re-runs the target multiple times
- **AND** no detector fires on any re-run
- **THEN** calibration SHALL complete normally
- **AND** `beforeIteration()`/`afterIteration()` SHALL have been called for each re-run

### Requirement: Detector lifecycle during stage execution

The detector lifecycle hooks SHALL wrap target execution during stage iterations (I2S, Generalization, Grimoire), identically to the main iteration cycle. For each stage execution:

1. Call `detectorManager.beforeIteration()` before executing the target with the stage input.
2. Execute the target.
3. If the target returns normally (`ExitKind.Ok`), call `detectorManager.afterIteration()`. If this throws a `VulnerabilityError`, upgrade to `ExitKind.Crash`.
4. If a crash or timeout occurs (including `VulnerabilityError`), call `fuzzer.abortStage(exitKind)`, break out of the stage loop, and proceed to artifact writing. Stage-discovered detector findings SHALL NOT be minimized (same as stage-discovered crashes).

#### Scenario: Detector finding during stage aborts stage

- **WHEN** a stage execution triggers a `VulnerabilityError` (via module hook or `afterIteration()`)
- **THEN** `fuzzer.abortStage(ExitKind.Crash)` SHALL be called
- **AND** the stage loop SHALL break
- **AND** the raw stage input SHALL be written as a `crash-{hash}` artifact WITHOUT minimization

#### Scenario: Clean stage execution with detectors active

- **WHEN** the stage loop executes multiple inputs
- **AND** no detector fires on any stage execution
- **THEN** the stage SHALL complete normally
- **AND** `beforeIteration()`/`afterIteration()` SHALL have been called for each stage execution

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

## ADDED Requirements

### Requirement: DetectorManager construction in fuzz loop

The fuzz loop SHALL construct a `DetectorManager` from the resolved `FuzzOptions.detectors` configuration. The detector tokens from `detectorManager.getTokens()` SHALL be included in the `FuzzerConfig` passed to the `Fuzzer` constructor, so they are available to the mutation engine from the first iteration.

#### Scenario: Detector tokens passed to Fuzzer

- **WHEN** the fuzz loop constructs the `Fuzzer`
- **AND** detectors are active
- **THEN** `detectorManager.getTokens()` SHALL be called before `Fuzzer` construction
- **AND** the returned tokens SHALL be passed as `detectorTokens` in `FuzzerConfig`
