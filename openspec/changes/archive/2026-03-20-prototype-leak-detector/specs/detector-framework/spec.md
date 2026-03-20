## MODIFIED Requirements

### Requirement: Detector interface

The system SHALL define a `Detector` interface with the following lifecycle hooks:

- `name` (readonly string): Unique identifier for the detector (kebab-case, e.g., `"prototype-pollution"`).
- `tier` (readonly 1 | 2): Classification determining default-on (1) or opt-in (2) behavior.
- `getTokens()`: Returns an array of `Uint8Array` tokens to pre-seed in the mutation dictionary.
- `setup()`: Called once before fuzzing begins. Installs module hooks or initializes state.
- `beforeIteration()`: Called before each target execution. Captures baseline state for snapshot-based detectors.
- `afterIteration(targetReturnValue?: unknown)`: Called after target execution completes without throwing. Receives the target's return value (or `undefined` if the target did not return a value). Checks for violations and throws `VulnerabilityError` if a condition is met. SHALL NOT be called when the target crashed or timed out. SHALL NOT perform state restoration - that is the responsibility of `resetIteration()`.
- `resetIteration()`: Called after every iteration regardless of exit kind. Restores any per-iteration state captured by `beforeIteration()` (e.g., prototype restoration). SHALL NOT throw. If restoration fails, the detector SHALL make a best-effort attempt and continue silently.
- `teardown()`: Called after fuzzing ends. Restores any patched modules.

#### Scenario: Detector implements all lifecycle hooks

- **WHEN** a detector is registered with the `DetectorManager`
- **THEN** the detector SHALL implement all seven interface members
- **AND** the `name` SHALL be a non-empty kebab-case string
- **AND** the `tier` SHALL be either `1` or `2`

#### Scenario: afterIteration receives target return value

- **WHEN** the target completes without throwing and returns a value
- **THEN** `afterIteration()` SHALL be called with the target's return value as the first argument

#### Scenario: afterIteration receives undefined when target has no return value

- **WHEN** the target completes without throwing and does not explicitly return a value
- **THEN** `afterIteration()` SHALL be called with `undefined` as the first argument

#### Scenario: Existing detectors ignoring the parameter still satisfy the interface

- **WHEN** a detector implements `afterIteration()` with no parameters (e.g., `afterIteration(): void`)
- **THEN** it SHALL still satisfy the `Detector` interface (the parameter is optional)

#### Scenario: resetIteration called after Ok exit

- **WHEN** the target completes without throwing
- **AND** `afterIteration()` has been called (which may or may not throw)
- **THEN** `resetIteration()` SHALL be called on every active detector
- **AND** `resetIteration()` SHALL run even if `afterIteration()` threw a `VulnerabilityError`

#### Scenario: resetIteration called after crash exit

- **WHEN** the target throws during execution
- **THEN** `afterIteration()` SHALL NOT be called
- **AND** `resetIteration()` SHALL be called on every active detector
- **AND** any per-iteration state captured by `beforeIteration()` SHALL be restored

#### Scenario: resetIteration called after timeout exit

- **WHEN** the watchdog fires
- **THEN** `afterIteration()` SHALL NOT be called
- **AND** `resetIteration()` SHALL be called on every active detector

#### Scenario: resetIteration does not throw

- **WHEN** `resetIteration()` encounters an error during state restoration
- **THEN** it SHALL NOT throw
- **AND** it SHALL make a best-effort attempt to restore state

### Requirement: DetectorManager orchestration

The system SHALL provide a `DetectorManager` class that:

