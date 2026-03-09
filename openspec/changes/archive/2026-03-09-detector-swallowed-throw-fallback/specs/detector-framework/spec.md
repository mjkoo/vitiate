## MODIFIED Requirements

### Requirement: Module hooking utility

The system SHALL provide a utility for safely monkey-patching Node built-in module exports. The utility SHALL:

- Accept a module specifier (e.g., `"child_process"`, `"fs"`) and a function name.
- Replace the exported function with a wrapper that runs a detector check before calling the original.
- Store the original function reference for restoration.
- Restore the original function when `restore()` is called.
- Support hooking the same function from multiple detectors (hooks compose as a chain).

The hook wrapper SHALL wrap the `check()` call in a try/catch. When the caught exception is a `VulnerabilityError`, the wrapper SHALL write it to a module-level stash slot (first-write-wins — if the slot is already occupied, the new error is discarded) and then re-throw the original error. The stash preserves the `VulnerabilityError` with its detection-site stack trace as a backup for cases where the target catches the thrown error. Non-`VulnerabilityError` exceptions from the `check` callback SHALL be re-thrown without stashing (these indicate detector bugs, not findings).

The module SHALL export a `drainStashedVulnerabilityError()` function that returns the stashed `VulnerabilityError` (or `undefined` if none) and clears the slot. `DetectorManager` SHALL be the only caller — it drains in `endIteration()`, `beforeIteration()` (defensive discard), and `teardown()` (defensive cleanup).

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

### Requirement: DetectorManager orchestration

The system SHALL provide a `DetectorManager` class that:

- Accepts the `detectors` configuration from `FuzzOptions` in its constructor.
- Resolves which detectors are active: Tier 1 detectors are enabled by default unless explicitly disabled; Tier 2 detectors are disabled by default unless explicitly enabled.
- Instantiates active detectors with their resolved options.
- Delegates lifecycle calls (`setup`, `beforeIteration`, `resetIteration`, `teardown`) to all active detectors. The `afterIteration()` delegation is internal to `endIteration()` and SHALL NOT be exposed as a public method on `DetectorManager`.
- Collects dictionary tokens from all active detectors via `getTokens()`.
- Drains and discards any stale module-hook stash in `beforeIteration()` before activating detectors (defensive guard against stash leaks from incomplete prior iterations).
- Provides an `endIteration(targetCompletedOk)` method that encapsulates the full post-execution protocol.

The `endIteration(targetCompletedOk: boolean)` method SHALL:

1. Drain the module-hook stash via `drainStashedVulnerabilityError()` before any other work.
2. If `targetCompletedOk` is `true`: call `afterIteration()` on each active detector, collecting the first `VulnerabilityError` thrown (continuing to call remaining detectors even after an error). Return the `afterIteration()` error if present, otherwise return the drained stash error.
3. If `targetCompletedOk` is `false`: return the drained stash error (do NOT call `afterIteration()`).
4. Regardless of `targetCompletedOk`: call `resetIteration()` on every active detector in a `finally` block.
5. Regardless of `targetCompletedOk`: set the detector active flag to `false` in a `finally` block.
6. If `afterIteration()` throws a non-`VulnerabilityError` exception and a stashed `VulnerabilityError` exists, return the stashed finding (the real vulnerability takes priority over a detector bug). Only re-throw the non-`VulnerabilityError` when no stashed finding exists.

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

- **WHEN** `DetectorManager` is constructed with `{ pathTraversal: { allowedPaths: ["/var/www"] } }`
- **THEN** the path traversal detector SHALL be active with the specified `allowedPaths`
- **AND** the default `deniedPaths: ["/etc/passwd"]` SHALL apply

#### Scenario: Lifecycle delegation order

- **WHEN** multiple detectors are active
- **THEN** `beforeIteration()` SHALL call each detector's `beforeIteration()` in registration order
- **AND** `endIteration()` SHALL drain the module-hook stash before calling `afterIteration()`
- **AND** `endIteration()` SHALL call each detector's `afterIteration()` in registration order (when `targetCompletedOk` is true)
- **AND** if any detector's `afterIteration()` throws, the manager SHALL continue calling remaining detectors' `afterIteration()` before collecting the first error
- **AND** `endIteration()` SHALL call each detector's `resetIteration()` in registration order (always)

#### Scenario: Teardown runs even after errors

- **WHEN** `teardown()` is called on the `DetectorManager`
- **THEN** the module-hook stash SHALL be drained (cleared) before detector teardown
- **AND** every active detector's `teardown()` SHALL be called regardless of whether errors occurred during fuzzing

#### Scenario: endIteration returns afterIteration finding on Ok exit (takes priority over stash)

- **WHEN** `endIteration(true)` is called
- **AND** a detector's `afterIteration()` throws a `VulnerabilityError`
- **THEN** `endIteration` SHALL return the `afterIteration()` `VulnerabilityError`
- **AND** the stash SHALL have been drained (cleared) before `afterIteration()` was called
- **AND** any stashed hook error SHALL be discarded (afterIteration finding takes priority)
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns stashed hook error on Ok exit when afterIteration finds nothing

- **WHEN** `endIteration(true)` is called
- **AND** no detector's `afterIteration()` throws
- **AND** a `VulnerabilityError` was stashed during hook execution (target swallowed the throw)
- **THEN** `endIteration` SHALL return the stashed `VulnerabilityError`
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration returns undefined on Ok exit without any finding

- **WHEN** `endIteration(true)` is called
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

- **WHEN** `endIteration(true)` is called
- **AND** a detector's `afterIteration()` throws a non-VulnerabilityError exception
- **AND** a `VulnerabilityError` was stashed during hook execution
- **THEN** `endIteration` SHALL return the stashed `VulnerabilityError` (finding takes priority over detector bug)
- **AND** `resetIteration()` SHALL have been called on all detectors
- **AND** the detector active flag SHALL be `false`

#### Scenario: endIteration re-throws non-VulnerabilityError when no stashed finding

- **WHEN** `endIteration(true)` is called
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
