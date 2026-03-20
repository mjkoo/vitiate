## 1. Detector Interface and Manager

- [x] 1.1 Add optional `targetReturnValue?: unknown` parameter to `Detector.afterIteration()` in `vitiate-core/src/detectors/types.ts`
- [x] 1.2 Update `DetectorManager.endIteration()` signature to accept `targetReturnValue?: unknown` as second parameter in `vitiate-core/src/detectors/manager.ts`
- [x] 1.3 Update `DetectorManager`'s private `afterIteration()` to accept and forward `targetReturnValue` to each detector's `afterIteration()` call
- [x] 1.4 Update existing detector manager tests to verify return value forwarding

## 2. Fuzz Loop Plumbing

- [x] 2.1 Add `result?: unknown` field to `TargetExecutionResult` interface in `vitiate-core/src/loop.ts`
- [x] 2.2 Update `executeTarget()` to capture and propagate `targetResult.result` for sync targets (direct return value) and async targets (resolved Promise value) into `TargetExecutionResult.result`
- [x] 2.3 Widen `makeBatchCallback()`'s target parameter from `(data: Buffer) => void` to `(data: Buffer) => unknown`, capture `target(input)` return value, and pass it to `endIteration(true, returnValue)`
- [x] 2.4 Update `runCalibration()` to pass `result` from `executeTarget()` to `detectorManager.endIteration()`
- [x] 2.5 Update `runStage()` to pass `result` from `executeTarget()` to `detectorManager.endIteration()`
- [x] 2.6 Update the first per-iteration execution (async target detection path) to pass `result` from `executeTarget()` to `detectorManager.endIteration()`
- [x] 2.7 Update the async per-iteration loop to pass `result` from `executeTarget()` to `detectorManager.endIteration()`
- [x] 2.8 Update `handleSolution` crash replay to pass `result` from `executeTarget()` to `detectorManager.endIteration()` (required for reference-leak findings to reproduce on replay and produce crash artifacts)
- [x] 2.9 Update `minimizeCrashInput` / `testCandidate` to pass `result` from `executeTarget()` to `detectorManager.endIteration()` (required for reference-leak findings to verify during minimization)
- [x] 2.10 Widen `FuzzTarget` type from `(data: Buffer) => void | Promise<void>` to `(data: Buffer) => unknown | Promise<unknown>` in `vitiate-core/src/fuzz.ts` and `vitiate-core/src/merge.ts`

## 3. Reference Leak Detection

- [x] 3.1 Implement the `containsPrototypeReference()` walk function in `vitiate-core/src/detectors/prototype-pollution.ts`: depth-limited (3), cycle-safe (`Set<object>`), `Object.keys()` traversal, returns `{ prototype: string, keyPath: string } | undefined`
- [x] 3.2 Integrate the reference leak check into `PrototypePollutionDetector.afterIteration(targetReturnValue?)`: run snapshot-diff first, then reference leak check only if snapshot-diff found nothing
- [x] 3.3 Throw `VulnerabilityError` with `changeType: "leaked-reference"`, `prototype`, and `keyPath` in context when a leak is detected

## 4. Tests

- [x] 4.1 Unit tests for `containsPrototypeReference()`: positive cases (direct prototype, nested 1-deep, nested 3-deep, array containing prototype), negative cases (plain object, undefined, primitive, depth-4 miss), cycle safety, symbol/non-enumerable exclusion, multiple-leaks-reports-first, exotic-object-throws
- [x] 4.2 Unit tests for `PrototypePollutionDetector.afterIteration()` with return value: leaked reference detected, snapshot-diff takes priority over leak, clean return value produces no finding
- [x] 4.3 Integration tests for return value plumbing: verify `endIteration(true, value)` forwards to detector's `afterIteration(value)`, verify `endIteration(true)` forwards `undefined`
- [x] 4.4 Verify all existing detector tests still pass (no regressions from the optional parameter change)

## 5. Example Update

- [x] 5.1 Update `examples/flatted-vuln/test/flatted.fuzz.ts`: remove `shallowMerge` workaround, add `return` to the fuzz target so it returns the parsed result
- [x] 5.2 Verify the flatted example detects the vulnerability with the simplified harness (manual run)

## 6. Lint and Checks

- [x] 6.1 Run full test suite (`pnpm test`) and verify all tests pass
- [x] 6.2 Run all lints and checks from `lefthook.yml` (eslint, clippy, prettier, cargo fmt, cargo deny, tsc)
