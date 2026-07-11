## Purpose

Stage execution manages the multi-stage pipeline (Colorization, REDQUEEN, I2S, Generalization, Grimoire, Unicode, Json) that runs after calibration for interesting inputs. This capability defines the protocol for beginning, advancing, and aborting stages, the state machine lifecycle, mutation semantics, and execution counting.

## Requirements

### Requirement: Begin stage after calibration

The system SHALL provide `fuzzer.beginStage()` which initiates a stage execution pipeline for the most recently calibrated corpus entry. The method SHALL:

1. Check that `StageState` is `None` (no stage currently active). If a stage is in progress, return `null`.
2. Read `last_interesting_corpus_id`. If not set (no corpus entry was recently added via `reportResult()` returning `Interesting` with completed calibration), clear `last_interesting_corpus_id` and return `null`.
3. Clear `last_interesting_corpus_id` (set to `None`) unconditionally - the ID is consumed regardless of whether the stage proceeds.
4. Decide whether the expensive stages run for this entry by calling `should_run_expensive_stages()` (see the "Expensive stage gating" requirement). The colorization/REDQUEEN stage (step 5) and the structure-aware stages (steps 7-10) are gated by this decision; the bounded I2S stage (step 6) is not.
5. If the expensive stages run AND REDQUEEN is enabled AND the corpus entry is at most `MAX_COLORIZATION_LEN` bytes: begin the colorization stage (transition to `StageState::Colorization`). Set `redqueen_ran_for_entry = true`.
6. If colorization was not started: attempt to start the I2S stage: read `CmpValuesMetadata` (populated by `reportResult()` alongside `AflppCmpValuesMetadata`). If the list is non-empty, begin the I2S stage (select 1-128 iterations, clone entry, apply `I2SSpliceReplace`, transition to `StageState::I2S`). Set `redqueen_ran_for_entry = false`. I2S is not gated by the expensive-stage decision.
7. If the expensive stages run AND I2S was not started AND Grimoire is enabled AND the input qualifies for generalization: begin the generalization stage directly (transition to `StageState::Generalization`).
8. If the expensive stages run AND I2S was not started AND Grimoire is enabled AND the input does NOT qualify for generalization BUT already has `GeneralizedInputMetadata`: begin the Grimoire stage directly (transition to `StageState::Grimoire`).
9. If the expensive stages run AND I2S was not started AND Grimoire stages are not applicable AND unicode is enabled AND the corpus entry has valid UTF-8 regions: begin the unicode stage directly (transition to `StageState::Unicode`).
10. If the expensive stages run AND I2S was not started AND unicode was not started AND JSON mutations are enabled AND the corpus entry passes `looks_like_json()`: begin the JSON stage directly (select 1-128 iterations, transition to `StageState::Json`).
11. If none of the above can start (including when the expensive stages are gated out and no I2S data exists): return `null`, and the entry proceeds to havoc mutation in the fuzz loop.

The pipeline ordering is: Colorization → REDQUEEN → I2S → Generalization → Grimoire → Unicode → Json → None. `beginStage()` attempts colorization first (if REDQUEEN enabled and the expensive stages run this entry). If colorization is skipped, it falls through to I2S, then the structure-aware stages (if the expensive stages run and each is enabled and applicable).

It SHALL be valid to call `beginStage()` only after `calibrateFinish()` has completed for the current interesting input. This is a protocol-level contract enforced by the JS fuzz loop's calling order (calibration always runs before `beginStage()`), not a Rust-side check - the Rust-side precondition checks are `StageState::None` and `last_interesting_corpus_id` being set.

#### Scenario: Stage begins with colorization when REDQUEEN enabled

- **WHEN** `reportResult()` returned `Interesting` and calibration has completed
- **AND** the expensive stages run for this entry (within the warmup window)
- **AND** REDQUEEN is enabled
- **AND** the corpus entry is at most `MAX_COLORIZATION_LEN` bytes
- **THEN** `beginStage()` SHALL return a non-null `Buffer` containing the original corpus entry (baseline hash computed by the subsequent `advanceStage()` call)
- **AND** `StageState` SHALL transition to `Colorization`
- **AND** `redqueen_ran_for_entry` SHALL be set to `true`

#### Scenario: I2S still runs when expensive stages are gated out

