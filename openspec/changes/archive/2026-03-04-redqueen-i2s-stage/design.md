## Context

Vitiate's fuzz engine (`vitiate-napi/src/engine.rs`) currently exposes a stateless request-response protocol to JavaScript: `getNextInput()` returns a mutated buffer, the JS fuzz loop (`vitiate/src/loop.ts`) executes the target, and `reportResult()` evaluates coverage. I2S mutations happen inline in `getNextInput()` - one attempt per iteration on a randomly-selected corpus entry. The only multi-execution pattern is calibration (`calibrateRun`/`calibrateFinish`), which re-runs the same input 4-8 times to measure timing and detect unstable edges.

libafl_libfuzzer runs a formal I2S mutational stage after calibration: 1-128 concentrated I2S mutations on the freshly-traced corpus entry, each evaluated for new coverage. This targeted approach is significantly more effective because the CmpLog data was collected from _this_ entry, so operand matches are likely present in _this_ entry's bytes.

The design extends the calibration polling pattern into a general-purpose stage protocol. REDQUEEN.md (Option A) provides the full architectural analysis and rationale for this approach over alternatives (NAPI callback, batch generation, hybrid primitive).

## Goals / Non-Goals

**Goals:**
- Concentrated I2S effort: 1-128 targeted I2S mutations per interesting corpus entry, matching libafl_libfuzzer's `StdMutationalStage<I2SRandReplace>` behavior.
- Reuse existing `I2SSpliceReplace` and `I2SRandReplace` mutators directly - no new mutation algorithms.
- Seamless async target support in stage execution, using the same watchdog/re-arm/await/disarm pattern as the main loop and calibration.
- Extensible stage protocol that future stages (Grimoire, Generalization) can plug into without JS-side changes.
- No breaking changes to the existing `getNextInput()`/`reportResult()` protocol.

**Non-Goals:**
- Grimoire mutational stages or GeneralizationStage (Phase 2, separate change).
- Rust-driven execution via NAPI callback (Option B/D from REDQUEEN.md - possible Phase 3 optimization).
- Calibration of inputs discovered during stage execution (deferred to the main loop - see Decision 4).
- Changing how CmpLog data is collected (still piggybacks on every execution via the SWC plugin; no separate ShadowTracingStage needed).

## Decisions

### Decision 1: JS-driven stage protocol (Option A)

**Choice:** Add `beginStage()`/`advanceStage()`/`abortStage()` NAPI methods. JS drives target execution in a loop; Rust generates inputs and evaluates coverage.

**Alternatives considered:**
- *Option B (NAPI callback)*: Rust calls the target directly via `napi_call_function` in a loop. More natural for imperative stage code, but cannot `await` Promises from async targets. Would require a sync-only restriction or a fallback path, defeating the purpose.
- *Option D (Hybrid primitive)*: Factor out `execute_and_evaluate` as a Rust-internal primitive. Same async limitation as Option B, plus larger refactoring scope.
- *Option C (Batch)*: Generate all candidates upfront, execute in JS, evaluate in bulk. Not viable because coverage evaluation must happen between executions (the map is shared and must be zeroed between runs).

**Rationale:** Option A is the lowest-risk approach. It extends the proven calibration pattern, preserves async target support natively, and the "state machine" overhead is minimal - the I2S stage is a simple counted loop, not a complex interactive protocol.

### Decision 2: Stage state machine as a `StageState` enum

**Choice:** Add a `StageState` enum to `Fuzzer` with variants `None` and `I2S { corpus_id, iteration, max_iterations }`.

`beginStage()` transitions from `None` to `I2S { ... }`. `advanceStage()` increments `iteration` and returns the next mutated input, or transitions to `None` (returning `null` to JS) when `iteration >= max_iterations`. `abortStage()` transitions to `None` unconditionally.

**Rationale:** This mirrors the calibration state fields (`calibration_corpus_id`, `calibration_iterations`, etc.) but uses an enum to cleanly support future stage variants (Generalization, Grimoire) without proliferating `Option` fields.

### Decision 3: Factor coverage evaluation into a shared helper

**Choice:** Extract the coverage evaluation logic from `report_result()` into a private `evaluate_coverage()` method. Both `report_result()` and `advance_stage()` call this helper.

The shared helper performs:
1. Mask unstable edges.
2. Construct observer from `map_ptr`.
3. Evaluate crash/timeout objective.
4. Evaluate `MaxMapFeedback::is_interesting()`.
5. If interesting: add to corpus with `SchedulerTestcaseMetadata`, call `scheduler.on_add()`.
6. Zero coverage map.
7. Return whether the input was interesting (and the `CorpusId` if added).

`report_result()` additionally: drains CmpLog, promotes tokens, prepares calibration state, increments `total_execs`.

`advance_stage()` additionally: drains and discards CmpLog entries (see Decision 6), increments `total_execs`, generates the next stage candidate.

**Rationale:** The map-read → feedback-evaluate → map-zero sequence is identical. Duplicating it would be error-prone (any future change to feedback evaluation would need to be mirrored in two places).

### Decision 4: Inputs found interesting during a stage skip calibration

