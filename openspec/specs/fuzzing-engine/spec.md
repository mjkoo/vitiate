## Requirements

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

### Requirement: Auto-seed on empty corpus

If no seeds have been added when `getNextInput()` is first called, the system SHALL
automatically add a diverse set of default inputs to the corpus: an empty buffer, `"\n"`,
`"0"`, `"\x00\x00\x00\x00"`, `"{}"`, and `"test"`. These provide the mutator with
structural tokens (JSON braces, null bytes, printable ASCII) as starting material.

Each auto-seed SHALL receive `SchedulerTestcaseMetadata` with depth 0 and a nominal execution time of 1ms. If auto-seeds are added via `addSeed()` internally, they inherit the metadata from that method. If added directly to the corpus, the metadata SHALL be added explicitly. Auto-seeds SHALL NOT be calibrated.

#### Scenario: No explicit seeds

- **WHEN** `getNextInput()` is called without any prior `addSeed()` calls
- **THEN** the call succeeds and returns a Buffer
- **AND** the corpus size is at least 6 (the default seed set)
- **AND** each auto-seed entry SHALL have `SchedulerTestcaseMetadata` with depth 0 and exec_time of 1ms

### Requirement: Get next mutated input

The system SHALL provide `fuzzer.getNextInput()` which returns a `Buffer` containing a
mutated input derived from the corpus. The system uses LibAFL's havoc mutations (bit
flips, byte flips, arithmetic, block insert/delete/copy, splicing) combined with token mutations (`TokenInsert`, `TokenReplace`) applied to a corpus
entry selected by the scheduler, followed by `I2SSpliceReplace` which may replace byte
patterns matching recorded comparison operands. For `CmpValues::Bytes` matches, `I2SSpliceReplace` randomly chooses between same-length overwrite and length-changing splice, enabling the fuzzer to construct operand substitutions where the replacement differs in length from the matched region.

The token mutations operate on the `Tokens` metadata in the fuzzer state. `TokenInsert` selects a random token and inserts it at a random position in the input, growing the input buffer. `TokenReplace` selects a random token and overwrites bytes at a random position. If no `Tokens` metadata exists or the token list is empty, token mutations are skipped.

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

#### Scenario: Token mutations can grow the input

- **WHEN** the fuzzer state contains `Tokens` metadata with token `"javascript"`
- **AND** the corpus contains a seed `"http://example.com"` (18 bytes)
- **AND** `getNextInput()` is called multiple times
- **THEN** at least one returned input SHALL have length greater than 18 bytes
  (demonstrating `TokenInsert` can grow the input)

#### Scenario: Token mutations use dictionary tokens

- **WHEN** the fuzzer state contains `Tokens` metadata with token `"javascript"`
- **AND** `getNextInput()` is called multiple times
- **THEN** at least one returned input SHALL contain the bytes `"javascript"`

#### Scenario: Selected corpus ID tracked for depth

- **WHEN** `getNextInput()` selects corpus entry with ID X
- **THEN** the Fuzzer's `last_corpus_id` SHALL be set to X
- **AND** a subsequent `reportResult()` that adds a new entry SHALL compute depth from entry X's metadata

### Requirement: Report execution result

The system SHALL provide `fuzzer.reportResult(exitKind: ExitKind, execTimeNs: number)` which:

1. Calls the shared `evaluate_coverage()` helper (passing the current input, `exec_time_ns`, `exit_kind`, and the scheduled corpus entry as parent). The helper masks unstable edges, reads coverage via the observer, evaluates whether the input was interesting or a crash/timeout, adds to corpus if interesting, and zeroes the coverage map.
2. If the helper returned interesting: `report_result` additionally prepares calibration state for subsequent `calibrateRun()` calls and stores the corpus ID in `last_interesting_corpus_id` for use by `beginStage()`.
3. Drains the thread-local CmpLog accumulator and stores the resulting entries as `CmpValuesMetadata` on the fuzzer state.
4. Extracts byte tokens from CmpLog entries and promotes frequent ones into the mutation dictionary.
5. Increments `total_execs` and `state.executions`.
6. Returns an `IterationResult`.

The `execTimeNs` parameter SHALL be the execution time of the target in nanoseconds, passed as `f64`.

