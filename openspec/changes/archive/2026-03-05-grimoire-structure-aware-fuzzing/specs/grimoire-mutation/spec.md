## ADDED Requirements

### Requirement: Grimoire mutational stage generates structure-aware mutations

The system SHALL implement a Grimoire mutational stage that runs after the generalization stage completes (when `GeneralizedInputMetadata` was successfully produced). The stage SHALL:

1. Select a random iteration count between 1 and 128 inclusive.
2. For each iteration: clone the `GeneralizedInputMetadata` from the corpus entry, apply the Grimoire scheduled mutator, convert the result to `BytesInput` via `generalized_to_bytes()`, and return the input for execution.
3. After each execution: drain and discard CmpLog, evaluate coverage via the shared `evaluate_coverage()` helper, and increment execution counters.
4. Use `StageState::Grimoire { corpus_id, iteration, max_iterations }` as the active state.

The stage uses the same `advanceStage`/`abortStage` protocol as I2S — structurally identical (counted loop with mutator call per iteration).

#### Scenario: Grimoire stage runs after successful generalization

- **WHEN** the generalization stage produces `GeneralizedInputMetadata` for a corpus entry
- **THEN** the Grimoire mutational stage SHALL begin
- **AND** 1–128 iterations of Grimoire mutations SHALL be generated

#### Scenario: Grimoire stage skipped without generalization metadata

- **WHEN** generalization was skipped or failed for a corpus entry
- **AND** the testcase has no pre-existing `GeneralizedInputMetadata`
- **THEN** the Grimoire stage SHALL NOT run
- **AND** the stage pipeline SHALL complete

#### Scenario: Grimoire stage runs with pre-existing metadata

- **WHEN** generalization was skipped for a corpus entry
- **AND** the testcase already has `GeneralizedInputMetadata` from a prior generalization
- **THEN** the Grimoire stage SHALL run using the existing metadata

### Requirement: Grimoire scheduled mutator composition

The Grimoire mutator SHALL be a `HavocScheduledMutator` wrapping five mutator entries with `max_stack_pow = 3` (up to 8 stacked mutations per iteration):

1. `GrimoireExtensionMutator` (1x weight)
2. `GrimoireRecursiveReplacementMutator` (1x weight)
3. `GrimoireStringReplacementMutator` (1x weight)
4. `GrimoireRandomDeleteMutator` (1x weight)
5. `GrimoireRandomDeleteMutator` (1x weight — doubled for extra deletion pressure)

The `GrimoireRandomDeleteMutator` is included twice to counteract the input-growth tendency of extension and recursive replacement mutators.

All five mutators are LibAFL's implementations used directly — they require `HasMetadata + HasRand + HasCorpus` trait bounds, which `FuzzerState` already satisfies.

#### Scenario: Mutator composition matches libafl_libfuzzer

- **WHEN** the Grimoire mutator is constructed
- **THEN** it SHALL contain exactly 5 entries: Extension, RecursiveReplacement, StringReplacement, RandomDelete, RandomDelete
- **AND** `max_stack_pow` SHALL be 3

### Requirement: Grimoire mutations operate on GeneralizedInputMetadata

Each Grimoire stage iteration SHALL:

1. Clone the `GeneralizedInputMetadata` from the corpus entry being mutated (identified by `StageState::Grimoire.corpus_id`).
2. Apply the `HavocScheduledMutator` to the cloned metadata. The scheduled mutator selects one or more of the five Grimoire mutators (up to `2^3 = 8` stacked) and applies them sequentially.
3. Convert the mutated `GeneralizedInputMetadata` to `BytesInput` via `generalized_to_bytes()` (which concatenates all `Bytes` segments, dropping `Gap` items).
4. Enforce `max_input_len` truncation.
5. Store the `BytesInput` internally (for corpus addition if interesting) and return it as a `Buffer`.

Mutations are NOT cumulative across iterations — each iteration starts from the original corpus entry's `GeneralizedInputMetadata`.

If the `HavocScheduledMutator` returns `MutationResult::Skipped` for an iteration (e.g., all selected sub-mutators skip due to empty `Tokens` or unsuitable metadata), the iteration SHALL still be counted (iteration counter incremented) and the unmutated `GeneralizedInputMetadata` SHALL be converted to `BytesInput` and returned for execution. This matches the simple counted-loop semantics — skipped mutations do not extend the iteration budget.

#### Scenario: Each iteration starts from original metadata

- **WHEN** a Grimoire stage runs for 5 iterations
- **THEN** each iteration SHALL clone the corpus entry's `GeneralizedInputMetadata` independently
- **AND** mutations from iteration N SHALL NOT carry over to iteration N+1

#### Scenario: Mutated metadata converted to bytes for execution