- Accepts the `detectors` configuration from `FuzzOptions` in its constructor.
- Resolves which detectors are active: Tier 1 detectors are enabled by default unless explicitly disabled; Tier 2 detectors are disabled by default unless explicitly enabled.
- Instantiates active detectors with their resolved options.
- Delegates lifecycle calls (`setup`, `beforeIteration`, `resetIteration`, `teardown`) to all active detectors. The `afterIteration()` delegation is internal to `endIteration()` and SHALL NOT be exposed as a public method on `DetectorManager`.
- Collects dictionary tokens from all active detectors via `getTokens()`.
- Drains and discards any stale module-hook stash in `beforeIteration()` before activating detectors (defensive guard against stash leaks from incomplete prior iterations).
- Provides an `endIteration(targetCompletedOk, targetReturnValue?)` method that encapsulates the full post-execution protocol.

The `endIteration(targetCompletedOk: boolean, targetReturnValue?: unknown)` method SHALL:

1. Drain the module-hook stash via `drainStashedVulnerabilityError()` before any other work.
2. If `targetCompletedOk` is `true`: call `afterIteration(targetReturnValue)` on each active detector, collecting the first `VulnerabilityError` thrown (continuing to call remaining detectors even after an error). Return the `afterIteration()` error if present, otherwise return the drained stash error.
3. If `targetCompletedOk` is `false`: return the drained stash error (do NOT call `afterIteration()`).
4. Regardless of `targetCompletedOk`: call `resetIteration()` on every active detector in a `finally` block.
5. Regardless of `targetCompletedOk`: set the detector active flag to `false` in a `finally` block.
6. If `afterIteration()` throws a non-`VulnerabilityError` exception and a stashed `VulnerabilityError` exists, return the stashed finding (the real vulnerability takes priority over a detector bug). Only re-throw the non-`VulnerabilityError` when no stashed finding exists.

The parameter type for `targetCompletedOk` SHALL be `boolean` (not `ExitKind`) to avoid coupling the detector framework to `@vitiate/engine`. The only branching is "target completed normally" vs "target did not complete normally."

The `setDetectorActive()` function SHALL be an internal implementation detail of `DetectorManager`. External callers (e.g., `loop.ts`) SHALL NOT import or call `setDetectorActive()` directly. Only `DetectorManager.beforeIteration()` and `DetectorManager.endIteration()` SHALL control the detector active flag.

#### Scenario: Default configuration enables Tier 1 only

- **WHEN** `DetectorManager` is constructed with `undefined` (no `detectors` config)
- **THEN** all Tier 1 detectors SHALL be active
- **AND** no Tier 2 detectors SHALL be active

#### Scenario: Explicit disable overrides tier default

- **WHEN** `DetectorManager` is constructed with `{ prototypePollution: false }`
- **THEN** the prototype pollution detector SHALL NOT be active
- **AND** the other Tier 1 detectors SHALL remain active

#### Scenario: Unknown detector keys are silently ignored

- **WHEN** `DetectorManager` is constructed with `{ futureDetector: true }` (a detector not yet implemented)
- **THEN** the unknown key SHALL be silently ignored
- **AND** all Tier 1 detectors SHALL remain active

#### Scenario: Options object implies enabled

- **WHEN** `DetectorManager` is constructed with `{ pathTraversal: { allowedPaths: ["/var/www"] } }`
- **THEN** the path traversal detector SHALL be active with the specified `allowedPaths`
- **AND** the default `deniedPaths: ["/etc/passwd"]` SHALL apply

#### Scenario: Lifecycle delegation order

- **WHEN** multiple detectors are active
- **THEN** `beforeIteration()` SHALL call each detector's `beforeIteration()` in registration order
- **AND** `endIteration()` SHALL drain the module-hook stash before calling `afterIteration()`
- **AND** `endIteration()` SHALL call each detector's `afterIteration(targetReturnValue)` in registration order (when `targetCompletedOk` is true)
- **AND** if any detector's `afterIteration()` throws, the manager SHALL continue calling remaining detectors' `afterIteration()` before collecting the first error
- **AND** `endIteration()` SHALL call each detector's `resetIteration()` in registration order (always)

#### Scenario: Teardown runs even after errors

