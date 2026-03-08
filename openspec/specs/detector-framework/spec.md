## Purpose

Core framework for bug detectors: the `Detector` interface, `VulnerabilityError` type, `DetectorManager` orchestration, module hooking utility, and detector configuration schema.

## Requirements

### Requirement: Detector interface

The system SHALL define a `Detector` interface with the following lifecycle hooks:

- `name` (readonly string): Unique identifier for the detector (kebab-case, e.g., `"prototype-pollution"`).
- `tier` (readonly 1 | 2): Classification determining default-on (1) or opt-in (2) behavior.
- `getTokens()`: Returns an array of `Uint8Array` tokens to pre-seed in the mutation dictionary.
- `setup()`: Called once before fuzzing begins. Installs module hooks or initializes state.
- `beforeIteration()`: Called before each target execution. Captures baseline state for snapshot-based detectors.
- `afterIteration()`: Called after target execution completes without throwing. Checks for violations and throws `VulnerabilityError` if a condition is met.
- `teardown()`: Called after fuzzing ends. Restores any patched modules.

#### Scenario: Detector implements all lifecycle hooks

- **WHEN** a detector is registered with the `DetectorManager`
- **THEN** the detector SHALL implement all six interface members
- **AND** the `name` SHALL be a non-empty kebab-case string
- **AND** the `tier` SHALL be either `1` or `2`

### Requirement: VulnerabilityError type

The system SHALL define a `VulnerabilityError` class that extends `Error`. It SHALL include:

- `detectorName` (string): The name of the detector that fired (matches `Detector.name`).
- `vulnerabilityType` (string): Human-readable vulnerability category (e.g., `"Prototype Pollution"`, `"Command Injection"`).
- `context` (Record<string, unknown>): Structured metadata about the finding (e.g., which function was called, what argument triggered it, which prototype was modified).

The error message SHALL include the detector name, vulnerability type, and a human-readable summary of the finding.

#### Scenario: VulnerabilityError is instanceof Error

- **WHEN** a detector throws a `VulnerabilityError`
- **THEN** the thrown value SHALL be an instance of `Error`
- **AND** `error instanceof VulnerabilityError` SHALL return `true`
- **AND** `error.detectorName` SHALL match the detector's `name` property
- **AND** `error.stack` SHALL include the call site where the vulnerability was triggered

#### Scenario: VulnerabilityError is treated as a crash by the fuzz engine

- **WHEN** a `VulnerabilityError` is thrown during target execution or in `afterIteration()`
- **THEN** the fuzz loop SHALL classify the iteration as `ExitKind.Crash`
- **AND** the Rust engine SHALL receive `ExitKind.Crash` via `reportResult()`
- **AND** the engine SHALL evaluate it against `CrashFeedback` like any other crash

### Requirement: DetectorManager orchestration

The system SHALL provide a `DetectorManager` class that:

- Accepts the `detectors` configuration from `FuzzOptions` in its constructor.
- Resolves which detectors are active: Tier 1 detectors are enabled by default unless explicitly disabled; Tier 2 detectors are disabled by default unless explicitly enabled.
- Instantiates active detectors with their resolved options.
- Delegates lifecycle calls (`setup`, `beforeIteration`, `afterIteration`, `teardown`) to all active detectors.
- Collects dictionary tokens from all active detectors via `getTokens()`.

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
- **AND** `afterIteration()` SHALL call each detector's `afterIteration()` in registration order
- **AND** if any detector's `afterIteration()` throws, the manager SHALL continue calling remaining detectors' `afterIteration()` before re-throwing the first error

#### Scenario: Teardown runs even after errors

- **WHEN** `teardown()` is called on the `DetectorManager`
- **THEN** every active detector's `teardown()` SHALL be called regardless of whether errors occurred during fuzzing

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

- **WHEN** a hooked function is called outside the `beforeIteration()`/`afterIteration()` window (e.g., during Vite module resolution or fuzzer setup)
- **THEN** the hook SHALL pass through to the original function without running the detector check

### Requirement: Detector configuration schema

The system SHALL define per-detector configuration using Valibot schemas within the `FuzzOptions.detectors` key. Each detector field SHALL accept either a `boolean` or a detector-specific options object:

- `boolean`: `true` enables with defaults, `false` disables.
- Options object: Enables the detector with the provided configuration.
- Absent field: Uses the tier default (Tier 1 = enabled, Tier 2 = disabled).

The following detector fields SHALL be defined for Tier 1 detectors:

- `prototypePollution?: boolean`
- `commandInjection?: boolean`
- `pathTraversal?: boolean | { sandboxRoot?: string }`

Tier 2 detector fields (`redos`, `ssrf`, `unsafeEval`) are NOT included in this change. They SHALL be added to the schema when their respective detectors are implemented. The schema SHALL accept and silently ignore unknown keys within the `detectors` object to allow forward-compatible configuration files.

#### Scenario: Valid boolean configuration

- **WHEN** `detectors: { prototypePollution: false }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the prototype pollution detector SHALL be disabled

#### Scenario: Valid options object configuration

- **WHEN** `detectors: { pathTraversal: { sandboxRoot: "./uploads" } }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the path traversal detector SHALL be enabled with `sandboxRoot` resolved to `"./uploads"`

#### Scenario: Empty detectors object uses defaults

- **WHEN** `detectors: {}` is provided in `FuzzOptions`
- **THEN** all Tier 1 detectors SHALL be enabled with default options
- **AND** all Tier 2 detectors SHALL be disabled
