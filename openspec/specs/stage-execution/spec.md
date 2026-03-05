## Purpose

Stage execution manages the I2S (Input-to-State) mutational stage that runs after calibration for interesting inputs. This capability defines the protocol for beginning, advancing, and aborting stages, the state machine lifecycle, mutation semantics, and execution counting.

## Requirements

### Requirement: Begin stage after calibration

The system SHALL provide `fuzzer.beginStage()` which initiates a stage execution pipeline for the most recently calibrated corpus entry. The method SHALL:

1. Check that `StageState` is `None` (no stage currently active). If a stage is in progress, return `null`.
2. Read `last_interesting_corpus_id`. If not set (no corpus entry was recently added via `reportResult()` returning `Interesting` with completed calibration), clear `last_interesting_corpus_id` and return `null`.
3. Clear `last_interesting_corpus_id` (set to `None`) unconditionally — the ID is consumed regardless of whether the stage proceeds.
4. Read the `CmpValuesMetadata` currently stored on the fuzzer state (populated by the preceding `reportResult()` call).
5. If `CmpValuesMetadata` is empty (no comparison data available, i.e., the vector contains zero `CmpValues` entries), return `null` immediately — no stage executions are needed.
6. Select a random iteration count between 1 and 128 inclusive (`state.rand_mut().below(128) + 1`).
7. Clone the corpus entry identified by the consumed corpus ID (the entry that triggered `Interesting`).
8. Apply `I2SSpliceReplace` mutation (which wraps `I2SRandReplace`) to the cloned input, using the `CmpValuesMetadata` as the mutation source.
9. Enforce `max_input_len` truncation on the mutated input.
10. Store the mutated input internally (e.g., in a `last_stage_input` field on `Fuzzer`) so that `advanceStage()` can add it to the corpus if coverage evaluation deems it interesting. This is necessary because `advanceStage()` does not receive the input as a parameter.
11. Transition the internal `StageState` from `None` to `I2S { corpus_id, iteration: 0, max_iterations }`.
12. Return the mutated input as a `Buffer`.

It SHALL be valid to call `beginStage()` only after `calibrateFinish()` has completed for the current interesting input. This is a protocol-level contract enforced by the JS fuzz loop's calling order (calibration always runs before `beginStage()`), not a Rust-side check — the Rust-side precondition checks are `StageState::None` and `last_interesting_corpus_id` being set.

#### Scenario: Stage begins with CmpLog data available

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** `CmpValuesMetadata` contains at least one entry
- **THEN** `beginStage()` SHALL return a non-null `Buffer` containing an I2S-mutated variant of the corpus entry
- **AND** `StageState` SHALL transition to `I2S`
- **AND** `last_interesting_corpus_id` SHALL be cleared

#### Scenario: Stage skipped when no CmpLog data

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** `CmpValuesMetadata` is empty
- **THEN** `beginStage()` SHALL return `null`
- **AND** `StageState` SHALL remain `None`
- **AND** `last_interesting_corpus_id` SHALL be cleared (consumed even though no stage runs)

#### Scenario: beginStage called without pending calibration

- **WHEN** `beginStage()` is called without a preceding `Interesting` result and completed calibration
- **THEN** `beginStage()` SHALL return `null`

#### Scenario: beginStage called during active stage

- **WHEN** `beginStage()` is called while `StageState` is `I2S` (a stage is already in progress)
- **THEN** `beginStage()` SHALL return `null`
- **AND** the active stage SHALL NOT be disrupted

#### Scenario: Mutated input respects max input length

- **WHEN** `beginStage()` generates an I2S-mutated input
- **AND** the mutated result exceeds `maxInputLen`
- **THEN** the returned buffer SHALL be truncated to `maxInputLen` bytes

#### Scenario: Iteration count is between 1 and 128

