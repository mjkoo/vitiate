## ADDED Requirements

### Requirement: Prototype pollution detection via snapshot diffing

The prototype pollution detector SHALL monitor built-in JavaScript prototypes for unauthorized modifications during fuzz target execution. It SHALL use a snapshot-and-diff approach:

1. In `beforeIteration()`, capture a snapshot of own-property names and non-function property values on all monitored prototypes.
2. In `afterIteration()`, compare the current state against the snapshot.
3. If any non-function own-property was added, modified, or deleted on a monitored prototype, throw a `VulnerabilityError`.

The detector SHALL have `name: "prototype-pollution"` and `tier: 1`.

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
- **THEN** `afterIteration()` SHALL return without throwing

### Requirement: Monitored prototypes

The detector SHALL monitor the following built-in prototypes:

- `Object.prototype`
- `Array.prototype`
- `String.prototype`
- `Number.prototype`
- `Boolean.prototype`
- `Function.prototype`
- `RegExp.prototype`
- `Date.prototype`
- `Map.prototype`
- `Set.prototype`
- `Promise.prototype`
- `Error.prototype`
- `WeakMap.prototype`
- `WeakSet.prototype`
- `ArrayBuffer.prototype`
- `Int8Array.prototype`, `Uint8Array.prototype`, `Int16Array.prototype`, `Uint16Array.prototype`, `Int32Array.prototype`, `Uint32Array.prototype`, `Float32Array.prototype`, `Float64Array.prototype`, `BigInt64Array.prototype`, `BigUint64Array.prototype`

#### Scenario: All monitored prototypes are checked

- **WHEN** `afterIteration()` runs
- **THEN** the detector SHALL compare all listed prototypes against their `beforeIteration()` snapshots

### Requirement: Prototype state restoration after detection

In `afterIteration()`, the detector SHALL check ALL monitored prototypes before throwing. For each polluted prototype found, the detector SHALL restore it to its pre-iteration snapshot state. After all prototypes have been checked and restored, the detector SHALL throw a `VulnerabilityError` for the first finding. This ensures that all pollution is cleaned up even when multiple prototypes are modified in a single iteration.

#### Scenario: Pollution is cleaned up after detection

- **WHEN** a `VulnerabilityError` is thrown for prototype pollution
- **AND** the fuzz loop catches the error and continues (e.g., `stopOnCrash` is false)
- **THEN** the next iteration's `beforeIteration()` snapshot SHALL reflect the original (unpolluted) prototype state
- **AND** all monitored prototypes SHALL have been restored, not just the one reported in the error

### Requirement: Prototype pollution dictionary tokens

The detector's `getTokens()` SHALL return tokens that guide the mutator toward producing prototype-pollution-triggering inputs:

- `__proto__`
- `constructor`
- `prototype`
- `__defineGetter__`
- `__defineSetter__`
- `__lookupGetter__`
- `__lookupSetter__`

#### Scenario: Tokens are returned as Uint8Array

- **WHEN** `getTokens()` is called
- **THEN** each token SHALL be returned as a UTF-8 encoded `Uint8Array`
- **AND** the returned array SHALL contain at least the seven tokens listed above