- **WHEN** the expensive stages are gated out for this entry
- **AND** `CmpValuesMetadata` contains at least one entry
- **THEN** `beginStage()` SHALL skip colorization/REDQUEEN and begin the I2S stage
- **AND** `StageState` SHALL transition to `I2S`

#### Scenario: Entry skips to havoc when expensive stages gated out and no I2S data

- **WHEN** the expensive stages are gated out for this entry
- **AND** `CmpValuesMetadata` is empty
- **THEN** `beginStage()` SHALL return `null`
- **AND** `StageState` SHALL remain `None`

### Requirement: Advance stage after each execution

The system SHALL provide `fuzzer.advanceStage(exitKind: ExitKind, execTimeNs: number)` which processes the result of a stage execution and returns the next candidate input. The method SHALL:

1. If `StageState` is `None` (no active stage), return `null` immediately.
2. Drain the CmpLog accumulator. For the colorization dual-trace execution, retain the entries; for all other stage executions, discard the entries.
3. Process the execution result based on the current stage type:
   - **`StageState::Colorization`**: Compute coverage hash and advance the binary search. When the search completes, execute the dual trace. After the dual trace, transition to `Redqueen` (if candidates exist) or fall through.
   - **`StageState::Redqueen`**: Evaluate coverage. If candidates remain, yield the next one. If exhausted, skip I2S and transition to generalization (if Grimoire enabled and input qualifies), or to Grimoire (if applicable), or to unicode (if applicable), or to JSON (if applicable), or to `None`.
   - **`StageState::I2S`**: Evaluate coverage. If iterations remain, generate next I2S mutation and return it. If iterations exhausted, transition to generalization (if Grimoire enabled and input qualifies), or to Grimoire (if Grimoire enabled and input already has `GeneralizedInputMetadata` but does not qualify for generalization), or to unicode (if Grimoire stages not applicable, unicode enabled, and valid UTF-8 regions exist), or to JSON (if unicode not applicable, JSON mutations enabled, and corpus entry passes `looks_like_json()`), or to `None`.
   - **`StageState::Generalization`**: Check novelty survival in coverage map for generalization decisions. Generate next candidate or transition to Grimoire (if generalization succeeded) or `None`.
   - **`StageState::Grimoire`**: Evaluate coverage. If iterations remain, generate next Grimoire mutation and return it. If iterations exhausted, transition to unicode (if unicode enabled and valid UTF-8 regions exist) or to JSON (if unicode not applicable, JSON mutations enabled, and corpus entry passes `looks_like_json()`) or `None`.
   - **`StageState::Unicode`**: Evaluate coverage. If iterations remain, generate next unicode mutation and return it. If iterations exhausted, transition to JSON (if JSON mutations enabled and corpus entry passes `looks_like_json()`) or `None`.
   - **`StageState::Json`**: Evaluate coverage. If iterations remain, clone original corpus entry, apply JSON mutations via the JSON `HavocScheduledMutator`, and return it. If iterations exhausted, transition to `None`.
4. Increment `total_execs` and `state.executions`.
5. Zero the coverage map after processing (via the shared evaluation helper or explicitly for generalization/colorization verification).

The `exitKind` parameter SHALL only be `ExitKind.Ok` - crashes and timeouts are handled by `abortStage()`, not `advanceStage()`.

#### Scenario: Colorization completes and transitions to REDQUEEN

- **WHEN** `advanceStage()` completes the colorization dual trace
- **AND** `AflppCmpValuesMetadata` and `TaintMetadata` are populated
- **AND** `multi_mutate()` produces non-empty candidates
- **THEN** `StageState` SHALL transition from `Colorization` to `Redqueen`
- **AND** the method SHALL return the first REDQUEEN candidate

#### Scenario: REDQUEEN completes and skips I2S

- **WHEN** `advanceStage()` is called after the last REDQUEEN candidate
- **AND** `redqueen_ran_for_entry` is `true`
- **THEN** I2S SHALL be skipped
- **AND** `StageState` SHALL transition to generalization (if applicable), Grimoire, unicode, JSON, or `None`

#### Scenario: REDQUEEN completes with no candidates and skips I2S

