## MODIFIED Requirements

### Requirement: `_exit` fallback with input capture

When `TerminateExecution` is unavailable or ineffective (V8 symbols not found on static Node.js builds, embedded environments, or native code hang that does not return to V8), the watchdog SHALL call `_exit()` to terminate the process. Before exiting, the watchdog SHALL read the current input from the shmem region and write it to disk as a timeout artifact.

When V8 termination is available, the `_exit` deadline SHALL be 5x the configured timeout (giving `TerminateExecution` ample time to propagate through JS frames). When V8 termination is unavailable, the `_exit` deadline SHALL equal the configured timeout (since `_exit` is the primary mechanism). This multiplier SHALL be determined by the result of `vitiate_v8_init()`, not by the target OS.

The `Watchdog` constructor and `installExceptionHandler` SHALL accept an `artifactPrefix` string parameter (replacing the previous `artifactDir` directory parameter). The artifact prefix is a path prefix - not necessarily a directory - and the artifact filename is appended directly to it:

- The timeout artifact path SHALL be `{artifactPrefix}timeout-{contentHash}`.
- The crash artifact path (SEH handler) SHALL be `{artifactPrefix}crash-{contentHash}`.
- If the prefix includes a directory component, the parent directory of the full artifact path SHALL be created recursively before writing.

The artifact prefix passed to the `Watchdog` constructor and `installExceptionHandler` SHALL be determined by the caller based on the active path convention:

- **When `artifactPrefix` is resolved** (CLI mode): Pass the resolved prefix directly (e.g., `./` for default, `./out/` for `-artifact_prefix=./out/`, `bug-` for `-artifact_prefix=bug-`).
- **Otherwise** (Vitest mode): Pass `testdata/fuzz/{sanitizedTestName}/` (trailing slash) so that artifacts are written as `testdata/fuzz/{sanitizedTestName}/timeout-{contentHash}`, preserving existing behavior.

#### Scenario: Timeout with V8 unavailable

- **WHEN** a fuzz target blocks for longer than the armed timeout
- **AND** V8 termination is unavailable (`vitiate_v8_init()` returned 0)
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `{artifactPrefix}timeout-{contentHash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process at 1x the configured timeout

#### Scenario: Native code hang with V8 available

- **WHEN** a fuzz target hangs in native addon code that does not return to V8 within 5x the timeout
- **AND** V8 termination is available but ineffective (native code does not reach a V8 safe point)
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `{artifactPrefix}timeout-{contentHash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process

#### Scenario: Input capture before exit

- **WHEN** the watchdog decides to call `_exit()`
- **THEN** it reads the current input from the shmem region
- **AND** writes it to disk with `fsync` before calling `_exit(77)`
- **AND** the timeout artifact is recoverable after process termination

#### Scenario: Non-directory prefix in watchdog

- **WHEN** the watchdog is constructed with `artifactPrefix` = `bug-`
- **AND** the target times out
- **THEN** the timeout artifact is written to `bug-timeout-{contentHash}` in the current directory

#### Scenario: Directory prefix in watchdog

- **WHEN** the watchdog is constructed with `artifactPrefix` = `./out/`
- **AND** the target times out
- **AND** `./out/` does not exist
- **THEN** `./out/` is created before writing
- **AND** the timeout artifact is written to `./out/timeout-{contentHash}`

#### Scenario: Vitest mode preserves existing behavior

- **WHEN** the watchdog is constructed with `artifactPrefix` = `testdata/fuzz/{sanitizedTestName}/`
- **AND** the target times out
- **THEN** the timeout artifact is written to `testdata/fuzz/{sanitizedTestName}/timeout-{contentHash}`
- **AND** the behavior is identical to the pre-change implementation

#### Scenario: SEH crash with non-directory prefix

- **WHEN** `installExceptionHandler` is called with `artifactPrefix` = `bug-`
- **AND** a native crash occurs on Windows
- **THEN** the crash artifact is written to `bug-crash-{contentHash}` in the current directory
