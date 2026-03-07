## MODIFIED Requirements

### Requirement: Write cached corpus entry

The system SHALL provide a function to write an interesting input to the cached corpus directory. The file name SHALL be the full SHA-256 hex digest of the input data. If a file with the same hash already exists, it SHALL NOT be overwritten (idempotent).

The cached corpus path SHALL be `{cacheDir}/{relativeFilePath}/{sanitizedTestName}/{hash}`, matching the loading path structure.

#### Scenario: Write new interesting input

- **WHEN** an interesting input `Buffer` is written for test "parse" in file `test/parsers/url.fuzz.ts`
- **THEN** a file is created at `.vitiate-corpus/test/parsers/url.fuzz.ts/{nameHash}-parse/{contentHash}` with the buffer contents
- **AND** the file path is returned

#### Scenario: Duplicate input is not re-written

- **WHEN** the same input buffer is written twice
- **THEN** only one file exists (the second write is a no-op)

#### Scenario: Cache directory is created on demand

- **WHEN** the cache subdirectory does not exist and a write is requested
- **THEN** the directory is created recursively before writing the file

### Requirement: Write crash artifact

The system SHALL provide a function to write a crash-triggering input to the seed corpus directory as a permanent regression test case. The file name SHALL be `crash-{hash}` where `{hash}` is the full SHA-256 hex digest of the input data.

Crash artifacts SHALL be written to `testdata/fuzz/{sanitizedTestName}/` relative to the test file's directory, where `{sanitizedTestName}` uses the hash-prefixed format. The directory SHALL be created if it does not exist.

#### Scenario: Write crash artifact

- **WHEN** a crash input is written for test "parse" in test file at `/project/tests/parser.fuzz.ts`
- **THEN** a file is created at `/project/tests/testdata/fuzz/{nameHash}-parse/crash-{contentHash}`
- **AND** the file path is returned

#### Scenario: Crash artifact directory created on demand

- **WHEN** `testdata/fuzz/{nameHash}-parse/` does not exist and a crash is written
- **THEN** the directory is created recursively before writing the file

#### Scenario: Duplicate crash is not re-written

- **WHEN** the same crash input is written twice
- **THEN** only one file exists (the second write is a no-op)

## ADDED Requirements

### Requirement: Write corpus entry to flat directory

The system SHALL provide a function to write an interesting input directly to a caller-specified directory using a flat layout. The file name SHALL be the full SHA-256 hex digest of the input data. If a file with the same hash already exists, it SHALL NOT be overwritten (idempotent). The directory SHALL be created recursively if it does not exist.

This function is used by the CLI fuzz loop when a positional corpus output directory is provided, matching libFuzzer's corpus output behavior (flat files in the output directory).

#### Scenario: Write to flat corpus directory

- **WHEN** an interesting input is written to `./corpus/` via `writeCorpusEntryToDir`
- **THEN** a file is created at `./corpus/{contentHash}` with the input bytes
- **AND** the file path is returned

#### Scenario: Directory created on demand

- **WHEN** `writeCorpusEntryToDir` is called with a non-existent directory
- **THEN** the directory is created recursively before writing

#### Scenario: Duplicate is idempotent

- **WHEN** the same input is written twice to the same directory
- **THEN** only one file exists (the second write is a no-op)

### Requirement: Write artifact with prefix

The system SHALL provide a function to write a crash or timeout artifact using a caller-specified prefix path. The artifact SHALL be written to `{prefix}{kind}-{contentHash}` where `kind` is `"crash"` or `"timeout"` and `contentHash` is the full SHA-256 hex digest of the input data.

If the prefix includes a directory component (e.g., `./out/`), the parent directory SHALL be created recursively if it does not exist.

This function is used by the CLI fuzz loop and supervisor when `-artifact_prefix` is set, matching libFuzzer's artifact output behavior.

#### Scenario: Write artifact with directory prefix

- **WHEN** `writeArtifactWithPrefix("./out/", data, "crash")` is called
- **THEN** the artifact is written to `./out/crash-{contentHash}`

#### Scenario: Write artifact with non-directory prefix

- **WHEN** `writeArtifactWithPrefix("bug-", data, "crash")` is called
- **THEN** the artifact is written to `bug-crash-{contentHash}` in the current directory

#### Scenario: Prefix directory created on demand

- **WHEN** `writeArtifactWithPrefix("./findings/", data, "crash")` is called
- **AND** `./findings/` does not exist
- **THEN** `./findings/` is created before writing the artifact

#### Scenario: Duplicate artifact is idempotent

- **WHEN** the same input is written twice with the same prefix
- **THEN** only one file exists (the second write is a no-op)
