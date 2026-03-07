## ADDED Requirements

### Requirement: fuzz test registrar function

The system SHALL export a `fuzz(name, target, options?)` function that registers a fuzz test with Vitest. The function SHALL follow the same pattern as Vitest's `bench()` - a top-level test registrar that appears in test output and integrates with Vitest's runner.

Signature:

```ts
fuzz(name: string, target: (data: Buffer) => void | Promise<void>, options?: FuzzOptions)
```

The `FuzzOptions` SHALL support:

- `maxLen` (number, optional): Maximum input length in bytes.
- `timeoutMs` (number, optional): Per-execution timeout in milliseconds.
- `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
- `runs` (number, optional): Maximum number of fuzzing iterations.
- `seed` (number, optional): RNG seed for reproducible fuzzing.

#### Scenario: Register a fuzz test

- **WHEN** `fuzz("my parser", (data) => parse(data))` is called in a test file
- **THEN** a test named "my parser" is registered with Vitest's runner

#### Scenario: Async fuzz target

- **WHEN** `fuzz("async target", async (data) => { await process(data) })` is called
- **THEN** the fuzz target is awaited on each execution

### Requirement: Regression mode behavior

In regression mode (no `VITIATE_FUZZ`), the `fuzz()` function SHALL load the corpus for the test and run each entry as a sub-test via Vitest. Each corpus entry produces a separate assertion - if the target throws for any entry, the test fails.

If no corpus directory exists or the directory is empty, the test SHALL run the target once with an empty `Buffer` as a smoke test.

#### Scenario: Replay corpus entries

- **WHEN** `fuzz("parse", target)` runs in regression mode
- **AND** `testdata/fuzz/parse/` contains files `seed1` and `seed2`
- **THEN** `target` is called with the contents of `seed1` and `seed2`
- **AND** both executions are reported in Vitest's test output

#### Scenario: Corpus entry triggers error

- **WHEN** a corpus entry causes the target to throw
- **THEN** the test fails with the error message and the corpus entry filename

#### Scenario: No corpus directory

- **WHEN** `fuzz("new-target", target)` runs in regression mode
- **AND** no `testdata/fuzz/new-target/` directory exists
- **THEN** `target` is called once with an empty Buffer
- **AND** the test passes if the target does not throw

### Requirement: Fuzzing mode behavior

In fuzzing mode (`VITIATE_FUZZ` is set), the `fuzz()` function SHALL detect whether it is running under a supervisor (the `VITIATE_SUPERVISOR` environment variable is set) and behave accordingly:

**Child mode (supervised):** When `VITIATE_SUPERVISOR` is set, the `fuzz()` callback SHALL enter the fuzz loop directly — creating a `Fuzzer` instance, loading seeds, and running the mutation loop until a termination condition is met. This is the existing behavior, unchanged.

**Parent mode (unsupervised):** When `VITIATE_SUPERVISOR` is not set, the `fuzz()` callback SHALL become the supervisor for a single fuzz test. It SHALL:

1. Allocate a cross-process shared memory region via the shared-memory-stash capability.
2. Spawn a child Vitest process filtered to execute only the targeted fuzz test, with `VITIATE_SUPERVISOR=1` and `VITIATE_FUZZ=1` set in the child's environment.
3. Enter the shared supervisor wait loop (`runSupervisor()`).
4. Translate the `SupervisorResult` into Vitest test semantics: `crashed === true` throws an error (test fails), `crashed === false` returns normally (test passes).

Each `fuzz()` call in a test file SHALL get its own independent supervisor lifecycle — its own shmem allocation, its own child process, its own crash recovery. Multiple fuzz tests in the same file run sequentially, each independently supervised.

All fuzz tests SHALL enter fuzzing mode when `VITIATE_FUZZ` is set. Per-test filtering SHALL be handled by Vitest's built-in `--test-name-pattern` / `-t` flag, which skips non-matching test callbacks at the runner level. The `VITIATE_FUZZ_PATTERN` env var, `getFuzzPattern()` helper, and `shouldEnterFuzzLoop()` pattern matching logic SHALL be removed.

> **Removed in change `projects-fuzz-activation`**: The following scenarios were removed: "Filter by pattern via VITIATE_FUZZ_PATTERN", "No pattern means all tests fuzz", "getFuzzPattern returns pattern from VITIATE_FUZZ_PATTERN", "getFuzzPattern returns null when no pattern is set", "getFuzzPattern returns null when pattern is empty".
> **Reason**: `VITIATE_FUZZ_PATTERN` had incorrect behavior — non-matching tests regression-replayed instead of skipping. Vitest's built-in `-t` / `--test-name-pattern` provides correct runner-level filtering. The standalone CLI adds `-test=<name>` for the same purpose.
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
- **`--test-name-pattern`** with anchored regex (`^...$`) filters at the Vitest runner level so only the targeted test runs. All other tests (fuzz and non-fuzz) are skipped — their callbacks never execute.
- **Test file path** SHALL be obtained from `getCurrentTest()?.file?.filepath`.
- **Regex escaping** SHALL use a well-supported library (e.g., `escape-string-regexp`) — custom regex escaping logic SHALL NOT be implemented.

The child's environment SHALL inherit the parent's env vars plus:
- `VITIATE_SUPERVISOR=1` — signals the child's `fuzz()` to enter the fuzz loop directly.
- `VITIATE_FUZZ=1` — activates fuzzing mode.

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
- **AND** all other parent env vars (including `VITIATE_FUZZ_OPTIONS`) are inherited

### Requirement: fuzz.skip, fuzz.only, fuzz.todo modifiers

The `fuzz` function SHALL support `.skip`, `.only`, and `.todo` modifiers matching Vitest's `test` modifiers.

#### Scenario: Skip a fuzz test

- **WHEN** `fuzz.skip("disabled", target)` is called
- **THEN** the test is registered but skipped during execution

#### Scenario: Only run specific fuzz test

- **WHEN** `fuzz.only("focused", target)` is called
- **THEN** only this test runs (standard Vitest `.only` behavior)

#### Scenario: Todo fuzz test

- **WHEN** `fuzz.todo("planned")` is called
- **THEN** the test appears as a todo in Vitest output
