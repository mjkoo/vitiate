## Why

The `DetectorManager` lifecycle has a critical inconsistency: when a fuzz iteration ends with `exitKind !== Ok` (module-hook VulnerabilityError, regular crash, or timeout), `afterIteration()` is skipped and only `setDetectorActive(false)` is called. The prototype pollution detector relies on `afterIteration()` for both **detection** (snapshot comparison) and **restoration** (undoing pollution). When skipped, polluted prototypes persist as the new baseline, permanently blinding the detector for those properties. This bug exists in all 4 fuzz-mode execution paths (main loop, calibration, stage, minimization) but NOT in regression mode, where `afterIteration()` is always called. The root cause is a structural API problem: callers must manually remember to call the right cleanup method in every code path, and the current API conflates "check for findings" with "restore state."

## What Changes

- Split the `Detector` interface's `afterIteration()` into two distinct operations: **check** (detect new findings) and **reset** (restore pre-iteration state). The reset operation runs unconditionally after every iteration regardless of exit kind.
- Introduce a `DetectorManager.endIteration(targetCompletedOk)` method that encapsulates the full post-execution protocol: run checks only when the target completed normally, run reset always, deactivate the detector window always. This replaces the current pattern where callers manually branch on exitKind and call `setDetectorActive(false)` in else branches.
- Update all 4 fuzz-mode call sites and the regression-mode call site to use the unified `endIteration()` API, eliminating the manual `setDetectorActive(false)` calls that bypass cleanup.
- `setDetectorActive()` becomes an internal implementation detail of `DetectorManager`, no longer imported by `loop.ts`.

## Capabilities

### New Capabilities

_(none — this is a bugfix to existing capabilities)_

### Modified Capabilities

- `detector-framework`: The `Detector` interface gains a `resetIteration()` lifecycle hook. `DetectorManager` gains an `endIteration(targetCompletedOk)` method that guarantees cleanup runs regardless of exit kind. `DetectorManager.afterIteration()` becomes internal-only (called by `endIteration()`). The module hooking utility's iteration window description is updated.
- `prototype-pollution-detector`: The "Prototype state restoration after detection" requirement moves restoration from `afterIteration()` to `resetIteration()`, with a new scenario covering restoration when `afterIteration()` is not called.
- `fuzz-loop`: The detector lifecycle protocol changes from manual `afterIteration()`/`setDetectorActive(false)` branching to a single `endIteration(targetCompletedOk)` call in all execution paths (main loop, calibration, stage, minimization).
- `test-fuzz-api`: The regression-mode replay loop uses the same `endIteration()` API for detector lifecycle, unifying the protocol with fuzz mode.

## Impact

- **vitiate/src/detectors/types.ts**: `Detector` interface adds `resetIteration()` method.
- **vitiate/src/detectors/manager.ts**: `DetectorManager` gains `endIteration()`, internalizes `setDetectorActive()`.
- **vitiate/src/detectors/module-hook.ts**: `setDetectorActive()` export may become internal.
- **vitiate/src/detectors/prototype-pollution.ts**: Implements `resetIteration()` with prototype restoration logic (extracted from current `afterIteration()`).
- **vitiate/src/detectors/command-injection.ts**: Implements `resetIteration()` as no-op.
- **vitiate/src/detectors/path-traversal.ts**: Implements `resetIteration()` as no-op.
- **vitiate/src/loop.ts**: All 4 call sites simplified to single `endIteration()` call.
- **vitiate/src/fuzz.ts**: Regression replay loop updated.
- **vitiate/src/detectors/detectors.test.ts**: Tests updated for new lifecycle.
- **vitiate/src/loop.test.ts**: Tests updated for new lifecycle.
