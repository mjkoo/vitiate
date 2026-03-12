## MODIFIED Requirements

### Requirement: Seed loading

Before the fuzz loop begins, the system SHALL load all available seed inputs and add them to the fuzzer via `addSeed()`:

1. Read all files from the seed directory (`<dataDir>/testdata/<hashdir>/seeds/`).
2. Read all files from the crash directory (`<dataDir>/testdata/<hashdir>/crashes/`).
3. Read all files from the timeout directory (`<dataDir>/testdata/<hashdir>/timeouts/`).
4. Read all files from the cached corpus directory (`<dataDir>/corpus/<hashdir>/`).
5. Add each file's contents as a seed via `fuzzer.addSeed()`.

Where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root (default `.vitiate/`).

If no seeds are available, the fuzzer's auto-seed mechanism provides default starting inputs.

#### Scenario: Seeds from corpus directories

- **WHEN** the seed directory contains 2 files, the crash directory contains 1 file, and the cached corpus contains 5 files
- **THEN** 8 seeds are added to the fuzzer before the loop begins

#### Scenario: No seeds available

- **WHEN** neither the seed, crash, timeout, nor corpus directories exist
- **THEN** the fuzzer auto-seeds with its default set and the loop begins normally

### Requirement: Interesting input persistence

When `reportResult()` returns `Interesting`, the system SHALL persist the input according to the active path convention:

- **When `corpusOutputDir` is provided**: Write the input to `{corpusOutputDir}/{contentHash}` (flat layout) via `writeCorpusEntryToDir`.
- **When `libfuzzerCompat` is true and `corpusOutputDir` is not provided**: Do not write the input to disk. The in-memory corpus retains the input for the duration of the process.
- **Otherwise** (Vitest mode): Write the input to `<dataDir>/corpus/<hashdir>/<contentHash>` so it persists across fuzzing sessions.

#### Scenario: Interesting input saved to corpus dir (Vitest mode)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `libfuzzerCompat` is false
- **THEN** the input buffer is written to `<dataDir>/corpus/<hashdir>/<contentHash>`
- **AND** `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)`
- **AND** subsequent fuzzing sessions can load it as a seed

#### Scenario: Interesting input saved to corpus output dir (CLI with corpus dir)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `corpusOutputDir` is set to `./corpus/`
- **THEN** the input buffer is written to `./corpus/{contentHash}`

#### Scenario: Interesting input not written to disk (CLI without corpus dir)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `libfuzzerCompat` is true
- **AND** `corpusOutputDir` is not set
- **THEN** no file is written to disk
- **AND** the input is retained in the in-memory corpus for the remainder of the process
