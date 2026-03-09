## Context

Module-hook detectors (command injection, path traversal) detect vulnerabilities by throwing `VulnerabilityError` inside the hook wrapper during target execution. The error propagates out through `executeTarget()`, which reports it as `ExitKind.Crash`. This works when the target doesn't catch the error. When the target does catch it (e.g., `try { execSync(input) } catch (e) { }`), the finding is silently lost — `executeTarget()` returns `ExitKind.Ok`, and the detectors' `afterIteration()` methods are no-ops with nothing to report.

The `module-hook.ts` module already manages a global `detectorActive` flag and provides `installHook()` for wrapping module exports. `DetectorManager` imports `setDetectorActive` from it. The hook wrapper currently calls `check()` and either lets the throw propagate or falls through to the original function.

## Goals / Non-Goals

**Goals:**
- Recover module-hook detector findings that the target swallows via try/catch
- Surface the original `VulnerabilityError` (with detection-site stack trace) even when the target catches and discards or re-throws a different error
- Preserve the existing throw-during-execution behavior — hooks still throw, preventing the original function from executing
- No changes to the `Detector` interface or individual detector implementations

**Non-Goals:**
- Detecting findings when `detectorActive` is false (outside the iteration window) — this is correct behavior, not a gap
- Changing how snapshot-based detectors (prototype pollution) work — their `afterIteration()` skip on non-Ok is preserved
- Preventing the original function from executing after a swallowed `VulnerabilityError` — if the target catches and retries, the second call runs through the hook again. If the retry uses safe arguments, the check passes and the original function executes normally. If the retry uses different unsafe arguments, the check fires again but the stash already holds the first finding (first-write-wins), so the second finding is lost until the first is fixed and the input replayed. Either way, the stashed finding from the first call surfaces via `endIteration()`.

## Decisions

### 1. Module-level stash in `module-hook.ts`, not per-hook or per-detector

The stash is a single module-scoped `VulnerabilityError | undefined` slot in `module-hook.ts`. All hook wrappers write to the same slot (first write wins — subsequent fires within the same iteration are ignored since the slot is already occupied). A single `drainStashedVulnerabilityError()` export returns and clears the slot.

**Why not per-hook:** Each detector owns multiple hooks (path-traversal has ~30 across `fs` and `fs/promises`). Aggregating per-hook stashes would require iterating all hooks at drain time, which means either exposing hook internals or adding a drain method to each detector. A single module-level slot is simpler and sufficient — there's only ever one iteration in flight (single-threaded JS), so there's no ambiguity about which iteration a stashed error belongs to, and we only ever report the first finding.

**Why not per-detector with `afterIteration()` drain:** The non-Ok path in `endIteration()` deliberately skips `afterIteration()` to protect snapshot-based detectors from checking inconsistent post-crash state. Draining hook stashes on the non-Ok path would require either (a) always calling `afterIteration()` (breaking the contract), (b) a new `Detector` interface method (unnecessary coupling), or (c) having `DetectorManager` reach into detector internals. The module-level stash avoids all of these — `DetectorManager` drains it directly from `module-hook.ts`.

### 2. Stash before throwing, not instead of throwing

The hook wrapper wraps the `check()` call in a try/catch. If the caught exception is a `VulnerabilityError`, it writes to the stash slot (if empty) and re-throws. Non-`VulnerabilityError` exceptions propagate without stashing (these indicate detector bugs). The throw still prevents the original function from executing (same safety guarantee as today). The stash is purely a backup for the case where the throw is caught by the target.

**Alternative considered — stash without throwing:** The hook would stash the error and return without calling the original function. This eliminates the swallowed-throw problem entirely but changes the observable behavior: the target no longer receives an exception, so its control flow diverges from the throw path. Targets that log, retry, or branch on the exception would behave differently. The stash-and-rethrow approach preserves existing behavior exactly for non-catching targets, and only activates the fallback when the throw is swallowed.

### 3. `endIteration()` drains on both paths

```
endIteration(targetCompletedOk):
  try:
    stashed = drainStashedVulnerabilityError()
    if targetCompletedOk:
      try:
        afterIterationResult = afterIteration()
        return afterIterationResult ?? stashed
      catch nonVulnError:
        if stashed: return stashed
        throw nonVulnError
    return stashed
  finally:
    resetIteration() for all detectors
    setDetectorActive(false)
```

