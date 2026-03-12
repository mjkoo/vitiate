## MODIFIED Requirements

### Requirement: Dictionary discovery in Vitest mode

In Vitest mode, the system SHALL discover dictionary files by scanning the test's testdata directory at `<dataDir>/testdata/<hashdir>/` for:

1. Any file matching the glob pattern `*.dict`
2. A file named exactly `dictionary` (no extension)

Only files at the top level of the testdata directory SHALL be considered. Files within subdirectories (`seeds/`, `crashes/`, `timeouts/`) SHALL NOT be treated as dictionaries.

If multiple dictionary files are found, their contents SHALL be concatenated. If no dictionary files are found, the system SHALL proceed without user-provided tokens. No warning or error SHALL be emitted for a missing dictionary.

The previous convention of looking for a single `{sanitizedTestName}.dict` file as a sibling of the seed directory SHALL be replaced by this convention-based discovery within the per-test testdata directory.

#### Scenario: Single .dict file present

- **WHEN** a fuzz test runs in Vitest mode
- **AND** `.vitiate/testdata/<hashdir>/json.dict` exists with valid entries
- **THEN** the tokens from the file SHALL be loaded into `Tokens` metadata before the fuzz loop starts

#### Scenario: File named "dictionary" present

- **WHEN** a fuzz test runs in Vitest mode
- **AND** `.vitiate/testdata/<hashdir>/dictionary` exists with valid entries
- **THEN** the tokens from the file SHALL be loaded

#### Scenario: Multiple dictionary files concatenated

- **WHEN** `.vitiate/testdata/<hashdir>/` contains `tokens.dict` and `keywords.dict`
- **THEN** both files SHALL be discovered and their contents concatenated

#### Scenario: Dictionary file absent

- **WHEN** a fuzz test runs in Vitest mode
- **AND** no `*.dict` files and no `dictionary` file exist in the testdata directory
- **THEN** the fuzz loop SHALL start without user-provided tokens
- **AND** no warning or error SHALL be emitted

#### Scenario: Dict files inside subdirectories ignored

- **WHEN** `.vitiate/testdata/<hashdir>/seeds/something.dict` exists
- **THEN** it SHALL NOT be treated as a dictionary file
