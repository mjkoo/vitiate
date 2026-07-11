## 1. Capture-once pristine table (detector)

- [x] 1.1 `captureSnapshot` stores the full descriptor for every own key (remove the function skip) in `vitiate-core/src/detectors/prototype-pollution.ts`.
- [x] 1.2 Add a `captured` latch; `beforeIteration` captures the pristine table on the first call and returns without rebuilding thereafter (keeps `dirty` orthogonal). `teardown` clears the table and resets `captured`.

## 2. Detect + restore function-valued pollution

- [x] 2.1 `afterIteration`: remove the function skip so added/replaced/deleted function-valued properties route through the existing `descriptorChanged` add/modify/delete logic (symbol keys included).
- [x] 2.2 `restorePrototype`: remove the function skip; delete any current key absent from the pristine table, and redefine pristine descriptors only where the current descriptor differs (identical redefine of a non-configurable built-in is skipped). Keep per-property `warnResidue`.
- [x] 2.3 (review follow-up) `afterIteration` deleted check uses a `Set` of current own keys instead of `getOwnPropertyDescriptor` per pristine key, so the now-larger pristine table adds no descriptor allocations to the per-iteration diff.

## 3. Tests

- [x] 3.1 Replace the "ignores function-valued property additions" unit test with pre-existing-not-flagged + newly-added-flagged; add replaced-method, deleted-method, symbol-keyed-function, and captured-latch cases (fresh detector per case, real built-ins saved/restored) in `prototype-pollution.test.ts`. Deliberately avoid replacing `Array.prototype[Symbol.iterator]` (it sabotages the detector's own iteration).
- [x] 3.2 Add a `manager.test.ts` multi-iteration case: iteration 1 pollutes-and-resets, iteration 2 still detects a fresh function pollution against the persisted table.

## 4. Spec

- [x] 4.1 Update `prototype-pollution-detector` spec: snapshot requirement covers all own keys captured once; replace the function-ignore scenario; reword restoration for the pristine-table model; add added/replaced/deleted + persistence scenarios.

## 5. Verification

- [x] 5.1 `npx vitest run src/detectors/prototype-pollution.test.ts src/detectors/manager.test.ts` green (94 tests).
- [x] 5.2 Full `vitiate-core` vitest green (957), `tsc --noEmit` clean, eslint clean on changed files.
- [x] 5.3 Planted-bug fuzz loop test (`loop.test.ts` "prototype pollution") still finds the bug and writes a `crash-` artifact.
- [x] 5.4 Cross-FFI confirmed without a Rust rebuild (change is pure TS; the prebuilt `vitiate-engine` addon is current): the planted-bug loop test and the regression-mode e2e detector test both pass through the real addon. The `flatted` discovery e2e is the documented probabilistic flake (loaded WSL2 did not assemble the payload in 60s); it exercises data-property `__proto__` detection, which this change leaves unchanged, so it is not a regression.
