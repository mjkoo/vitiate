## MODIFIED Requirements

_These requirements supersede the corresponding requirements in the baseline `stage-execution` spec. The full procedural steps are restated here - they replace (not extend) the baseline's numbered steps for each method._

### Requirement: Begin stage after calibration

The system SHALL provide `fuzzer.beginStage()` which initiates a stage execution pipeline for the most recently calibrated corpus entry. The method SHALL:

1. Check that `StageState` is `None` (no stage currently active). If a stage is in progress, return `null`.
2. Read `last_interesting_corpus_id`. If not set (no corpus entry was recently added via `reportResult()` returning `Interesting` with completed calibration), clear `last_interesting_corpus_id` and return `null`.
3. Clear `last_interesting_corpus_id` (set to `None`) unconditionally - the ID is consumed regardless of whether the stage proceeds.
4. Attempt to start the I2S stage: read `CmpValuesMetadata`. If non-empty, begin the I2S stage (unchanged behavior - select 1-128 iterations, clone entry, apply `I2SSpliceReplace`, transition to `StageState::I2S`).
5. If `CmpValuesMetadata` is empty (I2S skipped) AND Grimoire is enabled AND the input qualifies for generalization: begin the generalization stage directly (transition to `StageState::Generalization`).
6. If `CmpValuesMetadata` is empty (I2S skipped) AND Grimoire is enabled AND the input does NOT qualify for generalization BUT already has `GeneralizedInputMetadata`: begin the Grimoire stage directly (transition to `StageState::Grimoire`).
7. If none of the above can start: return `null`.

The pipeline ordering is: I2S → Generalization → Grimoire. `beginStage()` always attempts I2S first. If I2S is skipped and Grimoire is enabled, it falls through to generalization (or directly to Grimoire if the entry already has `GeneralizedInputMetadata`). Generalization and Grimoire transitions are also handled by `advanceStage()` when the preceding stage completes.

It SHALL be valid to call `beginStage()` only after `calibrateFinish()` has completed for the current interesting input. This is a protocol-level contract enforced by the JS fuzz loop's calling order (calibration always runs before `beginStage()`), not a Rust-side check - the Rust-side precondition checks are `StageState::None` and `last_interesting_corpus_id` being set.

#### Scenario: Stage begins with CmpLog data available

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** `CmpValuesMetadata` contains at least one entry
- **THEN** `beginStage()` SHALL return a non-null `Buffer` containing an I2S-mutated variant of the corpus entry
- **AND** `StageState` SHALL transition to `I2S`
- **AND** `last_interesting_corpus_id` SHALL be cleared

#### Scenario: Stage skipped when no CmpLog data and Grimoire disabled

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** `CmpValuesMetadata` is empty
- **AND** Grimoire is disabled
- **THEN** `beginStage()` SHALL return `null`
- **AND** `StageState` SHALL remain `None`
- **AND** `last_interesting_corpus_id` SHALL be cleared (consumed even though no stage runs)

#### Scenario: Generalization begins when I2S skipped and Grimoire enabled

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** `CmpValuesMetadata` is empty
- **AND** Grimoire is enabled
- **AND** the corpus entry qualifies for generalization (≤8192 bytes, has `MapNoveltiesMetadata`, not already generalized)
- **THEN** `beginStage()` SHALL return a non-null `Buffer` containing the original corpus entry (for verification)
- **AND** `StageState` SHALL transition to `Generalization`

#### Scenario: Grimoire begins when I2S skipped and entry already generalized

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** `CmpValuesMetadata` is empty
- **AND** Grimoire is enabled
- **AND** the corpus entry already has `GeneralizedInputMetadata` (does not qualify for generalization)
- **THEN** `beginStage()` SHALL return a non-null `Buffer` containing the first Grimoire-mutated input
- **AND** `StageState` SHALL transition to `Grimoire`

#### Scenario: beginStage called without pending calibration