- **WHEN** colorization and dual trace complete but `multi_mutate()` returns empty candidates
- **AND** `redqueen_ran_for_entry` is `true`
- **THEN** I2S SHALL be skipped
- **AND** the pipeline SHALL proceed to generalization/Grimoire/unicode/JSON/None

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

#### Scenario: I2S stage completes and transitions to unicode (Grimoire not applicable)

- **WHEN** `advanceStage()` is called after the last I2S iteration
- **AND** Grimoire stages are not applicable (disabled, OR entry does not qualify for generalization and has no pre-existing `GeneralizedInputMetadata`)
- **AND** unicode is enabled
- **AND** the corpus entry has valid UTF-8 regions
- **THEN** `StageState` SHALL transition from `I2S` to `Unicode`
- **AND** the method SHALL return a non-null `Buffer` containing the first unicode-mutated input

#### Scenario: I2S stage completes and transitions to JSON (Grimoire and unicode not applicable)

- **WHEN** `advanceStage()` is called after the last I2S iteration
- **AND** Grimoire stages are not applicable
- **AND** unicode is disabled or corpus entry has no valid UTF-8 regions
- **AND** JSON mutations are enabled
- **AND** the corpus entry passes `looks_like_json()`
- **THEN** `StageState` SHALL transition from `I2S` to `Json`
- **AND** the method SHALL return a non-null `Buffer` containing the first JSON-mutated input

#### Scenario: I2S stage completes without Grimoire, unicode, or JSON

- **WHEN** `advanceStage()` is called after the last I2S iteration
- **AND** Grimoire stages are not applicable
- **AND** unicode is disabled or not applicable
- **AND** JSON mutations are disabled or corpus entry does not pass `looks_like_json()`
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`

#### Scenario: Generalization completes and transitions to Grimoire

- **WHEN** `advanceStage()` completes the last generalization phase
- **AND** `GeneralizedInputMetadata` was successfully produced
- **THEN** `StageState` SHALL transition from `Generalization` to `Grimoire`

#### Scenario: Generalization fails and pipeline completes

- **WHEN** the verification phase fails (input unstable)
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`
- **AND** the unicode and JSON stages SHALL NOT be attempted (unstable inputs produce unreliable coverage)

#### Scenario: Grimoire stage completes and transitions to unicode

- **WHEN** `advanceStage()` is called after the last Grimoire iteration
- **AND** unicode is enabled
- **AND** the corpus entry has valid UTF-8 regions
- **THEN** `StageState` SHALL transition from `Grimoire` to `Unicode`

#### Scenario: Grimoire stage completes and transitions to JSON (unicode not applicable)

- **WHEN** `advanceStage()` is called after the last Grimoire iteration
- **AND** unicode is disabled or corpus entry has no valid UTF-8 regions
- **AND** JSON mutations are enabled
- **AND** the corpus entry passes `looks_like_json()`
- **THEN** `StageState` SHALL transition from `Grimoire` to `Json`

#### Scenario: Unicode stage completes and transitions to JSON

- **WHEN** `advanceStage()` is called after the last unicode iteration
- **AND** JSON mutations are enabled
- **AND** the corpus entry passes `looks_like_json()`
- **THEN** `StageState` SHALL transition from `Unicode` to `Json`
- **AND** the method SHALL return a non-null `Buffer` containing the first JSON-mutated input

#### Scenario: Unicode stage completes without JSON

