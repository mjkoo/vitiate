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

If `VITIATE_FUZZ` contains a non-`1` value, it SHALL be treated as a regex filter - only fuzz tests whose name matches the pattern SHALL enter supervised fuzzing mode. Non-matching tests SHALL fall back to regression behavior.

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

#### Scenario: Filter by pattern

- **WHEN** `VITIATE_FUZZ=parse` is set
- **AND** two fuzz tests exist: "parse" and "serialize"
- **THEN** only "parse" enters supervised fuzzing mode
- **AND** "serialize" runs in regression mode

#### Scenario: Crash found during supervised fuzzing

- **WHEN** the supervised child finds a crash (exit code 1, signal death, or code 77)
- **THEN** the `fuzz()` callback throws an error
- **AND** the error message includes the crash artifact path
- **AND** the Vitest test is reported as failed

#### Scenario: Campaign completes without crash

- **WHEN** the supervised child exits with code 0 (campaign complete)
- **THEN** the `fuzz()` callback returns normally
- **AND** the Vitest test is reported as passed

### Requirement: Child process spawning

The `fuzz()` callback in parent mode SHALL spawn the child Vitest process using the following command:

```
node <vitest-cli-path> run <testFilePath> --test-name-pattern "^<escapedFullTaskName>$"
```

where the full task name follows Vitest's `getTaskFullName` format: `"<relativeFilePath> <suite1> ... <testName>"` (space-separated hierarchy including the file's relative path and any describe blocks).

- **`process.execPath`** SHALL be used for the Node binary (same version, same flags).
- **Vitest CLI path** SHALL be resolved via `createRequire(import.meta.url).resolve('vitest/vitest.mjs')`.
- **`run`** mode ensures Vitest executes once and exits (no watch mode).
- **`--test-name-pattern`** with anchored regex (`^...$`) filters at the Vitest runner level so only the targeted test runs. All other tests (fuzz and non-fuzz) are skipped - their callbacks never execute.
- **Test file path** SHALL be obtained from `getCurrentTest()?.file?.filepath`.
- **Regex escaping** SHALL use a well-supported library (e.g., `escape-string-regexp`) - custom regex escaping logic SHALL NOT be implemented.

The child's environment SHALL inherit the parent's env vars plus:
- `VITIATE_SUPERVISOR=1` - signals the child's `fuzz()` to enter the fuzz loop directly.
- `VITIATE_FUZZ=1` - activates fuzzing mode.

The child picks up the same `vitest.config.ts` from the working directory, loads the same vitiate plugin, applies the same SWC transforms.

#### Scenario: Child process command

- **WHEN** `fuzz("parse (JSON)", target)` becomes a supervisor
- **THEN** the child is spawned with `process.execPath` as the Node binary
- **AND** the Vitest CLI path is resolved from the current module's resolution context
- **AND** `--test-name-pattern` receives the escaped full task name (file path + describe hierarchy + test name) with `^...$` anchors
- **AND** special regex characters in the test name (parentheses, brackets, etc.) are properly escaped using a library function

#### Scenario: Child environment

- **WHEN** the child Vitest process is spawned
- **THEN** `VITIATE_SUPERVISOR=1` is set in the child's environment
- **AND** `VITIATE_FUZZ=1` is set in the child's environment
- **AND** all other parent env vars (including `VITIATE_FUZZ_OPTIONS`, `VITIATE_CACHE_DIR`, `VITIATE_PROJECT_ROOT`) are inherited
