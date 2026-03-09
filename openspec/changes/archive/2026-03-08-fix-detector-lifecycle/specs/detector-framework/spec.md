## MODIFIED Requirements

### Requirement: Detector interface

The system SHALL define a `Detector` interface with the following lifecycle hooks:

- `name` (readonly string): Unique identifier for the detector (kebab-case, e.g., `"prototype-pollution"`).
- `tier` (readonly 1 | 2): Classification determining default-on (1) or opt-in (2) behavior.
- `getTokens()`: Returns an array of `Uint8Array` tokens to pre-seed in the mutation dictionary.
- `setup()`: Called once before fuzzing begins. Installs module hooks or initializes state.
- `beforeIteration()`: Called before each target execution. Captures baseline state for snapshot-based detectors.
- `afterIteration()`: Called after target execution completes without throwing. Checks for violations and throws `VulnerabilityError` if a condition is met. SHALL NOT be called when the target crashed or timed out. SHALL NOT perform state restoration — that is the responsibility of `resetIteration()`.
- `resetIteration()`: Called after every iteration regardless of exit kind. Restores any per-iteration state captured by `beforeIteration()` (e.g., prototype restoration). SHALL NOT throw. If restoration fails, the detector SHALL make a best-effort attempt and continue silently.
- `teardown()`: Called after fuzzing ends. Restores any patched modules.

#### Scenario: Detector implements all lifecycle hooks

- **WHEN** a detector is registered with the `DetectorManager`
- **THEN** the detector SHALL implement all seven interface members
- **AND** the `name` SHALL be a non-empty kebab-case string
- **AND** the `tier` SHALL be either `1` or `2`

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
- Provides an `endIteration(targetCompletedOk)` method that encapsulates the full post-execution protocol.

The `endIteration(targetCompletedOk: boolean)` method SHALL:

1. If `targetCompletedOk` is `true`: call `afterIteration()` on each active detector, collecting the first `VulnerabilityError` thrown (continuing to call remaining detectors even after an error).
2. Regardless of `targetCompletedOk`: call `resetIteration()` on every active detector in a `finally` block.
3. Regardless of `targetCompletedOk`: set the detector active flag to `false` in a `finally` block.
4. Return the first `VulnerabilityError` if one was thrown, or `undefined` if no detector found a violation.
5. Re-throw any non-`VulnerabilityError` exception (indicating a bug in the detector, not a finding).

The parameter type SHALL be `boolean` (not `ExitKind`) to avoid coupling the detector framework to `vitiate-napi`. The only branching is "target completed normally" vs "target did not complete normally."

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

- **WHEN** `DetectorManager` is constructed with `{ ssrf: true }` (a Tier 2 detector not yet implemented)
- **THEN** the unknown key SHALL be silently ignored
- **AND** all Tier 1 detectors SHALL remain active

#### Scenario: Options object implies enabled

- **WHEN** `DetectorManager` is constructed with `{ pathTraversal: { sandboxRoot: "/var/www" } }`
- **THEN** the path traversal detector SHALL be active with `sandboxRoot` set to `"/var/www"`

#### Scenario: Lifecycle delegation order

- **WHEN** multiple detectors are active
- **THEN** `beforeIteration()` SHALL call each detector's `beforeIteration()` in registration order
- **AND** `endIteration()` SHALL call each detector's `afterIteration()` in registration order (when `targetCompletedOk` is true)
- **AND** if any detector's `afterIteration()` throws, the manager SHALL continue calling remaining detectors' `afterIteration()` before collecting the first error
- **AND** `endIteration()` SHALL call each detector's `resetIteration()` in registration order (always)

#### Scenario: Teardown runs even after errors

- **WHEN** `teardown()` is called on the `DetectorManager`
- **THEN** every active detector's `teardown()` SHALL be called regardless of whether errors occurred during fuzzing

#### Scenario: endIteration returns VulnerabilityError on Ok exit with finding

- **WHEN** `endIteration(true)` is called
- **AND** a detector's `afterIteration()` throws a `VulnerabilityError`
- **THEN** `endIteration` SHALL return the `VulnerabilityError`
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns undefined on Ok exit without finding

- **WHEN** `endIteration(true)` is called
- **AND** no detector's `afterIteration()` throws
- **THEN** `endIteration` SHALL return `undefined`
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration skips checks on non-Ok exit but runs reset

- **WHEN** `endIteration(false)` is called
- **THEN** no detector's `afterIteration()` SHALL be called
- **AND** `resetIteration()` SHALL be called on all detectors
- **AND** the detector active flag SHALL be `false`
- **AND** `endIteration` SHALL return `undefined`

#### Scenario: endIteration re-throws non-VulnerabilityError

- **WHEN** `endIteration(true)` is called
- **AND** a detector's `afterIteration()` throws a non-VulnerabilityError exception
- **THEN** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`
- **AND** `endIteration` SHALL re-throw the non-VulnerabilityError exception

#### Scenario: afterIteration is not a public method on DetectorManager

- **WHEN** external code (e.g., `loop.ts`, `fuzz.ts`) interacts with the `DetectorManager`
- **THEN** the `afterIteration()` method SHALL NOT be accessible as a public API
- **AND** the only way to trigger detector checks SHALL be through `endIteration()`

### Requirement: Module hooking utility

The system SHALL provide a utility for safely monkey-patching Node built-in module exports. The utility SHALL:

- Accept a module specifier (e.g., `"child_process"`, `"fs"`) and a function name.
- Replace the exported function with a wrapper that runs a detector check before calling the original.
- Store the original function reference for restoration.
- Restore the original function when `restore()` is called.
- Support hooking the same function from multiple detectors (hooks compose as a chain).

#### Scenario: Hook intercepts function call

- **WHEN** a hook is installed on `child_process.exec`
- **AND** the target calls `exec("ls")`
- **THEN** the hook wrapper SHALL execute the detector check with the arguments
- **AND** if the check passes, the original `exec` function SHALL be called with the same arguments

#### Scenario: Hook restoration

- **WHEN** `restore()` is called on a hook
- **THEN** the module export SHALL be restored to the original function
- **AND** subsequent calls SHALL bypass the detector check

#### Scenario: Hook is gated by iteration window

- **WHEN** a hooked function is called outside the `beforeIteration()`/`endIteration()` window (e.g., during Vite module resolution or fuzzer setup)
- **THEN** the hook SHALL pass through to the original function without running the detector check