- **WHEN** `beginStage()` selects a random iteration count
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
3. Evaluate coverage using the shared `evaluate_coverage()` helper, passing the internally-stashed stage input, `exec_time_ns`, `exit_kind` (which is `ExitKind::Ok` per the constraint below), and the parent `corpus_id` from `StageState::I2S`. The helper masks unstable edges, constructs the observer, evaluates crash/timeout objective (a no-op for `ExitKind::Ok`) and `MaxMapFeedback::is_interesting()`, adds to corpus if interesting, and zeroes the coverage map.
4. Increment the stage iteration counter, `total_execs`, and `state.executions`.
5. If `iteration < max_iterations`: clone the original corpus entry (identified by `StageState::I2S.corpus_id`), apply `I2SSpliceReplace` mutation, enforce `max_input_len` truncation, store the mutated input internally (for the next `advanceStage()` call's corpus addition), and return the mutated input as a `Buffer`.
6. If `iteration >= max_iterations`: transition `StageState` to `None` and return `null` (stage complete).

The `exitKind` parameter SHALL only be `ExitKind.Ok` — crashes and timeouts are handled by `abortStage()`, not `advanceStage()`. The parameter is accepted for forward-compatibility with future stage types that may handle non-Ok exit kinds; calling with non-Ok values in the current I2S stage is a programming error and behavior is undefined.

#### Scenario: Stage advances with more iterations remaining

- **WHEN** `advanceStage(ExitKind.Ok, execTimeNs)` is called
- **AND** the current iteration is less than `max_iterations`
- **THEN** the method SHALL return a non-null `Buffer` containing the next I2S-mutated input
- **AND** the iteration counter SHALL increment by 1
- **AND** `total_execs` and `state.executions` SHALL each increment by 1

#### Scenario: Stage completes when iterations exhausted

- **WHEN** `advanceStage(ExitKind.Ok, execTimeNs)` is called
- **AND** the current iteration equals `max_iterations - 1` (last iteration)
- **THEN** the method SHALL return `null`
- **AND** `StageState` SHALL transition to `None`
- **AND** `total_execs` and `state.executions` SHALL each increment by 1

#### Scenario: Single-iteration stage completes immediately

- **WHEN** `beginStage()` selected `max_iterations = 1`
- **AND** `advanceStage(ExitKind.Ok, execTimeNs)` is called after the first execution
- **THEN** the method SHALL return `null` (stage complete after one iteration)
- **AND** `StageState` SHALL transition to `None`

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
- **THEN** the coverage map SHALL be zeroed after evaluation (by the shared helper)
- **AND** the next stage execution SHALL start with a clean coverage map

#### Scenario: advanceStage called with no active stage

- **WHEN** `advanceStage()` is called and `StageState` is `None`
- **THEN** the method SHALL return `null`
- **AND** no coverage evaluation SHALL occur

#### Scenario: advanceStage enforces max input length

- **WHEN** `advanceStage()` generates the next I2S-mutated input
- **AND** the mutated result exceeds `maxInputLen`
- **THEN** the returned buffer SHALL be truncated to `maxInputLen` bytes

### Requirement: Abort stage on crash or timeout

The system SHALL provide `fuzzer.abortStage(exitKind: ExitKind)` which cleanly terminates the current stage without evaluating the final execution's coverage. The method SHALL:

1. Drain the CmpLog accumulator and discard all entries.
2. Zero the coverage map (may contain partial/corrupt data from the crashed execution).
3. Increment `total_execs` and `state.executions` (the aborted execution still counts as a target invocation).
4. Transition `StageState` to `None`.
5. NOT evaluate coverage or add the crashed/timed-out input to the corpus.
6. NOT add the crash/timeout to the solutions corpus — the crash artifact is written by the JS fuzz loop, but `solutionCount` is not incremented by `abortStage()`. This is intentional: stage-discovered crashes are handled at the JS level (artifact writing) rather than the Rust level (solutions tracking). The `solutionCount` stat only reflects crashes detected via `reportResult()`.

The `exitKind` parameter is accepted for interface consistency and potential future use (e.g., logging, metrics) but does not influence the current method's behavior.

After `abortStage()` returns, the crash/timeout input and error are available in the JS fuzz loop for artifact writing via the existing crash-handling path. Stage-discovered crashes are NOT minimized inline — the raw stage input is written as the artifact (see fuzz-loop spec for details). The aborted execution's timing is intentionally not reported since the execution was abnormal and the timing would not be meaningful for scheduling.

#### Scenario: Stage aborted on crash

- **WHEN** the target throws during a stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition to `None`
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed
- **AND** `total_execs` and `state.executions` SHALL each increment by 1
- **AND** no corpus entry SHALL be added for the crashed execution
- **AND** `solutionCount` SHALL NOT be incremented

#### Scenario: Stage aborted on timeout

- **WHEN** the watchdog fires during a stage execution
- **AND** `abortStage(ExitKind.Timeout)` is called
- **THEN** `StageState` SHALL transition to `None`
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed
- **AND** `total_execs` and `state.executions` SHALL each increment by 1
- **AND** no corpus entry SHALL be added for the timed-out execution
- **AND** `solutionCount` SHALL NOT be incremented

#### Scenario: abortStage is safe to call with no active stage

- **WHEN** `abortStage()` is called and `StageState` is already `None`
- **THEN** the method SHALL be a no-op (no error, no counter increments)

### Requirement: Stage state machine lifecycle

The `Fuzzer` SHALL maintain a `StageState` enum with the following variants:

- `None`: No stage is active. This is the initial state and the state after a stage completes or is aborted.
- `I2S { corpus_id: CorpusId, iteration: usize, max_iterations: usize }`: An I2S mutational stage is in progress.

State transitions:
- `None` -> `I2S`: Via `beginStage()` when CmpLog data is available.
- `I2S` -> `I2S`: Via `advanceStage()` when `iteration < max_iterations` (iteration incremented).
- `I2S` -> `None`: Via `advanceStage()` when `iteration >= max_iterations`, or via `abortStage()`.

The `StageState` enum SHALL be designed for extensibility — future stages (Generalization, Grimoire) add new variants without changing existing transitions.

#### Scenario: Initial state is None

- **WHEN** a `Fuzzer` is constructed
- **THEN** `StageState` SHALL be `None`

#### Scenario: Full I2S stage lifecycle

- **WHEN** `beginStage()` returns a non-null input
- **AND** `advanceStage()` is called after each target execution
- **AND** the stage runs to completion (all iterations exhausted)
- **THEN** `StageState` transitions `None` -> `I2S` -> `I2S` (repeated) -> `None`

#### Scenario: Aborted I2S stage lifecycle

- **WHEN** `beginStage()` returns a non-null input
- **AND** the target crashes on the 3rd iteration
- **AND** `abortStage()` is called
- **THEN** `StageState` transitions `None` -> `I2S` -> `I2S` (2 advances) -> `None` (abort)

### Requirement: I2S stage mutations use the original corpus entry

Each I2S stage iteration SHALL clone the original corpus entry (identified by `corpus_id` in `StageState::I2S`) and apply a fresh `I2SSpliceReplace` mutation. The mutations SHALL NOT be cumulative — each iteration starts from the unmodified corpus entry, not from the previous iteration's mutated output.

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

Each stage execution SHALL increment both the `total_execs` counter on the Fuzzer and the `executions` counter on the fuzzer state. This ensures `fuzzer.stats.totalExecs` accurately reflects the total number of target invocations including stage executions. This applies to both `advanceStage()` (normal completion) and `abortStage()` (crash/timeout) calls.

#### Scenario: Stats reflect stage executions

- **WHEN** the main loop runs 50 iterations and 3 of those trigger I2S stages with `max_iterations` averaging 64 each
- **THEN** `fuzzer.stats.totalExecs` SHALL equal `50 + (3 * 64)` = 242

#### Scenario: Aborted stage execution counted in stats

- **WHEN** an I2S stage runs for 5 iterations and the 6th execution crashes
- **AND** `abortStage()` is called
- **THEN** `total_execs` SHALL include all 6 executions (5 via `advanceStage()` + 1 via `abortStage()`)
