## ADDED Requirements

### Requirement: Test name flag

The CLI SHALL accept a `-test=<name>` flag that selects exactly one fuzz test by name. When provided:

1. The name SHALL be escaped and anchored as `^{escaped}$` before being passed to `startVitest()` as the `testNamePattern` option, ensuring exact-match semantics (e.g., `-test=parse-url` matches only "parse-url", not "parse-url-v2").
2. The name SHALL be used as the `testName` for `runSupervisor()`, ensuring crash artifacts are written to the correct test-specific directory.

When `-test` is not provided, all fuzz tests in the file enter the fuzz loop. The parent SHALL derive `testName` from the filename (current behavior), which is correct for the single-test-per-file convention used in libFuzzer/OSS-Fuzz.

#### Scenario: Filter to specific test in multi-test file

- **WHEN** `npx vitiate ./test.fuzz.ts -test=parse-url` is executed
- **AND** the file contains `fuzz("parse-url", ...)` and `fuzz("normalize-url", ...)`
- **THEN** only "parse-url" enters the fuzz loop
- **AND** "normalize-url" is skipped by Vitest's runner (callback never executes)
- **AND** crash artifacts are written to `testdata/fuzz/{hash}-parse-url/`

#### Scenario: No filter runs all tests

- **WHEN** `npx vitiate ./test.fuzz.ts` is executed without `-test`
- **AND** the file contains `fuzz("parse-url", ...)` and `fuzz("normalize-url", ...)`
- **THEN** both tests enter the fuzz loop sequentially
- **AND** crash artifacts use the filename-derived test name

#### Scenario: Filter with libFuzzer flags

- **WHEN** `npx vitiate ./test.fuzz.ts -test=parse-url -max_total_time=30 -max_len=4096` is executed
- **THEN** the test filter is applied AND the libFuzzer flags are forwarded to the fuzzer

## MODIFIED Requirements

### Requirement: CLI entry point

The system SHALL provide a `bin` entry (`npx vitiate`) that accepts a fuzz test file path as the first positional argument and starts fuzzing targeting that file.

Usage: `npx vitiate <test-file> [corpus_dirs...] [flags]`

The CLI SHALL:

1. Parse the test file path from the first positional argument.
2. Parse the optional `-test=<name>` flag.
3. Check for the `VITIATE_SUPERVISOR` environment variable to determine mode:
   - **If absent (parent mode)**: Allocate shmem, spawn itself as a child process with `VITIATE_SUPERVISOR` set to the shmem identifier, and enter the supervisor wait loop. If `-test` is provided, use the name as `testName` for `runSupervisor()`. Otherwise, derive `testName` from the filename.
   - **If present (child mode)**: Attach to the shmem region, set `VITIATE_FUZZ=1` in the process environment, and call `startVitest('test', [testFile], ...)` with the vitiate plugin loaded. If `-test` is provided, escape and anchor the name as `^{escaped}$` and pass as `testNamePattern` to `startVitest()`.
4. In parent mode, forward the exit code from the supervisor's exit code protocol (0, 1, or respawn on signal death).

#### Scenario: Basic invocation (parent mode)

- **WHEN** `npx vitiate ./tests/parser.fuzz.ts` is executed
- **THEN** the CLI allocates a shmem region
- **AND** spawns itself as a child with `VITIATE_SUPERVISOR` set
- **AND** enters the supervisor wait loop

#### Scenario: Child mode invocation

- **WHEN** `npx vitiate ./tests/parser.fuzz.ts` is executed with `VITIATE_SUPERVISOR` set
- **THEN** the CLI attaches to the shmem region
- **AND** Vitest starts in fuzzing mode with `./tests/parser.fuzz.ts` as the test file
- **AND** the vitiate plugin is loaded for instrumentation

#### Scenario: No test file provided

- **WHEN** `npx vitiate` is executed with no arguments
- **THEN** an error message is printed and the process exits with code 1

#### Scenario: Child inherits CLI flags

- **WHEN** `npx vitiate ./test.ts -timeout=10 -runs=100000 -seed=42` is executed
- **THEN** the child process receives the same arguments
- **AND** the child parses and applies the same flags as if invoked directly

#### Scenario: Test filter passed to child

- **WHEN** `npx vitiate ./test.ts -test=parse-url` is executed in child mode
- **THEN** `startVitest()` is called with `testNamePattern: "^parse\\-url$"` (escaped and anchored)
- **AND** only the "parse-url" test callback executes (exact match)
