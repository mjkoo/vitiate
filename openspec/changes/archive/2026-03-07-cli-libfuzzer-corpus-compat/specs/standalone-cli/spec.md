## MODIFIED Requirements

### Requirement: Corpus directory positional arguments

The CLI SHALL accept additional positional arguments (after the test file) as corpus directories. The first corpus directory is the writable output directory; additional directories are read-only seed sources.

When positional corpus directories are provided:
- All directories SHALL be loaded as seed sources on startup.
- The first directory SHALL be used as the writable output directory for new interesting inputs discovered during fuzzing. New inputs SHALL be written as `{firstCorpusDir}/{contentHash}` (flat layout, no subdirectories).
- The first directory SHALL be created if it does not exist when the first interesting input is written.

When no positional corpus directories are provided in CLI mode:
- The fuzz loop SHALL NOT write new interesting inputs to disk. The in-memory corpus in the LibAFL engine retains all interesting inputs for the duration of the process, matching libFuzzer's behavior when no corpus directory is given.
- Interesting inputs discovered before a crash/respawn are lost. This is expected — users who want corpus persistence must provide a corpus directory.

The CLI SHALL ensure the following environment variables are set before the fuzz loop runs (following the existing pattern where the child process sets its own environment before starting Vitest):

- `VITIATE_LIBFUZZER_COMPAT=1` — signals that the fuzz loop SHALL use libFuzzer path conventions for corpus writes and artifact paths.
- `VITIATE_CORPUS_OUTPUT_DIR` — set to the first positional corpus directory when provided. Not set when no corpus dirs are given.
- `VITIATE_ARTIFACT_PREFIX` — set to the `-artifact_prefix` flag value when provided. Not set when the flag is omitted (the child defaults to `./` under libFuzzer compat mode).

These env vars SHALL be read via helper functions in `config.ts` (e.g., `isLibfuzzerCompat()`, `getCorpusOutputDir()`, `getArtifactPrefix()`), following the established pattern of `isFuzzingMode()` and `isSupervisorChild()` which use the private `envTruthy()` helper. `FuzzOptions` is defined via a valibot schema (`FuzzOptionsSchema`) and parsed by `getCliOptions()` using `v.safeParse` — the new env vars are separate from `VITIATE_FUZZ_OPTIONS` and do not require schema validation (they are simple string/boolean values).

In Vitest mode, none of these environment variables SHALL be set. The fuzz loop SHALL use the cache directory layout for corpus and `testdata/fuzz/{sanitizedName}/` for artifacts.

#### Scenario: Single corpus directory

- **WHEN** `npx vitiate ./test.ts ./corpus/` is executed
- **THEN** `./corpus/` is used as both the seed source and the writable corpus output directory
- **AND** new interesting inputs are written to `./corpus/{contentHash}`

#### Scenario: Multiple corpus directories

- **WHEN** `npx vitiate ./test.ts ./corpus/ ./seeds1/ ./seeds2/` is executed
- **THEN** `./corpus/` is the writable output directory
- **AND** `./seeds1/` and `./seeds2/` are read-only seed sources
- **AND** all entries from all three directories are loaded as seeds
- **AND** new interesting inputs are written to `./corpus/{contentHash}`

#### Scenario: No corpus directories — in-memory only

- **WHEN** `npx vitiate ./test.ts` is executed without corpus directories
- **THEN** new interesting inputs are kept in the in-memory corpus only
- **AND** no corpus entries are written to disk

#### Scenario: Corpus output directory created on demand

- **WHEN** `npx vitiate ./test.ts ./new-corpus/` is executed
- **AND** `./new-corpus/` does not exist
- **AND** the fuzzer discovers an interesting input
- **THEN** `./new-corpus/` is created
- **AND** the input is written to `./new-corpus/{contentHash}`

#### Scenario: Vitest mode ignores corpus output dir

