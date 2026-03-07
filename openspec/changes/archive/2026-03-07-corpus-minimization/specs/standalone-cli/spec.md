## MODIFIED Requirements

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
