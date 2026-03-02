## 1. Rust Foundation

- [x] 1.1 Add imports for `CorpusPowerTestcaseScore`, `SchedulerMetadata`, `SchedulerTestcaseMetadata`, `UnstableEntriesMetadata`, `PowerSchedule`, and `CorpusId` to `engine.rs`
- [x] 1.2 Change the `FuzzerScheduler` type alias from `ProbabilitySamplingScheduler<UniformScore>` to `ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>` and remove the `UniformScore` implementation
- [x] 1.3 Add new fields to the `Fuzzer` struct: `last_corpus_id: Option<CorpusId>`, and calibration state fields (`cal_corpus_id`, `cal_first_map`, `cal_history_map`, `cal_total_time`, `cal_iterations`, `cal_has_unstable`)
- [x] 1.4 Initialize `SchedulerMetadata` with `PowerSchedule::fast()` in `Fuzzer::new()` via `state.add_metadata()`
- [x] 1.5 Initialize all new Fuzzer fields to their default/None values in `Fuzzer::new()`

## 2. Depth Tracking & Parent Stashing

- [x] 2.1 Write tests for depth tracking: depth increments from parent, root entry has depth zero, parent without metadata defaults to zero
- [x] 2.2 In `get_next_input()`, stash the selected corpus ID into `self.last_corpus_id` after `scheduler.next()`
- [x] 2.3 In `report_result()` interesting path, compute depth from `self.last_corpus_id` by reading the parent's `SchedulerTestcaseMetadata`

## 3. Unstable Edge Masking

- [x] 3.1 Write tests for unstable edge masking: unstable edge masked during feedback (not interesting), stable edges unaffected, no masking without metadata
- [x] 3.2 Add unstable edge masking as the first operation in `report_result()`: if `UnstableEntriesMetadata` exists, zero coverage map entries at unstable indices before observer construction

## 4. reportResult Signature & Metadata Population

- [x] 4.1 Change `report_result()` signature to accept `exec_time_ns: f64` as a second parameter (breaking change)
- [x] 4.2 Update all existing callers of `report_result()` in Rust tests to pass `exec_time_ns`
- [x] 4.3 Write tests for per-testcase metadata population: metadata fields set on interesting input, preliminary exec_time set from the passed value
- [x] 4.4 In the `report_result()` interesting path: set `testcase.exec_time`, create `SchedulerTestcaseMetadata` (depth, bitmap_size, n_fuzz_entry, handicap, cycle_and_time), add metadata to testcase
- [x] 4.5 Prepare calibration state after adding a new corpus entry: set `cal_corpus_id`, `cal_total_time` (including original exec time), `cal_iterations = 1`, clear map/history fields

## 5. Seed Scheduler Metadata

- [x] 5.1 Write tests for seed metadata: explicit seeds via `addSeed()` have `SchedulerTestcaseMetadata` with depth 0 and nominal 1ms exec_time
- [x] 5.2 In `addSeed()`, add `SchedulerTestcaseMetadata` (depth 0) and set `exec_time` to 1ms for each seed entry
- [x] 5.3 Write tests for auto-seed metadata: each auto-seed has `SchedulerTestcaseMetadata` with depth 0 and nominal 1ms exec_time
- [x] 5.4 If auto-seeds bypass `addSeed()` and add to corpus directly, add metadata explicitly in the auto-seed path

## 6. Calibration Methods

- [x] 6.1 Write tests for `calibrate_run()`: first call captures baseline, subsequent calls detect stable/unstable edges, returns true/false based on iteration count, extends to 8 runs on unstable detection
- [x] 6.2 Implement `calibrate_run(exec_time_ns: f64) -> bool` as a `#[napi]` method: accumulate timing, snapshot coverage map, compare against baseline, detect unstable edges, zero map, return whether more runs needed
- [x] 6.3 Write tests for `calibrate_finish()`: averaged exec_time set on testcase, global SchedulerMetadata updated, unstable edges merged, error on finish without pending calibration
- [x] 6.4 Implement `calibrate_finish()` as a `#[napi]` method: compute averaged timing, update testcase metadata, update global SchedulerMetadata totals, merge unstable edges into UnstableEntriesMetadata, re-score entry via `scheduler.on_replace()`, clear calibration state
- [x] 6.5 Write test for crash during calibration: partial data finalized correctly, entry remains in corpus with partial calibration metadata, participates in scheduling

## 7. TypeScript Fuzz Loop Changes

- [x] 7.1 Add execution timing measurement around target calls in the fuzz loop: `Number(process.hrtime.bigint())` before and after, compute elapsed nanoseconds
- [x] 7.2 Update `reportResult()` call to pass `execTimeNs` as the second argument
- [x] 7.3 Implement the calibration loop after `reportResult()` returns `Interesting`: re-run target via watchdog (or direct call), call `calibrateRun()`, loop while it returns true, break on crash/timeout, call `calibrateFinish()` after loop
- [x] 7.4 Handle async targets in the calibration loop: await Promise if target returns one, measure full async execution time

## 8. Scoring Verification

- [x] 8.1 Write test for power scoring affecting selection: two entries with different calibrated exec_times and bitmap_sizes, verify the faster/higher-coverage entry is selected more frequently over many iterations

## 9. Integration & Regression

- [x] 9.1 Write E2E test for calibration loop: verify the JS calibration loop executes after `reportResult()` returns `Interesting` and the entry's metadata is populated with calibrated values
- [x] 9.2 Run the full test suite and verify all existing tests pass with the new `reportResult()` signature
- [x] 9.3 Run lints and checks: eslint, clippy, prettier, cargo fmt, cargo deny, cargo autoinherit, cargo msrv