The drain happens first, before `afterIteration()`, so the stash is always cleared regardless of which path executes. On the Ok path, `afterIteration()` results (e.g., prototype pollution findings) take priority over the stashed hook error via the existing first-error-wins convention. On the non-Ok path, only the stashed hook error is checked.

**Why drain before `afterIteration()`:** If `afterIteration()` throws a non-`VulnerabilityError` (detector bug), the finally block still runs `resetIteration()` and `setDetectorActive(false)`, but we need the stash to have been cleared already. Draining first ensures no stale errors leak to the next iteration regardless of exceptions.

**Stashed finding preferred over detector bugs:** If `afterIteration()` throws a non-`VulnerabilityError` and a stashed `VulnerabilityError` exists, the stashed finding is returned instead of re-throwing. A real vulnerability finding is more fundamental than a detector bug — the bug is likely generic error handling that may erase context. The non-`VulnerabilityError` is only re-thrown when there is no stashed finding to preserve.

**Redundancy in the normal case:** When the target doesn't catch the `VulnerabilityError`, `executeTarget()` already returns `ExitKind.Crash` with the error. `endIteration(false)` drains the same error from the stash and returns it. The fuzz loop's `if (detectorError) { caughtError = detectorError }` overwrites `caughtError` with the identical object. This is harmless redundancy — correctness in the swallowed-throw case is worth the no-op drain in the common case.

### 4. First-write-wins stash

Only the first `VulnerabilityError` per iteration is stashed — subsequent hook fires within the same iteration see the slot is occupied and skip the write. This matches the existing convention where `afterIteration()` returns only the first `VulnerabilityError`. The crash artifact preserves the input, and replaying it will re-trigger all findings.

### 5. Defensive drain in `beforeIteration()` and `teardown()`

`beforeIteration()` drains and discards any stale stash before activating detectors. This guards against stash leaks if a previous iteration's `endIteration()` was never called (e.g., an unrelated exception in the fuzz loop between `executeTarget` and `endIteration`). Without this, a stale stash from iteration N could be misattributed to iteration N+1.

`teardown()` drains the stash before calling detector teardown methods. This handles mid-iteration shutdown where `endIteration()` was never called.

Both are defensive no-ops in the normal case — the stash is always drained by `endIteration()`.

## Risks / Trade-offs

- **[Behavioral change on non-Ok path]** `endIteration(false)` previously always returned `undefined`. It can now return a `VulnerabilityError`. All callers already handle non-undefined returns (`if (detectorError) { ... }`), so this is safe. The semantic change is intentional: the non-Ok path now surfaces hook findings that were previously lost.

- **[ExitKind override]** When a hook fires, the target catches the error, and then times out, the fuzz loop receives `ExitKind.Timeout` from `executeTarget` but `detectorError` from `endIteration`. The loop overwrites `exitKind` to `Crash`, which is correct — the vulnerability finding is more significant than the timeout, and the crash artifact should reflect the detector finding.

- **[Stashed finding suppresses detector bug rethrow]** If `afterIteration()` throws a non-`VulnerabilityError` (detector bug) and a stashed `VulnerabilityError` exists, the stashed finding is returned and the detector bug is silently swallowed. This is acceptable because the real finding is more valuable than the bug signal — a detector bug will reproduce on the next iteration, while the vulnerability finding might not. If no stashed finding exists, the non-`VulnerabilityError` is re-thrown as before.

- **[Collected afterIteration finding lost on later detector bug]** If `afterIteration()` collects a `VulnerabilityError` from detector A and then detector B throws a non-`VulnerabilityError`, the collected finding is lost — the catch clause returns the stashed finding (if any) or rethrows the bug. This is a pre-existing limitation (the current code also loses the collected finding when a later detector throws a bug), and the stash mechanism improves the outcome by ensuring at least the stashed finding surfaces rather than only the rethrown bug.

- **[Single-slot limitation]** Only the first hook fire per iteration is stashed. If the target catches the first `VulnerabilityError` and then triggers a different detector, the second finding is lost until the first is fixed and the input is replayed. This matches the existing first-error-wins convention and is acceptable — fixing one vulnerability at a time is the normal workflow.