- **WHEN** `beginStage()` is called without a preceding `Interesting` result and completed calibration
- **THEN** `beginStage()` SHALL return `null`

#### Scenario: beginStage called during active stage

- **WHEN** `beginStage()` is called while `StageState` is not `None` (any stage in progress)
- **THEN** `beginStage()` SHALL return `null`
- **AND** the active stage SHALL NOT be disrupted

#### Scenario: Mutated input respects max input length

- **WHEN** `beginStage()` generates an I2S-mutated input
- **AND** the mutated result exceeds `maxInputLen`
- **THEN** the returned buffer SHALL be truncated to `maxInputLen` bytes

#### Scenario: Iteration count is between 1 and 128

- **WHEN** `beginStage()` selects a random iteration count for I2S
- **THEN** `max_iterations` SHALL be between 1 and 128 inclusive

#### Scenario: I2SSpliceReplace mutation is a no-op

- **WHEN** `beginStage()` applies `I2SSpliceReplace` to the cloned corpus entry
- **AND** the mutation does not modify the input (e.g., no CmpLog operands match any bytes in the input)
- **THEN** `beginStage()` SHALL still return the (unmodified) input as a `Buffer`
- **AND** the stage SHALL proceed normally

### Requirement: Advance stage after each execution

The system SHALL provide `fuzzer.advanceStage(exitKind: ExitKind, execTimeNs: number)` which processes the result of a stage execution and returns the next candidate input. The method SHALL:

1. If `StageState` is `None` (no active stage), return `null` immediately.
2. Drain the CmpLog accumulator and discard all entries (do not update `CmpValuesMetadata` or promote tokens).
3. Process the execution result based on the current stage type:
   - **`StageState::I2S`**: Evaluate coverage. If iterations remain, generate next I2S mutation and return it. If iterations exhausted, transition to generalization (if Grimoire enabled and input qualifies), or to Grimoire (if Grimoire enabled and input already has `GeneralizedInputMetadata` but does not qualify for generalization), or to `None`.
   - **`StageState::Generalization`**: Check novelty survival in coverage map for generalization decisions. Generate next candidate or transition to Grimoire (if generalization succeeded) or `None`.
   - **`StageState::Grimoire`**: Evaluate coverage. If iterations remain, generate next Grimoire mutation and return it. If iterations exhausted, transition to `None`.
4. Increment `total_execs` and `state.executions`.
5. Zero the coverage map after processing (via the shared evaluation helper or explicitly for generalization verification).

The `exitKind` parameter SHALL only be `ExitKind.Ok` - crashes and timeouts are handled by `abortStage()`, not `advanceStage()`.

#### Scenario: I2S stage completes and transitions to generalization

- **WHEN** `advanceStage()` is called after the last I2S iteration
- **AND** Grimoire is enabled
- **AND** the corpus entry qualifies for generalization
- **THEN** `StageState` SHALL transition from `I2S` to `Generalization`
- **AND** the method SHALL return a non-null `Buffer` containing the original corpus entry (for verification)

#### Scenario: I2S stage completes and transitions to Grimoire (pre-existing metadata)

- **WHEN** `advanceStage()` is called after the last I2S iteration
- **AND** Grimoire is enabled
- **AND** the corpus entry does NOT qualify for generalization (e.g., already generalized)
- **AND** the testcase already has `GeneralizedInputMetadata`
- **THEN** `StageState` SHALL transition from `I2S` to `Grimoire`
- **AND** the method SHALL return a non-null `Buffer` containing the first Grimoire-mutated input

#### Scenario: I2S stage completes without Grimoire

