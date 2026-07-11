## MODIFIED Requirements

### Requirement: Prototype pollution detection via snapshot diffing

The prototype pollution detector SHALL monitor built-in JavaScript prototypes for unauthorized modifications during fuzz target execution. It SHALL use a snapshot-and-diff approach:

1. On the first `beforeIteration()`, capture a **pristine table**: the full descriptor of every own property (data, accessor, and function-valued, including symbol keys) on all monitored prototypes. This capture happens once and is not rebuilt on subsequent iterations; it is captured on the first `beforeIteration()` (after user modules and their polyfills have loaded, before any target executes), not in `setup()`.
2. In `afterIteration(targetReturnValue?)`, compare the current state of each monitored prototype against the pristine table.
3. If any own property - of any kind, including function-valued - was added, modified, or deleted on a monitored prototype relative to the pristine table, throw a `VulnerabilityError`.

A function-valued property present in the pristine table (a pre-existing polyfill or built-in method) SHALL NOT be flagged. Only properties that differ from the pristine table are findings.

Additionally, `afterIteration()` SHALL perform a reference leak check on `targetReturnValue` (see the `prototype-reference-leak` capability spec). The snapshot-diff check SHALL run first. If a snapshot-diff finding exists, it SHALL take priority and the reference leak check SHALL be skipped for that iteration.

The detector SHALL have `name: "prototype-pollution"` and `tier: 2`.

#### Scenario: Detect property addition to Object.prototype

- **WHEN** the fuzz target executes code that adds a property to `Object.prototype` (e.g., `Object.prototype.isAdmin = true`)
- **THEN** the detector SHALL throw a `VulnerabilityError` in `afterIteration()`
- **AND** the error's `context` SHALL include the prototype name (`"Object.prototype"`), the property name (`"isAdmin"`), and the change type (`"added"`)

#### Scenario: Detect property modification on Array.prototype

- **WHEN** the fuzz target modifies an existing non-function property on `Array.prototype`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the original and new values

#### Scenario: Ignore pre-existing function-valued properties

- **WHEN** a function-valued property is present on a built-in prototype when the pristine table is captured (a polyfill installed before the first iteration, or a built-in method)
- **AND** the fuzz target does not change it
- **THEN** the detector SHALL NOT throw a `VulnerabilityError` for that property

#### Scenario: Detect a newly-added function-valued property

- **WHEN** the fuzz target adds a function-valued property absent from the pristine table (e.g., `Object.prototype.toJSON = () => {}`)
- **THEN** the detector SHALL throw a `VulnerabilityError` with `changeType: "added"` and `isAccessor: false`

#### Scenario: Detect a replaced built-in method

- **WHEN** the fuzz target replaces an existing built-in method with a different function (e.g., `Array.prototype.map = evil`)
- **THEN** the detector SHALL throw a `VulnerabilityError` with `changeType: "modified"`

#### Scenario: Detect a deleted built-in method

- **WHEN** the fuzz target deletes an existing built-in method (e.g., `delete Array.prototype.push`)
- **THEN** the detector SHALL throw a `VulnerabilityError` with `changeType: "deleted"`

#### Scenario: Clean iteration produces no finding

- **WHEN** the fuzz target executes without modifying any built-in prototypes
- **AND** the fuzz target's return value does not contain references to monitored prototypes
- **THEN** `afterIteration()` SHALL return without throwing

#### Scenario: Detect leaked prototype reference in return value

- **WHEN** the fuzz target does not modify any built-in prototypes
- **AND** the fuzz target returns an object containing a reference to a monitored prototype (e.g., `{ x: Array.prototype }`)
- **THEN** the detector SHALL throw a `VulnerabilityError` with `context.changeType: "leaked-reference"`

#### Scenario: Snapshot-diff finding suppresses reference leak finding

- **WHEN** the fuzz target both mutates `Object.prototype` AND returns `{ x: Array.prototype }`
- **THEN** the detector SHALL throw a `VulnerabilityError` for the snapshot-diff finding (`changeType: "added"` or `"modified"`)
- **AND** the reference leak finding SHALL NOT be reported

### Requirement: Prototype state restoration after detection

The prototype pollution detector SHALL separate detection from restoration:

- In `afterIteration()`, the detector SHALL check ALL monitored prototypes against the pristine table. If pollution is found, it SHALL throw a `VulnerabilityError` for the first finding. `afterIteration()` SHALL NOT restore prototypes - restoration is the responsibility of `resetIteration()`.
- In `resetIteration()`, the detector SHALL restore ALL monitored prototypes to the pristine table state: delete any own property absent from the table (including function-valued properties added during the iteration) and redefine any pristine descriptor whose current descriptor differs. `resetIteration()` SHALL NOT throw.

This separation ensures that prototype restoration occurs regardless of whether `afterIteration()` was called. When a module-hook detector fires (e.g., command injection), the target execution ends with a crash and `afterIteration()` is not called - but `resetIteration()` still runs unconditionally via `endIteration()`, preventing polluted prototypes from persisting.

Because the pristine table is captured once and not re-baselined, a mutation that cannot be restored (a non-configurable redefine) or a legitimate late polyfill installed during a later iteration SHALL be re-detected on subsequent iterations rather than absorbed into a new baseline. This is acceptable: `stopOnCrash` defaults true (the campaign stops on the first finding) and repeated identical findings are deduplicated.

#### Scenario: Pollution is cleaned up after detection

- **WHEN** a `VulnerabilityError` is thrown for prototype pollution (via `afterIteration()`)
- **AND** the fuzz loop catches the error and continues (e.g., `stopOnCrash` is false)
- **THEN** `resetIteration()` SHALL restore all monitored prototypes to the pristine table state
- **AND** all monitored prototypes SHALL have been restored, not just the one reported in the error

#### Scenario: Function pollution is cleaned up

- **WHEN** the fuzz target adds, replaces, or deletes a function-valued property on a monitored prototype
- **AND** the property was configurable
- **THEN** `resetIteration()` SHALL restore that property to its pristine-table state (deleting an addition, or redefining a replacement/deletion back to the original function)

#### Scenario: Pollution is cleaned up when afterIteration is not called

- **WHEN** a target execution causes prototype pollution
- **AND** the target also triggers a module-hook VulnerabilityError (e.g., command injection) or a regular crash
- **AND** `afterIteration()` is NOT called (because the target did not complete normally)
- **THEN** `resetIteration()` SHALL still restore all monitored prototypes to the pristine table state
- **AND** the prototype pollution detector SHALL NOT be blinded for future iterations

#### Scenario: resetIteration is idempotent

- **WHEN** `afterIteration()` detects pollution and `resetIteration()` runs afterward
- **THEN** `resetIteration()` SHALL find the polluted properties and perform the restore (since `afterIteration()` only detects, it does not restore)
- **AND** if `resetIteration()` is called again without an intervening iteration, it SHALL make no further changes (nothing remains to restore)

#### Scenario: Pristine table persists across a campaign

- **WHEN** one iteration pollutes a monitored prototype, is detected, and is reset
- **AND** a later iteration in the same campaign introduces a fresh pollution
- **THEN** the later pollution SHALL still be detected against the pristine table captured on the first iteration (the table is not cleared between iterations)
