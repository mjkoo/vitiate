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

#### Scenario: Create with defaults

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** a Fuzzer instance is created with maxInputLen=4096 and a random seed, holding
  a reference to the provided coverage map
- **AND** the CmpLog accumulator is enabled
- **AND** `SchedulerMetadata` with `PowerSchedule::fast()` is present on the state
- **AND** `TopRatedsMetadata` is present on the state with an empty edge-to-corpus-ID map
- **AND** the havoc mutator includes token mutations
- **AND** no `Tokens` metadata is present on the state (no dictionary provided)

#### Scenario: Create with custom config

- **WHEN** `new Fuzzer(createCoverageMap(32768), { maxInputLen: 1024, seed: 42n })` is called
- **THEN** a Fuzzer instance is created with the specified configuration
- **AND** the CmpLog accumulator is enabled

#### Scenario: Create with dictionary path

- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/path/to/json.dict" })` is called
- **AND** the file contains valid AFL/libfuzzer dictionary entries
- **THEN** the `Tokens` state metadata SHALL contain the parsed tokens from the file
- **AND** the tokens SHALL be available to `TokenInsert` and `TokenReplace` from the first `getNextInput()` call

#### Scenario: Create with nonexistent dictionary path

- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/nonexistent.dict" })` is called
- **THEN** construction SHALL fail with an error indicating the file was not found

#### Scenario: Create with malformed dictionary

- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/path/to/bad.dict" })` is called
- **AND** the file contains malformed content
- **THEN** construction SHALL fail with an error indicating the parse failure

#### Scenario: Reproducible with same seed

- **WHEN** two Fuzzer instances are created with the same seed and coverage maps of the
  same size, and the same sequence of addSeed/getNextInput/reportResult calls is performed
- **THEN** both instances SHALL produce identical mutation sequences

#### Scenario: Create with defaults includes stage state

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** `stage_state` SHALL be `StageState::None`
- **AND** `last_interesting_corpus_id` SHALL be `None`
