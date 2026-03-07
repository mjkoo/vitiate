## ADDED Requirements

### Requirement: Load cached corpus with paths

The system SHALL provide a `loadCachedCorpusWithPaths()` function that loads cached corpus entries and returns an array of `{ path: string; data: Buffer }` tuples. The function SHALL accept the same parameters as `loadCachedCorpus()` (`cacheDir`, `testFilePath`, `testName`) and read from the same directory structure.

This function is used by optimize mode to identify which files to delete after set cover.

#### Scenario: Load cached corpus with paths

- **WHEN** `.vitiate-corpus/test/url.fuzz.ts/e7f3a1b2-parse_url/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `{ path, data }` tuples are returned
- **AND** each `path` is the absolute path to the file
- **AND** each `data` is the file's contents as a Buffer

#### Scenario: Cache directory does not exist

- **WHEN** the cache directory for a test does not exist
- **THEN** an empty array is returned (no error thrown)

### Requirement: Load corpus from directories with paths

The system SHALL provide a `loadCorpusDirsWithPaths()` function that loads corpus entries from multiple directories and returns an array of `{ path: string; data: Buffer }` tuples. The function SHALL accept the same `dirs: string[]` parameter as `loadCorpusFromDirs()`.

This function is used by CLI merge mode. Paths are needed for the control file records (identifying which inputs have been replayed) and for logging skipped/crashing inputs.

#### Scenario: Load from multiple directories with paths

- **WHEN** `./corpus/` contains files `abc` and `def`, and `./extra/` contains file `ghi`
- **THEN** three `{ path, data }` tuples are returned with absolute paths

#### Scenario: Non-existent directory

- **WHEN** one of the specified directories does not exist
- **THEN** entries from existing directories are returned
- **AND** the non-existent directory contributes zero entries (no error thrown)

### Requirement: Delete corpus entry

The system SHALL provide a `deleteCorpusEntry(filePath: string)` function that deletes a single corpus entry file from disk using `unlinkSync`.

If the file does not exist (ENOENT), the function SHALL silently succeed (idempotent deletion). Other filesystem errors SHALL be propagated.

#### Scenario: Delete existing entry

- **WHEN** `deleteCorpusEntry("/path/to/entry")` is called
- **AND** the file exists
- **THEN** the file is deleted from disk

#### Scenario: Delete non-existent entry

- **WHEN** `deleteCorpusEntry("/path/to/missing")` is called
- **AND** the file does not exist
- **THEN** the function returns without error (idempotent)

#### Scenario: Filesystem error propagated

- **WHEN** `deleteCorpusEntry("/path/to/entry")` is called
- **AND** the deletion fails with a non-ENOENT error (e.g., permission denied)
- **THEN** the error is thrown to the caller
