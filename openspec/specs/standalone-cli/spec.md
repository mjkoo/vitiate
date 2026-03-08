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
- `-dict=<path>`: Path to an AFL/libfuzzer-format dictionary file. Resolved relative to cwd. The resolved absolute path SHALL be passed to the child process via the `dictionaryPath` field in the `VITIATE_CLI_IPC` JSON blob. See `user-dictionary` capability.
- `-fork=N`: Accepted for OSS-Fuzz compatibility. Vitiate always runs a single
  supervised worker; this flag is permanently ignored. `-fork=1` is silently
  accepted (matches the default architecture). `-fork=0` warns that non-fork
  mode is not available. `-fork=N` (N>1) warns that multi-worker mode is ignored.
- `-jobs=N`: Accepted for OSS-Fuzz compatibility. Vitiate always runs a single job;
  this flag is permanently ignored. `-jobs=1` is silently accepted.
  `-jobs=N` (N>1) prints a warning.
- `-merge=1`: Enter corpus merge mode. Load all inputs from all specified corpus directories, replay each through the fuzz target to collect coverage edges, run set cover to select the minimal subset covering all edges, and write surviving entries to the first corpus directory. At least one corpus directory SHALL be required when `-merge=1` is set; the CLI SHALL print an error and exit with code 1 if no corpus directories are provided. See `set-cover-merge` capability for full merge behavior.

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

#### Scenario: Dictionary flag

- **WHEN** `npx vitiate ./test.ts -dict=./json.dict` is executed
- **AND** `./json.dict` exists and contains valid dictionary entries
- **THEN** the dictionary path SHALL be resolved to an absolute path
- **AND** the child process SHALL receive the absolute path in the `dictionaryPath` field of `VITIATE_CLI_IPC`

#### Scenario: Dictionary flag with nonexistent file

- **WHEN** `npx vitiate ./test.ts -dict=./missing.dict` is executed
- **AND** `./missing.dict` does not exist
- **THEN** an error message SHALL be printed and the process SHALL exit with a non-zero exit code

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

#### Scenario: Merge mode invoked

- **WHEN** `npx vitiate ./test.ts -merge=1 ./corpus/ ./extra/` is executed
- **THEN** the CLI enters merge mode instead of fuzzing mode
- **AND** corpus directories are loaded, replayed, minimized, and written to `./corpus/`

#### Scenario: Merge mode without corpus directories

- **WHEN** `npx vitiate ./test.ts -merge=1` is executed with no corpus directories
- **THEN** an error message is printed to stderr
- **AND** the process exits with code 1

### Requirement: Corpus directory positional arguments

The CLI SHALL accept additional positional arguments (after the test file) as corpus directories. The first corpus directory is the writable output directory; additional directories are read-only seed sources.

When positional corpus directories are provided:
- All directories SHALL be loaded as seed sources on startup.
- The first directory SHALL be used as the writable output directory for new interesting inputs discovered during fuzzing. New inputs SHALL be written as `{firstCorpusDir}/{contentHash}` (flat layout, no subdirectories).
- The first directory SHALL be created if it does not exist when the first interesting input is written.

When no positional corpus directories are provided in CLI mode:
- The fuzz loop SHALL NOT write new interesting inputs to disk. The in-memory corpus in the LibAFL engine retains all interesting inputs for the duration of the process, matching libFuzzer's behavior when no corpus directory is given.
- Interesting inputs discovered before a crash/respawn are lost. This is expected — users who want corpus persistence must provide a corpus directory.

The CLI SHALL pass CLI-specific IPC configuration to the child process via the `VITIATE_CLI_IPC` environment variable, a JSON blob validated by the `CliIpcSchema` in `config.ts`. The blob includes:

- `libfuzzerCompat: true` — signals that the fuzz loop SHALL use libFuzzer path conventions for corpus writes and artifact paths.
- `corpusOutputDir` — set to the first positional corpus directory when provided. Omitted when no corpus dirs are given.
- `artifactPrefix` — set to the `-artifact_prefix` flag value when provided. Omitted when the flag is omitted (the child defaults to `./` under libFuzzer compat mode).
- `corpusDirs` — array of corpus directory paths.
- `dictionaryPath` — resolved absolute path to the dictionary file.
- `forkExplicit` — set to `true` when the user passes any `-fork=N` flag. Omitted otherwise. Used by the child to resolve `stopOnCrash: "auto"` correctly.

