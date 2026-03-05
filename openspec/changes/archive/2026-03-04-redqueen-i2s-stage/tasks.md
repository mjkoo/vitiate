## 1. Async Target Test Coverage (prerequisite)

- [x] 1.1 Add async coverage + calibration test to `loop.test.ts`: async target that writes to coverage map after `await`, verify `callCount > runs` (calibration triggered by coverage feedback from async continuations). (Already implemented.)
- [x] 1.2 Add async coverage + timeout test to `loop.test.ts`: same as 1.1 but with `timeoutMs` configured, exercising the watchdog re-arm/await/disarm path during calibration. (Already implemented.)
- [x] 1.3 Run full test suite — confirm new async tests pass, establishing the baseline before rearchitecture. (Already passing.)

## 2. Shared Coverage Evaluation Helper (Rust refactor)

- [x] 2.1 Extract `evaluate_coverage()` private method from `report_result()` in `engine.rs`. The helper accepts parameters: `input: &[u8]`, `exec_time_ns: f64`, `exit_kind: ExitKind`, `parent_corpus_id: CorpusId`. It performs: mask unstable edges, construct observer, evaluate crash/timeout objective (using `exit_kind`), evaluate `MaxMapFeedback::is_interesting()`, add to corpus if interesting (with `SchedulerTestcaseMetadata` including depth from parent + 1, bitmap_size, n_fuzz_entry, handicap, cycle_and_time; call `scheduler.on_add()`), zero coverage map. Returns a result with three fields: `is_interesting: bool`, `is_solution: bool`, `corpus_id: Option<CorpusId>`. The `report_result()` caller uses `is_solution` to populate `IterationResult.solution`; the `advance_stage()` caller ignores it (always false for `ExitKind::Ok`).
- [x] 2.2 Refactor `report_result()` to call `evaluate_coverage()` (passing current input, exec_time_ns, exit_kind, and scheduled corpus entry as parent) instead of inline logic. Ensure all existing behavior is preserved: CmpLog drain, `CmpValuesMetadata` storage, token promotion, calibration state preparation, `last_interesting_corpus_id` storage, `total_execs`/`state.executions` increment.
- [x] 2.3 Run full test suite — confirm refactor is behavior-preserving (all existing tests pass).

## 3. Stage State Machine (Rust)

- [x] 3.1 Add `StageState` enum to `engine.rs` with variants `None` and `I2S { corpus_id: CorpusId, iteration: usize, max_iterations: usize }`. Add `stage_state: StageState` field to `Fuzzer`, initialized to `StageState::None`.
- [x] 3.2 Add `last_interesting_corpus_id: Option<CorpusId>` field to `Fuzzer`, initialized to `None`. Add `last_stage_input: Option<Vec<u8>>` field (or equivalent) for storing the most recently generated stage input so `advanceStage()` can add it to the corpus. Wire `report_result()` to set `last_interesting_corpus_id` when it returns `Interesting` (after calibration state is prepared).

## 4. Stage NAPI Methods (Rust)

- [x] 4.1 Implement `begin_stage()` NAPI method: check `StageState` is `None`, read and clear `last_interesting_corpus_id` (clear unconditionally after reading — consumed regardless of whether stage proceeds), check non-empty `CmpValuesMetadata`, select random iteration count 1-128, clone corpus entry, apply `I2SSpliceReplace` mutation, truncate to `max_input_len`, store mutated input in `last_stage_input`, transition to `StageState::I2S`, return `Buffer`. Return `null` if any precondition not met.
- [x] 4.2 Implement `advance_stage(exit_kind, exec_time_ns)` NAPI method: return `null` if no active stage; drain and discard CmpLog accumulator, call `evaluate_coverage()` (passing `last_stage_input`, exec_time_ns, ExitKind::Ok, StageState::I2S.corpus_id as parent), increment iteration and `total_execs`/`state.executions`, generate next I2S candidate (store in `last_stage_input`, truncate to `max_input_len`) or return `null` if exhausted.
- [x] 4.3 Implement `abort_stage(exit_kind)` NAPI method: no-op (no counter increment) if no active stage; otherwise drain and discard CmpLog, zero coverage map, increment `total_execs`/`state.executions`, reset `StageState` to `None`. Note: `solutionCount` is NOT incremented — stage crashes are handled at JS level.
- [x] 4.4 Update `vitiate-napi/index.d.ts` TypeScript type declarations for `beginStage()`, `advanceStage()`, and `abortStage()`.

