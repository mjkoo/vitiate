## ADDED Requirements

### Requirement: Generalization execution cap

The generalization stage SHALL be bounded to at most `MAX_GENERALIZATION_EXECS` target executions per corpus entry, so that the Offset/Delimiter/Bracket gap-finding sweep cannot spend an unbounded number of target calls on a single large entry.

The engine SHALL track the number of generalization executions spent on the current entry, resetting the counter when generalization begins and incrementing it on each generalization execution. When the counter reaches `MAX_GENERALIZATION_EXECS` outside the verification phase, the stage SHALL finalize early using the payload generalized so far - storing `GeneralizedInputMetadata` and performing the normal transition to the Grimoire/unicode stages - rather than aborting or continuing the sweep to natural completion.

The verification execution SHALL never be cut short by the cap (the cap is far greater than 1), so a genuine generalization always runs at least the verification execution.

#### Scenario: Generalization finalizes early at the cap

- **WHEN** a generalization stage reaches `MAX_GENERALIZATION_EXECS` executions while in a gap-finding phase
- **THEN** the stage SHALL finalize with the payload generalized so far
- **AND** the corpus entry SHALL have `GeneralizedInputMetadata` stored
- **AND** the stage SHALL transition normally (to Grimoire/unicode if enabled, otherwise to `None`)

#### Scenario: Verification is not capped

- **WHEN** a generalization stage is in the verification phase
- **THEN** the exec cap SHALL NOT terminate the stage regardless of the counter
