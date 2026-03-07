## ADDED Requirements

### Requirement: Dictionary file path resolution

The system SHALL provide a function to resolve the dictionary file path for a fuzz test. The dictionary file SHALL be located at `testdata/fuzz/{sanitizedTestName}.dict` relative to the test file's directory, where `{sanitizedTestName}` uses the same hash-prefixed format as seed corpus directories.

This file is a sibling to the seed corpus directory (`testdata/fuzz/{sanitizedTestName}/`). It is NOT a file within the seed corpus directory — seed corpus loading SHALL NOT read `.dict` files as seed inputs.

The function SHALL return the path if the file exists, or `undefined` if it does not. No error SHALL be raised for a missing dictionary file.

#### Scenario: Dictionary file exists

- **WHEN** `getDictionaryPath(testDir, "parse-json")` is called
- **AND** the file `{testDir}/testdata/fuzz/{sanitizedName}.dict` exists
- **THEN** the absolute path to the dictionary file SHALL be returned

#### Scenario: Dictionary file does not exist

- **WHEN** `getDictionaryPath(testDir, "parse-json")` is called
- **AND** no file exists at `{testDir}/testdata/fuzz/{sanitizedName}.dict`
- **THEN** `undefined` SHALL be returned

#### Scenario: Dictionary file is not loaded as seed corpus

- **WHEN** `loadSeedCorpus(testDir, "parse-json")` is called
- **AND** `testdata/fuzz/{sanitizedName}.dict` exists as a sibling file (not inside the corpus directory)
- **THEN** the `.dict` file SHALL NOT be included in the returned seed corpus entries
