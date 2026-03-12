## MODIFIED Requirements

### Requirement: _exit fallback with input capture

When `TerminateExecution` is unavailable or ineffective, the watchdog SHALL call `_exit()` to terminate the process. Before exiting, the watchdog SHALL read the current input from the shmem region and write it to disk as a timeout artifact.

The `Watchdog` constructor and `installExceptionHandler` SHALL accept an `artifactPrefix` string parameter. The artifact prefix is a path prefix - not necessarily a directory - and the artifact filename is appended directly:

- The timeout artifact path SHALL be `{artifactPrefix}timeout-{contentHash}`.
- The crash artifact path (SEH handler) SHALL be `{artifactPrefix}crash-{contentHash}`.

The artifact prefix passed to the `Watchdog` constructor and `installExceptionHandler` SHALL be determined by the caller based on the active path convention:

- **When `artifactPrefix` is resolved** (CLI mode): Pass the resolved prefix directly (e.g., `./` for default, `./out/` for `-artifact_prefix=./out/`).
- **Otherwise** (Vitest mode): Pass `<dataDir>/testdata/<hashdir>/timeouts/` (trailing slash) so that timeout artifacts are written as `<dataDir>/testdata/<hashdir>/timeouts/timeout-{contentHash}`. For crash artifacts from SEH, pass `<dataDir>/testdata/<hashdir>/crashes/` so that crash artifacts are written as `<dataDir>/testdata/<hashdir>/crashes/crash-{contentHash}`.

Where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

#### Scenario: Vitest mode uses global test data root

- **WHEN** the watchdog is constructed in Vitest mode
- **AND** the target times out
- **THEN** the timeout artifact is written to `<dataDir>/testdata/<hashdir>/timeouts/timeout-{contentHash}`

#### Scenario: CLI mode with artifact prefix

- **WHEN** the watchdog is constructed with `artifactPrefix` = `./out/`
- **AND** the target times out
- **THEN** the timeout artifact is written to `./out/timeout-{contentHash}`

#### Scenario: SEH crash in Vitest mode

- **WHEN** `installExceptionHandler` is called in Vitest mode
- **AND** a native crash occurs on Windows
- **THEN** the crash artifact is written to `<dataDir>/testdata/<hashdir>/crashes/crash-{contentHash}`
