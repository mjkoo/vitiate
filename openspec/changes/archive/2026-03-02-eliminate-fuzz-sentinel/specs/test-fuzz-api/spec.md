## MODIFIED Requirements

### Requirement: Fuzzing mode behavior

In fuzzing mode (`VITIATE_FUZZ` is set), the `fuzz()` function SHALL detect whether it is running under a supervisor (the `VITIATE_SUPERVISOR` environment variable is set) and behave accordingly:

**Child mode (supervised):** When `VITIATE_SUPERVISOR` is set, the `fuzz()` callback SHALL enter the fuzz loop directly - creating a `Fuzzer` instance, loading seeds, and running the mutation loop until a termination condition is met. This is the existing behavior, unchanged.

**Parent mode (unsupervised):** When `VITIATE_SUPERVISOR` is not set, the `fuzz()` callback SHALL become the supervisor for a single fuzz test. It SHALL:

1. Allocate a cross-process shared memory region via the shared-memory-stash capability.
2. Spawn a child Vitest process filtered to execute only the targeted fuzz test, with `VITIATE_SUPERVISOR=1` and `VITIATE_FUZZ=1` set in the child's environment.
3. Enter the shared supervisor wait loop (`runSupervisor()`).
4. Translate the `SupervisorResult` into Vitest test semantics: `crashed === true` throws an error (test fails), `crashed === false` returns normally (test passes).

Each `fuzz()` call in a test file SHALL get its own independent supervisor lifecycle - its own shmem allocation, its own child process, its own crash recovery. Multiple fuzz tests in the same file run sequentially, each independently supervised.

If `VITIATE_FUZZ_PATTERN` is set, its value SHALL be treated as a regex filter - only fuzz tests whose name matches the pattern SHALL enter supervised fuzzing mode. Non-matching tests SHALL fall back to regression behavior. If `VITIATE_FUZZ_PATTERN` is not set (or empty), all fuzz tests SHALL enter fuzzing mode.

`getFuzzPattern()` SHALL read `process.env["VITIATE_FUZZ_PATTERN"]` and return its value if it is a non-empty string, or `null` otherwise. The function SHALL NOT inspect the value of `VITIATE_FUZZ`.

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

#### Scenario: Filter by pattern via VITIATE_FUZZ_PATTERN

- **WHEN** `VITIATE_FUZZ=1` and `VITIATE_FUZZ_PATTERN=parse` are set
- **AND** two fuzz tests exist: "parse" and "serialize"
- **THEN** only "parse" enters supervised fuzzing mode
- **AND** "serialize" runs in regression mode

#### Scenario: No pattern means all tests fuzz

- **WHEN** `VITIATE_FUZZ=1` is set and `VITIATE_FUZZ_PATTERN` is not set
- **AND** two fuzz tests exist: "parse" and "serialize"
- **THEN** both "parse" and "serialize" enter supervised fuzzing mode

#### Scenario: Crash found during supervised fuzzing

- **WHEN** the supervised child finds a crash (exit code 1, signal death, or code 77)
- **THEN** the `fuzz()` callback throws an error
- **AND** the error message includes the crash artifact path
- **AND** the Vitest test is reported as failed

#### Scenario: Campaign completes without crash

- **WHEN** the supervised child exits with code 0 (campaign complete)
- **THEN** the `fuzz()` callback returns normally
- **AND** the Vitest test is reported as passed

#### Scenario: getFuzzPattern returns pattern from VITIATE_FUZZ_PATTERN

- **WHEN** `VITIATE_FUZZ_PATTERN=parser` is set in the environment
- **THEN** `getFuzzPattern()` returns `"parser"`

#### Scenario: getFuzzPattern returns null when no pattern is set

- **WHEN** `VITIATE_FUZZ_PATTERN` is not set in the environment
- **THEN** `getFuzzPattern()` returns `null`

#### Scenario: getFuzzPattern returns null when pattern is empty

- **WHEN** `VITIATE_FUZZ_PATTERN=""` is set in the environment
- **THEN** `getFuzzPattern()` returns `null`
