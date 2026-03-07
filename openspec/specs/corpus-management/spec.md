## ADDED Requirements

### Requirement: Test name directory format

The system SHALL use a hash-prefixed directory name scheme for all corpus and artifact paths keyed by test name. The `sanitizeTestName(name)` function SHALL produce a directory name in the format `{hash}-{slug}` where:

- `{hash}` is the first 8 characters of the SHA-256 hex digest of the original unsanitized test name. This guarantees uniqueness — distinct test names always produce distinct directory names.
- `{slug}` is a lossy human-readable hint derived from the original name: non-`[a-zA-Z0-9\-_.]` characters replaced with `_`, consecutive underscores collapsed, leading/trailing underscores stripped. The slug is never used for uniqueness; it exists only so humans can identify the test from a directory listing.

If the slug is empty after sanitization, only the hash SHALL be used (no trailing dash).

#### Scenario: Simple test name

- **WHEN** `sanitizeTestName("parse-url")` is called
- **THEN** the result is `"{hash}-parse-url"` where `{hash}` is the first 8 hex chars of SHA-256 of `"parse-url"`

#### Scenario: Test name with special characters

- **WHEN** `sanitizeTestName("parse url")` is called
- **THEN** the result is `"{hash}-parse_url"` where `{hash}` differs from the hash of `"parse-url"`

#### Scenario: Names that previously collided are now distinct

- **WHEN** `sanitizeTestName("parse url")` and `sanitizeTestName("parse:url")` are called
- **THEN** both produce different directory names (different hash prefixes)
- **AND** both have the slug `parse_url` as a human hint

#### Scenario: Empty or degenerate names

- **WHEN** `sanitizeTestName("")` or `sanitizeTestName("...")` is called
- **THEN** the result is a valid directory name consisting of the hash only (no slug portion)

### Requirement: Seed corpus loading

The system SHALL provide a function to load seed corpus entries from `testdata/fuzz/{sanitizedTestName}/` relative to the test file's directory, where `{sanitizedTestName}` uses the hash-prefixed format. Each file in the directory SHALL be read as a raw binary `Buffer`. Files with a `crash-` prefix SHALL be included (they are regression test cases from previous crashes).

#### Scenario: Load existing seed corpus

- **WHEN** `testdata/fuzz/e7f3a1b2-parse_url/` contains files `seed1`, `seed2`, and `crash-abc123`
- **THEN** three `Buffer` values are returned, one for each file's contents

#### Scenario: Corpus directory does not exist

- **WHEN** `testdata/fuzz/e7f3a1b2-parse_url/` does not exist
- **THEN** an empty array is returned (no error thrown)

#### Scenario: Corpus directory is empty

- **WHEN** `testdata/fuzz/e7f3a1b2-parse_url/` exists but contains no files
- **THEN** an empty array is returned

### Requirement: Cached corpus loading

The system SHALL provide a function to load cached corpus entries from the cache directory. The cache directory SHALL be resolved using the following precedence:

1. The `VITIATE_CACHE_DIR` environment variable, if set. If the value is a relative path, it SHALL be resolved relative to `VITIATE_PROJECT_ROOT` (if set) or `process.cwd()`.
2. `.vitiate-corpus/` resolved relative to `VITIATE_PROJECT_ROOT`, if set.
3. `.vitiate-corpus/` resolved relative to `process.cwd()` (fallback).

Cached entries SHALL be stored at `{cacheDir}/{relativeFilePath}/{sanitizedTestName}/{hash}`, where `relativeFilePath` is the test file's path relative to `VITIATE_PROJECT_ROOT` (or `process.cwd()` if unset), and `{sanitizedTestName}` uses the hash-prefixed format. This file-qualified path prevents collisions between tests with the same `fuzz()` name in different files.

The `loadCachedCorpus` function SHALL accept `testFilePath` (the test file's path relative to the project root) and `testName` as parameters.

#### Scenario: Load cached corpus

- **WHEN** `.vitiate-corpus/test/parsers/url.fuzz.ts/e7f3a1b2-parse_url/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `Buffer` values are returned

#### Scenario: Custom cache directory via env var

- **WHEN** `VITIATE_CACHE_DIR=/tmp/fuzz-cache` is set
- **THEN** cached entries are loaded from `/tmp/fuzz-cache/test/parsers/url.fuzz.ts/e7f3a1b2-parse_url/`

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

#### Scenario: Same test name in different files does not collide

- **WHEN** `test/parsers/url.fuzz.ts` has `fuzz("parse", ...)`
- **AND** `test/parsers/json.fuzz.ts` has `fuzz("parse", ...)`
- **THEN** cached corpus for the first is at `{cacheDir}/test/parsers/url.fuzz.ts/{hash}-parse/`
- **AND** cached corpus for the second is at `{cacheDir}/test/parsers/json.fuzz.ts/{hash}-parse/`
- **AND** both have the same `{hash}` (same test name) but different file path prefixes
- **AND** no entries are shared between the two

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
