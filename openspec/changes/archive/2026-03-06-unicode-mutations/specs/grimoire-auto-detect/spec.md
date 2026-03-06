## MODIFIED Requirements

### Requirement: Grimoire state accessible to stage pipeline

The `grimoire_enabled` field SHALL be checked by `beginStage()` and the stage transition logic in `advanceStage()` to determine whether to enter the generalization and Grimoire stages. When `grimoire_enabled` is `false`:

- The stage pipeline SHALL skip generalization and Grimoire stages entirely.
- The I2S stage (which is independent of Grimoire) SHALL still run normally.
- `advanceStage()` transitioning out of `StageState::I2S` SHALL transition to `StageState::Unicode` (if unicode is enabled and the corpus entry has valid UTF-8 regions) instead of returning `null`.
- If unicode is also disabled or not applicable (disabled, or no valid UTF-8 regions exist), `advanceStage()` SHALL return `null` (pipeline complete).

#### Scenario: Disabled Grimoire skips to unicode after I2S

- **WHEN** `grimoire_enabled` is `false`
- **AND** the I2S stage completes
- **AND** unicode is enabled
- **AND** the corpus entry has valid UTF-8 regions
- **THEN** `advanceStage()` SHALL transition from `I2S` to `Unicode`
- **AND** the method SHALL return a non-null `Buffer` containing the first unicode-mutated input

#### Scenario: Disabled Grimoire and disabled unicode completes pipeline

- **WHEN** `grimoire_enabled` is `false`
- **AND** the I2S stage completes
- **AND** unicode is disabled (or no valid UTF-8 regions exist)
- **THEN** `advanceStage()` SHALL return `null`
- **AND** `StageState` SHALL transition to `None`

#### Scenario: Enabled Grimoire continues to generalization after I2S

- **WHEN** `grimoire_enabled` is `true`
- **AND** the I2S stage completes
- **THEN** `advanceStage()` SHALL transition to `StageState::Generalization`
- **AND** the generalization stage SHALL begin
