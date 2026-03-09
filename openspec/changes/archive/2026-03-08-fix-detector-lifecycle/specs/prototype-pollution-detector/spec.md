## MODIFIED Requirements

### Requirement: Prototype state restoration after detection

The prototype pollution detector SHALL separate detection from restoration:

- In `afterIteration()`, the detector SHALL check ALL monitored prototypes against their `beforeIteration()` snapshots. If pollution is found, it SHALL throw a `VulnerabilityError` for the first finding. `afterIteration()` SHALL NOT restore prototypes — restoration is the responsibility of `resetIteration()`.
- In `resetIteration()`, the detector SHALL restore ALL monitored prototypes to their `beforeIteration()` snapshot state. For each polluted prototype found, the detector SHALL delete added properties and restore modified/deleted properties. `resetIteration()` SHALL NOT throw.

This separation ensures that prototype restoration occurs regardless of whether `afterIteration()` was called. When a module-hook detector fires (e.g., command injection), the target execution ends with a crash and `afterIteration()` is not called — but `resetIteration()` still runs unconditionally via `endIteration()`, preventing polluted prototypes from persisting as the baseline for future iterations.

#### Scenario: Pollution is cleaned up after detection

- **WHEN** a `VulnerabilityError` is thrown for prototype pollution (via `afterIteration()`)
- **AND** the fuzz loop catches the error and continues (e.g., `stopOnCrash` is false)
- **THEN** `resetIteration()` SHALL restore all monitored prototypes to their pre-iteration state
- **AND** the next iteration's `beforeIteration()` snapshot SHALL reflect the original (unpolluted) prototype state
- **AND** all monitored prototypes SHALL have been restored, not just the one reported in the error

#### Scenario: Pollution is cleaned up when afterIteration is not called

- **WHEN** a target execution causes prototype pollution
- **AND** the target also triggers a module-hook VulnerabilityError (e.g., command injection) or a regular crash
- **AND** `afterIteration()` is NOT called (because the target did not complete normally)
- **THEN** `resetIteration()` SHALL still restore all monitored prototypes to their pre-iteration state
- **AND** the prototype pollution detector SHALL NOT be blinded for future iterations

#### Scenario: resetIteration is idempotent

- **WHEN** `afterIteration()` detects pollution and `resetIteration()` runs afterward
- **THEN** `resetIteration()` SHALL find the polluted properties and perform the full restore (since `afterIteration()` only detects, it does not restore)
- **AND** if `resetIteration()` is called again without an intervening `beforeIteration()`, it SHALL be a no-op (no remaining differences to restore)
