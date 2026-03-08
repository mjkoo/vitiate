## MODIFIED Requirements

### Requirement: Create fuzzer instance

The system SHALL provide a `Fuzzer` class constructable via
`new Fuzzer(coverageMap, config?)` that accepts a required coverage map `Buffer` and an
optional `FuzzerConfig` object. The Fuzzer SHALL stash a reference to the coverage map
buffer for zero-copy access on each iteration.

The config SHALL support the following fields, all optional with defaults:

- `maxInputLen` (number, default 4096): Maximum byte length of generated inputs.
- `seed` (bigint, optional): RNG seed for reproducible mutation sequences. If omitted,
  a random seed is used.
- `dictionaryPath` (string, optional): Absolute path to an AFL/libfuzzer-format dictionary file. If provided, the file SHALL be parsed via `Tokens::from_file()` during construction and the resulting tokens SHALL be added as `Tokens` state metadata before any fuzz iterations execute. If the file does not exist or contains malformed content, construction SHALL fail with an error indicating the file path and nature of the failure.
- `detectorTokens` (array of `Buffer`, optional): Pre-seeded dictionary tokens from active bug detectors. If provided, each buffer SHALL be inserted into the `Tokens` state metadata during construction, after any user-provided dictionary tokens. Detector tokens SHALL be exempt from the `MAX_DICTIONARY_SIZE` cap (treated identically to user-provided dictionary tokens). If CmpLog subsequently observes a comparison operand matching a pre-seeded detector token, the token SHALL NOT be promoted a second time into the dictionary.

On construction, the Fuzzer SHALL enable the CmpLog accumulator so that `traceCmp` calls
record comparison operands. The Fuzzer SHALL also initialize `CmpValuesMetadata` on the
fuzzer state and include `I2SSpliceReplace` (wrapping `I2SRandReplace`) in its mutation pipeline. This replaces the prior `I2SRandReplace` as the post-havoc I2S mutator.

On construction, the Fuzzer SHALL initialize `SchedulerMetadata` with `PowerSchedule::fast()` on the fuzzer state. The scheduler SHALL use `CorpusPowerTestcaseScore` as its `TestcaseScore` implementation (replacing the prior `UniformScore`).

On construction, the Fuzzer SHALL initialize the havoc mutator with `havoc_mutations()` merged with `tokens_mutations()`, providing both standard havoc mutations and dictionary-based token mutations in a single scheduled mutator.

On construction, the Fuzzer SHALL initialize `TopRatedsMetadata` on the fuzzer state. This metadata is consumed by the `MinimizerScheduler` to track the best corpus entry per coverage edge (see corpus-minimizer spec).

On construction, the Fuzzer SHALL additionally initialize:

- `stage_state` to `StageState::None`.
- `last_interesting_corpus_id` to `None` (`Option<CorpusId>`). This field is set by `report_result()` when an input is added to the corpus, and consumed (cleared) by `begin_stage()`.
- `last_stage_input` to `None` (or equivalent empty state). This field stores the most recently generated stage input so that `advanceStage()` can add it to the corpus if coverage evaluation deems it interesting.

#### Scenario: Create with detector tokens

- **WHEN** `new Fuzzer(coverageMap, { detectorTokens: [Buffer.from("__proto__"), Buffer.from("../")] })` is called
- **THEN** the `Tokens` state metadata SHALL contain `"__proto__"` and `"../"` as token entries
- **AND** the tokens SHALL be available to `TokenInsert` and `TokenReplace` from the first `getNextInput()` call

#### Scenario: Detector tokens coexist with user dictionary

- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/path/to/json.dict", detectorTokens: [Buffer.from("__proto__")] })` is called
- **AND** the dictionary file contains valid entries
- **THEN** both user dictionary tokens and detector tokens SHALL be present in `Tokens` metadata
- **AND** user dictionary tokens SHALL be loaded first, followed by detector tokens

#### Scenario: Detector tokens exempt from CmpLog cap

- **WHEN** the `Fuzzer` is constructed with 50 detector tokens
- **AND** CmpLog promotion reaches `MAX_DICTIONARY_SIZE`
- **THEN** all 50 detector tokens SHALL remain in `Tokens` metadata (not counted toward cap)

#### Scenario: CmpLog does not re-promote detector tokens

- **WHEN** the `Fuzzer` is constructed with detector token `"__proto__"`
- **AND** CmpLog observes `"__proto__"` as a comparison operand at runtime
- **THEN** `"__proto__"` SHALL NOT be promoted a second time
- **AND** `"__proto__"` SHALL appear exactly once in `Tokens` metadata
