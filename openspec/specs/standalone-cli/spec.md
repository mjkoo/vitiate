## ADDED Requirements

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

### Requirement: libFuzzer-compatible flags

The CLI SHALL accept libFuzzer-style flags (hyphen prefix, `=` separator):

- `-max_len=N`: Maximum input length in bytes. Passed to `FuzzerConfig.maxInputLen`.
- `-timeout=N`: Per-execution timeout in seconds. Converted to milliseconds for `FuzzOptions.timeoutMs`. Applies to both synchronous and asynchronous fuzz targets.
- `-runs=N`: Exit after N executions. Passed to `FuzzOptions.runs`.
- `-seed=N`: RNG seed. Passed to `FuzzerConfig.seed`.
- `-fork=N`: Accepted for OSS-Fuzz compatibility. Vitiate always runs a single
  supervised worker; this flag is permanently ignored. `-fork=1` is silently
  accepted (matches the default architecture). `-fork=0` warns that non-fork
  mode is not available. `-fork=N` (N>1) warns that multi-worker mode is ignored.
- `-jobs=N`: Accepted for OSS-Fuzz compatibility. Vitiate always runs a single job;
  this flag is permanently ignored. `-jobs=1` is silently accepted.
  `-jobs=N` (N>1) prints a warning.
- `-merge=1`: Accepted but ignored (not MVP). Print a warning.

#### Scenario: max_len flag

- **WHEN** `npx vitiate ./test.ts -max_len=1024` is executed
- **THEN** the fuzzer is configured with `maxInputLen: 1024`

#### Scenario: Multiple flags

- **WHEN** `npx vitiate ./test.ts -timeout=10 -runs=100000 -seed=42` is executed
- **THEN** the fuzzer is configured with timeout 10000ms, 100000 max runs, and seed 42
- **AND** the timeout applies to both synchronous and asynchronous targets

#### Scenario: Multi-worker fork flag is ignored

- **WHEN** `npx vitiate ./test.ts -fork=4` is executed
- **THEN** a warning is printed that `-fork=4` is ignored (vitiate runs a single supervised worker)
- **AND** fuzzing proceeds with single-worker mode

#### Scenario: Parallel jobs flag is ignored

- **WHEN** `npx vitiate ./test.ts -jobs=4` is executed
- **THEN** a warning is printed that `-jobs=4` is ignored (vitiate runs a single job)
- **AND** fuzzing proceeds normally

#### Scenario: Timeout enforced on synchronous target

- **WHEN** `npx vitiate ./test.ts -timeout=5` is executed against a synchronous fuzz target
- **THEN** the watchdog is armed with 5000ms before each target execution
- **AND** a synchronous hang is interrupted after 5 seconds

### Requirement: Corpus directory positional arguments

The CLI SHALL accept additional positional arguments (after the test file) as corpus directories. The first corpus directory is the writable output directory; additional directories are read-only seed sources.

#### Scenario: Single corpus directory

- **WHEN** `npx vitiate ./test.ts ./corpus/` is executed
- **THEN** `./corpus/` is used as both the seed source and the writable corpus output directory

#### Scenario: Multiple corpus directories

- **WHEN** `npx vitiate ./test.ts ./corpus/ ./seeds1/ ./seeds2/` is executed
- **THEN** `./corpus/` is the writable output directory
- **AND** `./seeds1/` and `./seeds2/` are read-only seed sources
- **AND** all entries from all three directories are loaded as seeds

### Requirement: Fuzztime flag

The CLI SHALL accept a `-fuzztime` flag specifying the total fuzzing duration. The value SHALL accept a number followed by an optional unit suffix: `s` (seconds, default), `m` (minutes), `h` (hours).

#### Scenario: Fuzztime in seconds

- **WHEN** `npx vitiate ./test.ts -fuzztime=30s` is executed
- **THEN** the fuzz loop terminates after 30 seconds

#### Scenario: Fuzztime in minutes

- **WHEN** `npx vitiate ./test.ts -fuzztime=5m` is executed
- **THEN** the fuzz loop terminates after 5 minutes

#### Scenario: Fuzztime without unit

- **WHEN** `npx vitiate ./test.ts -fuzztime=60` is executed
- **THEN** the fuzz loop terminates after 60 seconds (default unit)