## 5. Stage Execution Loop (TypeScript)

- [x] 5.1 Add stage execution loop in `loop.ts` after the calibration block (after `fuzzer.calibrateFinish()`). Only enter if calibration completed normally (not interrupted by crash/timeout). Call `fuzzer.beginStage()`, loop with target execution and `advanceStage()`, break on `null` return. Use the same three-branch target execution pattern as the main loop and calibration (watchdog sync, watchdog async with re-arm/await/disarm, no-watchdog direct call).
- [x] 5.2 Handle crash/timeout during stage: call `fuzzer.abortStage(exitKind)`, capture the stage input and error, break to the main loop's artifact-writing path (step 10). Stage crashes are NOT minimized — the raw stage input is written as the artifact. The loop terminates after writing the artifact.
- [x] 5.3 Stash stage inputs to shmem (`shmemHandle?.stashInput(stageInput)`) before each stage execution.

## 6. Tests

- [x] 6.1 Add unit test: I2S stage runs after interesting input with CmpLog data — verify `beginStage()` returns non-null, stage loop executes, `callCount > runs + stage_iterations`.
- [x] 6.2 Add unit test: stage skipped when no CmpLog data — target that writes coverage but no `trace_cmp` calls, verify `beginStage()` returns `null`, `callCount` matches expected (runs + calibration only).
- [x] 6.3 Add unit test: crash during stage execution — target that crashes on specific I2S-mutated input, verify crash artifact written with the stage input (without minimization), fuzz campaign terminates.
- [x] 6.4 Add unit test: async target in stage execution — async target with coverage after `await`, verify stage executes correctly with async targets.
- [x] 6.5 Add unit test: timeout during stage execution — target that times out on I2S-mutated input, verify timeout artifact written with the stage input, fuzz campaign terminates.
- [x] 6.6 Add unit test: `totalExecs` includes stage executions — run fuzz loop, trigger I2S stage, verify `stats.totalExecs` counts main-loop + calibration + stage iterations. Also verify that if a stage is aborted (crash/timeout), the aborted execution is counted in `totalExecs`.
- [x] 6.7 Add unit test: corpus growth during stage without calibration — target where stage-mutated input hits new coverage, verify corpus grows but `callCount` does not include extra calibration runs for the stage-discovered entry.
- [x] 6.8 Add unit test: `beginStage()` returns `null` without preceding calibration — call `beginStage()` before any interesting input, verify it returns `null`.
- [x] 6.9 Add unit test: stage without watchdog — run stage execution with no `timeoutMs` configured, verify stage completes normally using direct target calls.
- [x] 6.10 Add Rust unit test: `beginStage()` returns `null` during active stage — start a stage, call `beginStage()` again without completing/aborting, verify it returns `null` and the active stage is unaffected.
- [x] 6.11 Add Rust unit test: `advanceStage()` returns `null` with no active stage — call `advanceStage(ExitKind::Ok, 0)` without a preceding `beginStage()`, verify it returns `null` with no side effects.
- [x] 6.12 Add Rust unit test: single-iteration stage — seed the RNG to force `max_iterations = 1`, verify first `advanceStage()` returns `null` (stage complete after one execution).
- [x] 6.13 Add Rust unit test: CmpLog drained and discarded during stage — verify that `CmpValuesMetadata` is not overwritten by CmpLog data from stage executions, and token promotion does not occur during stage.
- [x] 6.14 Add Rust unit test: non-cumulative mutations — verify each stage iteration clones the original corpus entry (not the previous iteration's mutated output). Can check by verifying mutation inputs match the original entry's bytes.
- [x] 6.15 Add Rust unit test: `abortStage` no-op with no active stage — call `abortStage(ExitKind::Crash)` without a preceding `beginStage()`, verify `total_execs` and `state.executions` are unchanged and no error is raised.
- [x] 6.16 Add integration test: calibration crash prevents stage loop — target that crashes during calibration re-runs, verify `beginStage()` is never called and the fuzz loop continues to the next iteration (or terminates per base calibration spec).
- [x] 6.17 Run full test suite including existing fuzz-pipeline integration tests — confirm no regressions.

## 7. Cleanup

- [x] 7.1 Run all lints: eslint, clippy, prettier, cargo fmt, cargo deny, cargo msrv. Fix any issues.
- [x] 7.2 Verify `lefthook` pre-commit hooks pass.