- **WHEN** `teardown()` is called on the `DetectorManager`
- **THEN** the module-hook stash SHALL be drained (cleared) before detector teardown
- **AND** every active detector's `teardown()` SHALL be called regardless of whether errors occurred during fuzzing

#### Scenario: endIteration forwards return value to afterIteration

- **WHEN** `endIteration(true, someValue)` is called
- **THEN** each active detector's `afterIteration(someValue)` SHALL be called with `someValue`

#### Scenario: endIteration with no return value passes undefined

- **WHEN** `endIteration(true)` is called without a second argument
- **THEN** each active detector's `afterIteration(undefined)` SHALL be called

#### Scenario: endIteration returns afterIteration finding on Ok exit (takes priority over stash)

- **WHEN** `endIteration(true, returnValue)` is called
- **AND** a detector's `afterIteration()` throws a `VulnerabilityError`
- **THEN** `endIteration` SHALL return the `afterIteration()` `VulnerabilityError`
- **AND** the stash SHALL have been drained (cleared) before `afterIteration()` was called
- **AND** any stashed hook error SHALL be discarded (afterIteration finding takes priority)
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns stashed hook error on Ok exit when afterIteration finds nothing

- **WHEN** `endIteration(true, returnValue)` is called
- **AND** no detector's `afterIteration()` throws
- **AND** a `VulnerabilityError` was stashed during hook execution (target swallowed the throw)
- **THEN** `endIteration` SHALL return the stashed `VulnerabilityError`
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns undefined on Ok exit without any finding

- **WHEN** `endIteration(true, returnValue)` is called
- **AND** no detector's `afterIteration()` throws
- **AND** no `VulnerabilityError` was stashed
- **THEN** `endIteration` SHALL return `undefined`
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns stashed hook error on non-Ok exit

- **WHEN** `endIteration(false)` is called
- **AND** a `VulnerabilityError` was stashed during hook execution
- **THEN** no detector's `afterIteration()` SHALL be called
- **AND** `endIteration` SHALL return the stashed `VulnerabilityError`
- **AND** `resetIteration()` SHALL be called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns undefined on non-Ok exit without stashed error

- **WHEN** `endIteration(false)` is called
- **AND** no `VulnerabilityError` was stashed
- **THEN** no detector's `afterIteration()` SHALL be called
- **AND** `resetIteration()` SHALL be called on all detectors
- **AND** the detector active flag SHALL be `false`
- **AND** `endIteration` SHALL return `undefined`

#### Scenario: endIteration returns stashed finding when afterIteration throws non-VulnerabilityError

- **WHEN** `endIteration(true, returnValue)` is called
- **AND** a detector's `afterIteration()` throws a non-VulnerabilityError exception
- **AND** a `VulnerabilityError` was stashed during hook execution
- **THEN** `endIteration` SHALL return the stashed `VulnerabilityError` (finding takes priority over detector bug)
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration re-throws non-VulnerabilityError when no stashed finding

- **WHEN** `endIteration(true, returnValue)` is called
- **AND** a detector's `afterIteration()` throws a non-VulnerabilityError exception
- **AND** no `VulnerabilityError` was stashed
- **THEN** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`
- **AND** `endIteration` SHALL re-throw the non-VulnerabilityError exception

#### Scenario: beforeIteration drains stale stash

- **WHEN** `beforeIteration()` is called
- **AND** a `VulnerabilityError` remains in the module-hook stash from a prior iteration (e.g., `endIteration()` was never called)
- **THEN** the stale stash SHALL be drained and discarded
- **AND** detectors SHALL be activated normally

#### Scenario: afterIteration is not a public method on DetectorManager

- **WHEN** external code (e.g., `loop.ts`, `fuzz.ts`) interacts with the `DetectorManager`
- **THEN** the `afterIteration()` method SHALL NOT be accessible as a public API
- **AND** the only way to trigger detector checks SHALL be through `endIteration()`
