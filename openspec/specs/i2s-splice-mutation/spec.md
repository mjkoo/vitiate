## Requirements

### Requirement: I2S splice replace mutator

The system SHALL provide an `I2SSpliceReplace` mutator that wraps LibAFL's `I2SRandReplace` and adds a length-changing splice path for `CmpValues::Bytes` entries. The mutator SHALL implement `Mutator<BytesInput, FuzzerState>` and be used as the post-havoc I2S mutator in the fuzzing pipeline.

#### Entry selection

On each call to `mutate()`, the mutator SHALL select a single random entry from `CmpValuesMetadata` via `state.rand_mut().below(cmps_len)` and a random starting offset in the input via `state.rand_mut().below(input_len)`. This matches `I2SRandReplace`'s single-entry selection strategy. If `CmpValuesMetadata` is absent, empty, or the input is empty, the mutator SHALL return `MutationResult::Skipped`.

The mutator SHALL use **wrap-around scanning**: starting from the random offset, it checks all `input_len` positions by wrapping to position 0 after reaching the end. This ensures matches at any position are found regardless of the starting offset, while the random start provides diversity when multiple matches exist.

If the selected entry is `CmpValues::Bytes`, the mutator SHALL handle it directly using the splice/overwrite logic described below. If the selected entry is a non-`Bytes` variant (U8, U16, U32, U64), the mutator SHALL delegate the entire `mutate()` call to the inner `I2SRandReplace`, which performs its own independent random entry selection and matching.

#### Splice/overwrite strategy for `CmpValues::Bytes`

For `CmpValues::Bytes` entries where a match is found in the input (see "Partial prefix matching" below for how `matched_prefix_len` is determined), the mutator SHALL select the strategy deterministically based on operand lengths:

