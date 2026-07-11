## MODIFIED Requirements

### Requirement: Shared coverage evaluation helper

The `Fuzzer` SHALL implement a private `evaluate_coverage()` method that encapsulates the coverage evaluation logic shared between `report_result()` and `advance_stage()`.

The helper SHALL accept the following parameters:
- `input: &[u8]` - the input bytes to store in the testcase if interesting.
- `exec_time_ns: f64` - execution time in nanoseconds for the testcase's `exec_time`.
- `exit_kind: ExitKind` - used for crash/timeout objective evaluation.
- `parent_corpus_id: CorpusId` - used to compute `depth` (parent's depth + 1).

The helper SHALL:

1. Classify the coverage map in place into AFL-style hit-count buckets before any feedback or novelty read. Each raw count SHALL be replaced by its bucket representative (`0 -> 0`, `1 -> 1`, `2 -> 2`, `3 -> 3`, `4-7 -> 4`, `8-15 -> 8`, `16-31 -> 16`, `32-127 -> 32`, `128-255 -> 128`). The representative SHALL be a fixed point of the display bucket index, so a history map storing classified values yields the same `ft` feature count as one storing raw counts. Nonzero counts SHALL remain nonzero so that `bitmap_size` and `MapIndexesMetadata` are unaffected. Because admission keys on the classified map, `MaxMapFeedback` admits an input when it reaches a new (edge, hit-count-bucket), not merely a new raw per-edge maximum.
2. Mask unstable edges (zero coverage map entries at indices in the unstable entries set).
3. Construct a `StdMapObserver` from `map_ptr`.
4. Evaluate crash/timeout objective (`CrashFeedback`, `TimeoutFeedback`) using `exit_kind`. For `ExitKind::Ok` (the only value used by `advance_stage()`), objective evaluation will return "not a solution" - this is expected and the evaluation is still performed for uniformity.
5. Evaluate coverage feedback (`MaxMapFeedback::is_interesting()`). During the coverage map iteration that computes `MapNoveltiesMetadata`, also collect the indices of all nonzero entries into `MapIndexesMetadata`.
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

#### Scenario: Admission keys on hit-count bucket, not raw maximum

- **WHEN** an edge's history holds a count in the bucket `[4,7]` (e.g. a classified value of 4)
- **AND** a later execution produces a raw count of 5 at that edge (still bucket `[4,7]`) with no other new coverage
- **THEN** the input SHALL NOT be interesting (same hit-count bucket)
- **AND WHEN** a later execution instead produces a raw count of 8 (bucket `[8,15]`)
- **THEN** the input SHALL be interesting (a new hit-count bucket)

#### Scenario: Classification preserves bitmap_size and ft

- **WHEN** `evaluate_coverage()` classifies the coverage map
- **THEN** the number of nonzero entries (and thus `bitmap_size` and `MapIndexesMetadata`) SHALL be unchanged from the raw map
- **AND** `compute_coverage_features()` over the classified history SHALL yield the same `ft` as over the equivalent raw history

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
