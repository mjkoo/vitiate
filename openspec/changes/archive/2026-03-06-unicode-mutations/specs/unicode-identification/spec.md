## ADDED Requirements

### Requirement: UTF-8 region identification extracts character boundary metadata

The system SHALL provide a UTF-8 identification algorithm that analyzes a byte input and produces `UnicodeIdentificationMetadata` containing all valid UTF-8 string regions with precomputed character boundaries. The metadata is stored as `Rc<Vec<(usize, BitVec)>>` - a reference-counted list of `(region_start_offset, character_boundary_bitvec)` tuples. The algorithm SHALL:

1. Use a BFS traversal starting at byte offset 0.
2. At each unvisited position, attempt to parse the remaining bytes as UTF-8.
3. On success: record the region as `(start_offset, character_boundary_bitvec)` where the BitVec marks byte positions that are the start of a UTF-8 character. Mark all bytes in the region as visited.
4. On partial UTF-8 error: record the valid prefix as a region, then queue `error_offset + 1` as the next position to try.
5. After recording a region, queue any unset BitVec positions within the region (continuation bytes within multi-byte characters).
6. Continue until all byte positions are visited or queued.

The result SHALL be an `Rc<Vec<(usize, BitVec)>>` - a reference-counted list of tuples, one per contiguous UTF-8 region found in the input. The BitVec for each region SHALL have length equal to the region's byte length, with set bits at character boundary positions (the byte offset where each character starts).

#### Scenario: Fully valid UTF-8 input

- **WHEN** the input bytes are entirely valid UTF-8 (e.g., `"hello world"`)
- **THEN** `UnicodeIdentificationMetadata` SHALL contain exactly one region starting at offset 0
- **AND** the BitVec SHALL have set bits at every character boundary (all characters are single-byte ASCII)

#### Scenario: Input with embedded invalid bytes

- **WHEN** the input contains valid UTF-8 followed by invalid bytes followed by more valid UTF-8 (e.g., `b"abc\xFF\xFEdef"`)
- **THEN** `UnicodeIdentificationMetadata` SHALL contain at least two regions
- **AND** the first region SHALL cover `"abc"` and the second SHALL cover `"def"`
- **AND** invalid bytes SHALL not be included in any region

#### Scenario: Multi-byte UTF-8 characters

- **WHEN** the input contains multi-byte UTF-8 characters (e.g., emoji, CJK characters)
- **THEN** the BitVec SHALL mark only the first byte of each multi-byte sequence as a character boundary
- **AND** continuation bytes SHALL NOT be marked as character boundaries

#### Scenario: Empty input

- **WHEN** the input is empty (zero bytes)
- **THEN** `UnicodeIdentificationMetadata` SHALL contain an empty list of regions

#### Scenario: Entirely non-UTF-8 input

- **WHEN** the input contains no valid UTF-8 sequences
- **THEN** `UnicodeIdentificationMetadata` SHALL contain an empty list of regions

### Requirement: Unicode identification metadata is cached per testcase

The system SHALL compute `UnicodeIdentificationMetadata` once per corpus entry and store it on the testcase. If `UnicodeIdentificationMetadata` is already present on the testcase, the identification step SHALL be skipped.

The metadata SHALL be recomputed for mutated inputs within the unicode stage (since mutations change byte layout), but the original corpus entry's metadata SHALL persist across stage invocations.

#### Scenario: Metadata cached on first computation

- **WHEN** the unicode stage begins for a corpus entry that has no `UnicodeIdentificationMetadata`
- **THEN** the system SHALL compute and store the metadata on the testcase
- **AND** subsequent stage invocations for the same entry SHALL reuse the cached metadata

#### Scenario: Mutated inputs get fresh metadata

- **WHEN** a unicode mutator modifies the input bytes
- **THEN** `UnicodeIdentificationMetadata` SHALL be recomputed for the mutated input
- **AND** the recomputed metadata SHALL reflect the new byte layout
