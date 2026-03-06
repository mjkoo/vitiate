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

#### Scenario: Create with custom config

- **WHEN** `new Fuzzer(createCoverageMap(32768), { maxInputLen: 1024, seed: 42n })` is called
- **THEN** a Fuzzer instance is created with the specified configuration
- **AND** the CmpLog accumulator is enabled

#### Scenario: Reproducible with same seed

- **WHEN** two Fuzzer instances are created with the same seed and coverage maps of the
  same size, and the same sequence of addSeed/getNextInput/reportResult calls is performed
- **THEN** both instances SHALL produce identical mutation sequences

#### Scenario: Create with defaults includes stage state

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** `stage_state` SHALL be `StageState::None`
- **AND** `last_interesting_corpus_id` SHALL be `None`

### Requirement: Add seed inputs

The system SHALL provide `fuzzer.addSeed(input: Buffer)` to add a seed input to the
corpus. Seeds serve as starting points for mutation.

Each seed added via `addSeed()` SHALL receive `SchedulerTestcaseMetadata` with depth 0, a nominal execution time of 1ms, and `cycle_and_time` of (1ms, 1). This ensures `CorpusPowerTestcaseScore` can compute a score for seeds without erroring on missing `exec_time`. Seeds SHALL NOT be calibrated.

Each seed SHALL also receive empty `MapIndexesMetadata` (containing no edge indices). This ensures `MinimizerScheduler::update_score()` succeeds without error when `scheduler.on_add()` is called. Seeds have no coverage data, so they cover no edges and cannot become favored.

#### Scenario: Add a seed

- **WHEN** `fuzzer.addSeed(Buffer.from("hello"))` is called
- **THEN** the corpus contains one entry and `getNextInput()` can produce mutations
  derived from it
- **AND** the entry SHALL have `SchedulerTestcaseMetadata` with depth 0 and exec_time of 1ms
- **AND** the entry SHALL have empty `MapIndexesMetadata`

#### Scenario: Add multiple seeds

- **WHEN** three different seeds are added via `addSeed()`
- **THEN** the corpus size is 3 and `getNextInput()` can produce mutations derived from
  any of them
- **AND** each entry SHALL have `SchedulerTestcaseMetadata` with depth 0 and exec_time of 1ms
- **AND** each entry SHALL have empty `MapIndexesMetadata`

### Requirement: Shared coverage evaluation helper

The `Fuzzer` SHALL implement a private `evaluate_coverage()` method that encapsulates the coverage evaluation logic shared between `report_result()` and `advance_stage()`.

The helper SHALL accept the following parameters:
- `input: &[u8]` — the input bytes to store in the testcase if interesting.
- `exec_time_ns: f64` — execution time in nanoseconds for the testcase's `exec_time`.
- `exit_kind: ExitKind` — used for crash/timeout objective evaluation.
- `parent_corpus_id: CorpusId` — used to compute `depth` (parent's depth + 1).

The helper SHALL:

1. Mask unstable edges (zero coverage map entries at indices in the unstable entries set).
2. Construct a `StdMapObserver` from `map_ptr`.
3. Evaluate crash/timeout objective (`CrashFeedback`, `TimeoutFeedback`) using `exit_kind`. For `ExitKind::Ok` (the only value used by `advance_stage()`), objective evaluation will return "not a solution" — this is expected and the evaluation is still performed for uniformity.
4. Evaluate coverage feedback (`MaxMapFeedback::is_interesting()`). During the coverage map iteration that computes `MapNoveltiesMetadata`, also collect the indices of all nonzero entries into `MapIndexesMetadata`.
5. If interesting: create a `Testcase` from the provided `input` bytes, set `exec_time` to `Duration::from_nanos(exec_time_ns as u64)`, add `SchedulerTestcaseMetadata` with the following fields:
   - `depth`: `parent_corpus_id`'s depth + 1.
   - `bitmap_size`: number of non-zero entries in the coverage map.
   - `n_fuzz_entry`: initialized to 0.
   - `handicap`: initialized to 0.
   - `cycle_and_time`: initialized to `(Duration::ZERO, 0)`.
   Store `MapNoveltiesMetadata` and `MapIndexesMetadata` on the testcase. Add to corpus via `corpus_mut().add()`, call `scheduler.on_add()`.
6. Zero the coverage map.
7. Return a result indicating: whether the input was interesting (new coverage), whether it was a solution (crash/timeout objective triggered), and the `CorpusId` if a corpus entry was added.

`report_result()` SHALL call this helper (passing the current input, `exec_time_ns`, `exit_kind`, and the scheduled corpus entry as parent) and additionally: check the helper's `is_solution` flag to populate the `IterationResult.solution` field, drain CmpLog, store `CmpValuesMetadata`, promote tokens, prepare calibration state if interesting, store corpus ID in `last_interesting_corpus_id` if interesting, increment `total_execs` and `state.executions`.

`advance_stage()` SHALL call this helper (passing the internally-stashed stage input, `exec_time_ns`, `exit_kind`, and `StageState::I2S.corpus_id` as parent) and additionally: drain and discard CmpLog, increment `total_execs` and `state.executions`, generate the next stage candidate. The `is_solution` flag from the helper is ignored during stage execution (since `exit_kind` is always `Ok`, it will always be `false`).

#### Scenario: Helper produces same result as inline evaluation

- **WHEN** `report_result()` uses the shared helper for coverage evaluation
- **THEN** the coverage evaluation results SHALL be identical to the prior inline implementation
- **AND** no behavioral change SHALL be observable from JavaScript

#### Scenario: Helper correctly identifies interesting inputs during stage

- **WHEN** `advance_stage()` uses the shared helper
- **AND** the coverage map contains novel coverage
- **THEN** the helper SHALL return interesting=true
- **AND** the input SHALL be added to the corpus

#### Scenario: MapIndexesMetadata stored alongside MapNoveltiesMetadata

- **WHEN** `evaluate_coverage()` processes an interesting input whose coverage map has nonzero values at indices {10, 20, 30, 40, 50}
- **AND** only indices {40, 50} are novel (exceed the global max map)
- **THEN** the corpus entry SHALL have `MapNoveltiesMetadata` containing {40, 50}
- **AND** the corpus entry SHALL have `MapIndexesMetadata` containing {10, 20, 30, 40, 50}
