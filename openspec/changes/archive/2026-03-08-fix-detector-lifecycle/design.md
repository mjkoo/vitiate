## Context

The detector lifecycle in the fuzz loop currently follows a manually-branched pattern at every execution site:

```typescript
detectorManager.beforeIteration();
let { exitKind, error } = await executeTarget(target, input, ...);

if (exitKind === ExitKind.Ok) {
  try { detectorManager.afterIteration(); } catch (e) { /* upgrade to crash */ }
} else {
  setDetectorActive(false);  // BUG: skips cleanup
}
```

This pattern is duplicated across 4 fuzz-mode call sites (main loop, calibration, stage, minimization) and implemented differently in regression mode. The `else` branch skips `afterIteration()`, which means snapshot-based detectors (prototype pollution) never get a chance to restore state. The prototype pollution detector's `afterIteration()` both detects pollution AND restores prototypes - skipping it leaves polluted prototypes as the new baseline.

Regression mode does not have this bug because it always calls `afterIteration()` regardless of whether the target threw.

## Goals / Non-Goals

**Goals:**

- Make it structurally impossible to skip detector cleanup by providing a single method that handles the full post-execution protocol.
- Separate the "check for findings" concern from the "restore state" concern in the Detector interface so they can be invoked independently.
- Unify fuzz-mode and regression-mode detector lifecycle into the same API call.
- Remove `setDetectorActive()` from loop.ts's public surface - it should be an internal implementation detail of DetectorManager.

**Non-Goals:**

- Changing detector behavior for OK exits (the happy path is correct today).
- Adding new detectors or changing detection logic.
- Fixing the "target swallows VulnerabilityError" limitation (separate concern).
- Hooking `fs/promises` (separate enhancement).

## Decisions

### Decision 1: Add `resetIteration()` to the Detector interface

