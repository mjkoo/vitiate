## MODIFIED Requirements

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
