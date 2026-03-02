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

On construction, the Fuzzer SHALL enable the CmpLog accumulator so that `traceCmp` calls
record comparison operands. The Fuzzer SHALL also initialize `CmpValuesMetadata` on the
fuzzer state and include `I2SRandReplace` in its mutation pipeline.

On construction, the Fuzzer SHALL initialize `SchedulerMetadata` with `PowerSchedule::fast()` on the fuzzer state. The scheduler SHALL use `CorpusPowerTestcaseScore` as its `TestcaseScore` implementation (replacing the prior `UniformScore`).

#### Scenario: Create with defaults

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** a Fuzzer instance is created with maxInputLen=4096 and a random seed, holding
  a reference to the provided coverage map
- **AND** the CmpLog accumulator is enabled
- **AND** `SchedulerMetadata` with `PowerSchedule::fast()` is present on the state

#### Scenario: Create with custom config

- **WHEN** `new Fuzzer(createCoverageMap(32768), { maxInputLen: 1024, seed: 42n })` is called
- **THEN** a Fuzzer instance is created with the specified configuration
- **AND** the CmpLog accumulator is enabled

#### Scenario: Reproducible with same seed

- **WHEN** two Fuzzer instances are created with the same seed and coverage maps of the
  same size, and the same sequence of addSeed/getNextInput/reportResult calls is performed
- **THEN** both instances SHALL produce identical mutation sequences

### Requirement: Add seed inputs

The system SHALL provide `fuzzer.addSeed(input: Buffer)` to add a seed input to the
corpus. Seeds serve as starting points for mutation.

Each seed added via `addSeed()` SHALL receive `SchedulerTestcaseMetadata` with depth 0, a nominal execution time of 1ms, and `cycle_and_time` of (1ms, 1). This ensures `CorpusPowerTestcaseScore` can compute a score for seeds without erroring on missing `exec_time`. Seeds SHALL NOT be calibrated.

#### Scenario: Add a seed

- **WHEN** `fuzzer.addSeed(Buffer.from("hello"))` is called
- **THEN** the corpus contains one entry and `getNextInput()` can produce mutations
  derived from it
- **AND** the entry SHALL have `SchedulerTestcaseMetadata` with depth 0 and exec_time of 1ms

#### Scenario: Add multiple seeds

- **WHEN** three different seeds are added via `addSeed()`
- **THEN** the corpus size is 3 and `getNextInput()` can produce mutations derived from
  any of them
- **AND** each entry SHALL have `SchedulerTestcaseMetadata` with depth 0 and exec_time of 1ms

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
flips, byte flips, arithmetic, block insert/delete/copy, splicing) applied to a corpus
entry selected by the scheduler, followed by `I2SRandReplace` which may replace byte
patterns matching recorded comparison operands.

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

#### Scenario: Selected corpus ID tracked for depth

- **WHEN** `getNextInput()` selects corpus entry with ID X
- **THEN** the Fuzzer's `last_corpus_id` SHALL be set to X
- **AND** a subsequent `reportResult()` that adds a new entry SHALL compute depth from entry X's metadata

### Requirement: Report execution result

The system SHALL provide `fuzzer.reportResult(exitKind: ExitKind, execTimeNs: number)` which:

1. Masks unstable edges: if the fuzzer's unstable entries set is non-empty, zero coverage map entries at all indices in the set. This SHALL be the first operation, before observer construction.
2. Reads coverage data from the stashed coverage map pointer via the observer.
3. Evaluates whether the input was interesting (new coverage) or a crash, updates the corpus accordingly.
4. If the input is interesting: sets the testcase's `exec_time` to `Duration::from_nanos(execTimeNs as u64)`, creates `SchedulerTestcaseMetadata` (depth, bitmap_size, n_fuzz_entry, handicap, cycle_and_time), adds the entry to the corpus, and prepares calibration state for subsequent `calibrateRun()` calls.
5. Zeroes the coverage map in place.
6. Drains the thread-local CmpLog accumulator and stores the resulting entries as `CmpValuesMetadata` on the fuzzer state.
7. Returns an `IterationResult`.

The `execTimeNs` parameter SHALL be the execution time of the target in nanoseconds, passed as `f64` (see Decision 6 in the design). This is a **breaking change** from the prior single-argument signature.

The `ExitKind` enum SHALL have values: `Ok` (0), `Crash` (1), `Timeout` (2).

The `IterationResult` object SHALL contain:

- `interesting` (boolean): Whether the input was added to the corpus.
- `solution` (boolean): Whether the input was a crash/timeout (added to solutions).

#### Scenario: New coverage is interesting

- **WHEN** the coverage map contains a byte pattern not seen in any previous iteration
  and `reportResult(ExitKind.Ok, execTimeNs)` is called
- **THEN** the result has `interesting: true` and the corpus size increases by one
- **AND** the new entry has `SchedulerTestcaseMetadata` populated
- **AND** calibration state is prepared for subsequent `calibrateRun()` calls

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

### Requirement: Fuzzer statistics

The system SHALL provide `fuzzer.stats` (getter) returning a `FuzzerStats` object with:

- `totalExecs` (bigint): Total number of `reportResult()` calls.
- `corpusSize` (number): Number of entries in the working corpus.
- `solutionCount` (number): Number of crash/timeout inputs found.
- `coverageEdges` (number): Number of distinct coverage map positions that have been
  observed nonzero across all iterations.
- `execsPerSec` (number): Executions per second since Fuzzer creation.

#### Scenario: Stats after fuzzing

- **WHEN** 1000 iterations of getNextInput/reportResult have been performed
- **THEN** `stats.totalExecs` equals 1000n, `stats.corpusSize` is at least 1,
  and `stats.execsPerSec` is greater than 0

#### Scenario: Stats at creation

- **WHEN** `stats` is read immediately after Fuzzer creation
- **THEN** `totalExecs` is 0n, `corpusSize` is 0, `solutionCount` is 0,
  `coverageEdges` is 0, and `execsPerSec` is 0

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
