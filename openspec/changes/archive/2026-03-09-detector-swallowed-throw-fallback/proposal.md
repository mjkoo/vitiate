## Why

Module-hook detectors (command injection, path traversal) throw `VulnerabilityError` inside the target's call stack during execution. If the target wraps the hooked call in try/catch, the error is swallowed and the finding is silently lost — the fuzzer reports `ExitKind.Ok` and no detector surfaces the violation. This is the only scenario where a detected vulnerability produces no output.

## What Changes

- **Module-level stash in hook wrapper**: When a module-hook `check()` callback throws `VulnerabilityError`, the error is written to a module-level slot in `module-hook.ts` (first-write-wins) before re-throwing. The throw behavior is unchanged — this adds a backup record with the original stack trace captured at the detection site.
- **`drainStashedVulnerabilityError()` export**: New function on `module-hook.ts` that returns and clears the stashed `VulnerabilityError`. Single drain point for the entire hook subsystem.
- **`endIteration()` drains on both paths**: `DetectorManager.endIteration()` calls `drainStashedVulnerabilityError()` regardless of `targetCompletedOk`. On the Ok path, this happens before the existing `afterIteration()` flow. On the non-Ok path, it drains directly without calling `afterIteration()` — preserving the contract that snapshot-based detectors (prototype pollution) don't run checks on crashed/timed-out state.
- **`beforeIteration()` discards stale stash**: `DetectorManager.beforeIteration()` drains and discards any stale stash before activating detectors. This is a defensive measure against stash leaks if a previous iteration's `endIteration()` was never called (e.g., due to an unrelated exception in the fuzz loop).
- **`teardown()` drains stash before detector teardown**: Defensive cleanup for mid-iteration shutdown scenarios where `endIteration()` was never called.
- **No Detector interface changes**: Individual detectors' `afterIteration()` and `resetIteration()` remain unchanged. The stash is module-level infrastructure managed by `DetectorManager`, not per-detector state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `detector-framework`: `endIteration()` gains drain-on-both-paths behavior; `beforeIteration()` gains defensive stash discard; `teardown()` gains defensive stash drain; module hook utility gains stash-on-throw and `drainStashedVulnerabilityError()` export

## Impact

- `vitiate/src/detectors/module-hook.ts`: Hook wrapper gains stash-before-throw logic; new `drainStashedVulnerabilityError()` export
- `vitiate/src/detectors/manager.ts`: `endIteration()` calls drain on both Ok and non-Ok paths; `beforeIteration()` discards stale stash; `teardown()` drains stash before detector teardown
- No changes to individual detector implementations (command-injection, path-traversal)
- No config changes, no breaking API changes, no new dependencies
- `DetectorManager` already imports from `module-hook.ts` (`setDetectorActive`), so this adds no new coupling