The `ExitKind` enum SHALL have values: `Ok` (0), `Crash` (1), `Timeout` (2).

The `IterationResult` object SHALL contain:

- `interesting` (boolean): Whether the input was added to the corpus.
- `solution` (boolean): Whether the input was a crash/timeout (added to solutions).

When `reportResult()` returns `Interesting`, the most recently added corpus ID SHALL be stored in `last_interesting_corpus_id` for use by `beginStage()`. This corpus ID identifies the entry that the I2S stage will mutate.

#### Scenario: New coverage is interesting

- **WHEN** the coverage map contains a byte pattern not seen in any previous iteration
  and `reportResult(ExitKind.Ok, execTimeNs)` is called
- **THEN** the result has `interesting: true` and the corpus size increases by one
- **AND** the new entry has `SchedulerTestcaseMetadata` populated
- **AND** calibration state is prepared for subsequent `calibrateRun()` calls
- **AND** the corpus ID is stored in `last_interesting_corpus_id` for `beginStage()`

#### Scenario: Duplicate coverage is not interesting

- **WHEN** the coverage map contains the same byte pattern as a previous iteration and
  `reportResult(ExitKind.Ok, execTimeNs)` is called
- **THEN** the result has `interesting: false` and the corpus size does not change

#### Scenario: Crash detected

- **WHEN** `reportResult(ExitKind.Crash, execTimeNs)` is called
- **THEN** the result has `solution: true` and the solution count increases by one

#### Scenario: CmpLog metadata updated on reportResult

- **WHEN** instrumented code calls `traceCmp` with string operands during a fuzz iteration
- **AND** `reportResult(ExitKind.Ok, execTimeNs)` is called
- **THEN** the fuzzer state contains `CmpValuesMetadata` with the recorded comparison entries
- **AND** the CmpLog data is available for subsequent `beginStage()` I2S mutations

#### Scenario: Unstable edges masked before evaluation

- **WHEN** the fuzzer's unstable entries set contains index 42
- **AND** the coverage map has a nonzero value only at index 42
- **AND** `reportResult(ExitKind.Ok, execTimeNs)` is called
- **THEN** index 42 SHALL be zeroed before the observer reads the map
- **AND** the result SHALL have `interesting: false`

#### Scenario: No masking without unstable entries

- **WHEN** the fuzzer's unstable entries set is empty
- **AND** `reportResult(ExitKind.Ok, execTimeNs)` is called
- **THEN** all coverage map entries SHALL be evaluated normally

### Requirement: Calibrate run

The system SHALL provide `fuzzer.calibrateRun(execTimeNs: number)` which performs one calibration iteration for the most recently added corpus entry. The method SHALL:

1. Accumulate the execution time (converting `execTimeNs` from nanoseconds as `f64` to `Duration`).
2. Read the current coverage map into a snapshot.
3. On the first call after `reportResult()` returned `Interesting`: store the snapshot as the baseline.
4. On subsequent calls: compare the snapshot against the baseline and mark differing indices as unstable. Set the `cal_has_unstable` flag if any new unstable edges are found.
5. Zero the coverage map for the next run.
6. Return `true` if more calibration runs are needed, `false` if calibration is complete.

The target run count SHALL be 4 (`CAL_STAGE_START`) if no unstable edges are detected, or 8 (`CAL_STAGE_MAX`) if unstable edges are detected. The iteration count includes the original fuzz iteration as run #1.

#### Scenario: First calibration run captures baseline

- **WHEN** `calibrateRun(execTimeNs)` is called for the first time after an `Interesting` result
- **THEN** the coverage map SHALL be stored as the baseline snapshot
- **AND** the coverage map SHALL be zeroed
- **AND** the method SHALL return `true` (more runs needed)

#### Scenario: Subsequent run detects stable edges

- **WHEN** `calibrateRun(execTimeNs)` is called and the coverage map matches the baseline
- **THEN** no unstable edges SHALL be recorded
- **AND** the coverage map SHALL be zeroed

#### Scenario: Subsequent run detects unstable edges

- **WHEN** `calibrateRun(execTimeNs)` is called and the coverage map differs from the baseline at some indices
- **THEN** the differing indices SHALL be marked as unstable
- **AND** the target run count SHALL extend to 8