- **WHEN** `advanceStage()` is called after the last I2S iteration
- **AND** Grimoire is disabled (or entry has no `GeneralizedInputMetadata` and doesn't qualify for generalization)
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`

#### Scenario: Generalization completes and transitions to Grimoire

- **WHEN** `advanceStage()` completes the last generalization phase
- **AND** `GeneralizedInputMetadata` was successfully produced
- **THEN** `StageState` SHALL transition from `Generalization` to `Grimoire`
- **AND** the method SHALL return a non-null `Buffer` containing the first Grimoire-mutated input

#### Scenario: Generalization fails and pipeline completes

- **WHEN** the verification phase fails (input unstable)
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`

#### Scenario: Grimoire stage completes

- **WHEN** `advanceStage()` is called after the last Grimoire iteration
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`

#### Scenario: Stage advances with more iterations remaining (I2S)

- **WHEN** `advanceStage(ExitKind.Ok, execTimeNs)` is called during I2S
- **AND** the current iteration is less than `max_iterations`
- **THEN** the method SHALL return a non-null `Buffer` containing the next I2S-mutated input
- **AND** the iteration counter SHALL increment by 1
- **AND** `total_execs` and `state.executions` SHALL each increment by 1

#### Scenario: New coverage during stage adds to corpus without calibration

- **WHEN** `advanceStage()` evaluates coverage and the input triggers new coverage
- **THEN** the internally-stashed input SHALL be added to the corpus with `SchedulerTestcaseMetadata`
- **AND** `scheduler.on_add()` SHALL be called for the new entry
- **AND** calibration state SHALL NOT be prepared (no `calibration_corpus_id` set)
- **AND** the stage SHALL continue with the next iteration (not interrupted)

#### Scenario: CmpLog accumulator drained and discarded during stage

- **WHEN** `advanceStage()` is called after a stage execution
- **THEN** the CmpLog accumulator SHALL be drained
- **AND** the drained entries SHALL be discarded (not stored in `CmpValuesMetadata`)
- **AND** token promotion SHALL NOT occur

#### Scenario: Coverage map zeroed between stage executions

- **WHEN** `advanceStage()` processes a stage execution result
- **THEN** the coverage map SHALL be zeroed after evaluation
- **AND** the next stage execution SHALL start with a clean coverage map

#### Scenario: advanceStage called with no active stage

- **WHEN** `advanceStage()` is called and `StageState` is `None`
- **THEN** the method SHALL return `null`
- **AND** no coverage evaluation SHALL occur

#### Scenario: advanceStage enforces max input length

- **WHEN** `advanceStage()` generates the next mutated input (I2S or Grimoire)
- **AND** the mutated result exceeds `maxInputLen`
- **THEN** the returned buffer SHALL be truncated to `maxInputLen` bytes

### Requirement: Abort stage on crash or timeout

The system SHALL provide `fuzzer.abortStage(exitKind: ExitKind)` which cleanly terminates the current stage without evaluating the final execution's coverage. The method SHALL:

1. Drain the CmpLog accumulator and discard all entries.
2. Zero the coverage map (may contain partial/corrupt data from the crashed execution).
3. Increment `total_execs` and `state.executions` (the aborted execution still counts as a target invocation).
4. Transition `StageState` to `None` (regardless of which stage variant was active - I2S, Generalization, or Grimoire).
5. NOT evaluate coverage or add the crashed/timed-out input to the corpus.
6. NOT add the crash/timeout to the solutions corpus - the crash artifact is written by the JS fuzz loop, but `solutionCount` is not incremented by `abortStage()`. This is intentional: stage-discovered crashes are handled at the JS level (artifact writing) rather than the Rust level (solutions tracking). The `solutionCount` stat only reflects crashes detected via `reportResult()`.

The `exitKind` parameter is accepted for interface consistency and potential future use (e.g., logging, metrics) but does not influence the current method's behavior.

After `abortStage()` returns, the crash/timeout input and error are available in the JS fuzz loop for artifact writing via the existing crash-handling path. Stage-discovered crashes are NOT minimized inline - the raw stage input is written as the artifact (see fuzz-loop spec for details). The aborted execution's timing is intentionally not reported since the execution was abnormal and the timing would not be meaningful for scheduling.

#### Scenario: Stage aborted during generalization

- **WHEN** the target crashes during a generalization stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition from `Generalization` to `None`
- **AND** no `GeneralizedInputMetadata` SHALL be stored
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed

#### Scenario: Stage aborted during Grimoire

- **WHEN** the target times out during a Grimoire stage execution
- **AND** `abortStage(ExitKind.Timeout)` is called
- **THEN** `StageState` SHALL transition from `Grimoire` to `None`
- **AND** the remaining Grimoire iterations SHALL be skipped

#### Scenario: Stage aborted on crash (I2S - unchanged)

- **WHEN** the target throws during an I2S stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition to `None`
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed
- **AND** `total_execs` and `state.executions` SHALL each increment by 1
- **AND** no corpus entry SHALL be added for the crashed execution
- **AND** `solutionCount` SHALL NOT be incremented

#### Scenario: abortStage is safe to call with no active stage

- **WHEN** `abortStage()` is called and `StageState` is already `None`
- **THEN** the method SHALL be a no-op (no error, no counter increments)

### Requirement: Stage state machine lifecycle

The `Fuzzer` SHALL maintain a `StageState` enum with the following variants:

- `None`: No stage is active. This is the initial state and the state after a stage completes or is aborted.
- `I2S { corpus_id: CorpusId, iteration: usize, max_iterations: usize }`: An I2S mutational stage is in progress.
- `Generalization { corpus_id: CorpusId, novelties: Vec<usize>, payload: Vec<Option<u8>>, phase: GeneralizationPhase, candidate_range: (usize, usize) }`: A generalization stage is in progress, analyzing the corpus entry for structural gaps.
- `Grimoire { corpus_id: CorpusId, iteration: usize, max_iterations: usize }`: A Grimoire mutational stage is in progress.

State transitions:
- `None` → `I2S`: Via `beginStage()` when CmpLog data is available.
- `None` → `Generalization`: Via `beginStage()` when I2S is skipped, Grimoire is enabled, and the input qualifies for generalization.
- `None` → `Grimoire`: Via `beginStage()` when I2S is skipped, Grimoire is enabled, and the input has pre-existing `GeneralizedInputMetadata` but does not qualify for generalization.
- `I2S` → `I2S`: Via `advanceStage()` when `iteration < max_iterations` (iteration incremented).
- `I2S` → `Generalization`: Via `advanceStage()` when I2S completes and Grimoire is enabled and input qualifies for generalization.
- `I2S` → `Grimoire`: Via `advanceStage()` when I2S completes and Grimoire is enabled and input has pre-existing `GeneralizedInputMetadata` but does not qualify for generalization.
- `I2S` → `None`: Via `advanceStage()` when I2S completes and Grimoire is disabled (or input has no `GeneralizedInputMetadata` and doesn't qualify for generalization).
- `Generalization` → `Generalization`: Via `advanceStage()` while gap-finding phases continue.
- `Generalization` → `Grimoire`: Via `advanceStage()` when generalization completes successfully.
- `Generalization` → `None`: Via `advanceStage()` when generalization fails (verification) or is abandoned.
- `Grimoire` → `Grimoire`: Via `advanceStage()` when `iteration < max_iterations`.
- `Grimoire` → `None`: Via `advanceStage()` when iterations exhausted.
- Any → `None`: Via `abortStage()`.

#### Scenario: Initial state is None

- **WHEN** a `Fuzzer` is constructed
- **THEN** `StageState` SHALL be `None`

#### Scenario: Full three-stage pipeline lifecycle

- **WHEN** `beginStage()` starts an I2S stage
- **AND** I2S completes and Grimoire is enabled
- **AND** generalization succeeds
- **AND** Grimoire completes
- **THEN** `StageState` transitions `None` → `I2S` → ... → `Generalization` → ... → `Grimoire` → ... → `None`

#### Scenario: I2S-to-Grimoire pipeline (pre-existing metadata)

- **WHEN** `beginStage()` starts an I2S stage
- **AND** I2S completes and Grimoire is enabled
- **AND** the corpus entry already has `GeneralizedInputMetadata` (generalization skipped)
- **THEN** `StageState` transitions `None` → `I2S` → ... → `Grimoire` → ... → `None`

#### Scenario: I2S-only pipeline (Grimoire disabled)

- **WHEN** `beginStage()` starts an I2S stage
- **AND** I2S completes
- **AND** Grimoire is disabled
- **THEN** `StageState` transitions `None` → `I2S` → ... → `None`

#### Scenario: Generalization-to-Grimoire without I2S

- **WHEN** `beginStage()` skips I2S (no CmpLog data)
- **AND** Grimoire is enabled and input qualifies
- **AND** generalization succeeds
- **THEN** `StageState` transitions `None` → `Generalization` → ... → `Grimoire` → ... → `None`

#### Scenario: Aborted generalization lifecycle

- **WHEN** `beginStage()` starts generalization
- **AND** the target crashes during a generalization execution
- **THEN** `StageState` transitions `None` → `Generalization` → `None` (abort)

### Requirement: I2S stage mutations use the original corpus entry

Each I2S stage iteration SHALL clone the original corpus entry (identified by `corpus_id` in `StageState::I2S`) and apply a fresh `I2SSpliceReplace` mutation. The mutations SHALL NOT be cumulative - each iteration starts from the unmodified corpus entry, not from the previous iteration's mutated output.

The `I2SSpliceReplace` mutator reads `CmpValuesMetadata` from the fuzzer state. Since `advanceStage()` does not update `CmpValuesMetadata` (it discards CmpLog entries), the mutations throughout the stage are driven by the CmpLog data from the original `reportResult()` call that triggered `Interesting`.

This requirement summarizes behavior already specified in the `beginStage()` and `advanceStage()` procedural steps. In case of conflict, the procedural steps govern.

#### Scenario: Each iteration mutates the original entry

- **WHEN** an I2S stage runs for 5 iterations
- **THEN** each iteration SHALL start with a fresh clone of the original corpus entry
- **AND** each iteration SHALL independently apply `I2SSpliceReplace` mutation
- **AND** mutations SHALL NOT accumulate across iterations

#### Scenario: Mutations driven by original CmpLog data

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("foo", "bar")` from the triggering execution
- **AND** the I2S stage runs multiple iterations
- **THEN** each iteration's `I2SSpliceReplace` mutation SHALL use the original `CmpValues::Bytes("foo", "bar")` data
- **AND** the metadata SHALL NOT be overwritten by CmpLog entries from stage executions

### Requirement: Stage execution increments total executions counter

Each stage execution SHALL increment both the `total_execs` counter on the Fuzzer and the `executions` counter on the fuzzer state. This ensures `fuzzer.stats.totalExecs` accurately reflects the total number of target invocations including stage executions. This applies to both `advanceStage()` (normal completion) and `abortStage()` (crash/timeout) calls. This applies to all stage types: I2S, Generalization, and Grimoire.

#### Scenario: Stats reflect stage executions

- **WHEN** the main loop runs 50 iterations and 3 of those trigger I2S stages with `max_iterations` averaging 64 each
- **THEN** `fuzzer.stats.totalExecs` SHALL equal `50 + (3 * 64)` = 242

#### Scenario: Aborted stage execution counted in stats

- **WHEN** an I2S stage runs for 5 iterations and the 6th execution crashes
- **AND** `abortStage()` is called
- **THEN** `total_execs` SHALL include all 6 executions (5 via `advanceStage()` + 1 via `abortStage()`)

#### Scenario: Generalization and Grimoire executions counted

- **WHEN** a pipeline runs I2S (64 iterations) + generalization (20 executions) + Grimoire (32 iterations)
- **THEN** `total_execs` SHALL increment by 116 for the stage pipeline
