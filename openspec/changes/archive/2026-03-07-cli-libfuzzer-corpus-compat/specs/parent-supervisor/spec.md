## MODIFIED Requirements

### Requirement: Crash artifact format

The parent SHALL write crash artifacts in the same format as the fuzz loop's existing crash artifact writing. The artifact path depends on whether `artifactPrefix` is set in `SupervisorOptions`:

- **When `artifactPrefix` is set** (CLI mode): The artifact SHALL be written to `{prefix}{kind}-{contentHash}` where `kind` is `"crash"` or `"timeout"` and `contentHash` is the full SHA-256 hex digest of the input data. If the prefix includes a directory component, the parent directory SHALL be created if it does not exist.
- **When `artifactPrefix` is not set** (Vitest mode): The artifact SHALL be written to `testdata/fuzz/{sanitizedTestName}/{kind}-{contentHash}` where `{sanitizedTestName}` uses the hash-prefixed format (`{nameHash}-{slug}`). This preserves the existing behavior.

In both cases, the file contents SHALL be the raw input bytes. The parent SHALL also log the crash to stderr with the signal/exception type and artifact path.

The `testName` and `testDir` fields on `SupervisorOptions` remain required for Vitest-mode artifact writing and for log messages.

#### Scenario: Crash artifact written by parent with artifact prefix

- **WHEN** the parent writes a crash artifact after a native crash
- **AND** `artifactPrefix` is set to `./out/`
- **THEN** the artifact file path is `./out/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes
- **AND** the parent logs the signal type and artifact path to stderr

#### Scenario: Crash artifact written by parent without artifact prefix

- **WHEN** the parent writes a crash artifact after a native crash
- **AND** `artifactPrefix` is not set
- **THEN** the artifact file path is `testdata/fuzz/{nameHash}-{slug}/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes
- **AND** the parent logs the signal type and artifact path to stderr

#### Scenario: Crash artifact is idempotent

- **WHEN** the same input causes a crash on respawn
- **THEN** the parent writes to the same artifact path (same content hash)
- **AND** the file is overwritten with identical contents (no corruption)

#### Scenario: CLI with default artifact prefix

- **WHEN** the standalone CLI runs without `-artifact_prefix`
- **AND** `artifactPrefix` is set to `./` (CLI default)
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `./crash-{contentHash}`

#### Scenario: CLI with explicit artifact prefix

- **WHEN** the standalone CLI runs with `-artifact_prefix=./findings/`
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `./findings/crash-{contentHash}`

#### Scenario: Vitest supervisor preserves existing behavior

- **WHEN** the Vitest `fuzz()` parent mode detects a native crash
- **AND** `artifactPrefix` is not set in `SupervisorOptions`
- **THEN** the parent writes crash artifact to `testdata/fuzz/{nameHash}-{slug}/crash-{contentHash}`
- **AND** the behavior is identical to the pre-change implementation

### Requirement: Native crash detection

The detection mechanism is unchanged — the only modification is that the crash artifact path in the scenarios now references the resolved artifact format (see "Crash artifact format" requirement above) instead of a hardcoded `testdata/fuzz/` path.

#### Scenario: Native crash on Unix

- **WHEN** the child process is killed by a signal (SIGSEGV, SIGBUS, SIGABRT, SIGILL, or SIGFPE)
- **THEN** the parent detects the signal death via `WIFSIGNALED(status)`
- **AND** the parent reads the signal number from `WTERMSIG(status)`
- **AND** the parent reads the crashing input from the shmem stash
- **AND** the parent writes a crash artifact using the resolved artifact format
- **AND** the crash artifact metadata includes the signal number

#### Scenario: Native crash on Windows

- **WHEN** the child process crashes with a Windows exception (e.g., `EXCEPTION_ACCESS_VIOLATION`)
- **THEN** the child's vectored exception handler writes crash metadata to shmem
- **AND** the parent detects the abnormal exit code
- **AND** the parent reads the crashing input from the shmem stash
- **AND** the parent writes a crash artifact using the resolved artifact format
