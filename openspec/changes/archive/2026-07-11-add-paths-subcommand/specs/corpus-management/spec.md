## ADDED Requirements

### Requirement: Per-test entry counts

The system SHALL provide a function that, given a test file path and test name, returns the entry counts for that test across its testdata buckets and cached corpus: `seeds`, `crashes`, `timeouts`, `ooms` (each counting regular files directly under `<root>/testdata/<hashdir>/<bucket>/`), and `corpus` (counting regular files directly under `<root>/corpus/<hashdir>/`).

Counts SHALL exclude hidden files (starting with `.`) and SHALL NOT descend into nested subdirectories, matching the corpus read semantics used elsewhere. Missing directories SHALL count as zero (no error), so the function is safe to call for a test that has never been fuzzed. Counting SHALL NOT read file contents.

#### Scenario: Counts across buckets and corpus

- **WHEN** a test's `seeds/` has 3 files, `crashes/` has 2, `timeouts/` has 1, `ooms/` has 4, and its corpus dir has 2
- **THEN** the returned counts are `{ seeds: 3, crashes: 2, timeouts: 1, ooms: 4, corpus: 2 }`

#### Scenario: Nothing on disk

- **WHEN** no directories exist for the test
- **THEN** all counts are zero

#### Scenario: Hidden files and nested dirs excluded

- **WHEN** a `seeds/` directory contains one regular file, one dotfile, and one nested subdirectory
- **THEN** the `seeds` count is 1

### Requirement: On-disk hash directory enumeration

The system SHALL provide a function that lists the hash-directory names present on disk under `<root>/testdata/` or `<root>/corpus/` (selected by a `kind` argument). It SHALL return only directory names (not regular files) and SHALL return an empty array if the root does not exist. This enables reconciling on-disk directories against the set of currently-discovered tests to detect orphans.

#### Scenario: Lists directories only

- **WHEN** `<root>/testdata/` contains two hash directories and one stray regular file
- **THEN** only the two directory names are returned

#### Scenario: Missing root

- **WHEN** `<root>/corpus/` does not exist
- **THEN** an empty array is returned

### Requirement: Orphan entry counting

The system SHALL provide a function that counts the entries held by an on-disk hash directory for orphan reporting, given its `kind` (`testdata` or `corpus`) and hash-directory name. For a `corpus` directory the count SHALL be the number of regular files directly under it; for a `testdata` directory the count SHALL be the sum of entries across its buckets (`seeds`, `crashes`, `timeouts`, `ooms`). A missing directory SHALL count as zero.

#### Scenario: Testdata orphan sums buckets

- **WHEN** an orphaned testdata dir has 2 files in `seeds/` and 1 in `crashes/`
- **THEN** the counted entries total 3

#### Scenario: Corpus orphan counts files

- **WHEN** an orphaned corpus dir has 1 file
- **THEN** the counted entries total 1

#### Scenario: Missing directory

- **WHEN** the named hash directory does not exist
- **THEN** the counted entries total 0
