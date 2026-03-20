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
- `afterIteration(targetReturnValue?: unknown)`: Called after target execution completes without throwing. Receives the target's return value (or `undefined` if the target did not return a value). Checks for violations and throws `VulnerabilityError` if a condition is met. SHALL NOT be called when the target crashed or timed out. SHALL NOT perform state restoration - that is the responsibility of `resetIteration()`.
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

#### Scenario: afterIteration receives target return value

- **WHEN** the target completes without throwing and returns a value
- **THEN** `afterIteration()` SHALL be called with the target's return value as the first argument

#### Scenario: afterIteration receives undefined when target has no return value

- **WHEN** the target completes without throwing and does not explicitly return a value
- **THEN** `afterIteration()` SHALL be called with `undefined` as the first argument

#### Scenario: Existing detectors ignoring the parameter still satisfy the interface

- **WHEN** a detector implements `afterIteration()` with no parameters (e.g., `afterIteration(): void`)
- **THEN** it SHALL still satisfy the `Detector` interface (the parameter is optional)

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

### Requirement: Module hooking utility

The system SHALL provide a utility for safely monkey-patching Node built-in module exports. The utility SHALL:

- Accept a module specifier (e.g., `"child_process"`, `"fs"`) and a function name.
- Replace the exported function with a wrapper that runs a detector check before calling the original.
- Store the original function reference for restoration.
- Restore the original function when `restore()` is called.
- Support hooking the same function from multiple detectors (hooks compose as a chain).

The hook wrapper SHALL wrap the `check()` call in a try/catch. When the caught exception is a `VulnerabilityError`, the wrapper SHALL write it to a module-level stash slot (first-write-wins - if the slot is already occupied, the new error is discarded) and then re-throw the original error. The stash preserves the `VulnerabilityError` with its detection-site stack trace as a backup for cases where the target catches the thrown error. Non-`VulnerabilityError` exceptions from the `check` callback SHALL be re-thrown without stashing (these indicate detector bugs, not findings).

The module SHALL export a `drainStashedVulnerabilityError()` function that returns the stashed `VulnerabilityError` (or `undefined` if none) and clears the slot. `DetectorManager` SHALL be the only caller - it drains in `endIteration()`, `beforeIteration()` (defensive discard), and `teardown()` (defensive cleanup).

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

#### Scenario: Hook stashes VulnerabilityError before re-throwing

- **WHEN** the `check` callback throws a `VulnerabilityError`
- **AND** the stash slot is empty
- **THEN** the hook wrapper SHALL write the error to the module-level stash slot
- **AND** the hook wrapper SHALL re-throw the same `VulnerabilityError`
- **AND** the original function SHALL NOT be called

#### Scenario: Second hook fire within same iteration does not overwrite stash

- **WHEN** a hook has already stashed a `VulnerabilityError` in this iteration
- **AND** a second hook fire throws a different `VulnerabilityError`
- **THEN** the stash slot SHALL retain the first error (first-write-wins)
- **AND** the second error SHALL still be re-thrown

#### Scenario: Non-VulnerabilityError from check is not stashed

- **WHEN** the `check` callback throws a `TypeError` (or other non-VulnerabilityError)
- **THEN** the error SHALL propagate without being stashed
- **AND** the stash slot SHALL remain unchanged

#### Scenario: Drain returns and clears the stashed error

- **WHEN** `drainStashedVulnerabilityError()` is called
- **AND** a `VulnerabilityError` is stashed
- **THEN** the function SHALL return the stashed error
- **AND** the stash slot SHALL be cleared to `undefined`

#### Scenario: Drain returns undefined when no error stashed

- **WHEN** `drainStashedVulnerabilityError()` is called
- **AND** no `VulnerabilityError` is stashed
- **THEN** the function SHALL return `undefined`

### Requirement: Detector configuration schema

The system SHALL define per-detector configuration using Valibot schemas within the `FuzzOptions.detectors` key. Each detector field SHALL accept either a `boolean` or a detector-specific options object:

- `boolean`: `true` enables with defaults, `false` disables.
- Options object: Enables the detector with the provided configuration.
- Absent field: Uses the tier default (Tier 1 = enabled, Tier 2 = disabled).

The following detector fields SHALL be defined for Tier 1 detectors:

- `commandInjection?: boolean`
- `pathTraversal?: boolean | { allowedPaths?: string[]; deniedPaths?: string[] }` - Tier 1 on Unix/macOS, Tier 2 on Windows (the default allowed-path policy cannot reliably cover cross-drive access, UNC paths, or junctions on Windows, making false positives likely without explicit user configuration).
- `unsafeEval?: boolean`

The following detector fields SHALL be defined for Tier 2 detectors:

- `prototypePollution?: boolean`
- `redos?: boolean | { thresholdMs?: number }`
- `ssrf?: boolean | { blockedHosts?: string[]; allowedHosts?: string[] }`

The `unsafeEval` field SHALL accept only `boolean` values. If an options object is provided for `unsafeEval`, the schema SHALL reject it with a validation error (unlike `redos` and `ssrf` which accept options objects).

The `redos` options object SHALL accept:
- `thresholdMs` (number, optional): Per-call wall-clock time threshold in milliseconds. Default: 100.

The `ssrf` options object SHALL accept:
- `blockedHosts` (string[], optional): Additional host specifications to block (CIDR, IP, hostname, wildcard domain). Extends the built-in blocklist.
- `allowedHosts` (string[], optional): Host specifications to allow, overriding the blocklist. Same format as `blockedHosts`.