These fields SHALL be read via helper functions in `config.ts` (e.g., `isLibfuzzerCompat()`, `getCorpusOutputDir()`, `getArtifactPrefix()`) which delegate to `getCliIpc()`.

In Vitest mode, `VITIATE_CLI_IPC` SHALL NOT be set. The fuzz loop SHALL use the cache directory layout for corpus and `testdata/fuzz/{sanitizedName}/` for artifacts.

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
- **AND** `VITIATE_CLI_IPC` is not set (or `corpusOutputDir` is absent)
- **THEN** interesting inputs are written to the cache directory layout (existing behavior)

#### Scenario: Fork flag sets forkExplicit in CliIpc

- **WHEN** `npx vitiate ./test.ts -fork=1` is executed
- **THEN** the `VITIATE_CLI_IPC` JSON blob includes `forkExplicit: true`
- **AND** the child can use this to resolve `stopOnCrash: "auto"` (see crash-continuation capability)

#### Scenario: No fork flag omits forkExplicit from CliIpc

- **WHEN** `npx vitiate ./test.ts` is executed without `-fork`
- **THEN** the `VITIATE_CLI_IPC` JSON blob does not include `forkExplicit`
- **AND** the child resolves `stopOnCrash: "auto"` to `true` (see crash-continuation capability)

### Requirement: -detectors CLI flag

The standalone CLI SHALL accept a `-detectors` flag (single-hyphen, consistent with the existing libFuzzer-compatible flag convention) that configures which bug detectors are active. When `-detectors` is specified, ALL detector defaults are disabled — only explicitly listed detectors are enabled. This makes the flag self-contained: you get exactly what you list.

The flag value SHALL be a comma-separated list of directives:

- `<name>`: Enable a detector (e.g., `pathTraversal`)
- `<name>.<key>=<value>`: Enable a detector with an option (e.g., `pathTraversal.sandboxRoot=/var/www`)

When the flag is absent, tier defaults apply (Tier 1 enabled, Tier 2 disabled). When the flag is present, the parsed configuration SHALL be passed via the `VITIATE_FUZZ_OPTIONS` JSON to the child process.

Detector names SHALL match the camelCase field names in `FuzzOptions.detectors` (e.g., `prototypePollution`, `commandInjection`, `pathTraversal`). An unknown detector name SHALL cause the CLI to print an error and exit.

#### Scenario: Enable specific detector (others disabled)

- **WHEN** `npx vitiate ./test.ts -detectors=prototypePollution` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: true, commandInjection: false, pathTraversal: false }` in its fuzz options

#### Scenario: Disable all detectors

- **WHEN** `npx vitiate ./test.ts -detectors=` is executed (empty value)
- **THEN** the child process SHALL receive `detectors: { prototypePollution: false, commandInjection: false, pathTraversal: false }` in its fuzz options

#### Scenario: Enable multiple detectors

- **WHEN** `npx vitiate ./test.ts -detectors=prototypePollution,commandInjection` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: true, commandInjection: true, pathTraversal: false }` in its fuzz options

#### Scenario: Detector option with dotted syntax

- **WHEN** `npx vitiate ./test.ts -detectors=pathTraversal.sandboxRoot=/var/www` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: false, commandInjection: false, pathTraversal: { sandboxRoot: "/var/www" } }` in its fuzz options

#### Scenario: Combined enable and option

- **WHEN** `npx vitiate ./test.ts -detectors=pathTraversal,pathTraversal.sandboxRoot=/var/www` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: false, commandInjection: false, pathTraversal: { sandboxRoot: "/var/www" } }` in its fuzz options

#### Scenario: Invalid detector name

- **WHEN** `npx vitiate ./test.ts -detectors=nonexistent` is executed
- **THEN** the CLI SHALL print an error message listing valid detector names
- **AND** the process SHALL exit with a non-zero exit code

