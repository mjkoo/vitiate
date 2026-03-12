## ADDED Requirements

### Requirement: Test name directory format

The system SHALL use a Nix-style base32 hash directory name scheme for all corpus and artifact paths keyed by test identity. The `hashTestPath(relativeTestFilePath, testName)` function SHALL produce a directory name in the format `{nix32hash}-{slug}` where:

- `{nix32hash}` is the 32-character Nix base32 encoding of the XOR-folded (160-bit) SHA-256 digest of `<relativeTestFilePath>::<testName>`. The hash input includes the test file path to prevent collisions between same-named tests in different files without requiring directory hierarchy namespacing.
- `{slug}` is a lossy human-readable hint derived from the test name only: non-`[a-zA-Z0-9\-_.]` characters replaced with `_`, consecutive underscores collapsed, leading/trailing underscores stripped. The slug is never used for uniqueness; it exists only so humans can identify the test from a directory listing.

If the slug is empty after sanitization, only the hash SHALL be used (no trailing dash).

The previous `sanitizeTestName(name)` function (which used an 8-char truncated SHA-256 hex prefix of the test name only) SHALL be replaced by `hashTestPath`.

#### Scenario: Standard test name

- **WHEN** `hashTestPath("src/parser.fuzz.ts", "parse-url")` is called
- **THEN** the result matches `^[0-9a-df-np-sv-z]{32}-parse-url$`
- **AND** the hash is the Nix base32 encoding of the XOR-folded SHA-256 of `"src/parser.fuzz.ts::parse-url"`

#### Scenario: Test name with special characters

- **WHEN** `hashTestPath("src/parser.fuzz.ts", "parse url")` is called
- **THEN** the result matches `^[0-9a-df-np-sv-z]{32}-parse_url$`

#### Scenario: Names that previously collided are now distinct

- **WHEN** `hashTestPath("src/a.fuzz.ts", "parse")` and `hashTestPath("src/b.fuzz.ts", "parse")` are called
- **THEN** both produce different directory names (different hash prefixes)
- **AND** both have the slug `parse` as a human hint

#### Scenario: Empty or degenerate names

- **WHEN** `hashTestPath("test.fuzz.ts", "")` or `hashTestPath("test.fuzz.ts", "...")` is called
- **THEN** the result is a valid directory name consisting of the 32-char hash only (no slug portion)

### Requirement: Dictionary file path resolution

The system SHALL discover dictionary files for a fuzz test by scanning the test's testdata directory (`<root>/testdata/<hashdir>/`) for any file matching `*.dict` or named `dictionary`. Files inside subdirectories (`seeds/`, `crashes/`, `timeouts/`) SHALL NOT be considered.

The previous `getDictionaryPath()` function (which looked for a single `{sanitizedTestName}.dict` file as a sibling of the seed directory) SHALL be replaced by the new convention-based discovery.

When multiple dictionary files are found, their contents SHALL be concatenated.

#### Scenario: Single dict file discovered

- **WHEN** `.vitiate/testdata/<hashdir>/json.dict` exists
- **THEN** the dictionary path SHALL resolve to that file

#### Scenario: Multiple dict files concatenated

- **WHEN** `.vitiate/testdata/<hashdir>/` contains `tokens.dict` and `keywords.dict`
- **THEN** both files SHALL be discovered and concatenated

#### Scenario: File named "dictionary" discovered

- **WHEN** `.vitiate/testdata/<hashdir>/dictionary` exists (no extension)
- **THEN** it SHALL be discovered as a dictionary file

#### Scenario: No dictionary files

- **WHEN** `.vitiate/testdata/<hashdir>/` contains no `*.dict` files and no `dictionary` file
- **THEN** no dictionary SHALL be loaded (no error raised)

#### Scenario: Dictionary file is not loaded as seed corpus

- **WHEN** `loadTestDataCorpus` is called
- **AND** `.vitiate/testdata/<hashdir>/json.dict` exists at the top level
- **THEN** the `.dict` file SHALL NOT be included in the returned seed entries (seeds are loaded from the `seeds/` subdirectory only)