**Choice:** When `evaluate_coverage()` returns interesting during a stage execution, the input is added to the corpus with nominal metadata (same as seeds: depth from parent, `exec_time` from the single execution, no multi-run calibration). Calibration for these entries is deferred - they will be calibrated when they are selected by the scheduler in a future main-loop iteration and trigger `Interesting` again, or they can be calibrated in a future enhancement.

**Alternative considered:** Run calibration inline during the stage (nested calibration loop inside the stage loop). This would be correct but adds complexity: the stage would need to pause, run 4-8 calibration executions for the new entry, then resume I2S iterations. Since calibration is primarily about timing accuracy and unstable edge detection (not correctness), deferring it is acceptable.

**Rationale:** Simplicity. The I2S stage's purpose is to find new coverage, not to produce perfectly-calibrated corpus entries. Entries found during the stage are added with their single-execution timing data, which is sufficient for the scheduler to score them. If they trigger `Interesting` again in the main loop (which they will if they have genuinely novel coverage), full calibration runs then.

### Decision 5: Stage iteration count (1-128, randomly chosen)

**Choice:** `beginStage()` selects `max_iterations = state.rand_mut().below(128) + 1`, matching libafl_libfuzzer's `StdMutationalStage` default iteration count formula.

**Rationale:** Direct parity with libafl_libfuzzer. The iteration count determines how much effort is spent on I2S mutations per corpus entry. A random count between 1 and 128 balances exploration breadth (try many entries) with exploitation depth (try many mutations per entry).

### Decision 6: CmpLog accumulator is drained and discarded during stage executions

**Choice:** In `advance_stage()`, drain the CmpLog accumulator and discard the entries. Do not update `CmpValuesMetadata` or promote tokens.

**Rationale:** CmpLog data from stage executions comes from I2S-mutated inputs - the operands observed are artifacts of the mutation, not structural properties of the original corpus entry. The I2S mutations for the current stage are driven by the CmpLog data collected during the _original_ execution (stored in `CmpValuesMetadata` by `report_result()`). Overwriting this with stage-execution CmpLog data would corrupt the mutation source. Token promotion is also skipped because stage inputs are synthetic variants, not representative of natural target behavior.

### Decision 7: `abortStage()` semantics on crash/timeout

**Choice:** When the target crashes or times out during a stage execution, JS calls `abortStage(exitKind)` and breaks out of the stage loop. `abortStage()`:
1. Drains and discards the CmpLog accumulator.
2. Zeroes the coverage map.
3. Resets `StageState` to `None`.
4. Does NOT evaluate coverage or add to corpus.

After `abortStage()`, the main loop handles the crash/timeout using its existing artifact-writing path. The crashing/timing-out input is available in JS (it was the `stageInput` passed to the target).

**Alternative considered:** Have `abortStage()` return the crash input so Rust can write the artifact. Rejected because the JS loop already has the input and the artifact-writing path is JS-side code.

**Rationale:** Stage abort is a clean reset. The crash/timeout during a stage is treated exactly like a crash/timeout during a normal iteration - the stage is simply abandoned and the main loop takes over. This keeps the crash-handling path unified.

### Decision 8: Stage inputs are stashed to shmem

**Choice:** The JS stage loop calls `shmemHandle?.stashInput(stageInput)` before each stage execution, identical to the main loop. This ensures the parent supervisor can recover the crashing input if the process dies during a stage execution (e.g., native addon SIGSEGV).

**Rationale:** Without stashing, a native crash during an I2S stage execution would be unrecoverable - the parent supervisor would read stale data from shmem (the main-loop input, not the stage input that caused the crash).

## Risks / Trade-offs

**[JS↔Rust round-trip overhead per stage execution]** → Each stage execution requires a `beginStage`/`advanceStage` NAPI call plus the target execution. For I2S (1-128 iterations of fast targets), this overhead is negligible compared to target execution time. If future stages run thousands of iterations on very fast targets, consider migrating to Option D (Rust-driven execution).

**[Uncalibrated stage-discovered inputs]** → Inputs found interesting during a stage have single-execution timing, not averaged calibration timing. This slightly reduces scheduler accuracy for these entries. Mitigation: these entries are re-calibrated when selected by the scheduler in a future iteration, or we can add a deferred calibration queue in a follow-up.

**[CmpLog data from the triggering iteration may be stale]** → The I2S stage uses `CmpValuesMetadata` from the `report_result()` call that triggered `Interesting`. If the corpus entry was selected via the scheduler (not the most recently added), its CmpLog data may not match. However, this is the same data that was collected during the execution that produced the interesting coverage - it's the best CmpLog data available for this entry without a separate tracing stage. For most interesting inputs, the CmpLog data is fresh (collected in the same iteration).

**[Stage-discovered crash is not minimized inline]** → When a stage execution crashes, the stage aborts and the main loop writes the artifact. The main loop's minimization path runs for normal-iteration crashes but not for stage crashes (the stage input is a synthetic I2S variant, not the `last_input` from `getNextInput()`). This is acceptable for the MVP - stage-discovered crashes can be minimized in a follow-up or by re-running the artifact through the minimizer manually.

## Open Questions

None - all key decisions are resolved. The design follows Option A from REDQUEEN.md with the Phase 1 scope (I2S stage only).
