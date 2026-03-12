## ADDED Requirements

### Requirement: REDQUEEN mutation stage

The system SHALL implement a REDQUEEN mutation stage that generates transform-aware targeted replacement candidates using LibAFL's `AflppRedQueen::multi_mutate()`. The stage SHALL:

1. Set the current corpus ID on the fuzzer state via `state.set_corpus_id(corpus_id)` so that `AflppRedQueen` can identify the current testcase (required by the `HasCurrentCorpusId` trait bound).
2. Call `multi_mutate()` once with the corpus entry and populated `AflppCmpValuesMetadata` and `TaintMetadata`, producing a `Vec<BytesInput>` of all candidates.
3. Store the candidates in `StageState::Redqueen`.
4. Yield one candidate per `advanceStage()` call, evaluating coverage for each.
5. Transition to the next stage when all candidates are exhausted.

The maximum number of candidates SHALL be capped at `MAX_REDQUEEN_CANDIDATES` (2048).

#### Scenario: REDQUEEN stage generates candidates

- **WHEN** `beginStage()` transitions to the REDQUEEN stage after colorization
- **AND** `AflppCmpValuesMetadata` and `TaintMetadata` are populated
- **THEN** `multi_mutate()` SHALL be called with `max_count: Some(2048)`
- **AND** the returned candidates SHALL be stored in `StageState::Redqueen`
- **AND** the first candidate SHALL be returned as a `Buffer`

#### Scenario: REDQUEEN yields one candidate per advance

- **WHEN** `advanceStage()` is called during the REDQUEEN stage
- **THEN** coverage SHALL be evaluated for the previous candidate
- **AND** the next candidate SHALL be returned
- **AND** the index SHALL increment by 1

#### Scenario: REDQUEEN stage completes

- **WHEN** all REDQUEEN candidates have been yielded and evaluated
- **THEN** the stage SHALL transition to the next stage in the pipeline (skipping I2S)

#### Scenario: REDQUEEN with no candidates

- **WHEN** `multi_mutate()` returns an empty candidate list (no transform patterns detected)
- **THEN** the REDQUEEN stage SHALL immediately complete
- **AND** the pipeline SHALL transition to the next stage (skipping I2S)

#### Scenario: Current corpus ID set before multi_mutate

- **WHEN** the REDQUEEN stage begins
- **THEN** `state.set_corpus_id(corpus_id)` SHALL be called before `multi_mutate()`
- **AND** `multi_mutate()` SHALL be able to read the current corpus ID from the state

### Requirement: REDQUEEN stage state

The `StageState` enum SHALL include a `Redqueen` variant with the following fields:

- `corpus_id: CorpusId` - the corpus entry being processed.
- `candidates: Vec<BytesInput>` - pre-generated candidates from `multi_mutate()`.
- `index: usize` - the current candidate index.

#### Scenario: Initial state after begin

- **WHEN** the REDQUEEN stage begins
- **THEN** `index` SHALL be 0
- **AND** `candidates` SHALL contain the full output of `multi_mutate()`

### Requirement: REDQUEEN requires both metadata types

The REDQUEEN mutation stage SHALL only run when both `AflppCmpValuesMetadata` (with populated `orig_cmpvals` and `new_cmpvals`) and `TaintMetadata` are available on the fuzzer state (via `state.metadata_map()`). If either is missing, the stage SHALL be skipped.

#### Scenario: REDQUEEN skipped without TaintMetadata

- **WHEN** colorization was skipped (input too large)
- **AND** no `TaintMetadata` exists on the fuzzer state
- **THEN** the REDQUEEN stage SHALL be skipped
- **AND** I2S SHALL run instead

#### Scenario: REDQUEEN skipped without CmpLog data

- **WHEN** colorization completed but no comparison values were recorded
- **AND** `AflppCmpValuesMetadata` has empty `orig_cmpvals`
- **THEN** the REDQUEEN stage SHALL be skipped

### Requirement: REDQUEEN candidates respect max input length

Each candidate yielded by the REDQUEEN stage SHALL be truncated to `maxInputLen` bytes if it exceeds the configured maximum.

#### Scenario: Oversized candidate truncated

- **WHEN** `multi_mutate()` produces a candidate larger than `maxInputLen`
- **THEN** the candidate SHALL be truncated to `maxInputLen` bytes before being returned as a `Buffer`

### Requirement: REDQUEEN stage drains CmpLog

Each `advanceStage()` call during the REDQUEEN stage SHALL drain the CmpLog accumulator and discard the entries, consistent with the existing stage protocol for mutational stages.

#### Scenario: CmpLog discarded during REDQUEEN

- **WHEN** `advanceStage()` processes a REDQUEEN candidate execution
- **THEN** the CmpLog accumulator SHALL be drained and discarded
