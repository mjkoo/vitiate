## ADDED Requirements

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
4. Evaluate coverage feedback (`MaxMapFeedback::is_interesting()`).
5. If interesting: create a `Testcase` from the provided `input` bytes, set `exec_time` to `Duration::from_nanos(exec_time_ns as u64)`, add `SchedulerTestcaseMetadata` with the following fields:
   - `depth`: `parent_corpus_id`'s depth + 1.
   - `bitmap_size`: number of non-zero entries in the coverage map.
   - `n_fuzz_entry`: initialized to 0.
   - `handicap`: initialized to 0.
   - `cycle_and_time`: initialized to `(Duration::ZERO, 0)`.
   Add to corpus via `corpus_mut().add()`, call `scheduler.on_add()`.
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

### Requirement: StageState enum on Fuzzer

The `Fuzzer` struct SHALL include a `stage_state` field of type `StageState`. The enum SHALL have:

- `None`: No stage active (initial and terminal state).
- `I2S { corpus_id: CorpusId, iteration: usize, max_iterations: usize }`: I2S mutational stage in progress.

The enum SHALL be non-exhaustive or designed to accommodate future variants (Generalization, Grimoire) without breaking changes.

#### Scenario: StageState initialized to None

- **WHEN** a `Fuzzer` is constructed via `new Fuzzer(coverageMap, config?)`
- **THEN** `stage_state` SHALL be `StageState::None`

## MODIFIED Requirements

### Requirement: Create fuzzer instance

The system SHALL provide a `Fuzzer` class constructable via `new Fuzzer(coverageMap, config?)` that accepts a required coverage map `Buffer` and an optional `FuzzerConfig` object.

**Delta**: On construction, the Fuzzer SHALL additionally initialize:

- `stage_state` to `StageState::None`.
- `last_interesting_corpus_id` to `None` (`Option<CorpusId>`). This field is set by `report_result()` when an input is added to the corpus, and consumed (cleared) by `begin_stage()`.
- `last_stage_input` to `None` (or equivalent empty state). This field stores the most recently generated stage input so that `advanceStage()` can add it to the corpus if coverage evaluation deems it interesting.

All other construction behavior remains unchanged (see base spec).

#### Scenario: Create with defaults includes stage state

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** `stage_state` SHALL be `StageState::None`
- **AND** `last_interesting_corpus_id` SHALL be `None`

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
