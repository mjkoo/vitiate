## ADDED Requirements

### Requirement: CLI entry point

The system SHALL provide a `bin` entry (`npx vitiate`) that accepts a fuzz test file path as the first positional argument and starts fuzzing targeting that file.

Usage: `npx vitiate <test-file> [corpus_dirs...] [flags]`

The CLI SHALL:

1. Parse the test file path from the first positional argument.
2. Check for the `VITIATE_SUPERVISOR` environment variable to determine mode:
   - **If absent (parent mode)**: Allocate shmem, spawn itself as a child process with `VITIATE_SUPERVISOR` set to the shmem identifier, and enter the supervisor wait loop.
   - **If present (child mode)**: Attach to the shmem region, set `VITIATE_FUZZ=1` in the process environment, and call `startVitest('test', [testFile], ...)` with the vitiate plugin loaded.
3. In parent mode, forward the exit code from the supervisor's exit code protocol (0, 1, or respawn on signal death).

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

### Requirement: libFuzzer-compatible flags

The CLI SHALL accept libFuzzer-style flags (hyphen prefix, `=` separator):

- `-max_len=N`: Maximum input length in bytes. Passed to `FuzzerConfig.maxInputLen`.
- `-timeout=N`: Per-execution timeout in seconds. Converted to milliseconds for `FuzzOptions.timeoutMs`. Applies to both synchronous and asynchronous fuzz targets.
- `-runs=N`: Exit after N executions. Passed to `FuzzOptions.runs`.
- `-seed=N`: RNG seed. Passed to `FuzzerConfig.seed`.
- `-fork=N`: Accepted but ignored (not MVP). Print a warning if N > 1.
- `-jobs=N`: Accepted but ignored (not MVP). Print a warning if N > 1.
- `-merge=1`: Accepted but ignored (not MVP). Print a warning.

#### Scenario: max_len flag

- **WHEN** `npx vitiate ./test.ts -max_len=1024` is executed
- **THEN** the fuzzer is configured with `maxInputLen: 1024`

#### Scenario: Multiple flags

- **WHEN** `npx vitiate ./test.ts -timeout=10 -runs=100000 -seed=42` is executed
- **THEN** the fuzzer is configured with timeout 10000ms, 100000 max runs, and seed 42
- **AND** the timeout applies to both synchronous and asynchronous targets

#### Scenario: Unsupported flag warns

- **WHEN** `npx vitiate ./test.ts -fork=4` is executed
- **THEN** a warning is printed that `-fork` is not yet supported
- **AND** fuzzing proceeds with default settings

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