- **WHEN** `advanceStage()` is called after the last unicode iteration
- **AND** JSON mutations are disabled or corpus entry does not pass `looks_like_json()`
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`

#### Scenario: JSON stage completes

- **WHEN** `advanceStage()` is called after the last JSON iteration
- **THEN** `StageState` SHALL transition to `None`
- **AND** the method SHALL return `null`

#### Scenario: JSON stage advances with more iterations remaining

- **WHEN** `advanceStage(ExitKind.Ok, execTimeNs)` is called during the JSON stage
- **AND** the current iteration is less than `max_iterations`
- **THEN** the method SHALL return a non-null `Buffer` containing the next JSON-mutated input
- **AND** the iteration counter SHALL increment by 1
- **AND** `total_execs` and `state.executions` SHALL each increment by 1

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

#### Scenario: CmpLog accumulator drained and discarded during non-dual-trace stages

- **WHEN** `advanceStage()` is called after a stage execution that is NOT the colorization dual trace
- **THEN** the CmpLog accumulator SHALL be drained
- **AND** the drained entries SHALL be discarded (not stored in `AflppCmpValuesMetadata`)

#### Scenario: CmpLog accumulator retained during dual trace

- **WHEN** `advanceStage()` is called after the colorization dual trace execution
- **THEN** the CmpLog accumulator SHALL be drained
- **AND** the drained entries SHALL be stored as `new_cmpvals` in `AflppCmpValuesMetadata`

#### Scenario: Coverage map zeroed between stage executions

- **WHEN** `advanceStage()` processes a stage execution result
- **THEN** the coverage map SHALL be zeroed after evaluation
- **AND** the next stage execution SHALL start with a clean coverage map

#### Scenario: advanceStage called with no active stage

- **WHEN** `advanceStage()` is called and `StageState` is `None`
- **THEN** the method SHALL return `null`
- **AND** no coverage evaluation SHALL occur

#### Scenario: advanceStage enforces max input length

- **WHEN** `advanceStage()` generates the next mutated input (I2S, Grimoire, unicode, or JSON)
- **AND** the mutated result exceeds `maxInputLen`
- **THEN** the returned buffer SHALL be truncated to `maxInputLen` bytes

### Requirement: Abort stage on crash or timeout

The system SHALL provide `fuzzer.abortStage(exitKind: ExitKind)` which cleanly terminates the current stage without evaluating the final execution's coverage. The method SHALL:

1. Drain the CmpLog accumulator and discard all entries.
2. Zero the coverage map (may contain partial/corrupt data from the crashed execution).
3. Increment `total_execs` and `state.executions` (the aborted execution still counts as a target invocation).
4. Transition `StageState` to `None` (regardless of which stage variant was active - Colorization, Redqueen, I2S, Generalization, Grimoire, Unicode, or Json).
5. NOT evaluate coverage or add the crashed/timed-out input to the main corpus.
6. If the exit kind is Crash or Timeout, add the stage input to the solutions corpus and increment `solutionCount`. This ensures `FuzzerStats` reflects stage-discovered crashes consistently with main-loop crashes recorded by `reportResult()`. If the exit kind is Ok, do not record a solution.

After `abortStage()` returns, the crash/timeout input and error are available in the JS fuzz loop for artifact writing via the existing crash-handling path. Stage-discovered crashes are NOT minimized inline. The aborted execution's timing is intentionally not reported since the execution was abnormal.

#### Scenario: Stage aborted during colorization

- **WHEN** the target crashes during a colorization stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition from `Colorization` to `None`
- **AND** no `TaintMetadata` SHALL be stored
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed

#### Scenario: Stage aborted during REDQUEEN

- **WHEN** the target crashes during a REDQUEEN candidate execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition from `Redqueen` to `None`
- **AND** remaining REDQUEEN candidates SHALL be discarded

#### Scenario: Stage aborted during unicode

- **WHEN** the target crashes during a unicode stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition from `Unicode` to `None`
- **AND** the remaining unicode iterations SHALL be skipped

#### Scenario: Stage aborted during generalization

- **WHEN** the target crashes during a generalization stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition from `Generalization` to `None`
- **AND** no `GeneralizedInputMetadata` SHALL be stored

#### Scenario: Stage aborted during Grimoire

- **WHEN** the target times out during a Grimoire stage execution
- **AND** `abortStage(ExitKind.Timeout)` is called
- **THEN** `StageState` SHALL transition from `Grimoire` to `None`

#### Scenario: Stage aborted during JSON

- **WHEN** the target crashes during a JSON stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition from `Json` to `None`
- **AND** the remaining JSON iterations SHALL be skipped
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed
- **AND** `total_execs` and `state.executions` SHALL each increment by 1
- **AND** the stage input SHALL be added to the solutions corpus
- **AND** `solutionCount` SHALL be incremented by 1

#### Scenario: Stage aborted on crash (I2S - unchanged)

- **WHEN** the target throws during an I2S stage execution
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition to `None`
- **AND** the CmpLog accumulator SHALL be drained and discarded
- **AND** the coverage map SHALL be zeroed
- **AND** `total_execs` and `state.executions` SHALL each increment by 1
- **AND** no corpus entry SHALL be added for the crashed execution
- **AND** the stage input SHALL be added to the solutions corpus
- **AND** `solutionCount` SHALL be incremented by 1

#### Scenario: abortStage is safe to call with no active stage

- **WHEN** `abortStage()` is called and `StageState` is already `None`
- **THEN** the method SHALL be a no-op (no error, no counter increments)

### Requirement: Stage state machine lifecycle

The `Fuzzer` SHALL maintain a `StageState` enum with the following variants:

- `None`: No stage is active.
- `Colorization { corpus_id, original_hash, original_input, changed_input, pending_ranges, taint_ranges, executions, max_executions, awaiting_dual_trace }`: A colorization stage is in progress.
- `Redqueen { corpus_id, candidates, index }`: A REDQUEEN mutation stage is in progress.
- `I2S { corpus_id, iteration, max_iterations }`: An I2S mutational stage is in progress.
- `Generalization { corpus_id, novelties, payload, phase, candidate_range }`: A generalization stage is in progress.
- `Grimoire { corpus_id, iteration, max_iterations }`: A Grimoire mutational stage is in progress.
- `Unicode { corpus_id, iteration, max_iterations }`: A unicode mutational stage is in progress.
- `Json { corpus_id, iteration, max_iterations }`: A JSON mutational stage is in progress.

State transitions:
- `None` → `Colorization`: Via `beginStage()` when REDQUEEN is enabled and input ≤ `MAX_COLORIZATION_LEN`.
- `None` → `I2S`: Via `beginStage()` when colorization is skipped and CmpLog data is available.
- `None` → `Generalization`: Via `beginStage()` when I2S is skipped, Grimoire is enabled, and the input qualifies.
- `None` → `Grimoire`: Via `beginStage()` when I2S is skipped, Grimoire is enabled, and the input has pre-existing `GeneralizedInputMetadata`.
- `None` → `Unicode`: Via `beginStage()` when prior stages skipped and unicode enabled.
- `None` → `Json`: Via `beginStage()` when prior stages skipped and JSON mutations enabled and corpus entry passes `looks_like_json()`.
- `Colorization` → `Colorization`: Via `advanceStage()` during binary search iterations.
- `Colorization` → `Redqueen`: Via `advanceStage()` after dual trace, when candidates exist.
- `Colorization` → `Generalization` / `Grimoire` / `Unicode` / `Json` / `None`: Via `advanceStage()` after dual trace, when REDQUEEN produces no candidates and subsequent stages apply. I2S is always skipped after colorization (`redqueen_ran_for_entry` is `true`).
- `Redqueen` → `Redqueen`: Via `advanceStage()` when candidates remain.
- `Redqueen` → `Generalization`: Via `advanceStage()` when candidates exhausted, Grimoire enabled, input qualifies.
- `Redqueen` → `Grimoire`: Via `advanceStage()` when candidates exhausted, Grimoire enabled, pre-existing metadata.
- `Redqueen` → `Unicode`: Via `advanceStage()` when candidates exhausted, Grimoire not applicable, unicode enabled.
- `Redqueen` → `Json`: Via `advanceStage()` when candidates exhausted and prior post-REDQUEEN stages not applicable and JSON enabled and corpus entry passes `looks_like_json()`.
- `Redqueen` → `None`: Via `advanceStage()` when candidates exhausted and no subsequent stages apply.
- `I2S` → `I2S`: Via `advanceStage()` when iterations remain.
- `I2S` → `Generalization`: Via `advanceStage()` when I2S completes and Grimoire enabled and input qualifies.
- `I2S` → `Grimoire`: Via `advanceStage()` when I2S completes and Grimoire enabled and pre-existing metadata.
- `I2S` → `Unicode`: Via `advanceStage()` when I2S completes and Grimoire not applicable and unicode enabled.
- `I2S` → `Json`: Via `advanceStage()` when I2S completes and Grimoire and unicode not applicable and JSON enabled and corpus entry passes `looks_like_json()`.
- `I2S` → `None`: Via `advanceStage()` when I2S completes and no subsequent stages apply.
- `Generalization` → `Generalization`: Via `advanceStage()` while gap-finding phases continue.
- `Generalization` → `Grimoire`: Via `advanceStage()` when generalization completes successfully.
- `Generalization` → `None`: Via `advanceStage()` when generalization fails.
- `Grimoire` → `Grimoire`: Via `advanceStage()` when iterations remain.
- `Grimoire` → `Unicode`: Via `advanceStage()` when iterations exhausted and unicode applicable.
- `Grimoire` → `Json`: Via `advanceStage()` when iterations exhausted and unicode not applicable and JSON enabled and corpus entry passes `looks_like_json()`.
- `Grimoire` → `None`: Via `advanceStage()` when iterations exhausted and unicode and JSON not applicable.
- `Unicode` → `Unicode`: Via `advanceStage()` when iterations remain.
- `Unicode` → `Json`: Via `advanceStage()` when iterations exhausted and JSON enabled and corpus entry passes `looks_like_json()`.
- `Unicode` → `None`: Via `advanceStage()` when iterations exhausted and JSON not applicable.
- `Json` → `Json`: Via `advanceStage()` when iterations remain.
- `Json` → `None`: Via `advanceStage()` when iterations exhausted.
- Any → `None`: Via `abortStage()`.

#### Scenario: Initial state is None

- **WHEN** a `Fuzzer` is constructed
- **THEN** `StageState` SHALL be `None`

#### Scenario: Full eight-stage pipeline lifecycle

- **WHEN** `beginStage()` starts a colorization stage (REDQUEEN enabled)
- **AND** colorization completes and dual trace executes
- **AND** REDQUEEN candidates are generated and exhausted
- **AND** I2S is skipped (REDQUEEN ran)
- **AND** Grimoire is enabled and generalization succeeds
- **AND** Grimoire completes and unicode is enabled
- **AND** unicode completes and JSON mutations are enabled and corpus entry passes `looks_like_json()`
- **AND** JSON completes
- **THEN** `StageState` transitions `None` → `Colorization` → ... → `Redqueen` → ... → `Generalization` → ... → `Grimoire` → ... → `Unicode` → ... → `Json` → ... → `None`

#### Scenario: I2S-to-JSON pipeline (REDQUEEN disabled, Grimoire and unicode not applicable)

- **WHEN** `beginStage()` starts an I2S stage (REDQUEEN disabled)
- **AND** I2S completes
- **AND** Grimoire stages are not applicable
- **AND** unicode is disabled
- **AND** JSON mutations are enabled and corpus entry passes `looks_like_json()`
- **THEN** `StageState` transitions `None` → `I2S` → ... → `Json` → ... → `None`

#### Scenario: Colorization-to-REDQUEEN without I2S

- **WHEN** `beginStage()` starts colorization
- **AND** colorization + dual trace complete
- **AND** REDQUEEN generates candidates
- **AND** REDQUEEN completes
- **AND** Grimoire is disabled and unicode is disabled
- **THEN** `StageState` transitions `None` → `Colorization` → ... → `Redqueen` → ... → `None`
- **AND** I2S is never entered

#### Scenario: Full pipeline with all features explicitly enabled

- **WHEN** REDQUEEN is explicitly enabled (`redqueen: true`)
- **AND** Grimoire is explicitly enabled (`grimoire: true`)
- **AND** unicode is enabled
- **AND** JSON mutations are enabled
- **THEN** the full pipeline SHALL run: Colorization → Redqueen → (skip I2S) → Generalization → Grimoire → Unicode → Json → None

#### Scenario: Aborted JSON lifecycle

- **WHEN** the JSON stage is active
- **AND** the target crashes during a JSON execution
- **THEN** `StageState` transitions from `Json` to `None` (abort)

#### Scenario: Unicode stage skipped when no valid UTF-8 regions

- **WHEN** the unicode stage is about to begin for a corpus entry
- **AND** `UnicodeIdentificationMetadata` is computed and contains no valid UTF-8 regions (empty list)
- **THEN** the unicode stage SHALL NOT be entered
- **AND** `beginStage()` or `advanceStage()` SHALL return `null` (pipeline complete)
- **AND** `StageState` SHALL transition to `None`

#### Scenario: First unicode mutation returns Skipped

- **WHEN** the unicode stage begins and the first `mutate()` call returns `Skipped` (all stacked mutations skipped)
- **THEN** the stage SHALL return the unmodified clone of the corpus entry as the candidate input
- **AND** the stage SHALL proceed normally with remaining iterations

### Requirement: I2S stage mutations use the original corpus entry

Each I2S stage iteration SHALL clone the original corpus entry (identified by `corpus_id` in `StageState::I2S`) and apply a fresh `I2SSpliceReplace` mutation. The mutations SHALL NOT be cumulative - each iteration starts from the unmodified corpus entry, not from the previous iteration's mutated output.

The `I2SSpliceReplace` mutator reads `CmpValuesMetadata` from the fuzzer state. Since `reportResult()` stores both `AflppCmpValuesMetadata` and `CmpValuesMetadata` (flattened from `orig_cmpvals`), no runtime adapter is needed - I2S reads `CmpValuesMetadata` directly. Since `advanceStage()` does not update the metadata (it discards CmpLog entries for non-dual-trace executions), the mutations throughout the stage are driven by the CmpLog data from the original `reportResult()` call.

#### Scenario: Each iteration mutates the original entry

- **WHEN** an I2S stage runs for 5 iterations
- **THEN** each iteration SHALL start with a fresh clone of the original corpus entry
- **AND** each iteration SHALL independently apply `I2SSpliceReplace` mutation
- **AND** mutations SHALL NOT accumulate across iterations

#### Scenario: Mutations driven by original CmpLog data

- **WHEN** `AflppCmpValuesMetadata.orig_cmpvals` contains entries from the triggering execution
- **AND** the I2S stage runs multiple iterations
- **THEN** each iteration's `I2SSpliceReplace` mutation SHALL use the flattened `orig_cmpvals` data
- **AND** the metadata SHALL NOT be overwritten by CmpLog entries from stage executions

### Requirement: Stage execution increments total executions counter

Each stage execution SHALL increment both the `total_execs` counter on the Fuzzer and the `executions` counter on the fuzzer state. This applies to both `advanceStage()` (normal completion) and `abortStage()` (crash/timeout) calls. This applies to all stage types: Colorization, Redqueen, I2S, Generalization, Grimoire, Unicode, and Json.

#### Scenario: Stats reflect stage executions including full pipeline

- **WHEN** the main loop runs 50 iterations and one triggers a full pipeline with colorization (200 execs), dual trace (1 exec), REDQUEEN (500 candidates), generalization (50 execs), Grimoire (64 iters), Unicode (48 iters), and JSON (32 iters)
- **THEN** `fuzzer.stats.totalExecs` SHALL equal `50 + 200 + 1 + 500 + 50 + 64 + 48 + 32` = 945

#### Scenario: Aborted stage execution counted in stats

- **WHEN** a colorization stage runs for 5 iterations and the 6th execution crashes
- **AND** `abortStage()` is called
- **THEN** `total_execs` SHALL include all 6 executions

### Requirement: Expensive stage gating

To bound stage amplification, the engine SHALL NOT run the expensive stages (colorization/REDQUEEN and the structure-aware post-I2S stages: generalization, Grimoire, unicode, JSON) on every interesting entry for the whole campaign. `should_run_expensive_stages()` SHALL decide per interesting entry:

1. The first `EXPENSIVE_STAGE_WARMUP` interesting entries offered to `beginStage()` SHALL always run the expensive stages (thorough early exploration).
2. After the warmup window, the expensive stages SHALL run on a sampled fraction of entries, chosen with the engine's seeded RNG (`rand_below(EXPENSIVE_STAGE_DENOM) < EXPENSIVE_STAGE_NUMER`).

The decision SHALL be deterministic under a fixed engine seed. The bounded I2S stage is exempt from this gate. These parameters are internal engine tunables, not user-facing configuration.

#### Scenario: Warmup entries always run expensive stages

- **WHEN** fewer than `EXPENSIVE_STAGE_WARMUP` interesting entries have been offered to `beginStage()`
- **THEN** `should_run_expensive_stages()` SHALL return `true` for each

#### Scenario: Post-warmup entries are sampled

- **WHEN** more than `EXPENSIVE_STAGE_WARMUP` interesting entries have been offered
- **THEN** `should_run_expensive_stages()` SHALL return `true` for some entries and `false` for others (a sampled fraction), deterministically under a fixed seed
