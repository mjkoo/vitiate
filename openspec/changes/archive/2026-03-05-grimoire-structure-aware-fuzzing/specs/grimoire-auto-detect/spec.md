## ADDED Requirements

### Requirement: Auto-detect Grimoire eligibility from corpus content

The system SHALL automatically determine whether to enable Grimoire (generalization + Grimoire mutation stages) by scanning corpus content for UTF-8 text. The detection SHALL:

1. Iterate all testcases currently in `state.corpus()`.
2. For each testcase, check whether its input bytes are valid UTF-8 (via `std::str::from_utf8` or equivalent).
3. Count the number of valid UTF-8 inputs (`utf8_count`) and non-UTF-8 inputs (`non_utf8_count`).
4. Enable Grimoire if `utf8_count > non_utf8_count` (strictly greater than).
5. Store the result as a `grimoire_enabled: bool` field on the `Fuzzer` struct.

The detection result persists for the fuzzer's lifetime - it is NOT re-evaluated as the corpus grows, except in the deferred detection case (see below).

#### Scenario: Majority UTF-8 corpus enables Grimoire

- **WHEN** the corpus contains 8 valid UTF-8 inputs and 2 non-UTF-8 inputs
- **THEN** `grimoire_enabled` SHALL be `true`

#### Scenario: Majority non-UTF-8 corpus disables Grimoire

- **WHEN** the corpus contains 3 valid UTF-8 inputs and 7 non-UTF-8 inputs
- **THEN** `grimoire_enabled` SHALL be `false`

#### Scenario: Equal counts disable Grimoire

- **WHEN** the corpus contains 5 valid UTF-8 inputs and 5 non-UTF-8 inputs
- **THEN** `grimoire_enabled` SHALL be `false` (strictly greater-than required)

#### Scenario: All UTF-8 corpus enables Grimoire

- **WHEN** every corpus entry is valid UTF-8
- **THEN** `grimoire_enabled` SHALL be `true`

### Requirement: Explicit Grimoire override via configuration

The `FuzzerConfig` (NAPI config object passed to `Fuzzer::new()`) SHALL accept an optional `grimoire` field:

- `grimoire: true` - Force-enable Grimoire regardless of corpus content.
- `grimoire: false` - Force-disable Grimoire regardless of corpus content.
- `grimoire: undefined` (or field absent) - Use auto-detection.

When an explicit value is provided, corpus scanning SHALL be skipped entirely.

#### Scenario: Explicit enable overrides non-UTF-8 corpus

- **WHEN** `FuzzerConfig.grimoire` is `true`
- **AND** the corpus contains only non-UTF-8 inputs
- **THEN** `grimoire_enabled` SHALL be `true`

#### Scenario: Explicit disable overrides UTF-8 corpus

- **WHEN** `FuzzerConfig.grimoire` is `false`
- **AND** the corpus contains only UTF-8 inputs
- **THEN** `grimoire_enabled` SHALL be `false`

#### Scenario: Absent field triggers auto-detection

- **WHEN** `FuzzerConfig.grimoire` is not provided
- **THEN** auto-detection SHALL run based on corpus content

### Requirement: Deferred detection for empty corpus

When the corpus is empty at `Fuzzer::new()` time and no explicit `grimoire` override is set:

1. Set `grimoire_enabled` to `false` initially.
2. Track the count of interesting inputs found via `reportResult()`. Stage-found entries (added to the corpus via `evaluate_coverage()` during `advanceStage()`) do NOT count toward this threshold.
3. After 10 interesting inputs have been added to the corpus, run the auto-detection scan (as described in the auto-detect requirement) on all current corpus entries (i.e., the 10 newly-found inputs, since the corpus was empty at init).
4. Update `grimoire_enabled` based on the scan result.
5. Do not re-evaluate after this point.

Until the deferred detection fires, generalization and Grimoire stages SHALL be skipped.

#### Scenario: Empty corpus defers detection

- **WHEN** the corpus is empty at initialization
- **AND** no explicit `grimoire` override is set
- **THEN** `grimoire_enabled` SHALL be `false`
- **AND** generalization and Grimoire stages SHALL be skipped

#### Scenario: Deferred detection triggers after 10 interesting inputs

- **WHEN** the 10th interesting input is added to the corpus
- **AND** 8 of the 10 inputs are valid UTF-8
- **THEN** `grimoire_enabled` SHALL be set to `true`
- **AND** subsequent interesting inputs SHALL trigger generalization and Grimoire stages

#### Scenario: Deferred detection with binary inputs

- **WHEN** the 10th interesting input is added to the corpus
- **AND** 7 of the 10 inputs are non-UTF-8
- **THEN** `grimoire_enabled` SHALL remain `false`

#### Scenario: Explicit override bypasses deferred detection

- **WHEN** the corpus is empty at initialization
- **AND** `FuzzerConfig.grimoire` is `true`
- **THEN** `grimoire_enabled` SHALL be `true` immediately
- **AND** no deferred detection SHALL occur

### Requirement: Grimoire state accessible to stage pipeline

The `grimoire_enabled` field SHALL be checked by `beginStage()` and the stage transition logic in `advanceStage()` to determine whether to enter the generalization and Grimoire stages. When `grimoire_enabled` is `false`:

- The stage pipeline SHALL skip generalization and Grimoire stages entirely.
- The I2S stage (which is independent of Grimoire) SHALL still run normally.
- `advanceStage()` transitioning out of `StageState::I2S` SHALL return `null` (pipeline complete) instead of transitioning to `StageState::Generalization`.

#### Scenario: Disabled Grimoire skips post-I2S stages

- **WHEN** `grimoire_enabled` is `false`
- **AND** the I2S stage completes
- **THEN** `advanceStage()` SHALL return `null`
- **AND** `StageState` SHALL transition to `None`

#### Scenario: Enabled Grimoire continues to generalization after I2S

- **WHEN** `grimoire_enabled` is `true`
- **AND** the I2S stage completes
- **THEN** `advanceStage()` SHALL transition to `StageState::Generalization`
- **AND** the generalization stage SHALL begin
