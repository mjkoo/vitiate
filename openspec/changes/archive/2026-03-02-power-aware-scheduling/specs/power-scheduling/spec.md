## ADDED Requirements

### Requirement: Power-aware corpus scoring

The scheduler SHALL weight corpus entry selection using `CorpusPowerTestcaseScore` (from LibAFL) instead of uniform weighting. The scoring algorithm SHALL consider the following factors for each corpus entry:

- **Execution speed**: Entries faster than the global average SHALL receive higher scores (up to 3x boost). Entries slower than average SHALL be penalized (down to 0.1x).
- **Coverage size**: Entries with larger bitmap sizes relative to the global average SHALL receive higher scores (up to 3x boost).
- **Mutation depth**: Deeper entries (more parent-child hops from the original seed) SHALL receive higher scores, up to 5x at depth 25+.
- **Handicap**: Entries added when `queue_cycles` is high (i.e., added recently relative to the campaign's progress) SHALL receive a boost.
- **Fuzz count**: Entries that have been selected many times SHALL be deprioritized using the FAST schedule (logarithmic decay based on path frequency).

The scheduler SHALL use `PowerSchedule::fast()` exclusively. There SHALL be no user-configurable schedule strategy.

The `ProbabilitySamplingScheduler` SHALL remain the scheduler implementation — only the `TestcaseScore` type parameter changes from `UniformScore` to `CorpusPowerTestcaseScore`.

#### Scenario: Fast entry selected more frequently

- **WHEN** the corpus contains entry A (calibrated avg exec time 100us) and entry B (calibrated avg exec time 1ms), both with equal coverage and depth
- **THEN** over many selections, entry A SHALL be selected significantly more often than entry B

#### Scenario: High-coverage entry selected more frequently

- **WHEN** the corpus contains entry A (bitmap size 500) and entry B (bitmap size 50), both with equal exec time and depth
- **THEN** over many selections, entry A SHALL be selected significantly more often than entry B

#### Scenario: Deep entry boosted

- **WHEN** the corpus contains entry A (depth 0) and entry B (depth 20), both with equal exec time and coverage
- **THEN** over many selections, entry B SHALL be selected more often than entry A

#### Scenario: Frequently-fuzzed entry deprioritized

- **WHEN** entry A has been selected 1000 times and entry B has been selected 10 times, both otherwise equal
- **THEN** entry B SHALL be selected more often than entry A in subsequent iterations

### Requirement: Scheduler metadata lifecycle

The engine SHALL initialize `SchedulerMetadata` with `PowerSchedule::fast()` during `Fuzzer` construction. This metadata SHALL track:

- `exec_time`: Running total of calibrated execution times across all corpus entries.
- `cycles`: Running total of calibration iterations across all entries.
- `bitmap_size`: Running total of bitmap sizes across all entries.
- `bitmap_size_log`: Running total of log2(bitmap_size) across all entries.
- `bitmap_entries`: Count of calibrated corpus entries.
- `queue_cycles`: Number of complete passes through the corpus.
- `n_fuzz`: Path frequency array (`Vec<u32>` with 2^21 entries) for tracking how often each path has been fuzzed.

Global averages (used by `CorpusPowerTestcaseScore`) are derived from these running totals: `avg_exec_time = exec_time / cycles`, `avg_bitmap_size = bitmap_size / bitmap_entries`.

`calibrateFinish()` SHALL update these running totals with the calibrated entry's values. The totals SHALL only reflect calibrated data — preliminary values from `reportResult()` SHALL NOT be added to the global metadata.

#### Scenario: Metadata present after construction

- **WHEN** a Fuzzer is constructed
- **THEN** `SchedulerMetadata` SHALL exist on the fuzzer state with `PowerSchedule::fast()`
- **AND** all counters SHALL be zero
- **AND** `n_fuzz` SHALL be allocated with 2^21 entries

#### Scenario: Global totals updated after calibration

- **WHEN** `calibrateFinish()` completes for an entry with total_time=400us over 4 runs and bitmap_size=150
- **THEN** `SchedulerMetadata.exec_time` SHALL increase by 400us
- **AND** `SchedulerMetadata.cycles` SHALL increase by 4
- **AND** `SchedulerMetadata.bitmap_size` SHALL increase by 150
- **AND** `SchedulerMetadata.bitmap_entries` SHALL increase by 1

### Requirement: Per-testcase scheduler metadata

When `reportResult()` adds a new corpus entry (returns `Interesting`), the engine SHALL create `SchedulerTestcaseMetadata` for the entry with the following preliminary values:

- `depth`: Parent entry's depth + 1, or 0 if no parent exists.
- `bitmap_size`: Number of nonzero bytes in the coverage map at the time of evaluation.
- `n_fuzz_entry`: Corpus ID mapped to an index in the `n_fuzz` frequency array (via modular arithmetic).
- `handicap`: Current `queue_cycles` from global `SchedulerMetadata`.
- `cycle_and_time`: Tuple of (exec_time from the single iteration, 1).

These values are preliminary. `calibrateFinish()` SHALL update `cycle_and_time` and the testcase's `exec_time` with averaged calibration measurements. `bitmap_size`, `depth`, `n_fuzz_entry`, and `handicap` are final at creation time.

#### Scenario: Metadata populated on interesting input

- **WHEN** `reportResult()` returns `Interesting`
- **THEN** the new corpus entry SHALL have `SchedulerTestcaseMetadata` with depth, bitmap_size, n_fuzz_entry, handicap, and cycle_and_time populated

#### Scenario: Depth increments from parent

- **WHEN** `getNextInput()` selects a corpus entry at depth 3
- **AND** the subsequent `reportResult()` returns `Interesting`
- **THEN** the new corpus entry's depth SHALL be 4

#### Scenario: Root entry has depth zero

- **WHEN** `reportResult()` adds a corpus entry with no parent (first interesting input, or parent lookup fails)
- **THEN** the new corpus entry's depth SHALL be 0

#### Scenario: Calibration updates preliminary metadata

- **WHEN** `reportResult()` sets preliminary cycle_and_time to (500us, 1)
- **AND** calibration completes with total_time=2ms over 4 runs
- **THEN** cycle_and_time SHALL be updated to (2ms, 4)
- **AND** exec_time SHALL be updated to 500us (2ms / 4)

### Requirement: Calibration protocol

When `reportResult()` returns `Interesting`, the system SHALL support a calibration loop that re-runs the input to measure averaged execution time and detect unstable coverage edges.

The protocol SHALL work as follows:

1. The original fuzz iteration counts as calibration run #1. Its execution time is included in the calibration total. The coverage map is zeroed by `reportResult()` before returning.
2. JS re-runs the target via the watchdog (or direct call) and calls `calibrateRun(execTimeNs)` after each re-execution. Rust reads the coverage map, accumulates timing, compares the map against the first calibration run's baseline, detects unstable edges, and zeroes the map.
3. `calibrateRun()` SHALL return `true` if more runs are needed, `false` if calibration is complete.
4. The minimum total run count SHALL be 4 (`CAL_STAGE_START`). If unstable edges are detected during any run, the total SHALL extend to 8 (`CAL_STAGE_MAX`).
5. After the calibration loop completes (or is interrupted by crash/timeout), JS SHALL call `calibrateFinish()` to finalize metadata and merge unstable edges.

The first `calibrateRun()` call SHALL capture the coverage map as the baseline snapshot. Subsequent calls SHALL compare against this baseline.

#### Scenario: Minimum calibration runs without instability

- **WHEN** `reportResult()` returns `Interesting` and no unstable edges are detected during calibration
- **THEN** 3 additional calibration runs SHALL be performed (4 total including original)
- **AND** `calibrateRun()` SHALL return `false` after the 3rd additional run

#### Scenario: Extended calibration for unstable edges

- **WHEN** unstable edges are detected during a calibration run
- **THEN** calibration SHALL extend to a total of 8 runs
- **AND** `calibrateRun()` SHALL return `true` until the 7th additional run completes

#### Scenario: Calibration interrupted by crash

- **WHEN** the target crashes during a calibration run
- **THEN** JS SHALL break out of the calibration loop
- **AND** `calibrateFinish()` SHALL be called with partial data
- **AND** the entry SHALL remain in the corpus with metadata derived from the completed runs
- **AND** the entry SHALL participate in scheduling with its partial calibration scores

#### Scenario: Calibration interrupted by timeout

- **WHEN** the target times out during a calibration run
- **THEN** JS SHALL break out of the calibration loop
- **AND** `calibrateFinish()` SHALL be called with partial data
- **AND** the entry SHALL remain in the corpus with metadata derived from the completed runs
- **AND** the entry SHALL participate in scheduling with its partial calibration scores

#### Scenario: Averaged timing replaces single-shot

- **WHEN** calibration completes with 4 runs totaling 2ms
- **THEN** the corpus entry's `exec_time` SHALL be 500us (2ms / 4)
- **AND** `cycle_and_time` SHALL be (2ms, 4)

#### Scenario: Calibration re-scores entry

- **WHEN** `calibrateFinish()` completes
- **THEN** the scheduler SHALL re-score the entry using the calibrated metadata
- **AND** subsequent `getNextInput()` calls SHALL use the updated score for selection probability

### Requirement: Unstable edge detection

During calibration, each run's coverage map SHALL be compared against the first calibration run's coverage map (the baseline). Any coverage map index where the value differs between the baseline and a subsequent run SHALL be recorded as unstable.

The set of unstable indices discovered during a single entry's calibration SHALL be merged into the global the fuzzer's unstable entries set when `calibrateFinish()` is called. The unstable set SHALL only grow — edges SHALL never be removed from it.

#### Scenario: Stable edges not flagged

- **WHEN** all calibration runs produce identical coverage maps
- **THEN** no new unstable edges SHALL be recorded
- **AND** `calibrateRun()` SHALL NOT extend the run count beyond 4

#### Scenario: Flaky edge detected

- **WHEN** coverage map index 42 has value 1 in the first calibration run and value 0 in a subsequent run
- **THEN** index 42 SHALL be added to the fuzzer's unstable entries set
- **AND** `calibrateRun()` SHALL return `true` to extend calibration to 8 total runs

#### Scenario: Unstable edges accumulate across entries

- **WHEN** entry A's calibration detects unstable edges at indices {42, 100}
- **AND** entry B's calibration later detects unstable edges at indices {100, 200}
- **THEN** the global the fuzzer's unstable entries set SHALL contain {42, 100, 200}

#### Scenario: Unstable edges are never removed

- **WHEN** an edge index has been recorded as unstable
- **THEN** it SHALL remain in the fuzzer's unstable entries set for the lifetime of the fuzzer
- **AND** there SHALL be no mechanism to remove entries from the unstable set

### Requirement: Unstable edge masking

Before evaluating `feedback.is_interesting()` in `reportResult()`, the engine SHALL zero out coverage map entries at all indices present in the fuzzer's unstable entries set. This SHALL be the first operation in `reportResult()`, before observer construction, so that the observer and feedback never see values at unstable edge indices.

If no the fuzzer's unstable entries set exists on the state (no calibration has completed yet), masking SHALL be skipped and all coverage map entries SHALL be evaluated normally.

#### Scenario: Unstable edge masked during feedback

- **WHEN** the fuzzer's unstable entries set contains index 42
- **AND** the coverage map has a nonzero value at index 42 and no other new coverage
- **AND** `reportResult()` is called
- **THEN** the input SHALL NOT be considered interesting
- **AND** the corpus size SHALL NOT increase

#### Scenario: Stable edges unaffected by masking

- **WHEN** the fuzzer's unstable entries set contains index 42
- **AND** the coverage map has new coverage at index 99 (not in the unstable set)
- **AND** `reportResult()` is called
- **THEN** the input SHALL be considered interesting based on the stable edge at index 99

#### Scenario: No masking without unstable metadata

- **WHEN** no the fuzzer's unstable entries set exists on the state
- **AND** `reportResult()` is called
- **THEN** all coverage map entries SHALL be evaluated normally with no masking applied

#### Scenario: Masking occurs before observer construction

- **WHEN** the fuzzer's unstable entries set contains unstable indices
- **AND** `reportResult()` is called
- **THEN** the coverage map SHALL be modified (unstable entries zeroed) before the observer reads it
- **AND** the observer SHALL see zero at all unstable indices regardless of the target's actual coverage

### Requirement: Mutation depth tracking

The engine SHALL track the corpus ID selected by `getNextInput()` as the "last corpus ID" (parent for the next iteration). When `reportResult()` adds a new corpus entry, the entry's depth SHALL be computed as:

- If `last_corpus_id` is set and the parent entry has `SchedulerTestcaseMetadata`: parent's depth + 1.
- Otherwise: 0.

#### Scenario: Depth chain across mutations

- **WHEN** a seed entry has depth 0
- **AND** a mutation of that seed discovers new coverage (added at depth 1)
- **AND** a mutation of that depth-1 entry discovers new coverage (added at depth 2)
- **THEN** the three entries SHALL have depths 0, 1, and 2 respectively

#### Scenario: Parent without metadata defaults to zero

- **WHEN** `last_corpus_id` points to a corpus entry that lacks `SchedulerTestcaseMetadata`
- **THEN** the child entry's depth SHALL be 0

### Requirement: Seed scheduler metadata

All seeds — both explicit seeds added via `addSeed()` and auto-seeds added on empty corpus — SHALL receive `SchedulerTestcaseMetadata` with:

- `depth`: 0
- `exec_time`: 1ms (nominal value)
- `cycle_and_time`: (1ms, 1)

Seeds SHALL NOT be calibrated. Their nominal metadata allows `CorpusPowerTestcaseScore` to compute a score without erroring on missing `exec_time`. The values will be inaccurate until the entries are replaced by discovered inputs with calibrated measurements.

The metadata SHALL be added in `addSeed()` so that all code paths that add seeds to the corpus produce entries with valid scheduler metadata.

#### Scenario: Explicit seed has scheduler metadata

- **WHEN** `addSeed(input)` is called to add an explicit seed
- **THEN** the seed entry SHALL have `SchedulerTestcaseMetadata` with depth 0
- **AND** the seed's `exec_time` SHALL be 1ms

#### Scenario: Auto-seed has scheduler metadata

- **WHEN** auto-seeding triggers on an empty corpus
- **THEN** each auto-seed entry SHALL have `SchedulerTestcaseMetadata` with depth 0
- **AND** each auto-seed's `exec_time` SHALL be 1ms

#### Scenario: Seeds participate in power scoring

- **WHEN** seeds (explicit or auto) are in the corpus alongside calibrated entries
- **THEN** seeds SHALL be selectable by the scheduler
- **AND** their selection probability SHALL be determined by `CorpusPowerTestcaseScore` using their nominal metadata
