## 1. Detector Interface and Manager

- [x] 1.1 Add `resetIteration()` to the `Detector` interface in `vitiate/src/detectors/types.ts`
- [x] 1.2 Implement `resetIteration()` in `PrototypePollutionDetector`: extract prototype restoration logic from `afterIteration()` into `resetIteration()`, keeping detection (snapshot diff + throw) in `afterIteration()`. `afterIteration()` no longer restores prototypes — it only detects and throws.
- [x] 1.3 Implement `resetIteration()` as no-op in `CommandInjectionDetector` and `PathTraversalDetector`
- [x] 1.4 Add `endIteration(targetCompletedOk: boolean)` method to `DetectorManager` that: runs `afterIteration()` checks only when `targetCompletedOk` is true, runs `resetIteration()` always in `finally`, sets detector active flag to `false` always in `finally`, returns `VulnerabilityError | undefined`. The parameter is `boolean` (not `ExitKind`) to avoid coupling the detector framework to `vitiate-napi`.
- [x] 1.5 Make `afterIteration()` a private method on `DetectorManager` — only `endIteration()` calls it
- [x] 1.6 Remove the `setDetectorActive` export from `vitiate/src/detectors/module-hook.ts` public API (keep as internal, only used by `DetectorManager`)
- [x] 1.7 Update `vitiate/src/detectors/index.ts` exports to remove `setDetectorActive` and the now-private `afterIteration`

## 2. Fuzz Loop Call Sites

- [x] 2.1 Update main iteration in `loop.ts` (lines ~647-671): replace manual `afterIteration()`/`setDetectorActive(false)` branching with `detectorManager.endIteration(exitKind === ExitKind.Ok)`
- [x] 2.2 Update `runCalibration()` in `loop.ts` (lines ~224-237): replace manual branching with `endIteration(exitKind === ExitKind.Ok)`
- [x] 2.3 Update `runStage()` in `loop.ts` (lines ~296-309): replace manual branching with `endIteration(exitKind === ExitKind.Ok)`
- [x] 2.4 Update `minimizeCrashInput()` in `loop.ts` (lines ~809-823): replace manual branching with `endIteration(result.exitKind === ExitKind.Ok)`
- [x] 2.5 Remove `import { setDetectorActive } from "./detectors/module-hook.js"` from `loop.ts`

## 3. Regression Mode

- [x] 3.1 Update regression replay loop in `fuzz.ts` (lines ~333-358): replace manual `afterIteration()` call with `endIteration(targetCompletedOk)` where `targetCompletedOk` is `false` when target threw, `true` otherwise

## 4. Tests

- [x] 4.1 Update detector unit tests in `vitiate/src/detectors/detectors.test.ts`: add tests for `resetIteration()` on each detector, add tests for `endIteration()` return value semantics, add test that `endIteration(false)` runs reset but not checks
- [x] 4.2 Add test: prototype pollution is restored even when co-occurring with a module-hook crash (the bug this change fixes) — `afterIteration()` is NOT called, but `resetIteration()` still restores prototypes
- [x] 4.3 Update existing prototype pollution tests that verify restoration happens in `afterIteration()` — they now need to verify restoration happens in `resetIteration()` instead
- [x] 4.4 Make `afterIteration()` a private method on `DetectorManager` (enforced at compile time via TypeScript `private`; no runtime test — JS has no runtime `private` enforcement)
- [x] 4.5 Update fuzz loop tests in `vitiate/src/loop.test.ts`: verify `endIteration()` is called in all paths, verify `setDetectorActive` is not imported
- [x] 4.6 Run full test suite and verify all existing tests pass with the new lifecycle
