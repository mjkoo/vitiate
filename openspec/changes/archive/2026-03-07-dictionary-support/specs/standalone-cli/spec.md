## MODIFIED Requirements

### Requirement: libFuzzer-compatible flags

The CLI SHALL accept libFuzzer-style flags (hyphen prefix, `=` separator):

- `-max_len=N`: Maximum input length in bytes. Passed to `FuzzerConfig.maxInputLen`.
- `-timeout=N`: Per-execution timeout in seconds. Converted to milliseconds for `FuzzOptions.timeoutMs`. Applies to both synchronous and asynchronous fuzz targets.
- `-runs=N`: Exit after N executions. Passed to `FuzzOptions.runs`.
- `-seed=N`: RNG seed. Passed to `FuzzerConfig.seed`.
- `-artifact_prefix=<path>`: Prefix path for crash/timeout artifacts. See `cli-artifact-prefix` capability.
- `-dict=<path>`: Path to an AFL/libfuzzer-format dictionary file. Resolved relative to cwd. The resolved absolute path SHALL be passed to the child process via the `VITIATE_DICTIONARY_PATH` environment variable. See `user-dictionary` capability.
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

#### Scenario: Dictionary flag

- **WHEN** `npx vitiate ./test.ts -dict=./json.dict` is executed
- **AND** `./json.dict` exists and contains valid dictionary entries
- **THEN** the dictionary path SHALL be resolved to an absolute path
- **AND** the child process SHALL receive `VITIATE_DICTIONARY_PATH` set to the absolute path

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