- **WHEN** a fuzz test runs in Vitest mode
- **AND** `VITIATE_CORPUS_OUTPUT_DIR` is not set
- **THEN** interesting inputs are written to the cache directory layout (existing behavior)

### Requirement: Test name flag

The CLI SHALL accept a `-test=<name>` flag that selects exactly one fuzz test by name. When provided:

1. The name SHALL be escaped and anchored as `^{escaped}$` before being passed to `startVitest()` as the `testNamePattern` option, ensuring exact-match semantics (e.g., `-test=parse-url` matches only "parse-url", not "parse-url-v2").
2. The name SHALL be used as the `testName` for `runSupervisor()`, for logging and for Vitest-mode artifact path determination.

In CLI mode, the test name does NOT determine the artifact path — artifact paths are determined by the resolved artifact prefix (see `cli-artifact-prefix` capability). The `testName` is still passed to `SupervisorOptions` for log messages and as a fallback when `artifactPrefix` is not set.

When `-test` is not provided, all fuzz tests in the file enter the fuzz loop. The parent SHALL derive `testName` from the filename (current behavior), which is correct for the single-test-per-file convention used in libFuzzer/OSS-Fuzz.

#### Scenario: Filter to specific test in multi-test file

- **WHEN** `npx vitiate ./test.fuzz.ts -test=parse-url` is executed
- **AND** the file contains `fuzz("parse-url", ...)` and `fuzz("normalize-url", ...)`
- **THEN** only "parse-url" enters the fuzz loop
- **AND** "normalize-url" is skipped by Vitest's runner (callback never executes)
- **AND** crash artifacts are written to `./crash-{hash}` (CLI default) or `{prefix}crash-{hash}` if `-artifact_prefix` is set

#### Scenario: No filter runs all tests

- **WHEN** `npx vitiate ./test.fuzz.ts` is executed without `-test`
- **AND** the file contains `fuzz("parse-url", ...)` and `fuzz("normalize-url", ...)`
- **THEN** both tests enter the fuzz loop sequentially
- **AND** crash artifacts are written to the resolved artifact prefix path (not test-name-specific)

#### Scenario: Filter with libFuzzer flags

- **WHEN** `npx vitiate ./test.fuzz.ts -test=parse-url -max_total_time=30 -max_len=4096` is executed
- **THEN** the test filter is applied AND the libFuzzer flags are forwarded to the fuzzer

### Requirement: libFuzzer-compatible flags

The CLI SHALL accept libFuzzer-style flags (hyphen prefix, `=` separator):

- `-max_len=N`: Maximum input length in bytes. Passed to `FuzzerConfig.maxInputLen`.
- `-timeout=N`: Per-execution timeout in seconds. Converted to milliseconds for `FuzzOptions.timeoutMs`. Applies to both synchronous and asynchronous fuzz targets.
- `-runs=N`: Exit after N executions. Passed to `FuzzOptions.runs`.
- `-seed=N`: RNG seed. Passed to `FuzzerConfig.seed`.
- `-artifact_prefix=<path>`: Prefix path for crash/timeout artifacts. See `cli-artifact-prefix` capability.
- `-fork=N`: Accepted for OSS-Fuzz compatibility. Vitiate always runs a single
  supervised worker; this flag is permanently ignored. `-fork=1` is silently
  accepted (matches the default architecture). `-fork=0` warns that non-fork
  mode is not available. `-fork=N` (N>1) warns that multi-worker mode is ignored.
- `-jobs=N`: Accepted for OSS-Fuzz compatibility. Vitiate always runs a single job;
  this flag is permanently ignored. `-jobs=1` is silently accepted.
  `-jobs=N` (N>1) prints a warning.
- `-merge=1`: Accepted but ignored (not MVP). Print a warning.

#### Scenario: Artifact prefix flag

- **WHEN** `npx vitiate ./test.ts -artifact_prefix=./out/` is executed
- **THEN** crash and timeout artifacts are written with prefix `./out/`

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