#### Scenario: Returns false when calibration is complete

- **WHEN** `calibrateRun()` is called and the total iteration count (including original) reaches the target
- **THEN** the method SHALL return `false`

### Requirement: Calibrate finish

The system SHALL provide `fuzzer.calibrateFinish()` which finalizes calibration for the most recently added corpus entry. The method SHALL:

1. Compute the averaged execution time (total accumulated time / iteration count) and set it as the testcase's `exec_time`.
2. Update `SchedulerTestcaseMetadata.cycle_and_time` with (total_time, iteration_count).
3. Update global `SchedulerMetadata` running totals with the calibrated entry's values (exec_time, cycles, bitmap_size, bitmap_size_log, bitmap_entries).
4. Merge any newly discovered unstable edge indices into the fuzzer's unstable entries set (a `HashSet<usize>` field on `Fuzzer`).
5. Re-score the entry via `scheduler.on_replace()` so subsequent selections use calibrated weights.
6. Clear all calibration state fields on the Fuzzer.

It SHALL be valid to call `calibrateFinish()` with partial data (fewer runs than the target) if calibration was interrupted by a crash or timeout.

It SHALL be an error to call `calibrateFinish()` without a pending calibration (no prior `Interesting` result from `reportResult()`).

#### Scenario: Finalize with full calibration

- **WHEN** `calibrateFinish()` is called after 3 `calibrateRun()` calls (4 total runs)
- **THEN** the testcase's `exec_time` SHALL be the total time divided by 4
- **AND** global `SchedulerMetadata` SHALL be updated with the entry's calibrated values
- **AND** the entry SHALL be re-scored

#### Scenario: Finalize with partial data after crash

- **WHEN** calibration is interrupted after 1 `calibrateRun()` call (2 total runs) and `calibrateFinish()` is called
- **THEN** the testcase's `exec_time` SHALL be the total time divided by 2
- **AND** global `SchedulerMetadata` SHALL be updated with the partial data

#### Scenario: Unstable edges merged on finish

- **WHEN** `calibrateFinish()` is called and calibration detected unstable edges at indices {42, 100}
- **THEN** those indices SHALL be added to the fuzzer's unstable entries set

#### Scenario: Error on finish without pending calibration

- **WHEN** `calibrateFinish()` is called without a prior `Interesting` result from `reportResult()`
- **THEN** the method SHALL return an error

### Requirement: Begin stage NAPI method

The `Fuzzer` class SHALL expose a `beginStage()` method via NAPI that returns `Buffer | null`. This method initiates an I2S mutational stage for the most recently calibrated corpus entry.

The full behavioral specification is defined in the stage-execution capability spec (see Requirement: Begin stage after calibration). The NAPI method SHALL:
1. Accept no parameters.
2. Return `Buffer` containing the first I2S-mutated input if preconditions are met (`StageState::None`, pending `last_interesting_corpus_id`, non-empty `CmpValuesMetadata`).
3. Return `null` if any precondition is not met.

#### Scenario: beginStage returns first I2S candidate

- **WHEN** `beginStage()` is called after calibration completes for an interesting input with CmpLog data
- **THEN** the method SHALL return a `Buffer` containing an I2S-mutated variant
- **AND** the `Fuzzer` SHALL track the stage state internally

#### Scenario: beginStage returns null when not applicable

- **WHEN** `beginStage()` is called without a pending interesting input, or with empty CmpLog data, or during an active stage
- **THEN** the method SHALL return `null`

### Requirement: Advance stage NAPI method

The `Fuzzer` class SHALL expose an `advanceStage(exitKind: ExitKind, execTimeNs: number)` method via NAPI that returns `Buffer | null`. This method processes the result of a stage execution and optionally provides the next candidate.

The full behavioral specification is defined in the stage-execution capability spec (see Requirement: Advance stage after each execution). The NAPI method SHALL:
1. Accept `exitKind` (`ExitKind`) and `execTimeNs` (`number`, passed as `f64`).
2. If no active stage, return `null`.
3. Drain and discard CmpLog, evaluate coverage via the shared helper, increment counters.
4. Return `Buffer` containing the next I2S-mutated input if iterations remain.
5. Return `null` when iterations are exhausted (stage complete).

