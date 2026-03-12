# User Dictionary

## Purpose

Defines how user-provided dictionary files in AFL/libfuzzer text format are discovered, loaded, and integrated into the token mutation pipeline. User dictionaries seed the `Tokens` state metadata with domain-specific tokens before the fuzz loop begins, complementing auto-discovered CmpLog tokens.

## Requirements

### Requirement: Dictionary file format

The system SHALL accept dictionaries in the AFL/libfuzzer text format:

- One token per line, enclosed in double quotes: `name="value"` or `"value"`
- The optional `name=` prefix before the quoted value SHALL be ignored (it is a human-readable label)
- Hex escapes `\xHH` within quoted values SHALL be decoded to raw bytes
- Lines starting with `#` (after optional leading whitespace) SHALL be treated as comments and ignored
- Empty lines and whitespace-only lines SHALL be ignored
- Empty quoted values (`""`) SHALL be ignored (no zero-length token added)

Parsing SHALL be performed by LibAFL's `Tokens::from_file()`.

#### Scenario: Standard dictionary entries

- **WHEN** a dictionary file contains:
  ```
  keyword_true="true"
  keyword_false="false"
  ```
- **THEN** the tokens `true` and `false` (as raw bytes) SHALL be added to the `Tokens` metadata

#### Scenario: Hex escape decoding

- **WHEN** a dictionary file contains `magic="\xff\xd8\xff\xe0"`
- **THEN** the token `[0xFF, 0xD8, 0xFF, 0xE0]` (raw bytes) SHALL be added to the `Tokens` metadata

#### Scenario: Comments and blank lines are skipped

- **WHEN** a dictionary file contains:
  ```
  # This is a comment

  keyword="value"
  ```
- **THEN** only the token `value` SHALL be added
- **AND** the comment and blank line SHALL not produce tokens

#### Scenario: Duplicate tokens are deduplicated

- **WHEN** a dictionary file contains:
  ```
  a="hello"
  b="hello"
  ```
- **THEN** the token `hello` SHALL appear exactly once in the `Tokens` metadata

#### Scenario: Empty dictionary file

- **WHEN** a dictionary file exists but contains no token entries (only comments, blank lines, or nothing)
- **THEN** no tokens SHALL be added to `Tokens` metadata
- **AND** the system SHALL proceed without error

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

### Requirement: Dictionary flag in CLI mode

In CLI mode, the system SHALL accept a `-dict=<path>` flag specifying the path to a dictionary file. The path SHALL be resolved relative to the current working directory, matching libfuzzer behavior.

The resolved absolute path SHALL be passed to the child process via the `dictionaryPath` field in the `VITIATE_CLI_IPC` JSON blob.

If `-dict` is provided and the file does not exist, the system SHALL exit with an error before starting the fuzzer.

If `-dict` is not provided in CLI mode, the system SHALL NOT attempt convention-based dictionary discovery (the Vitest convention does not apply in CLI mode).

#### Scenario: Dictionary loaded via CLI flag

- **WHEN** `npx vitiate libfuzzer ./test.ts -dict=./my.dict` is executed
- **AND** `./my.dict` exists and contains valid entries
- **THEN** the tokens from the file SHALL be loaded into `Tokens` metadata before the fuzz loop starts

#### Scenario: CLI dictionary file not found

- **WHEN** `npx vitiate libfuzzer ./test.ts -dict=./missing.dict` is executed
- **AND** `./missing.dict` does not exist
- **THEN** the system SHALL print an error message and exit with a non-zero exit code
- **AND** the fuzzer SHALL NOT start

#### Scenario: No dictionary flag in CLI mode

- **WHEN** `npx vitiate libfuzzer ./test.ts` is executed without `-dict`
- **THEN** no dictionary file SHALL be loaded
- **AND** the system SHALL NOT search for a `.dict` file by convention

### Requirement: Tokens seeded before fuzz loop

When a dictionary file is provided (by convention or flag), the parsed tokens SHALL be added to the fuzzer state's `Tokens` metadata during `Fuzzer` construction, before any fuzz iterations execute. This ensures `TokenInsert` and `TokenReplace` mutators can use the tokens from iteration one.

#### Scenario: Tokens available from first iteration

- **WHEN** a dictionary file containing `"keyword"` is loaded
- **AND** the fuzz loop calls `getNextInput()` for the first time
- **THEN** the `TokenInsert` and `TokenReplace` mutators SHALL have access to the `keyword` token

### Requirement: Malformed dictionary causes startup error

If a dictionary file exists but contains malformed content (lines that are not comments, blank lines, or valid quoted token entries), `Fuzzer` construction SHALL fail with an error. The error message SHALL indicate the file path and the nature of the parse failure. Since dictionary loading occurs during `Fuzzer` construction (see fuzzing-engine spec), this error surfaces before any fuzz iterations execute.

This applies in both Vitest mode and CLI mode. In Vitest mode, the error occurs during `runFuzzLoop()` when it constructs the `Fuzzer` - not during plugin initialization or test discovery.

#### Scenario: Invalid dictionary syntax

- **WHEN** a dictionary file contains `not a valid line`
- **THEN** the system SHALL exit with an error indicating the parse failure
- **AND** the fuzzer SHALL NOT start

### Requirement: User-provided tokens exempt from auto-discovery cap

User-provided dictionary tokens SHALL NOT count toward the auto-discovered token cap (`MAX_DICTIONARY_SIZE`). The cap SHALL apply only to tokens promoted from CmpLog observation. Both user-provided and auto-discovered tokens coexist in the same `Tokens` metadata and are available to `TokenInsert`/`TokenReplace` uniformly.

#### Scenario: Auto-discovery cap ignores user tokens

- **WHEN** a dictionary file provides 600 tokens
- **AND** the auto-discovery cap is 512
- **THEN** all 600 user tokens SHALL be present in `Tokens` metadata
- **AND** up to 512 additional CmpLog-promoted tokens SHALL be allowed

#### Scenario: User tokens and CmpLog tokens coexist

- **WHEN** a dictionary file provides the token `"http"`
- **AND** CmpLog also discovers `"http"` as a comparison operand
- **THEN** the `Tokens` metadata SHALL contain exactly one `"http"` entry (deduplicated)
- **AND** the CmpLog-promoted token count SHALL still be incremented (the promoted slot is consumed)

### Requirement: Dictionary has no effect in regression mode

When running in regression mode (replaying known crash/timeout inputs without mutation), the dictionary file SHALL be ignored even if present. No tokens SHALL be loaded from the dictionary file.

#### Scenario: Regression mode ignores dictionary

- **WHEN** a fuzz test runs in regression mode
- **AND** a dictionary file exists at the convention path
- **THEN** no tokens SHALL be loaded from the dictionary file
- **AND** the regression inputs SHALL be replayed without mutation
