## ADDED Requirements

### Requirement: stopOnCrash option

The `FuzzOptions` schema SHALL accept a `stopOnCrash` field with three valid values: `true`, `false`, or `"auto"`. The default SHALL be `"auto"`.

When `stopOnCrash` is `true`, the fuzz loop SHALL terminate after finding the first crash or timeout (existing behavior).

When `stopOnCrash` is `false`, the fuzz loop SHALL continue iterating after finding a crash or timeout, recording each crash artifact and incrementing a crash counter.

When `stopOnCrash` is `"auto"`, the value SHALL be resolved to `true` or `false` before entering the fuzz loop, based on the execution mode:
- **Vitest fuzz mode**: resolves to `false`
- **libFuzzer CLI mode with explicit `-fork` flag**: resolves to `false`
- **libFuzzer CLI mode without `-fork` flag**: resolves to `true`

The fuzz loop SHALL only receive a resolved `true` or `false` value - it SHALL NOT perform auto-resolution itself.

#### Scenario: Default auto resolves to false in vitest mode

- **WHEN** a fuzz test runs in vitest fuzz mode
- **AND** `stopOnCrash` is not explicitly set (defaults to `"auto"`)
- **THEN** the fuzz loop continues after finding a crash
- **AND** the crash artifact is written
- **AND** fuzzing continues until another termination condition is met

#### Scenario: Default auto resolves to false in CLI fork mode

- **WHEN** the standalone CLI is invoked with `-fork=1`
- **AND** `stopOnCrash` is not explicitly set
- **THEN** the fuzz loop continues after finding a crash

#### Scenario: Default auto resolves to true in CLI non-fork mode

- **WHEN** the standalone CLI is invoked without a `-fork` flag
- **AND** `stopOnCrash` is not explicitly set
- **THEN** the fuzz loop stops after finding the first crash

#### Scenario: Explicit true overrides auto

- **WHEN** `stopOnCrash` is explicitly set to `true` in `FuzzOptions`
- **THEN** the fuzz loop stops after the first crash regardless of execution mode

#### Scenario: Explicit false overrides auto

- **WHEN** `stopOnCrash` is explicitly set to `false` in `FuzzOptions`
- **THEN** the fuzz loop continues after crashes regardless of execution mode

### Requirement: maxCrashes option

The `FuzzOptions` schema SHALL accept a `maxCrashes` field as a non-negative integer. The default SHALL be `1000`. A value of `0` SHALL mean unlimited (no crash limit).

When the crash counter reaches `maxCrashes` (and `maxCrashes` is not `0`), the fuzz loop SHALL:
1. Print a warning to stderr indicating the crash limit was reached.
2. Terminate the fuzz loop.

The `maxCrashes` option SHALL only take effect when `stopOnCrash` is `false`. When `stopOnCrash` is `true`, the loop terminates on the first crash and `maxCrashes` is irrelevant.

#### Scenario: Default maxCrashes limits crash collection

- **WHEN** `stopOnCrash` is `false`
- **AND** `maxCrashes` is not explicitly set (defaults to 1000)
- **AND** the fuzzer finds 1000 crashes
- **THEN** a warning is printed to stderr
- **AND** the fuzz loop terminates

#### Scenario: Unlimited crashes with maxCrashes=0

- **WHEN** `stopOnCrash` is `false`
- **AND** `maxCrashes` is explicitly set to `0`
- **THEN** the fuzz loop continues after crashes indefinitely
- **AND** no crash limit warning is printed

#### Scenario: Custom maxCrashes value

- **WHEN** `stopOnCrash` is `false`
- **AND** `maxCrashes` is explicitly set to `5`
- **AND** the fuzzer finds 5 crashes
- **THEN** a warning is printed to stderr
- **AND** the fuzz loop terminates

#### Scenario: maxCrashes irrelevant when stopOnCrash is true

- **WHEN** `stopOnCrash` is `true`
- **AND** `maxCrashes` is set to any value
- **THEN** the fuzz loop terminates on the first crash (maxCrashes has no effect)

