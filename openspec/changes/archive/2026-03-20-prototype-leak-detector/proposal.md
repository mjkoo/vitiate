## Why

The prototype pollution detector misses a common real-world vulnerability pattern: functions that **leak references** to built-in prototypes in their return values without directly mutating them. The flatted CVE (GHSA-rf6f-7fwh-wjgh) demonstrates this - `flatted.parse()` returns objects where a property `===` `Array.prototype`, but never writes to `Array.prototype` itself. The snapshot-diff detector sees no change and reports nothing. Currently the only workaround is for harness authors to manually simulate downstream writes (e.g., a `shallowMerge` in the harness), which requires anticipating the vulnerability shape and defeats the purpose of automated detection.

## What Changes

- Add a **reference leak check** to the prototype pollution detector: after the target returns, walk the return value (bounded depth) and check via `===` identity whether any reachable value is a monitored prototype. If found, throw a `VulnerabilityError` with `changeType: "leaked-reference"`.
- **Extend the `Detector` interface** to accept the target's return value in `afterIteration()`. This is a **BREAKING** change to the `Detector` interface (internal, not user-facing).
- **Plumb the target return value** through `DetectorManager.endIteration()` and the fuzz loop's batch callback / async iteration paths so detectors can inspect it.
- Update the flatted example harness to remove the `shallowMerge` workaround, validating that the detector now catches the vulnerability without harness-side assistance.

## Capabilities

### New Capabilities

- `prototype-reference-leak`: Detection of leaked built-in prototype references in fuzz target return values via identity comparison, including the bounded object walk, depth limits, cycle safety, and `VulnerabilityError` reporting with `changeType: "leaked-reference"`.

### Modified Capabilities

- `detector-framework`: The `Detector.afterIteration()` signature gains an optional parameter for the target's return value; `DetectorManager.endIteration()` accepts and forwards the return value; fuzz loop call sites pass the return value through.
- `prototype-pollution-detector`: The detector gains a second detection pass (reference leak check) that runs alongside the existing snapshot-diff in `afterIteration()`.

## Impact

- **`vitiate-core/src/detectors/types.ts`** - `Detector.afterIteration()` signature change (add optional return value parameter)
- **`vitiate-core/src/detectors/manager.ts`** - `endIteration()` and internal `afterIteration()` accept and forward the return value
- **`vitiate-core/src/detectors/prototype-pollution.ts`** - Add reference identity walk in `afterIteration()`, reuse existing `MONITORED_PROTOTYPES` list
- **`vitiate-core/src/loop.ts`** - Capture and pass target return value in `makeBatchCallback`, `runCalibration`, `runStage`, and async iteration paths
- **`vitiate-core/src/fuzz.ts`** and **`vitiate-core/src/merge.ts`** - Widen `FuzzTarget` return type from `void` to `unknown`
- **`examples/flatted-vuln/test/flatted.fuzz.ts`** - Simplify harness by removing the `shallowMerge` workaround
- **Existing detectors** (command-injection, path-traversal, ssrf, redos, unsafe-eval) - No functional change; they ignore the new parameter
- **All existing tests** - Must continue to pass; snapshot-diff detection is unchanged
