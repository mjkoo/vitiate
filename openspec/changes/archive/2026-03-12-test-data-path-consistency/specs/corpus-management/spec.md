## MODIFIED Requirements

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

### Requirement: Write crash artifact

The system SHALL write crash artifacts to `<root>/testdata/<hashdir>/crashes/crash-<contenthash>`. The function SHALL resolve the data root internally rather than accepting `testDir` as a parameter.

#### Scenario: Write crash artifact

- **WHEN** a crash input is written for test `"parse"` in `src/a.fuzz.ts`
- **THEN** a file is created at `.vitiate/testdata/<hashdir>/crashes/crash-<contenthash>`

#### Scenario: Crash directory created on demand

- **WHEN** `.vitiate/testdata/<hashdir>/crashes/` does not exist
- **THEN** the directory is created recursively before writing

### Requirement: Write timeout artifact

The system SHALL write timeout artifacts to `<root>/testdata/<hashdir>/timeouts/timeout-<contenthash>`. The behavior SHALL match crash artifact writing but in the `timeouts/` subdirectory.

#### Scenario: Write timeout artifact

- **WHEN** a timeout input is written for test `"parse"` in `src/a.fuzz.ts`
- **THEN** a file is created at `.vitiate/testdata/<hashdir>/timeouts/timeout-<contenthash>`

### Requirement: Load cached corpus with paths

The `loadCachedCorpusWithPaths()` function SHALL return `{ path: string; data: Buffer }` tuples from `<root>/corpus/<hashdir>/`. The function signature SHALL change to accept `(testFilePath: string, testName: string)` without a separate `cacheDir` parameter.

#### Scenario: Load cached corpus with paths

- **WHEN** `.vitiate/corpus/<hashdir>/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `{ path, data }` tuples are returned with absolute paths
