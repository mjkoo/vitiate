## MODIFIED Requirements

### Requirement: Shared coverage evaluation helper

The `Fuzzer` SHALL implement a private `evaluate_coverage()` method that encapsulates the coverage evaluation logic shared between `report_result()` and `advance_stage()`.

The helper SHALL accept the following parameters:
- `input: &[u8]` - the input bytes to store in the testcase if interesting.
- `exec_time_ns: f64` - execution time in nanoseconds for the testcase's `exec_time`.
- `exit_kind: ExitKind` - used for crash/timeout objective evaluation.
- `parent_corpus_id: CorpusId` - used to compute `depth` (parent's depth + 1).

The helper SHALL:

1. Classify the coverage map in place into AFL-style hit-count bucket bits before any feedback or novelty read. Each raw count SHALL be replaced by the one-hot bit identifying its bucket (`0 -> 0`, `1 -> 0x01`, `2 -> 0x02`, `3 -> 0x04`, `4-7 -> 0x08`, `8-15 -> 0x10`, `16-31 -> 0x20`, `32-127 -> 0x40`, `128-255 -> 0x80`), matching AFL's `count_class_lookup8`. Nonzero counts SHALL remain nonzero so that `bitmap_size` and `MapIndexesMetadata` are unaffected. Because admission uses OR-reduction feedback (`AflMapFeedback`) over the classified map, an input is interesting when it produces any (edge, hit-count-bucket) feature absent from the feedback's history - including a bucket lower than any previously observed for that edge - matching AFL's virgin-bitmap and libFuzzer's feature-set semantics. The feedback's history map SHALL accumulate, per edge, the bitwise OR of all bucket bits seen.
2. Mask unstable edges (zero coverage map entries at indices in the unstable entries set).
3. Construct a `StdMapObserver` from `map_ptr`.
4. Evaluate crash/timeout objective (`CrashFeedback`, `TimeoutFeedback`) using `exit_kind`. For `ExitKind::Ok` (the only value used by `advance_stage()`), objective evaluation will return "not a solution" - this is expected and the evaluation is still performed for uniformity.
5. Evaluate coverage feedback (`AflMapFeedback::is_interesting()`). During the coverage map iteration that computes `MapNoveltiesMetadata`, also collect the indices of all nonzero entries into `MapIndexesMetadata`.
6. If interesting: create a `Testcase` from the provided `input` bytes, set `exec_time` to `Duration::from_nanos(exec_time_ns as u64)`, add `SchedulerTestcaseMetadata` with the following fields:
   - `depth`: `parent_corpus_id`'s depth + 1.
   - `bitmap_size`: number of non-zero entries in the coverage map.
   - `n_fuzz_entry`: initialized to 0.
   - `handicap`: initialized to 0.
   - `cycle_and_time`: initialized to `(Duration::ZERO, 0)`.
   Store `MapNoveltiesMetadata` and `MapIndexesMetadata` on the testcase. Add to corpus via `corpus_mut().add()`, call `scheduler.on_add()`.
7. Zero the coverage map.
8. Return a result indicating: whether the input was interesting (new coverage), whether it was a solution (crash/timeout objective triggered), and the `CorpusId` if a corpus entry was added.

`report_result()` SHALL call this helper (passing the current input, `exec_time_ns`, `exit_kind`, and the scheduled corpus entry as parent) and additionally: use the helper's `is_solution` and `is_interesting` flags to determine the `IterationResult` variant (`Solution` if is_solution, `Interesting` if is_interesting, `None` otherwise), drain CmpLog, store `CmpValuesMetadata`, promote tokens, prepare calibration state if interesting, store corpus ID in `last_interesting_corpus_id` if interesting, increment `total_execs` and `state.executions`.

`advance_stage()` SHALL call this helper (passing the internally-stashed stage input, `exec_time_ns`, `exit_kind`, and `StageState::I2S.corpus_id` as parent) and additionally: drain and discard CmpLog, increment `total_execs` and `state.executions`, generate the next stage candidate. The `is_solution` flag from the helper is ignored during stage execution (since `exit_kind` is always `Ok`, it will always be `false`).

#### Scenario: Admission keys on a never-seen hit-count-bucket feature

- **WHEN** an edge's history holds the bucket `[4,7]` (bit `0x08`)
- **AND** a later execution produces a raw count of 5 at that edge (still bucket `[4,7]`) with no other new coverage
- **THEN** the input SHALL NOT be interesting (an already-seen bucket)
- **AND WHEN** a later execution instead produces a raw count of 8 (bucket `[8,15]`, bit `0x10`)
- **THEN** the input SHALL be interesting (a never-seen bucket)
- **AND WHEN** a later execution produces a raw count of 2 (bucket `[2,2]`, bit `0x02`), lower than every previously observed count at that edge
- **THEN** the input SHALL be interesting (a never-seen bucket, regardless of being lower than the running maximum)

#### Scenario: Classification preserves bitmap_size

- **WHEN** `evaluate_coverage()` classifies the coverage map
- **THEN** the number of nonzero entries (and thus `bitmap_size` and `MapIndexesMetadata`) SHALL be unchanged from the raw map

#### Scenario: Helper correctly identifies interesting inputs during stage

- **WHEN** `advance_stage()` uses the shared helper
- **AND** the coverage map contains novel coverage
- **THEN** the helper SHALL return interesting=true
- **AND** the input SHALL be added to the corpus

#### Scenario: MapIndexesMetadata stored alongside MapNoveltiesMetadata

- **WHEN** `evaluate_coverage()` processes an interesting input whose coverage map has nonzero values at indices {10, 20, 30, 40, 50}
- **AND** only indices {40, 50} are novel (contribute a bucket bit absent from the history map)
- **THEN** the corpus entry SHALL have `MapNoveltiesMetadata` containing {40, 50}
- **AND** the corpus entry SHALL have `MapIndexesMetadata` containing {10, 20, 30, 40, 50}

### Requirement: Fuzzer statistics

The system SHALL provide `fuzzer.stats` (getter) returning a `FuzzerStats` object with:

- `totalExecs` (number): Total number of target invocations, including main-loop executions (via `reportResult()`), stage executions (via `advanceStage()`), and aborted stage executions (via `abortStage()`). Does NOT include calibration executions.
- `calibrationExecs` (number): Total number of calibration target invocations (via `calibrateRun()`). Tracked separately from `totalExecs` because calibration re-runs the same input and does not produce new coverage. Users sum `totalExecs + calibrationExecs` for total target invocations.
- `corpusSize` (number): Number of entries in the working corpus.
- `solutionCount` (number): Number of crash/timeout inputs found. Includes both main-loop crashes (via `reportResult()`) and stage-discovered crashes (via `abortStage()` with `ExitKind.Crash` or `ExitKind.Timeout`).
- `coverageEdges` (number): Number of distinct coverage map positions that have been
  observed nonzero across all iterations.
- `coverageFeatures` (number): Count of distinct (edge, hit-count-bucket) features observed, computed as the sum of population counts (set bits) over the feedback's history map. Because the history map holds, per edge, the bitmask of all AFL hit-count buckets seen, each set bit is one feature. `coverageFeatures >= coverageEdges` (each nonzero edge contributes at least one bucket bit). This is libFuzzer's `ft` metric: features counted are those actually observed, not implicitly-crossed lower buckets.
- `execsPerSec` (number): Executions per second since Fuzzer creation (based on `totalExecs` only).

#### Scenario: Stats at creation

- **WHEN** `stats` is read immediately after Fuzzer creation
- **THEN** `totalExecs` is 0, `calibrationExecs` is 0, `corpusSize` is 0, `solutionCount` is 0,
  `coverageEdges` is 0, `coverageFeatures` is 0, and `execsPerSec` is 0

#### Scenario: Stats after fuzzing with stages

- **WHEN** 1000 main-loop iterations and 200 stage executions have been performed
- **THEN** `stats.totalExecs` equals 1200
- **AND** `stats.execsPerSec` reflects the combined throughput

#### Scenario: Calibration execs counted separately

- **WHEN** an interesting input triggers 3 calibration runs
- **THEN** `stats.calibrationExecs` increases by 3
- **AND** `stats.totalExecs` is unchanged by the calibration runs

#### Scenario: Features count distinct buckets seen per edge

- **WHEN** three edges have each been seen in exactly one bucket - hit counts observed at 1 (bucket `[1,1]`), 5 (bucket `[4,7]`), and 200 (bucket `[128,255]`)
- **THEN** `stats.coverageFeatures` equals 1 + 1 + 1 = 3 (one set bit per edge)
- **AND WHEN** one of those edges is later also seen at a second bucket
- **THEN** that edge contributes 2 features and `stats.coverageFeatures` increases by 1
