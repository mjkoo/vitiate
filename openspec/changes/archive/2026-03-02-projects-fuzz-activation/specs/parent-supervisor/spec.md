## MODIFIED Requirements

### Requirement: Crash artifact format

The parent SHALL write crash artifacts in the same format as the fuzz loop's existing crash artifact writing. The artifact file SHALL be written to `testdata/fuzz/{sanitizedTestName}/crash-{hash}` where `{sanitizedTestName}` uses the hash-prefixed format (`{nameHash}-{slug}`) and `{hash}` is computed from the crashing input bytes. The file contents SHALL be the raw input bytes.

The `testName` SHALL be provided by the caller via `SupervisorOptions.testName`. In the vitest `fuzz()` parent mode, this is the `name` parameter passed to `fuzz()`. In the standalone CLI, this is the `-test` value if provided, or the filename-derived name otherwise. The supervisor passes the `testName` through `sanitizeTestName()` to produce the directory name.

The parent SHALL also log the crash to stderr with the signal/exception type and artifact path.

#### Scenario: Crash artifact written by parent

- **WHEN** the parent writes a crash artifact after a native crash
- **THEN** the artifact file path is `testdata/fuzz/{nameHash}-{slug}/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes
- **AND** the parent logs the signal type and artifact path to stderr

#### Scenario: Crash artifact is idempotent

- **WHEN** the same input causes a crash on respawn
- **THEN** the parent writes to the same artifact path (same content hash)
- **AND** the file is overwritten with identical contents (no corruption)

#### Scenario: CLI with test name uses name as testName

- **WHEN** the standalone CLI runs with `-test=parse-url`
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `testdata/fuzz/{nameHash}-parse-url/crash-{contentHash}`

#### Scenario: CLI without test name uses filename-derived testName

- **WHEN** the standalone CLI runs without `-test` on `url-parser.fuzz.ts`
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `testdata/fuzz/{nameHash}-url-parser.fuzz/crash-{contentHash}`
