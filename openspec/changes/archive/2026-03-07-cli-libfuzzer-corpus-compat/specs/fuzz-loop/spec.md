## MODIFIED Requirements

### Requirement: Interesting input persistence

When `reportResult()` returns `Interesting`, the system SHALL persist the input according to the active path convention:

- **When `corpusOutputDir` is provided**: Write the input to `{corpusOutputDir}/{contentHash}` (flat layout) via `writeCorpusEntryToDir`.
- **When `libfuzzerCompat` is true and `corpusOutputDir` is not provided**: Do not write the input to disk. The in-memory corpus retains the input for the duration of the process.
- **Otherwise** (Vitest mode): Write the input to the cached corpus directory so it persists across fuzzing sessions.

#### Scenario: Interesting input saved to cache dir (Vitest mode)

- **WHEN** `reportResult()` returns `Interesting`
- **AND** `libfuzzerCompat` is false
- **THEN** the input buffer is written to `.vitiate-corpus/{testFilePath}/{sanitizedTestName}/{contentHash}`
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
