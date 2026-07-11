## MODIFIED Requirements

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

## ADDED Requirements

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
