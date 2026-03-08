## MODIFIED Requirements

### Requirement: Crash counter and multi-crash artifact collection

When `stopOnCrash` is `false`, the fuzz loop SHALL maintain a crash counter that increments for each crash or timeout that produces `IterationResult.Solution` **and is not suppressed or replaced by defect dedup**. Each such crash SHALL:

1. Be minimized (for JS crashes only, same as existing behavior) and written as a crash artifact.
2. Increment the crash counter.
3. Be appended to an internal list of crash artifact paths.

Crashes that are suppressed by dedup (duplicate with same or larger input) SHALL NOT increment the crash counter or be appended to the artifact path list. Crashes that are replaced by dedup (duplicate with smaller input) SHALL atomically replace the existing artifact but SHALL NOT increment the crash counter or append a new entry to the path list (the original entry remains).

After the fuzz loop terminates (by time limit, iteration limit, SIGINT, or `maxCrashes`), the `FuzzLoopResult` SHALL include:
- `crashCount`: the total number of unique crashes found (0 if none), excluding suppressed and replaced duplicates
- `crashArtifactPaths`: array of all artifact paths written during the campaign (updated in-place when an artifact is replaced by a smaller reproducer)
- `crashed`: `true` if `crashCount > 0`, `false` otherwise
- `error`: the error from the first crash (for vitest reporting compatibility)
- `crashInput`: the input from the first crash
- `crashArtifactPath`: the artifact path of the first crash (singular, for backward compatibility)
- `duplicateCrashesSkipped`: the total number of crashes suppressed by dedup

#### Scenario: Multiple JS crashes collected with dedup active

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzzer finds 5 JS crashes, 3 of which are duplicates of the first 2
- **THEN** 2 crash artifacts are written (each minimized)
- **AND** `crashCount` is 2
- **AND** `crashArtifactPaths` contains 2 paths
- **AND** `duplicateCrashesSkipped` is 3

#### Scenario: Suppressed duplicate does not count toward maxCrashes

- **WHEN** `stopOnCrash` is `false`
- **AND** `maxCrashes` is set to `5`
- **AND** the fuzzer finds 5 unique crashes and 10 duplicates
- **THEN** the crash counter reaches 5 (only unique crashes counted)
- **AND** the loop terminates due to `maxCrashes`
- **AND** `duplicateCrashesSkipped` is 10

#### Scenario: Replaced artifact updates path list in place

- **WHEN** `stopOnCrash` is `false`
- **AND** crash A is found with a 100-byte input, written to `crash-aaa`
- **AND** crash A is found again with a 50-byte input
- **THEN** `crash-aaa` is atomically replaced with the smaller input (new path `crash-bbb`)
- **AND** `crashArtifactPaths` contains `crash-bbb` (not both paths)
- **AND** `crashCount` remains unchanged (replacement is not a new crash)

#### Scenario: Mix of crashes and timeouts collected

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzzer finds 2 JS crashes and 1 timeout
- **THEN** 2 crash artifacts and 1 timeout artifact are written
- **AND** `crashCount` is 3
- **AND** timeouts are not minimized (same as existing behavior)
- **AND** timeouts are not deduplicated (fail open)

#### Scenario: No crashes found

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzzer runs to the time limit without any crash
- **THEN** `crashCount` is 0
- **AND** `crashArtifactPaths` is empty
- **AND** `crashed` is `false`
- **AND** `duplicateCrashesSkipped` is 0

#### Scenario: Stage crash collected when continuing

- **WHEN** `stopOnCrash` is `false`
- **AND** a crash occurs during stage execution
- **THEN** `abortStage()` is called (same as existing behavior)
- **AND** the raw stage input is written as a crash artifact without minimization, unless suppressed by dedup
- **AND** the crash counter is incremented only if the crash was not suppressed or replaced by dedup
- **AND** the fuzz loop continues to the next iteration (instead of terminating)
