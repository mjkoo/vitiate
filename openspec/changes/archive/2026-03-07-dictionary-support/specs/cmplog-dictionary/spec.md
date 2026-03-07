## ADDED Requirements

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