- **WHEN** a Grimoire mutator produces `[Gap, Bytes(b"fn"), Gap, Bytes(b"bar()"), Gap]`
- **THEN** the `BytesInput` returned for execution SHALL be `b"fnbar()"`

#### Scenario: Max input length enforced

- **WHEN** a Grimoire mutation produces a `BytesInput` exceeding `maxInputLen`
- **THEN** the returned buffer SHALL be truncated to `maxInputLen` bytes

### Requirement: Grimoire mutators read cross-corpus metadata

The Grimoire mutators access metadata from other corpus entries:

- `GrimoireExtensionMutator` reads `GeneralizedInputMetadata` from randomly-selected corpus entries and `Tokens` from global state.
- `GrimoireRecursiveReplacementMutator` reads `GeneralizedInputMetadata` from randomly-selected corpus entries and `Tokens` from global state.
- `GrimoireStringReplacementMutator` reads `Tokens` from global state.
- `GrimoireRandomDeleteMutator` reads only the current `GeneralizedInputMetadata`.

The extension and recursive replacement mutators use a shared helper (`extend_with_random_generalized`) that follows a probabilistic fallback chain: (1) 50% chance to try extracting a sub-range from another entry's `GeneralizedInputMetadata` or falling back to token append, (2) 50% chance to try whole-entry extension from another entry's `GeneralizedInputMetadata`. The helper returns `MutationResult::Skipped` only when the whole-entry extension path is taken and the randomly-selected corpus entry has no `GeneralizedInputMetadata`. If `Tokens` metadata is empty, `GrimoireStringReplacementMutator` SHALL return `MutationResult::Skipped`. The extension and recursive replacement mutators can still succeed via non-token fallback paths even when `Tokens` is empty.

#### Scenario: Extension from another generalized entry

- **WHEN** `GrimoireExtensionMutator` selects a corpus entry with `GeneralizedInputMetadata`
- **THEN** it SHALL extract a sub-range between two gap positions and append it to the current metadata

#### Scenario: Extension falls back to tokens when no generalized entries

- **WHEN** `GrimoireExtensionMutator` cannot find a corpus entry with `GeneralizedInputMetadata`
- **AND** `Tokens` metadata contains entries
- **THEN** it SHALL append `[Gap, Bytes(token), Gap]` from a randomly-selected token

#### Scenario: String replacement with empty Tokens

- **WHEN** `GrimoireStringReplacementMutator` is invoked
- **AND** `Tokens` metadata is empty
- **THEN** the mutation SHALL return `Skipped`

### Requirement: CmpLog and coverage handling during Grimoire stage

During Grimoire stage executions:

1. The CmpLog accumulator SHALL be drained and discarded after each execution.
2. Token promotion SHALL NOT occur.
3. Coverage SHALL be evaluated via the shared `evaluate_coverage()` helper. If the mutated input triggers new coverage, it SHALL be added to the corpus with `SchedulerTestcaseMetadata` and `MapNoveltiesMetadata`.
4. The coverage map SHALL be zeroed after evaluation.
5. `last_interesting_corpus_id` SHALL NOT be set (no recursive stage triggering).

#### Scenario: Grimoire mutation discovers new coverage

- **WHEN** a Grimoire-mutated input triggers new coverage
- **THEN** the input SHALL be added to the corpus
- **AND** `MapNoveltiesMetadata` SHALL be stored on the new testcase
- **AND** the Grimoire stage SHALL continue with the next iteration (not interrupted)

#### Scenario: CmpLog discarded during Grimoire stage

- **WHEN** a Grimoire stage execution completes
- **THEN** the CmpLog accumulator SHALL be drained and discarded

### Requirement: Grimoire stage abort behavior

When a Grimoire stage execution crashes or times out, `abortStage()` SHALL:

1. Drain and discard the CmpLog accumulator.
2. Zero the coverage map.
3. Increment `total_execs` and `state.executions`.
4. Transition `StageState` to `None`.
5. NOT evaluate coverage or add to corpus.

This matches the existing I2S abort behavior. The crash/timeout input is handled by the JS fuzz loop's artifact-writing path.

#### Scenario: Crash during Grimoire stage

- **WHEN** a Grimoire-mutated input causes the target to crash
- **AND** `abortStage(ExitKind.Crash)` is called
- **THEN** `StageState` SHALL transition to `None`
- **AND** the remaining Grimoire iterations SHALL be skipped
- **AND** `total_execs` SHALL increment by 1

### Requirement: Grimoire stage execution counting

Each Grimoire stage execution SHALL increment `total_execs` and `state.executions`, including the final execution if aborted.

#### Scenario: Full Grimoire stage execution count

- **WHEN** a Grimoire stage runs 64 iterations to completion
- **THEN** `total_execs` SHALL increment by 64
