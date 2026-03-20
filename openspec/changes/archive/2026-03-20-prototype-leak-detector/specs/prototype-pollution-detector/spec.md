## MODIFIED Requirements

### Requirement: Prototype pollution detection via snapshot diffing

The prototype pollution detector SHALL monitor built-in JavaScript prototypes for unauthorized modifications during fuzz target execution. It SHALL use a snapshot-and-diff approach:

1. In `beforeIteration()`, capture a snapshot of own-property names and non-function property values on all monitored prototypes.
2. In `afterIteration(targetReturnValue?)`, compare the current state against the snapshot.
3. If any non-function own-property was added, modified, or deleted on a monitored prototype, throw a `VulnerabilityError`.

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

#### Scenario: Ignore function-valued property additions

- **WHEN** the fuzz target adds a function-valued property to a built-in prototype (e.g., a polyfill)
- **THEN** the detector SHALL NOT throw a `VulnerabilityError`

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