The `Detector` interface gains a `resetIteration()` method that restores any state captured in `beforeIteration()`. This method:
- Is called after every iteration, regardless of exit kind.
- Must not throw. If restoration fails, it should be best-effort (log, don't crash the fuzzer).
- Is separate from `afterIteration()` which remains the "check for findings" hook.

**Rationale**: Separating check from cleanup makes the contract explicit. `afterIteration()` answers "did something bad happen?", `resetIteration()` answers "clean up whatever you captured in beforeIteration()". Module-hook detectors implement both as no-ops (they have no per-iteration state). Prototype pollution implements `afterIteration()` as snapshot diff + throw, and `resetIteration()` as prototype restoration.

**Alternative considered**: A single `afterIteration(crashed: boolean)` that skips detection when crashed but always restores. Rejected because it conflates two concerns and makes the interface contract less clear - callers would need to understand the internal branching.

**Alternative considered**: Always call `afterIteration()` and discard detector errors when already crashed. Rejected because `afterIteration()` for snapshot-based detectors may detect transient state from a half-completed execution, producing false positives. The detection logic should only run when the target completed normally.

### Decision 2: Add `endIteration(targetCompletedOk)` to DetectorManager

The `DetectorManager` gains a single `endIteration(targetCompletedOk: boolean)` method that encapsulates the full post-execution protocol:

```typescript
endIteration(targetCompletedOk: boolean): VulnerabilityError | undefined {
  try {
    if (targetCompletedOk) {
      // Run checks - may throw VulnerabilityError
      return this.runChecks();
    }
    return undefined;
  } finally {
    // ALWAYS runs: restore state and deactivate window
    this.runResets();
    setDetectorActive(false);
  }
}
```

The parameter is `boolean` rather than `ExitKind` because the only branching is "Ok vs everything else" - importing `ExitKind` from `vitiate-napi` would couple the pure-TS detector framework to the native addon, which is unnecessary.

Key design choices:
- Returns `VulnerabilityError | undefined` instead of throwing. This eliminates the try/catch at every call site and makes the "upgrade to crash" pattern explicit: `const detectorError = detectorManager.endIteration(exitKind === ExitKind.Ok)`.
- The `finally` block guarantees `resetIteration()` and `setDetectorActive(false)` always run, even if a check throws an unexpected (non-VulnerabilityError) error.
- Non-VulnerabilityError exceptions from `afterIteration()` are re-thrown (they indicate a bug in the detector, not a finding).
- `afterIteration()` becomes an internal method on `DetectorManager` - only `endIteration()` calls it. This prevents callers from bypassing the guaranteed cleanup by calling `afterIteration()` directly.

**Rationale**: A single method eliminates the manual branching that caused the bug. Callers cannot forget cleanup because it's unconditional inside the method. Returning instead of throwing simplifies call sites from try/catch blocks to simple assignment + conditional.

**Alternative considered**: Keep `afterIteration()` as the public API and add an internal `resetIteration()` call inside it. Rejected because this doesn't solve the problem - callers still wouldn't call `afterIteration()` for non-Ok exits, and the cleanup would still be skipped.

**Alternative considered**: Use `ExitKind` as the parameter type. Rejected because the detector framework has no dependency on `vitiate-napi` today, and the only branching is binary (target completed normally vs didn't). A boolean is simpler and avoids the coupling.

### Decision 3: Internalize `setDetectorActive()` and `afterIteration()`

The `setDetectorActive()` function is no longer exported from `module-hook.ts` for use by `loop.ts`. It is only called by `DetectorManager.beforeIteration()` (to activate) and `DetectorManager.endIteration()` (to deactivate). The `loop.ts` module no longer imports it.

Similarly, `afterIteration()` on `DetectorManager` becomes a private method. Only `endIteration()` calls it internally. This prevents callers from calling `afterIteration()` directly and bypassing the guaranteed `resetIteration()` cleanup.

**Rationale**: If only `DetectorManager` controls the active flag and the check/reset lifecycle, callers cannot accidentally leave state in an inconsistent condition. Both become implementation details of the manager's lifecycle protocol.

### Decision 4: Unified call site pattern

All execution paths (main loop, calibration, stage, minimization, regression) use the same pattern:

```typescript
detectorManager.beforeIteration();
const { exitKind, error } = await executeTarget(target, input, ...);
const detectorError = detectorManager.endIteration(exitKind === ExitKind.Ok);

// Merge: detector finding upgrades Ok to Crash
const finalExitKind = detectorError ? ExitKind.Crash : exitKind;
const finalError = detectorError ?? error;
```

This replaces 4 different manually-branched patterns with one consistent 3-line sequence.

## Risks / Trade-offs

**[Risk] Prototype restoration runs on half-completed executions** → The `resetIteration()` method restores prototypes to the pre-iteration snapshot. If the target crashed partway through a legitimate prototype modification (not pollution), the restoration still runs. This is acceptable: the snapshot was captured before the iteration, so restoration returns to a known-good state. A half-completed legitimate modification would be non-deterministic anyway.

**[Risk] Performance overhead of resetIteration** → For module-hook detectors, `resetIteration()` is a no-op. For prototype pollution, it walks `MONITORED_PROTOTYPES` and restores any changes. On non-Ok exits where no pollution occurred, this is a fast no-op (snapshot comparison finds no diffs). On Ok exits, both `afterIteration()` (detection pass) and `resetIteration()` (restoration pass) now walk all 25+ monitored prototypes - two passes instead of today's single combined pass. This is negligible compared to target execution time. If profiling shows otherwise, `resetIteration()` can be optimized to skip restoration when `afterIteration()` already restored (e.g., via an internal `dirty` flag), but this optimization is not included in the initial implementation.

**[Risk] Breaking change to Detector interface** → Adding `resetIteration()` to the interface is a breaking change for any external detector implementations. Since detectors are currently internal-only and not part of the public API, this is safe. If/when detectors become pluggable, the interface will need versioning.

**[Trade-off] Return vs throw for endIteration** → Returning `VulnerabilityError | undefined` is simpler for callers but changes the existing control flow pattern. All call sites must be updated. Since the call sites are already being rewritten to fix the bug, this is an acceptable cost for a cleaner API.
