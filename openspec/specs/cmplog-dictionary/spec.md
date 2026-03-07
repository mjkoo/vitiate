# CmpLog Dictionary

## Purpose

Defines how CmpLog byte operands are extracted into a token dictionary for use by token-based mutations. This capability bridges CmpLog feedback (which records comparison operands) with the fuzzing engine's token mutation pipeline (TokenInsert, TokenReplace).

## Requirements

### Requirement: Extract CmpLog byte operands into token dictionary

The system SHALL extract byte operands from `CmpValues::Bytes` entries in the CmpLog accumulator and add them to the LibAFL `Tokens` metadata on the fuzzer state. Both operands (left and right) of each `CmpValues::Bytes` entry SHALL be added as separate tokens.

Token extraction SHALL occur during `report_result()`, after the CmpLog accumulator is drained into `CmpValuesMetadata`. The extracted tokens SHALL be merged into any existing `Tokens` metadata on the state, or new `Tokens` metadata SHALL be created if none exists.

#### Scenario: String comparison operands become tokens

- **WHEN** instrumented code executes `__vitiate_trace_cmp(scheme, "javascript", ...)` where `scheme` is `"http"`
- **AND** `reportResult()` is called
- **THEN** the fuzzer state's `Tokens` metadata SHALL contain both `"http"` and `"javascript"` as token entries

#### Scenario: Tokens accumulate across iterations

- **WHEN** iteration 1 records `CmpValues::Bytes("http", "javascript")`
- **AND** iteration 2 records `CmpValues::Bytes("ftp", "javascript")`
- **AND** `reportResult()` is called after each iteration
- **THEN** the `Tokens` metadata SHALL contain `"http"`, `"javascript"`, and `"ftp"` after both iterations

#### Scenario: Tokens are deduplicated

- **WHEN** the same comparison `CmpValues::Bytes("http", "javascript")` fires on consecutive iterations
- **AND** `reportResult()` is called after each
- **THEN** the `Tokens` metadata SHALL contain exactly one entry for `"http"` and one for `"javascript"` (no duplicates)

### Requirement: Filter non-meaningful tokens

The system SHALL skip extraction of byte sequences that are empty (zero length), consist entirely of null bytes (`0x00`), or consist entirely of `0xFF` bytes. These values do not represent meaningful comparison operands.

#### Scenario: Empty bytes are skipped

- **WHEN** `CmpValues::Bytes` contains an empty left operand `[]`
- **THEN** no token SHALL be added for the empty operand

#### Scenario: All-null bytes are skipped

- **WHEN** `CmpValues::Bytes` contains an operand `[0x00, 0x00, 0x00, 0x00]`
- **THEN** no token SHALL be added for that operand

#### Scenario: All-0xFF bytes are skipped

- **WHEN** `CmpValues::Bytes` contains an operand `[0xFF, 0xFF]`
- **THEN** no token SHALL be added for that operand

#### Scenario: Mixed bytes with nulls are kept

- **WHEN** `CmpValues::Bytes` contains an operand `[0x00, 0x41, 0x00]`
- **THEN** the operand SHALL be added as a token (it is not all-null)

### Requirement: Non-Bytes CmpValues are not directly extracted

The system SHALL only extract tokens from `CmpValues::Bytes` entries. `CmpValues::U8`, `U16`, `U32`, and `U64` entries SHALL NOT have their numeric values directly converted to tokens. Integer comparisons already produce a companion `CmpValues::Bytes` entry with decimal string representations (per the cmplog-feedback spec), so they are covered by `Bytes` extraction.

#### Scenario: Integer CmpValues not separately tokenized

- **WHEN** the CmpLog accumulator contains `CmpValues::U16((1000, 2000, false))`
- **AND** it also contains `CmpValues::Bytes("1000", "2000")` (the companion entry)
- **THEN** tokens `"1000"` and `"2000"` SHALL be present in `Tokens` (from the Bytes entry)
- **AND** no additional token extraction SHALL occur from the U16 entry

### Requirement: Auto-discovered token promotion cap applies only to CmpLog tokens

The system SHALL enforce the auto-discovered token cap (`MAX_DICTIONARY_SIZE`) based on the count of CmpLog-promoted tokens only, not the total count of all tokens in the `Tokens` metadata. Tokens added from other sources (such as a user-provided dictionary) SHALL NOT count toward this cap.

When the number of CmpLog-promoted tokens reaches `MAX_DICTIONARY_SIZE`, no further CmpLog tokens SHALL be promoted, regardless of how many user-provided tokens exist in the `Tokens` metadata.

#### Scenario: Cap enforced on CmpLog tokens only

- **WHEN** 600 user-provided tokens exist in `Tokens` metadata
- **AND** CmpLog extraction promotes tokens during `reportResult()`
- **THEN** promotion SHALL continue until the CmpLog-promoted count reaches `MAX_DICTIONARY_SIZE`
- **AND** the 600 user-provided tokens SHALL remain unaffected

#### Scenario: Cap reached stops further CmpLog promotion

- **WHEN** the number of CmpLog-promoted tokens equals `MAX_DICTIONARY_SIZE`
- **AND** a new CmpLog byte operand exceeds the promotion threshold
- **THEN** the new token SHALL NOT be promoted into `Tokens` metadata
- **AND** existing tokens (both user-provided and previously promoted) SHALL remain intact
