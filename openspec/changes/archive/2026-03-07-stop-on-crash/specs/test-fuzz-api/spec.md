## MODIFIED Requirements

### Requirement: Fuzzing mode behavior

In fuzzing mode (`VITIATE_FUZZ` is set), the `fuzz()` function SHALL detect whether it is running under a supervisor (the `VITIATE_SUPERVISOR` environment variable is set) and behave accordingly:

**Child mode (supervised):** When `VITIATE_SUPERVISOR` is set, the `fuzz()` callback SHALL enter the fuzz loop directly - creating a `Fuzzer` instance, loading seeds, and running the mutation loop until a termination condition is met. If the fuzz loop result indicates crashes were found (`crashed === true`), the callback SHALL throw an error. The error message SHALL include the crash count and the first crash artifact path.

**Parent mode (unsupervised):** When `VITIATE_SUPERVISOR` is not set, the `fuzz()` callback SHALL become the supervisor for a single fuzz test. It SHALL:

1. Allocate a cross-process shared memory region via the shared-memory-stash capability.
2. Spawn a child Vitest process filtered to execute only the targeted fuzz test, with `VITIATE_SUPERVISOR=1` and `VITIATE_FUZZ=1` set in the child's environment.
3. Enter the shared supervisor wait loop (`runSupervisor()`).
4. Translate the `SupervisorResult` into Vitest test semantics: `crashed === true` throws an error (test fails), `crashed === false` returns normally (test passes).

Each `fuzz()` call in a test file SHALL get its own independent supervisor lifecycle - its own shmem allocation, its own child process, its own crash recovery. Multiple fuzz tests in the same file run sequentially, each independently supervised.

All fuzz tests SHALL enter fuzzing mode when `VITIATE_FUZZ` is set. Per-test filtering SHALL be handled by Vitest's built-in `--test-name-pattern` / `-t` flag, which skips non-matching test callbacks at the runner level. The `VITIATE_FUZZ_PATTERN` env var, `getFuzzPattern()` helper, and `shouldEnterFuzzLoop()` pattern matching logic SHALL be removed.

> **Removed in change `projects-fuzz-activation`**: The following scenarios were removed: "Filter by pattern via VITIATE_FUZZ_PATTERN", "No pattern means all tests fuzz", "getFuzzPattern returns pattern from VITIATE_FUZZ_PATTERN", "getFuzzPattern returns null when no pattern is set", "getFuzzPattern returns null when pattern is empty".
> **Reason**: `VITIATE_FUZZ_PATTERN` had incorrect behavior - non-matching tests regression-replayed instead of skipping. Vitest's built-in `-t` / `--test-name-pattern` provides correct runner-level filtering. The standalone CLI adds `-test=<name>` for the same purpose.
> **Migration**: Use `VITIATE_FUZZ=1 vitest run -t "<pattern>"` instead of `VITIATE_FUZZ=1 VITIATE_FUZZ_PATTERN=<pattern> vitest run`. For the standalone CLI, use `-test=<name>`.

#### Scenario: Enter fuzz loop (child mode)

- **WHEN** `fuzz("parse", target)` runs with `VITIATE_FUZZ=1` and `VITIATE_SUPERVISOR=1`
- **THEN** a Fuzzer instance is created with the global coverage map
- **AND** the mutation loop runs until a termination condition is met
- **AND** no supervisor is spawned (the fuzz loop runs in-process)

#### Scenario: Become supervisor (parent mode)

- **WHEN** `fuzz("parse", target)` runs with `VITIATE_FUZZ=1` and `VITIATE_SUPERVISOR` is not set
- **THEN** shmem is allocated for cross-process input stashing
- **AND** a child Vitest process is spawned with `VITIATE_SUPERVISOR=1` and `VITIATE_FUZZ=1`
- **AND** the child process is filtered to run only the "parse" fuzz test
- **AND** the `fuzz()` callback enters the shared supervisor wait loop
- **AND** the callback returns normally if no crash is found (test passes)
- **OR** the callback throws if a crash is found (test fails with artifact path)

#### Scenario: Multiple fuzz tests in one file

- **WHEN** a test file contains `fuzz("parse", parseTarget)` and `fuzz("serialize", serializeTarget)`
- **AND** both run in fuzzing mode without a supervisor
- **THEN** "parse" spawns its own supervised child, runs to completion, and returns
- **AND** then "serialize" spawns its own supervised child, runs to completion, and returns
- **AND** each has independent shmem, independent crash recovery, and independent artifacts

#### Scenario: All fuzz tests enter fuzzing mode when VITIATE_FUZZ is set

- **WHEN** `VITIATE_FUZZ=1` is set
- **AND** two fuzz tests exist: "parse" and "serialize"
- **THEN** both "parse" and "serialize" enter supervised fuzzing mode
- **AND** per-test filtering is handled by Vitest's `-t` flag at the runner level (non-matching callbacks never execute)

#### Scenario: Single crash found during supervised fuzzing

- **WHEN** the supervised child finds exactly one crash
- **THEN** the `fuzz()` callback throws an error
- **AND** the error message includes the crash artifact path
- **AND** the Vitest test is reported as failed

#### Scenario: Multiple crashes found in child mode

- **WHEN** `stopOnCrash` is `false`
- **AND** the child-mode fuzz loop finds multiple crashes before the campaign ends
- **THEN** the child's `fuzz()` callback throws an error
- **AND** the error message includes the crash count (e.g., "3 crashes found")
- **AND** the error message includes the artifact directory or first artifact path
- **AND** the Vitest test is reported as failed

#### Scenario: Multiple crashes surfaced to parent mode

- **WHEN** `stopOnCrash` is `false`
- **AND** the supervised child finds multiple crashes and exits with code 1
- **THEN** the parent's `fuzz()` callback throws via `translateSupervisorResult` with a generic crash message
- **AND** the child's detailed crash output (count, artifact paths) is visible via inherited stderr
- **AND** the Vitest test is reported as failed

#### Scenario: Campaign completes without crash

- **WHEN** the supervised child exits with code 0 (campaign complete)
- **THEN** the `fuzz()` callback returns normally
- **AND** the Vitest test is reported as passed

#### Scenario: stopOnCrash resolved in vitest child mode

- **WHEN** the `fuzz()` callback enters child mode (supervised)
- **AND** `stopOnCrash` is `"auto"` or not set
- **THEN** `stopOnCrash` is resolved to `false` before entering the fuzz loop
- **AND** the resolution uses `libfuzzerCompat=false` (vitest mode) to determine the default
