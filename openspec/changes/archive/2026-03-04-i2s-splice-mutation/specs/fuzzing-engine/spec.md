## MODIFIED Requirements

### Requirement: Create fuzzer instance

On construction, the Fuzzer SHALL initialize `CmpValuesMetadata` on the fuzzer state and include `I2SSpliceReplace` (wrapping `I2SRandReplace`) in its mutation pipeline. This replaces the prior `I2SRandReplace` as the post-havoc I2S mutator.

All other constructor behavior (coverage map, config, CmpLog accumulator, `SchedulerMetadata`, `PowerSchedule::fast()`) is unchanged.

### Requirement: Get next mutated input

The system SHALL provide `fuzzer.getNextInput()` which returns a `Buffer` containing a
mutated input derived from the corpus. The system uses LibAFL's havoc mutations (bit
flips, byte flips, arithmetic, block insert/delete/copy, splicing) applied to a corpus
entry selected by the scheduler, followed by `I2SSpliceReplace` which may replace byte
patterns matching recorded comparison operands. For `CmpValues::Bytes` matches, `I2SSpliceReplace` randomly chooses between same-length overwrite and length-changing splice, enabling the fuzzer to construct operand substitutions where the replacement differs in length from the matched region.

The method SHALL record the corpus ID of the selected entry as the "last corpus ID" for mutation depth tracking. When `reportResult()` subsequently adds a new corpus entry, it SHALL use this stored ID to determine the parent and compute depth.

#### Scenario: Mutations produce varied outputs

- **WHEN** `getNextInput()` is called 100 times with a single seed in the corpus
- **THEN** at least 2 distinct outputs are produced (mutations are not identity)

#### Scenario: Output respects maxInputLen

- **WHEN** a Fuzzer is configured with `maxInputLen: 128` and `getNextInput()` is called
- **THEN** the returned Buffer length SHALL NOT exceed 128 bytes

#### Scenario: I2S mutation uses comparison metadata

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("foo", "bar")`
- **AND** the corpus contains an input with bytes `"foo"`
- **AND** `getNextInput()` is called multiple times
- **THEN** at least one returned input SHALL contain the bytes `"bar"` replacing `"foo"`
  (demonstrating I2S replacement)

#### Scenario: I2S splice produces length-changing replacement

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("http", "javascript")`
- **AND** the corpus contains an input with bytes `"http://a"`
- **AND** `getNextInput()` is called multiple times
- **THEN** at least one returned input SHALL contain the bytes `"javascript"` replacing `"http"` with the input length increased by 6 bytes (demonstrating I2S splice)

#### Scenario: Selected corpus ID tracked for depth

- **WHEN** `getNextInput()` selects corpus entry with ID X
- **THEN** the Fuzzer's `last_corpus_id` SHALL be set to X
- **AND** a subsequent `reportResult()` that adds a new entry SHALL compute depth from entry X's metadata
