## MODIFIED Requirements

### Requirement: Crash artifact format

The parent SHALL write crash artifacts in the same format as the fuzz loop's existing crash artifact writing. The artifact path depends on whether `artifactPrefix` is set in `SupervisorOptions`:

- **When `artifactPrefix` is set** (CLI mode): The artifact SHALL be written to `{prefix}{kind}-{contentHash}` where `kind` is `"crash"` or `"timeout"` and `contentHash` is the full SHA-256 hex digest of the input data. If the prefix includes a directory component, the parent directory SHALL be created if it does not exist.
- **When `artifactPrefix` is not set** (Vitest mode): The artifact SHALL be written to `<dataDir>/testdata/<hashdir>/crashes/crash-{contentHash}` where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

In both cases, the file contents SHALL be the raw input bytes. The parent SHALL also log the crash to stderr with the signal/exception type and artifact path.

The `SupervisorOptions` SHALL accept `relativeTestFilePath` and `testName` for Vitest-mode artifact path resolution (replacing the previous `testDir` + `testName` pattern).

#### Scenario: Crash artifact written by parent with artifact prefix

- **WHEN** the parent writes a crash artifact after a native crash
- **AND** `artifactPrefix` is set to `./out/`
- **THEN** the artifact file path is `./out/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes

#### Scenario: Crash artifact written by parent without artifact prefix

- **WHEN** the parent writes a crash artifact after a native crash
- **AND** `artifactPrefix` is not set
- **THEN** the artifact file path is `<dataDir>/testdata/<hashdir>/crashes/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes

#### Scenario: CLI with default artifact prefix

- **WHEN** the standalone CLI runs without `-artifact_prefix`
- **AND** `artifactPrefix` is set to `./` (CLI default)
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `./crash-{contentHash}`

#### Scenario: Vitest supervisor uses global test data root

- **WHEN** the Vitest `fuzz()` parent mode detects a native crash
- **AND** `artifactPrefix` is not set in `SupervisorOptions`
- **THEN** the parent writes crash artifact to `.vitiate/testdata/<hashdir>/crashes/crash-{contentHash}`
