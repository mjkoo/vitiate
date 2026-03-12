# Global Test Data

## Purpose

Defines the global test data directory layout for vitiate, consolidating all test data (seeds, crash artifacts, timeout artifacts, dictionaries, and cached corpus) under a single configurable root directory.

## Requirements

### Requirement: Global test data root directory

The system SHALL store all test data under a single configurable root directory, default `.vitiate/` relative to the project root. The root directory SHALL contain two top-level subdirectories:

- `testdata/` - committed test data (seeds, crash artifacts, timeout artifacts, dictionaries)
- `corpus/` - cached corpus entries (gitignored)

#### Scenario: Default root directory

- **WHEN** no `dataDir` option is configured
- **THEN** the test data root SHALL be `.vitiate/` relative to the project root
- **AND** seeds SHALL be stored under `.vitiate/testdata/`
- **AND** cached corpus SHALL be stored under `.vitiate/corpus/`

#### Scenario: Custom root directory via plugin option

- **WHEN** `vitiatePlugin({ dataDir: 'fuzzing-data' })` is configured
- **THEN** the test data root SHALL be `fuzzing-data/` relative to the project root
- **AND** all test data SHALL use that root instead of `.vitiate/`

#### Scenario: Fallback when no project root is set

- **WHEN** the Vitest plugin has not set a project root
- **THEN** the test data root SHALL be `.vitiate/` relative to `process.cwd()`

### Requirement: Per-test testdata directory layout

Each fuzz test SHALL have a directory under `<root>/testdata/<hashdir>/` where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)`. Within this directory:

- `seeds/` - user-provided seed input files
- `crashes/` - crash artifact files named `crash-<contenthash>`
- `timeouts/` - timeout artifact files named `timeout-<contenthash>`

Dictionary files SHALL be discovered as siblings of these subdirectories (see dictionary discovery requirement).

#### Scenario: Seed directory location

- **WHEN** a fuzz test `"parses JSON"` exists in `src/parser.fuzz.ts`
- **THEN** seed inputs SHALL be loaded from `.vitiate/testdata/<hashdir>/seeds/`
- **AND** `<hashdir>` SHALL be the result of `hashTestPath("src/parser.fuzz.ts", "parses JSON")`

#### Scenario: Crash artifact location

- **WHEN** the fuzzer discovers a crash for test `"parses JSON"` in `src/parser.fuzz.ts`
- **THEN** the crash artifact SHALL be written to `.vitiate/testdata/<hashdir>/crashes/crash-<contenthash>`

#### Scenario: Timeout artifact location

- **WHEN** the fuzzer discovers a timeout for test `"parses JSON"` in `src/parser.fuzz.ts`
- **THEN** the timeout artifact SHALL be written to `.vitiate/testdata/<hashdir>/timeouts/timeout-<contenthash>`

#### Scenario: Directories created on demand

- **WHEN** a crash is written and the `crashes/` subdirectory does not exist
- **THEN** the directory SHALL be created recursively before writing the artifact

### Requirement: Per-test corpus directory layout

Each fuzz test SHALL have a corpus cache directory at `<root>/corpus/<hashdir>/` where `<hashdir>` is the same output of `hashTestPath(relativeTestFilePath, testName)` used for testdata. Corpus entries SHALL be files named by their content hash (SHA-256 hex digest).

#### Scenario: Corpus directory location

- **WHEN** a fuzz test `"parses JSON"` exists in `src/parser.fuzz.ts`
- **THEN** cached corpus entries SHALL be stored at `.vitiate/corpus/<hashdir>/<contenthash>`
- **AND** the `<hashdir>` SHALL be identical to the one used for testdata

#### Scenario: Consistent hash between testdata and corpus

- **WHEN** testdata is at `.vitiate/testdata/abc123-parses_JSON/`
- **THEN** corpus is at `.vitiate/corpus/abc123-parses_JSON/`
- **AND** both use the same `hashTestPath` output

### Requirement: Dictionary file discovery

The system SHALL discover dictionary files for a fuzz test by scanning the test's testdata directory (`<root>/testdata/<hashdir>/`) for:

1. Any file matching the glob pattern `*.dict`
2. A file named exactly `dictionary` (no extension)

Both patterns SHALL be checked. If multiple dictionary files are found, their contents SHALL be concatenated. Files within subdirectories (`seeds/`, `crashes/`, `timeouts/`) SHALL NOT be considered.

This convention allows users to drop in AFL-format dictionaries without needing to know a specific naming convention.

#### Scenario: Single .dict file

- **WHEN** `.vitiate/testdata/<hashdir>/json.dict` exists
- **THEN** the dictionary path SHALL resolve to that file

#### Scenario: File named "dictionary"

- **WHEN** `.vitiate/testdata/<hashdir>/dictionary` exists
- **THEN** the dictionary path SHALL resolve to that file

#### Scenario: Multiple dictionary files

- **WHEN** `.vitiate/testdata/<hashdir>/` contains both `tokens.dict` and `keywords.dict`
- **THEN** both files SHALL be discovered
- **AND** their contents SHALL be concatenated for use as the fuzzing dictionary

#### Scenario: No dictionary files

- **WHEN** `.vitiate/testdata/<hashdir>/` contains no `*.dict` files and no `dictionary` file
- **THEN** no dictionary SHALL be loaded (no error raised)

#### Scenario: Dict files inside subdirectories are ignored

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/something.dict` exists
- **THEN** it SHALL NOT be treated as a dictionary file (only top-level files are scanned)

### Requirement: Seed corpus loading from global root

The system SHALL load seed corpus entries from `<root>/testdata/<hashdir>/seeds/`. Each regular file in the directory SHALL be read as a raw binary `Buffer`. Hidden files (names starting with `.`) SHALL be excluded.

#### Scenario: Load seeds

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/` contains files `input1` and `input2`
- **THEN** two `Buffer` values SHALL be returned

#### Scenario: Seeds directory does not exist

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/` does not exist
- **THEN** an empty array SHALL be returned (no error)

#### Scenario: Seeds directory is empty

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/` exists but contains no files
- **THEN** an empty array SHALL be returned

### Requirement: Crash and timeout corpus loading for regression

The system SHALL load crash and timeout artifacts from `<root>/testdata/<hashdir>/crashes/` and `<root>/testdata/<hashdir>/timeouts/` respectively during regression mode. Each regular file SHALL be read as a raw binary `Buffer`.

#### Scenario: Load crashes for regression

- **WHEN** `.vitiate/testdata/<hashdir>/crashes/` contains `crash-abc123`
- **THEN** the file SHALL be included in the regression corpus

#### Scenario: Load both crashes and timeouts

- **WHEN** `.vitiate/testdata/<hashdir>/crashes/` contains one file and `timeouts/` contains one file
- **THEN** both files SHALL be included in the regression corpus

### Requirement: dataDir plugin option

The `VitiatePluginOptions` interface SHALL accept an optional `dataDir` property of type `string`. This replaces the current `cacheDir` option.

When set, the value SHALL be resolved relative to the project root and used as the test data root directory. The `cacheDir` option SHALL be removed.

#### Scenario: dataDir replaces cacheDir

- **WHEN** `vitiatePlugin({ dataDir: '.fuzzing' })` is configured
- **THEN** all test data (seeds, crashes, corpus) SHALL use `.fuzzing/` as the root
- **AND** the `cacheDir` option SHALL no longer be recognized

#### Scenario: dataDir resolved relative to project root

- **WHEN** `dataDir` is set to `'data'` and the project root is `/home/user/project`
- **THEN** the resolved test data root SHALL be `/home/user/project/data`