#### Scenario: advanceStage returns next candidate

- **WHEN** `advanceStage(ExitKind.Ok, execTimeNs)` is called with iterations remaining
- **THEN** the method SHALL return a `Buffer` containing the next I2S-mutated input

#### Scenario: advanceStage returns null at stage end

- **WHEN** `advanceStage()` is called on the final iteration
- **THEN** the method SHALL return `null`
- **AND** `StageState` SHALL be reset to `None`

### Requirement: Abort stage NAPI method

The `Fuzzer` class SHALL expose an `abortStage(exitKind: ExitKind)` method via NAPI that cleanly terminates the current stage.

The full behavioral specification is defined in the stage-execution capability spec (see Requirement: Abort stage on crash or timeout). The NAPI method SHALL:
1. Accept `exitKind` (`ExitKind`).
2. If no active stage, be a no-op (no error, no counter increments).
3. Drain and discard CmpLog, zero coverage map, increment `total_execs` and `state.executions`, reset `StageState` to `None`.

#### Scenario: abortStage cleans up stage state

- **WHEN** `abortStage(ExitKind.Crash)` is called during an active I2S stage
- **THEN** the CmpLog accumulator SHALL be drained
- **AND** the coverage map SHALL be zeroed
- **AND** `total_execs` and `state.executions` SHALL each increment by 1
- **AND** `StageState` SHALL be `None`

#### Scenario: abortStage is no-op without active stage

- **WHEN** `abortStage()` is called with `StageState` already `None`
- **THEN** the method SHALL be a no-op (no error, no counter increments)

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

### Requirement: StageState enum on Fuzzer

The `Fuzzer` struct SHALL include a `stage_state` field of type `StageState`. The enum SHALL have:

- `None`: No stage active (initial and terminal state).
- `I2S { corpus_id: CorpusId, iteration: usize, max_iterations: usize }`: I2S mutational stage in progress.

The enum SHALL be non-exhaustive or designed to accommodate future variants (Generalization, Grimoire) without breaking changes.

#### Scenario: StageState initialized to None

- **WHEN** a `Fuzzer` is constructed via `new Fuzzer(coverageMap, config?)`
- **THEN** `stage_state` SHALL be `StageState::None`

### Requirement: Fuzzer statistics

The system SHALL provide `fuzzer.stats` (getter) returning a `FuzzerStats` object with:

- `totalExecs` (bigint): Total number of target invocations, including main-loop executions (via `reportResult()`), stage executions (via `advanceStage()`), and aborted stage executions (via `abortStage()`).
- `corpusSize` (number): Number of entries in the working corpus.
- `solutionCount` (number): Number of crash/timeout inputs found via `reportResult()`. Stage-discovered crashes (handled by `abortStage()`) are NOT included in `solutionCount` — they are written as artifacts by the JS fuzz loop but not tracked in the Rust solutions corpus.
- `coverageEdges` (number): Number of distinct coverage map positions that have been
  observed nonzero across all iterations.
- `execsPerSec` (number): Executions per second since Fuzzer creation.

#### Scenario: Stats at creation

- **WHEN** `stats` is read immediately after Fuzzer creation
- **THEN** `totalExecs` is 0n, `corpusSize` is 0, `solutionCount` is 0,
  `coverageEdges` is 0, and `execsPerSec` is 0

#### Scenario: Stats after fuzzing with stages

- **WHEN** 1000 main-loop iterations and 200 stage executions have been performed
- **THEN** `stats.totalExecs` equals 1200n
- **AND** `stats.execsPerSec` reflects the combined throughput

### Requirement: End-to-end fuzzing loop

The system SHALL support a complete fuzzing loop driven by JavaScript: create fuzzer, add
seeds, then repeatedly call `getNextInput()` -> execute target -> `reportResult()`. Over
many iterations with a target that exhibits variable coverage based on input content, the
corpus SHALL grow as new coverage is discovered.

#### Scenario: Corpus grows with coverage-guided feedback

- **WHEN** a fuzzer is seeded, and 10000 iterations are run against a target that sets
  different coverage map bytes depending on input content
- **THEN** the corpus size is greater than the initial seed count
- **AND** the coverage edge count is greater than 0