Both `blockedHosts` and `allowedHosts` SHALL accept string values using the `StringOrStringArray` transform (splitting on `path.delimiter` for CLI compatibility).

The schema SHALL accept and silently ignore unknown keys within the `detectors` object to allow forward-compatible configuration files.

#### Scenario: Valid boolean configuration

- **WHEN** `detectors: { prototypePollution: false }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the prototype pollution detector SHALL be disabled

#### Scenario: Valid options object with allowedPaths and deniedPaths

- **WHEN** `detectors: { pathTraversal: { allowedPaths: ["/var/www"], deniedPaths: ["/var/www/secrets"] } }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the path traversal detector SHALL be enabled with the specified policy

#### Scenario: Valid options object with partial config

- **WHEN** `detectors: { pathTraversal: { deniedPaths: ["/etc/passwd"] } }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the path traversal detector SHALL use the default `allowedPaths: ["/"]` and the provided `deniedPaths`

#### Scenario: Empty detectors object uses defaults

- **WHEN** `detectors: {}` is provided in `FuzzOptions`
- **THEN** all Tier 1 detectors SHALL be enabled with default options
- **AND** all Tier 2 detectors SHALL be disabled

#### Scenario: Tier 2 detector enabled with boolean

- **WHEN** `detectors: { ssrf: true }` is provided in `FuzzOptions`
- **THEN** the SSRF detector SHALL be enabled with default options (empty `blockedHosts` and `allowedHosts`)
- **AND** all Tier 1 detectors SHALL remain enabled

#### Scenario: Tier 2 detector enabled with options

- **WHEN** `detectors: { ssrf: { blockedHosts: ["internal.corp.example.com"], allowedHosts: ["10.0.0.5"] } }` is provided
- **THEN** the SSRF detector SHALL be enabled with the specified configuration

#### Scenario: ReDoS detector with custom threshold

- **WHEN** `detectors: { redos: { thresholdMs: 50 } }` is provided
- **THEN** the ReDoS detector SHALL be enabled with a 50ms threshold

#### Scenario: ReDoS detector with boolean true uses default threshold

- **WHEN** `detectors: { redos: true }` is provided
- **THEN** the ReDoS detector SHALL be enabled with the default 100ms threshold

#### Scenario: Unsafe eval detector accepts boolean only

- **WHEN** `detectors: { unsafeEval: true }` is provided
- **THEN** the unsafe eval detector SHALL be enabled
- **WHEN** `detectors: { unsafeEval: false }` is provided
- **THEN** the unsafe eval detector SHALL be disabled

#### Scenario: Unsafe eval detector rejects options object

- **WHEN** `detectors: { unsafeEval: { someOption: true } }` is provided
- **THEN** the schema SHALL reject the configuration with a validation error

#### Scenario: SSRF blockedHosts accepts path-delimited string

- **WHEN** `detectors: { ssrf: { blockedHosts: "meta.internal:10.200.0.0/24" } }` is provided via CLI
- **THEN** the configuration SHALL parse into `blockedHosts: ["meta.internal", "10.200.0.0/24"]`

#### Scenario: CLI parseDetectorsFlag recognizes Tier 2 detectors

- **WHEN** `-detectors ssrf,redos,unsafeEval` is passed on the CLI
- **THEN** `parseDetectorsFlag` SHALL return `{ ssrf: true, redos: true, unsafeEval: true }`
- **AND** all other detectors SHALL be disabled (CLI flag disables defaults)

#### Scenario: CLI parseDetectorsFlag with Tier 2 dotted options

- **WHEN** `-detectors ssrf.blockedHosts=meta.internal` is passed on the CLI
- **THEN** `parseDetectorsFlag` SHALL return `{ ssrf: { blockedHosts: "meta.internal" } }`

### Requirement: Stash helper for direct-replacement hooks

The module-hook utility SHALL export a `stashAndRethrow(error: unknown): never` helper function (or equivalent) that replicates the stash-and-rethrow behavior used internally by `installHook`. The helper SHALL:

1. If `error` is a `VulnerabilityError`, write it to the module-level stash slot (first-write-wins - if the slot is already occupied, the new error is discarded).
2. Re-throw the original error unconditionally.

This helper is intended for detectors that wrap globals or prototype methods directly (not via `installHook`) but still need their findings recoverable by `DetectorManager.endIteration()` when the target swallows the thrown error.

The calling convention for direct-replacement hooks differs from `installHook`. In `installHook`, the check callback throws a `VulnerabilityError` and the `installHook` wrapper catches it, stashes, and re-throws. With `stashAndRethrow`, the direct-replacement wrapper creates the `VulnerabilityError` and passes it to `stashAndRethrow` directly - `stashAndRethrow` stashes and throws in one step (it never returns). Example usage:

```typescript
// Inside a direct-replacement wrapper:
const ve = new VulnerabilityError(name, type, context);
stashAndRethrow(ve); // stashes if slot is empty, then throws (never returns)
```

#### Scenario: Direct-replacement hook stashes VulnerabilityError

- **WHEN** a detector wraps a global function directly (not via `installHook`)
- **AND** the wrapper's check throws a `VulnerabilityError`
- **AND** the target catches the error (swallowing it)
- **THEN** the `VulnerabilityError` SHALL be recoverable via `drainStashedVulnerabilityError()`

#### Scenario: Stash helper preserves first-write-wins semantics

- **WHEN** a `VulnerabilityError` is already stashed
- **AND** a direct-replacement hook throws a second `VulnerabilityError`
- **THEN** the stash SHALL retain the first error