### Requirement: Crash counter and multi-crash artifact collection

When `stopOnCrash` is `false`, the fuzz loop SHALL maintain a crash counter that increments for each crash or timeout that produces `IterationResult.Solution`. Each crash SHALL:

1. Be minimized (for JS crashes only, same as existing behavior) and written as a crash artifact.
2. Increment the crash counter.
3. Be appended to an internal list of crash artifact paths.

After the fuzz loop terminates (by time limit, iteration limit, SIGINT, or `maxCrashes`), the `FuzzLoopResult` SHALL include:
- `crashCount`: the total number of crashes found (0 if none)
- `crashArtifactPaths`: array of all artifact paths written during the campaign
- `crashed`: `true` if `crashCount > 0`, `false` otherwise
- `error`: the error from the first crash (for vitest reporting compatibility)
- `crashInput`: the input from the first crash
- `crashArtifactPath`: the artifact path of the first crash (singular, for backward compatibility)

#### Scenario: Multiple JS crashes collected

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzzer finds 3 distinct JS crashes before the time limit
- **THEN** 3 crash artifacts are written (each minimized)
- **AND** `crashCount` is 3
- **AND** `crashArtifactPaths` contains 3 paths
- **AND** `crashed` is `true`
- **AND** `error` contains the first crash's error

#### Scenario: Mix of crashes and timeouts collected

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzzer finds 2 JS crashes and 1 timeout
- **THEN** 2 crash artifacts and 1 timeout artifact are written
- **AND** `crashCount` is 3
- **AND** timeouts are not minimized (same as existing behavior)

#### Scenario: No crashes found

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzzer runs to the time limit without any crash
- **THEN** `crashCount` is 0
- **AND** `crashArtifactPaths` is empty
- **AND** `crashed` is `false`

#### Scenario: Stage crash collected when continuing

- **WHEN** `stopOnCrash` is `false`
- **AND** a crash occurs during stage execution
- **THEN** `abortStage()` is called (same as existing behavior)
- **AND** the raw stage input is written as a crash artifact without minimization (same as existing behavior)
- **AND** the crash counter is incremented
- **AND** the fuzz loop continues to the next iteration (instead of terminating)

### Requirement: Auto-resolution plumbing via CliIpc

The `CliIpc` schema SHALL include an optional `forkExplicit` boolean field. The standalone CLI SHALL set `forkExplicit: true` in the `CliIpc` JSON blob when the user passes any `-fork=N` flag (regardless of N's value).

When resolving `stopOnCrash: "auto"` in libfuzzer-compat mode:
- If `forkExplicit` is `true` in `CliIpc`: resolve to `false` (continue after crash)
- If `forkExplicit` is `undefined` or `false`: resolve to `true` (stop on first crash)

#### Scenario: Fork flag sets forkExplicit

- **WHEN** the CLI is invoked with `-fork=1`
- **THEN** `forkExplicit: true` is set in the `VITIATE_CLI_IPC` JSON blob
- **AND** the child process can read it via `getCliIpc().forkExplicit`

#### Scenario: No fork flag leaves forkExplicit unset

- **WHEN** the CLI is invoked without any `-fork` flag
- **THEN** `forkExplicit` is not present in the `VITIATE_CLI_IPC` JSON blob
- **AND** `getCliIpc().forkExplicit` returns `undefined`

#### Scenario: Auto resolution in CLI with fork

- **WHEN** `stopOnCrash` is `"auto"`
- **AND** `libfuzzerCompat` is `true`
- **AND** `forkExplicit` is `true`
- **THEN** `stopOnCrash` resolves to `false`

#### Scenario: Auto resolution in CLI without fork

- **WHEN** `stopOnCrash` is `"auto"`
- **AND** `libfuzzerCompat` is `true`
- **AND** `forkExplicit` is `undefined`
- **THEN** `stopOnCrash` resolves to `true`