- **Equal lengths** (`matched_prefix_len == replacement_len`): Always **overwrite** — write `matched_prefix_len` bytes of the replacement operand over the match position. Input length is unchanged. Splice and overwrite produce identical results for equal-length operands.
- **Different lengths**: Always **splice** — delete the `matched_prefix_len` matched bytes and insert the full replacement operand at the match position. Input length changes by `replacement_len - matched_prefix_len`. Overwriting a prefix of the replacement is incorrect for equality comparisons (produces a truncated constant that won't satisfy the comparison). If the splice would exceed `max_size`, the mutator SHALL fall back to overwrite as a best-effort partial mutation.

The mutator SHALL return `MutationResult::Mutated` if a match was found and either overwrite or splice was applied, or `MutationResult::Skipped` if no match was found at any position.

#### Empty operand handling

The mutator SHALL handle empty operands as special cases:

- **Non-empty source + empty replacement**: The scan loop finds the source in the input and deletes it via splice with a zero-length replacement.
- **Empty source + non-empty replacement**: Empty-source pairs are skipped during the scan loop. If no scan match is found for any pair, the mutator SHALL attempt an **insertion fallback**: insert the non-empty replacement at the random offset `off` (with `matched_prefix_len = 0`). This ensures deletion/replacement of bytes already in the input is preferred over blind insertion. The insertion SHALL respect `max_size` — if `input_len + replacement_len > max_size`, the insertion is skipped and the mutator returns `MutationResult::Skipped`.
- **Both empty**: Skipped (no mutation possible).

#### Scenario: Different-length operands always splice

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("http", "javascript")`
- **AND** the corpus contains an input with bytes `"http://example.com"` (18 bytes)
- **THEN** the mutated input SHALL be `"javascript://example.com"` (24 bytes)
- **AND** the input length SHALL have increased by 6 bytes
- **AND** no coin flip SHALL occur — splice is always used for different-length operands

#### Scenario: Splice replaces longer match with shorter operand

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("javascript", "ftp")`
- **AND** the corpus contains an input with bytes `"javascript://x"` (14 bytes)
- **THEN** the mutated input SHALL be `"ftp://x"` (7 bytes)
- **AND** the input length SHALL have decreased by 7 bytes

#### Scenario: Equal-length operands always use overwrite

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("test", "pass")`
- **AND** the corpus contains an input with bytes `"test"`
- **THEN** the mutated input SHALL be `"pass"` (4 bytes, unchanged length)
- **AND** no splice operation SHALL occur regardless of RNG state

#### Scenario: Empty source with non-empty replacement inserts at random offset

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("", "javascript")`
- **AND** no scan match is found for any pair at any position
- **AND** the random offset is 5 in a 10-byte input
- **THEN** the mutator SHALL insert `"javascript"` at offset 5
- **AND** the input length SHALL increase by 10 bytes
- **AND** the mutator SHALL return `MutationResult::Mutated`

#### Scenario: Non-empty source with empty replacement deletes the match

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("http", "")`
- **AND** the input contains `"http://example.com"` (18 bytes)
- **THEN** the mutator SHALL delete the 4 matched bytes via splice
- **AND** the mutated input SHALL be `"://example.com"` (14 bytes)

#### Scenario: Insertion fallback respects max_size

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("", "javascript")`
- **AND** the input is 125 bytes with `max_size` of 128
- **THEN** the insertion (would produce 135 bytes) SHALL be skipped
- **AND** the mutator SHALL return `MutationResult::Skipped`

#### Scenario: Integer CmpValues variants delegate to I2SRandReplace

- **WHEN** the randomly selected `CmpValuesMetadata` entry is `CmpValues::U32((42, 99, false))`
- **THEN** the mutator SHALL delegate the entire `mutate()` call to the inner `I2SRandReplace`
- **AND** the inner `I2SRandReplace` SHALL perform its own independent random entry selection and matching

### Requirement: Splice respects max input size

The splice operation SHALL NOT produce an input larger than `max_size` (from `HasMaxSize` on the state). Before splicing, the mutator SHALL check that `current_len - matched_prefix_len + replacement_len <= max_size`. If the splice would exceed `max_size`, the mutator SHALL fall back to overwrite for that match.

#### Scenario: Splice within size limit proceeds

- **WHEN** `max_size` is 4096
- **AND** the input is 100 bytes
- **AND** a splice would produce a 106-byte input
- **THEN** the splice SHALL proceed and the input SHALL be 106 bytes

#### Scenario: Splice exceeding size limit falls back to overwrite

- **WHEN** `max_size` is 128
- **AND** the input is 120 bytes with a 4-byte match
- **AND** the replacement operand is 20 bytes (splice would produce 136 bytes)
- **THEN** the mutator SHALL fall back to overwrite (writing the first 4 bytes of the replacement)
- **AND** the input length SHALL remain 120 bytes
- **AND** the mutator SHALL return `MutationResult::Mutated`

### Requirement: Bidirectional operand matching

The mutator SHALL scan for both operands of a `CmpValues::Bytes` entry in the input, matching in both directions: if `v.0` is found, replace with `v.1`; if `v.1` is found, replace with `v.0`. The first match found (scanning from the random offset via wrap-around) SHALL be used. The splice-vs-overwrite strategy selection applies regardless of which direction matched.

#### Scenario: Forward direction match

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("abc", "xyz")`
- **AND** the input contains `"abc"` but not `"xyz"`
- **THEN** the mutator SHALL replace `"abc"` with `"xyz"`

#### Scenario: Reverse direction match

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("abc", "xyz")`
- **AND** the input contains `"xyz"` but not `"abc"`
- **THEN** the mutator SHALL replace `"xyz"` with `"abc"`

### Requirement: Partial prefix matching

Like `I2SRandReplace`, the mutator SHALL attempt decreasing prefix lengths when scanning for matches. At each position, the mutator starts with `matched_prefix_len = min(source_operand_len, remaining_input_len)` and decreases by 1 until a match is found or `matched_prefix_len` reaches the minimum threshold. The first match (at any position, at any prefix length) terminates the scan.

The mutator SHALL enforce a **minimum match threshold** of `max(2, ceil(source_len / 2))`. Prefix lengths below this threshold are not attempted. This prevents wasting mutations on single-byte partial matches that provide little value for guiding the fuzzer toward satisfying comparisons.

The `matched_prefix_len` determines the behavior of both strategies:

- **Overwrite**: writes `matched_prefix_len` bytes of the replacement operand over the match position. Only the first `matched_prefix_len` bytes of the replacement are used.
- **Splice**: deletes the `matched_prefix_len` matched bytes, then inserts the **full** replacement operand. Input length changes by `replacement_len - matched_prefix_len`.

#### Scenario: Partial match with different-length operands uses splice

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("http", "javascript")`
- **AND** the input contains `"htt"` (3-byte prefix match, `matched_prefix_len` = 3) but not the full `"http"`
- **AND** 3 >= `max(2, ceil(4/2))` = 2 (above minimum match threshold)
- **THEN** the mutator SHALL delete the 3 matched bytes and insert the full `"javascript"` (10 bytes)
- **AND** the input length SHALL change by +7 bytes

#### Scenario: Partial match below minimum threshold is skipped

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("javascript", "http")`
- **AND** the input contains `"java"` (4-byte prefix match) but not any longer prefix
- **AND** 4 < `max(2, ceil(10/2))` = 5 (below minimum match threshold)
- **THEN** the mutator SHALL NOT match at this position
- **AND** scanning SHALL continue to subsequent positions
