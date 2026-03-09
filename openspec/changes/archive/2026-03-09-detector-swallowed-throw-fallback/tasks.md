## 1. Module Hook Stash

- [x] 1.1 Add module-level stash slot (`VulnerabilityError | undefined`) and `drainStashedVulnerabilityError()` export to `module-hook.ts`
- [x] 1.2 Modify hook wrapper in `installHook` to catch `VulnerabilityError` from `check()`, write to stash (first-write-wins), then re-throw. Non-`VulnerabilityError` exceptions propagate unchanged.

## 2. DetectorManager Integration

- [x] 2.1 Import `drainStashedVulnerabilityError` in `manager.ts`
- [x] 2.2 Update `endIteration()`: drain stash before any other work; on Ok path return `afterIteration()` result ?? stashed error; on non-Ok path return stashed error directly. If `afterIteration()` throws non-`VulnerabilityError` and stash exists, return stashed finding instead of re-throwing.
- [x] 2.3 Update `beforeIteration()`: drain and discard stale stash before activating detectors (defensive guard against incomplete prior iterations)
- [x] 2.4 Update `teardown()`: drain stash before detector teardown (defensive cleanup for mid-iteration shutdown)

## 3. Tests

- [x] 3.1 Write unit tests for `module-hook.ts` stash: stash-on-throw, first-write-wins, non-VulnerabilityError not stashed, drain returns and clears, drain returns undefined when empty
- [x] 3.2 Write unit tests for `endIteration()`: Ok path with swallowed hook error surfaces stashed finding, Ok path with afterIteration finding takes priority over stash, non-Ok path surfaces stashed finding, non-Ok path without stash returns undefined, afterIteration throws non-VulnerabilityError with stash returns stashed finding, afterIteration throws non-VulnerabilityError without stash re-throws
- [x] 3.3 Write unit tests for `beforeIteration()`: stale stash is drained and discarded before activating detectors
- [x] 3.4 Write unit test for `teardown()`: stash is drained before detector teardown (mid-iteration shutdown scenario)

## 4. Verification

- [x] 4.1 Run full test suite, lints, and checks (eslint, clippy, prettier, cargo fmt, cargo deny, cargo autoinherit, cargo msrv)
