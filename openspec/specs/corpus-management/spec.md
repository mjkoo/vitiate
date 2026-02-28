## ADDED Requirements

### Requirement: Seed corpus loading

The system SHALL provide a function to load seed corpus entries from `testdata/fuzz/{testName}/` relative to the test file's directory. Each file in the directory SHALL be read as a raw binary `Buffer`. Files with a `crash-` prefix SHALL be included (they are regression test cases from previous crashes).

#### Scenario: Load existing seed corpus

- **WHEN** `testdata/fuzz/parse/` contains files `seed1`, `seed2`, and `crash-abc123`
- **THEN** three `Buffer` values are returned, one for each file's contents

#### Scenario: Corpus directory does not exist

- **WHEN** `testdata/fuzz/parse/` does not exist
- **THEN** an empty array is returned (no error thrown)

#### Scenario: Corpus directory is empty

- **WHEN** `testdata/fuzz/parse/` exists but contains no files
- **THEN** an empty array is returned

### Requirement: Cached corpus loading

The system SHALL provide a function to load cached corpus entries from the cache directory. The cache directory SHALL be resolved using the following precedence:

1. The `VITIATE_CACHE_DIR` environment variable, if set. If the value is a relative path, it SHALL be resolved relative to `VITIATE_PROJECT_ROOT` (if set) or `process.cwd()`.
2. `.vitiate-corpus/` resolved relative to `VITIATE_PROJECT_ROOT`, if set.
3. `.vitiate-corpus/` resolved relative to `process.cwd()` (fallback).

Cached entries are stored at `{cacheDir}/{testName}/{hash}`.

#### Scenario: Load cached corpus

- **WHEN** `.vitiate-corpus/parse/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `Buffer` values are returned

#### Scenario: Custom cache directory via env var

- **WHEN** `VITIATE_CACHE_DIR=/tmp/fuzz-cache` is set
- **THEN** cached entries are loaded from `/tmp/fuzz-cache/parse/`

#### Scenario: Cache directory does not exist

- **WHEN** the cache directory for a test does not exist
- **THEN** an empty array is returned (no error thrown)

#### Scenario: Cache dir resolves to project root when plugin is active

- **WHEN** `VITIATE_PROJECT_ROOT=/home/user/project` is set (by the vitiate plugin)
- **AND** `VITIATE_CACHE_DIR` is not set
- **THEN** the cache directory is `/home/user/project/.vitiate-corpus`

#### Scenario: Relative VITIATE_CACHE_DIR resolves against project root

- **WHEN** `VITIATE_CACHE_DIR=.my-corpus` is set
- **AND** `VITIATE_PROJECT_ROOT=/home/user/project` is set
- **THEN** the cache directory is `/home/user/project/.my-corpus`

#### Scenario: Fallback to cwd when no project root

- **WHEN** `VITIATE_PROJECT_ROOT` is not set
- **AND** `VITIATE_CACHE_DIR` is not set
- **THEN** the cache directory is `path.resolve(".vitiate-corpus")` (relative to cwd)

### Requirement: Write cached corpus entry

The system SHALL provide a function to write an interesting input to the cached corpus directory. The file name SHALL be a content hash (SHA-256 hex, truncated to 16 characters) of the input data. If a file with the same hash already exists, it SHALL NOT be overwritten (idempotent).

#### Scenario: Write new interesting input

- **WHEN** an interesting input `Buffer` is written for test "parse"
- **THEN** a file is created at `.vitiate-corpus/parse/{hash}` with the buffer contents
- **AND** the file path is returned

#### Scenario: Duplicate input is not re-written

- **WHEN** the same input buffer is written twice
- **THEN** only one file exists (the second write is a no-op)

#### Scenario: Cache directory is created on demand

- **WHEN** `.vitiate-corpus/parse/` does not exist and a write is requested
- **THEN** the directory is created recursively before writing the file

### Requirement: Write crash artifact

The system SHALL provide a function to write a crash-triggering input to the seed corpus directory as a permanent regression test case. The file name SHALL be `crash-{hash}` where `{hash}` is the SHA-256 hex of the input data, truncated to 16 characters.

Crash artifacts SHALL be written to `testdata/fuzz/{testName}/` relative to the test file's directory. The directory SHALL be created if it does not exist.

#### Scenario: Write crash artifact

- **WHEN** a crash input is written for test "parse" in test file at `/project/tests/parser.test.ts`
- **THEN** a file is created at `/project/tests/testdata/fuzz/parse/crash-{hash}`
- **AND** the file path is returned

#### Scenario: Crash artifact directory created on demand

- **WHEN** `testdata/fuzz/parse/` does not exist and a crash is written
- **THEN** the directory is created recursively before writing the file

#### Scenario: Duplicate crash is not re-written

- **WHEN** the same crash input is written twice
- **THEN** only one file exists (the second write is a no-op)
