## ADDED Requirements

### Requirement: Detector tokens passed through NAPI boundary

The system SHALL extend `FuzzerConfig` with a `detectorTokens` field that accepts an array of byte arrays. These tokens SHALL be inserted into LibAFL's `Tokens` state metadata during `Fuzzer::new()`, after any user-provided dictionary tokens.

#### Scenario: Detector tokens available to mutator

- **WHEN** the `Fuzzer` is constructed with `detectorTokens` containing `["__proto__", "../"]`
- **THEN** the `TokenInsert` and `TokenReplace` havoc mutations SHALL have access to these tokens
- **AND** the tokens SHALL be available from the first iteration (no promotion delay)

#### Scenario: Detector tokens coexist with user dictionary

- **WHEN** both a user dictionary file and detector tokens are provided
- **THEN** both sets of tokens SHALL be present in the `Tokens` state metadata
- **AND** the user dictionary tokens SHALL be loaded first, followed by detector tokens

#### Scenario: No detector tokens

- **WHEN** `detectorTokens` is empty or absent
- **THEN** the `Fuzzer` SHALL construct normally with only user dictionary tokens (if any)

### Requirement: Detector tokens exempt from auto-discovery cap

Detector tokens SHALL NOT count against the `MAX_DICTIONARY_SIZE` (512) cap enforced by the `TokenTracker`. They SHALL be treated like user-provided dictionary tokens — exempt from the cap.

#### Scenario: Detector tokens do not consume dictionary budget

- **WHEN** 50 detector tokens are pre-seeded
- **AND** the `TokenTracker` has discovered 500 CmpLog tokens
- **THEN** all 550 tokens SHALL be available (detector tokens do not reduce the budget for CmpLog tokens)

### Requirement: CmpLog does not duplicate detector tokens

The CmpLog token promotion pipeline SHALL NOT re-promote tokens that were pre-seeded by detectors. If CmpLog observes a comparison operand at runtime that matches a pre-seeded detector token, the system SHALL recognize it as already present in the dictionary and skip promotion.

#### Scenario: CmpLog does not duplicate detector tokens

- **WHEN** the detector pre-seeds `"__proto__"` as a token
- **AND** CmpLog observes `"__proto__"` as a comparison operand at runtime
- **THEN** `"__proto__"` SHALL NOT be promoted a second time
- **AND** `"__proto__"` SHALL appear exactly once in the `Tokens` metadata

### Requirement: Token collection from active detectors

The `DetectorManager` SHALL collect tokens from all active detectors by calling each detector's `getTokens()` method. The collected tokens SHALL be concatenated into a single array and passed as `detectorTokens` in `FuzzerConfig`.

#### Scenario: Tokens collected from multiple detectors

- **WHEN** prototype pollution and command injection detectors are both active
- **THEN** the `detectorTokens` array SHALL contain tokens from both detectors
- **AND** each detector's tokens SHALL be included exactly once