### Requirement: Seed corpus loading

The system SHALL load seed corpus entries from `<root>/testdata/<hashdir>/seeds/` relative to the global test data root, where `<hashdir>` is produced by `hashTestPath(relativeTestFilePath, testName)`. Each regular file in the directory SHALL be read as a raw binary `Buffer`. Hidden files (starting with `.`) SHALL be excluded.

The previous location (`testdata/fuzz/{sanitizedTestName}/` relative to the test file's directory) SHALL no longer be used.

#### Scenario: Load existing seed corpus

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/` contains files `seed1` and `seed2`
- **THEN** two `Buffer` values are returned, one for each file's contents

#### Scenario: Seeds directory does not exist

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/` does not exist
- **THEN** an empty array is returned (no error thrown)

#### Scenario: Seeds directory is empty

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/` exists but contains no files
- **THEN** an empty array is returned

### Requirement: Load testdata corpus for regression and seeding

The system SHALL provide a function to load all testdata entries for a fuzz test by reading from three subdirectories under `<root>/testdata/<hashdir>/`:

1. `seeds/` - user-provided seed inputs
2. `crashes/` - crash artifact files
3. `timeouts/` - timeout artifact files

Each regular file in each subdirectory SHALL be read as a raw binary `Buffer`. Hidden files (starting with `.`) SHALL be excluded. Missing subdirectories SHALL be silently skipped (no error). The combined result SHALL be returned as a single array.

This replaces the previous `loadTestDataCorpus` which read from a single flat directory. The new function is used both for seeding the fuzz loop and for regression mode replay.

#### Scenario: Load from all three subdirectories

- **WHEN** `seeds/` contains `input1`, `crashes/` contains `crash-abc`, and `timeouts/` contains `timeout-def`
- **THEN** three `Buffer` values are returned

#### Scenario: Only seeds exist

- **WHEN** `seeds/` contains files but `crashes/` and `timeouts/` do not exist
- **THEN** only the seed files are returned (no error for missing subdirectories)

#### Scenario: No testdata exists

- **WHEN** none of the three subdirectories exist
- **THEN** an empty array is returned

### Requirement: Cached corpus loading

The system SHALL load cached corpus entries from `<root>/corpus/<hashdir>/` relative to the global test data root. The cache directory path no longer includes the relative test file path as a parent directory component - the file path is encoded in the hash.

The `loadCachedCorpus` function signature SHALL change to accept `(testFilePath: string, testName: string)` without a separate `cacheDir` parameter - the data root is resolved internally.

#### Scenario: Load cached corpus

- **WHEN** `.vitiate/corpus/<hashdir>/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `Buffer` values are returned

#### Scenario: Cache directory does not exist

- **WHEN** the corpus directory for a test does not exist
- **THEN** an empty array is returned (no error thrown)

#### Scenario: Same test name in different files does not collide

- **WHEN** `src/a.fuzz.ts` has `fuzz("parse", ...)`
- **AND** `src/b.fuzz.ts` has `fuzz("parse", ...)`
- **THEN** cached corpus for the first is at `.vitiate/corpus/<hashA>-parse/`
- **AND** cached corpus for the second is at `.vitiate/corpus/<hashB>-parse/`
- **AND** `<hashA>` and `<hashB>` are different (file path is part of hash input)

### Requirement: Write cached corpus entry

The system SHALL write cached corpus entries to `<root>/corpus/<hashdir>/<contenthash>`. The function signature SHALL change to accept `(testFilePath: string, testName: string, data: Buffer)` without a separate `cacheDir` parameter.

#### Scenario: Write new interesting input

- **WHEN** an interesting input is written for test `"parse"` in `src/a.fuzz.ts`
- **THEN** a file is created at `.vitiate/corpus/<hashdir>/<contenthash>`

#### Scenario: Duplicate input is not re-written

- **WHEN** the same input buffer is written twice
- **THEN** only one file exists (the second write is a no-op)

#### Scenario: Cache directory is created on demand

- **WHEN** the cache subdirectory does not exist and a write is requested
- **THEN** the directory is created recursively before writing the file

### Requirement: Write crash artifact

The system SHALL write crash artifacts to `<root>/testdata/<hashdir>/crashes/crash-<contenthash>`. The function SHALL resolve the data root internally rather than accepting `testDir` as a parameter.

#### Scenario: Write crash artifact

- **WHEN** a crash input is written for test `"parse"` in `src/a.fuzz.ts`
- **THEN** a file is created at `.vitiate/testdata/<hashdir>/crashes/crash-<contenthash>`

#### Scenario: Crash directory created on demand

- **WHEN** `.vitiate/testdata/<hashdir>/crashes/` does not exist
- **THEN** the directory is created recursively before writing

#### Scenario: Duplicate crash is not re-written

- **WHEN** the same crash input is written twice
- **THEN** only one file exists (the second write is a no-op)

### Requirement: Write timeout artifact

The system SHALL write timeout artifacts to `<root>/testdata/<hashdir>/timeouts/timeout-<contenthash>`. The behavior SHALL match crash artifact writing but in the `timeouts/` subdirectory.

#### Scenario: Write timeout artifact

- **WHEN** a timeout input is written for test `"parse"` in `src/a.fuzz.ts`
- **THEN** a file is created at `.vitiate/testdata/<hashdir>/timeouts/timeout-<contenthash>`

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

### Requirement: Load cached corpus with paths

The `loadCachedCorpusWithPaths()` function SHALL return `{ path: string; data: Buffer }` tuples from `<root>/corpus/<hashdir>/`. The function signature SHALL change to accept `(testFilePath: string, testName: string)` without a separate `cacheDir` parameter.

#### Scenario: Load cached corpus with paths

- **WHEN** `.vitiate/corpus/<hashdir>/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `{ path, data }` tuples are returned with absolute paths

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

### Requirement: Replace artifact atomically

The system SHALL provide a `replaceArtifact(oldPath: string, newData: Buffer, kind: "crash" | "timeout"): string` function that atomically replaces an existing artifact file with new data.

The replacement SHALL:

1. Compute the new content hash (SHA-256 hex digest of `newData`).
2. Derive the new artifact path by replacing the hash portion of `oldPath` with the new hash (preserving the prefix and kind).
3. Write `newData` to a temporary file in the same directory as `oldPath`.
4. Rename the temporary file to the new artifact path (atomic on POSIX, near-atomic on Windows).
5. Delete the old artifact file if the new path differs from the old path.
6. Return the new artifact path.

If the new path is identical to the old path (same content hash), the function SHALL overwrite atomically via rename and return the same path.

#### Scenario: Replace crash artifact with smaller input

- **WHEN** `replaceArtifact("./out/crash-aaa", smallerBuffer, "crash")` is called
- **THEN** a new file `./out/crash-bbb` SHALL be created atomically (where `bbb` is the SHA-256 of `smallerBuffer`)
- **AND** the old file `./out/crash-aaa` SHALL be deleted
- **AND** the returned path SHALL be `./out/crash-bbb`

#### Scenario: Atomic write prevents partial reads

- **WHEN** `replaceArtifact` is called
- **THEN** the new data SHALL be written to a temporary file first
- **AND** the temporary file SHALL be renamed to the target path
- **AND** at no point SHALL a reader observe a partially-written artifact file

#### Scenario: Old file deleted only when paths differ

- **WHEN** `replaceArtifact("./out/crash-aaa", newData, "crash")` is called
- **AND** the SHA-256 of `newData` differs from `aaa`
- **THEN** `./out/crash-aaa` SHALL be deleted after the new file is in place

#### Scenario: Same content hash overwrites in place

- **WHEN** `replaceArtifact("./out/crash-aaa", data, "crash")` is called
- **AND** the SHA-256 of `data` equals `aaa`
- **THEN** the file SHALL be overwritten atomically
- **AND** no separate delete is needed
- **AND** the returned path SHALL be `./out/crash-aaa`
