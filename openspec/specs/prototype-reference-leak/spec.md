## Purpose

Detection of leaked built-in prototype references in fuzz target return values via identity comparison, including the bounded object walk, depth limits, cycle safety, and `VulnerabilityError` reporting with `changeType: "leaked-reference"`.

## Requirements

### Requirement: Prototype reference leak detection via identity walk

The prototype pollution detector SHALL check the fuzz target's return value for leaked references to monitored built-in prototypes. After the target completes without throwing, the detector SHALL walk the return value and compare each reachable object value against all monitored prototypes using strict identity (`===`).

If any reachable value is identical to a monitored prototype, the detector SHALL throw a `VulnerabilityError` with:
- `vulnerabilityType`: `"Prototype Pollution"`
- `context.changeType`: `"leaked-reference"`
- `context.prototype`: the name of the matched prototype (e.g., `"Array.prototype"`)
- `context.keyPath`: the dot-joined key path from the root to the leaked reference (e.g., `"x"` or `"x.y"`)

This check SHALL run alongside the existing snapshot-diff check in `afterIteration()`, not replace it. If both a snapshot-diff finding and a reference leak finding exist in the same iteration, the snapshot-diff finding SHALL take priority (it represents a more severe condition - actual mutation).

If multiple reachable values are prototype references, the detector SHALL report only the first one encountered during the walk.

#### Scenario: Detect leaked Array.prototype in return value

- **WHEN** the fuzz target returns an object `{ x: Array.prototype }`
- **AND** the detector's `afterIteration(returnValue)` is called with that object
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include `prototype: "Array.prototype"`, `changeType: "leaked-reference"`, and `keyPath: "x"`

#### Scenario: Detect leaked Object.prototype nested one level deep

- **WHEN** the fuzz target returns `{ a: { b: Object.prototype } }`
- **AND** the detector's `afterIteration(returnValue)` is called with that object
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context.keyPath` SHALL be `"a.b"`

#### Scenario: Return value is the prototype itself

- **WHEN** the fuzz target returns `Array.prototype` directly
- **AND** the detector's `afterIteration(returnValue)` is called with that value
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context.keyPath` SHALL be `""` (empty string, indicating the root)

#### Scenario: No leak in return value

- **WHEN** the fuzz target returns a plain object `{ x: 1, y: "hello" }`
- **THEN** the detector SHALL NOT throw a `VulnerabilityError` from the reference leak check

#### Scenario: Return value is undefined

- **WHEN** the fuzz target returns `undefined` (no explicit return)
- **THEN** the reference leak check SHALL be a no-op (no walk performed, no error thrown)

#### Scenario: Return value is a primitive

- **WHEN** the fuzz target returns a string, number, boolean, null, or bigint
- **THEN** the reference leak check SHALL be a no-op

#### Scenario: Snapshot-diff finding takes priority over reference leak

- **WHEN** the fuzz target both mutates `Object.prototype` directly AND returns an object containing a reference to `Array.prototype`
- **THEN** the detector SHALL throw a `VulnerabilityError` for the snapshot-diff finding (the direct mutation)
- **AND** the reference leak finding SHALL be suppressed for that iteration

#### Scenario: Return value is an array containing a prototype reference

- **WHEN** the fuzz target returns `[Array.prototype]`
- **AND** the detector's `afterIteration(returnValue)` is called with that array
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context.keyPath` SHALL be `"0"` (the array index as a string key)

#### Scenario: Multiple prototype references reports first encountered

- **WHEN** the fuzz target returns `{ a: Array.prototype, b: Object.prototype }`
- **THEN** the detector SHALL throw a `VulnerabilityError` for one of the leaked references
- **AND** only one `VulnerabilityError` SHALL be thrown (not both)

#### Scenario: Object.keys() throws on exotic return value

- **WHEN** the fuzz target returns an object containing a child whose `ownKeys` trap throws (e.g., a revoked Proxy)
- **THEN** the walk SHALL skip the unwalkable subtree without throwing
- **AND** the walk SHALL continue checking sibling branches
- **AND** if no leak is found in walkable branches, no `VulnerabilityError` SHALL be thrown

#### Scenario: Leak detected alongside unwalkable sibling

- **WHEN** the fuzz target returns an object with both an unwalkable child (e.g., a revoked Proxy) and a sibling containing a prototype reference
- **THEN** the detector SHALL detect the leaked reference in the walkable sibling
- **AND** the unwalkable subtree SHALL be silently skipped

### Requirement: Walk depth limit

The reference leak walk SHALL be bounded to a maximum depth of 3 levels from the root return value. The root value itself is depth 0; its direct properties are depth 1; their properties are depth 2; their properties are depth 3.

Values at depth greater than 3 SHALL NOT be visited.

#### Scenario: Reference at depth 3 is detected

- **WHEN** the fuzz target returns `{ a: { b: { c: Object.prototype } } }`
- **THEN** the detector SHALL detect the leaked reference at key path `"a.b.c"`

#### Scenario: Reference at depth 4 is not detected

- **WHEN** the fuzz target returns `{ a: { b: { c: { d: Object.prototype } } } }`
- **THEN** the detector SHALL NOT detect the leaked reference (depth exceeds limit)

### Requirement: Cycle safety

The reference leak walk SHALL track visited objects using a `Set<object>` to prevent infinite loops when the return value contains circular references. If an object has already been visited, the walk SHALL skip it without error.

#### Scenario: Circular reference does not cause infinite loop

- **WHEN** the fuzz target returns an object `obj` where `obj.self === obj` (circular reference)
- **AND** `obj` is not a monitored prototype
- **THEN** the walk SHALL terminate without hanging or throwing
- **AND** no `VulnerabilityError` SHALL be thrown (no prototype reference found)

#### Scenario: Circular reference containing a prototype leak is detected

- **WHEN** the fuzz target returns `{ a: Array.prototype, self: <circular> }`
- **THEN** the detector SHALL detect the leaked reference at key path `"a"`
- **AND** the walk SHALL not revisit the circular reference

### Requirement: Walk traversal scope

The reference leak walk SHALL enumerate only own enumerable string-keyed properties via `Object.keys()`. Symbol-keyed properties and non-enumerable properties SHALL NOT be traversed.

#### Scenario: Symbol-keyed property containing prototype is not detected

- **WHEN** the fuzz target returns `{ [Symbol("key")]: Object.prototype }`
- **THEN** the detector SHALL NOT detect the leaked reference

#### Scenario: Non-enumerable property containing prototype is not detected

- **WHEN** the fuzz target returns an object with a non-enumerable property whose value is `Object.prototype`
- **THEN** the detector SHALL NOT detect the leaked reference

#### Scenario: Map/Set entries containing prototype are not detected

- **WHEN** the fuzz target returns `new Map([["x", Array.prototype]])`
- **THEN** the detector SHALL NOT detect the leaked reference (Map entries are internal, not own enumerable string-keyed properties)
