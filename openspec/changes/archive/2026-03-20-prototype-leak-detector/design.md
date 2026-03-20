## Context

The prototype pollution detector currently uses snapshot-diffing: it captures property descriptors on 26 built-in prototypes before each iteration and checks for changes after. This catches direct prototype mutation but misses a common real-world pattern where a function returns an object containing a live `===` reference to a built-in prototype (as seen in CVE GHSA-rf6f-7fwh-wjgh / flatted@3.4.1).

The current workaround requires harness authors to simulate downstream writes (e.g., `shallowMerge`) to trigger the existing detector, which defeats the purpose of automated detection.

The `Detector` interface's `afterIteration()` currently takes no parameters, and the fuzz loop discards the target's return value. All call sites (batch callback, calibration, stage execution, async iteration) would need modification.

## Goals / Non-Goals

**Goals:**

- Detect prototype references leaked in fuzz target return values without requiring harness-side workarounds
- Preserve the existing snapshot-diff detection as-is (complement, not replace)
- Keep the reference walk bounded and cycle-safe to avoid performance regressions in the hot loop
- Make the API change backward-compatible for existing detectors (they can ignore the new parameter)

**Non-Goals:**

- Detecting prototype references leaked through side-channels other than the return value (e.g., global variables, closures, event emitters)
- Proxy-based detection (too invasive, risks breaking V8 invariants on built-in prototypes)
- Auto-returning values from targets that don't explicitly return (the user must `return` the value they want inspected)

## Decisions

### Decision 1: Identity comparison walk on the return value

After the target returns, walk the return value checking `value === monitoredPrototype` for each monitored prototype. This is the simplest approach that covers the gap.

**Alternatives considered:**
- **Proxy-based detection** - wrap monitored prototypes in Proxies to intercept property writes. Rejected: `Object.setPrototypeOf(proto, new Proxy(...))` may break V8 invariants; Proxies add overhead on every property access (not just during detection); the snapshot-diff approach is proven.
- **`Object.observe` / `Object.defineProperty` traps** - install setters on prototype properties. Rejected: `Object.observe` is deprecated; accessor traps on built-in prototypes are fragile and may break polyfills.
- **Automatic wrapping of known parsers** (e.g., hooking `JSON.parse`) - detect leaked references at the call site. Rejected: unbounded scope (which parsers?); doesn't generalize to user-defined functions.

### Decision 2: Widen FuzzTarget return type to `unknown`

Change `FuzzTarget` from `(data: Buffer) => void | Promise<void>` to `(data: Buffer) => unknown | Promise<unknown>`. This type is defined independently in both `fuzz.ts` and `merge.ts`, so both definitions need updating.

This is backward-compatible: TypeScript allows functions returning `void` to be assigned to callback parameters typed as returning `unknown` (contextual typing makes the return type covariant in callback position). Existing targets that don't return a value will produce `undefined`, which the walk trivially skips.

**Alternatives considered:**
- **Keep `void` and capture the runtime return value** - JavaScript doesn't enforce void returns, so we could capture the actual value without changing the type. Rejected: dishonest contract; TypeScript wouldn't guide users toward returning values; IDE autocomplete wouldn't show the return type.
- **Separate `expose()` API** (e.g., `vitiate.expose(result)` inside the target) - explicit opt-in. Rejected: more API surface; less ergonomic than a simple `return`; requires importing a new function.

### Decision 3: Walk parameters - depth 3, cycle-safe via visited set

- **Max depth: 3** - prototype references from parser bugs appear at shallow positions in the returned object (e.g., `result.x` or `result.x.y`), not deeply nested. Depth 3 covers the realistic attack surface without walking large object graphs.
- **Cycle safety:** use a `Set<object>` visited guard. This is necessary because the primary use case (parsers like flatted) explicitly handles circular references - the returned object may contain cycles.
- **Walk only own enumerable string keys** via `Object.keys()` (not `Reflect.ownKeys()`). Symbol keys and non-enumerable properties are unlikely to carry leaked prototype references from parser output, and skipping them reduces the walk cost.

**Alternatives considered:**
- **Depth 2** - would miss `result.nested.proto` patterns. Depth 3 is still very cheap.
- **Depth 5+** - diminishing returns; increases cost for complex return values with no realistic gain.
- **No visited set** (rely on depth limit) - rejected: depth 3 with a cyclic structure can still loop (e.g., `a.b.c === a`), and the visited set is O(1) per insertion.

### Decision 4: Optional parameter on `afterIteration()`

Change `Detector.afterIteration()` from `(): void` to `(targetReturnValue?: unknown): void`.

The parameter is optional so existing detector implementations continue to satisfy the interface without modification. Only the prototype pollution detector will inspect this value; other detectors ignore it.

The `DetectorManager.endIteration()` signature changes from `(targetCompletedOk: boolean)` to `(targetCompletedOk: boolean, targetReturnValue?: unknown)`. This is backward-compatible at all existing call sites (the second argument defaults to `undefined`).

**Alternatives considered:**
- **Separate `inspectReturnValue()` lifecycle hook** - a new method on the Detector interface. Rejected: adds interface surface; splits a single detection phase into two hooks for no benefit; forces all detectors to implement a new method (even as a no-op).
- **Pass return value via `beforeIteration()` context** - store it as state. Rejected: the value isn't available at `beforeIteration()` time; would require a third hook.

### Decision 5: Plumbing through the fuzz loop

Seven `endIteration()` call sites need modification to forward the target return value. They group into three categories:

1. **`makeBatchCallback`** (sync hot path) - widen the target parameter type from `(data: Buffer) => void` to `(data: Buffer) => unknown` (no Promise - batch mode is sync-only because the Rust engine drives the loop), capture `const returnValue = target(input)`, and pass to `endIteration(true, returnValue)`. The non-Ok path (`endIteration(false)`) does not need a return value (the target threw, so there is none).
2. **`executeTarget`** - propagate `targetResult.result` into the returned `TargetExecutionResult` via a new `result?: unknown` field. The NAPI `runTarget` already returns `{ exitKind, error?, result? }` where `result: unknown`. Currently `result` is used solely for async detection (`result instanceof Promise`); after this change it also carries the target's return value. For sync targets, `result` is the direct return value (currently `undefined` because the type says `void`, but at runtime JavaScript captures whatever the function returns). For async targets, `executeTarget` already awaits the Promise (`await targetResult.result`) - capture the resolved value instead of discarding it and include it as `result`. This gives both sync and async targets full parity.
3. **All `executeTarget` consumers** - six call sites that call `executeTarget()` and then `endIteration()` need to forward `result`:
   - **`runCalibration`** - pass `result` from `executeTarget()` to `endIteration()`
   - **`runStage`** - same pattern
   - **First per-iteration execution** (async target detection path) - same pattern
   - **Async per-iteration loop** - same pattern
   - **`handleSolution` crash replay** - replays the crash input with detectors active. If the original finding was a reference leak, the replay must forward the return value so the detector re-fires and the `VulnerabilityError` is recovered for the crash artifact. Without this, reference-leak findings would appear non-reproducible on replay.
   - **`minimizeCrashInput` / `testCandidate`** - tests whether a shorter input still triggers the same vulnerability. Must forward the return value so reference-leak findings can be verified during minimization. Without this, the minimizer would see all candidates as "no crash" and produce a degenerate artifact.

The NAPI-generated `runTarget` callback type in `index.d.ts` still declares `(data: Buffer) => void | Promise<void>`. This is intentionally left as-is: the `.d.ts` is auto-generated from Rust `#[napi]` annotations, and TypeScript's void-callback assignability rule means `(data: Buffer) => unknown` is assignable to the `void` parameter. The existing `result?: unknown` on the return type already captures the value at runtime, so no Rust-side changes are needed.

On the `!targetCompletedOk` path (target threw), the return value is `undefined` and the walk is skipped. This is correct: if the target crashed, there's no return value to inspect.

### Decision 6: VulnerabilityError context for leaked references

Report with `changeType: "leaked-reference"` (distinct from the existing `"added"` / `"modified"` / `"deleted"` types) and include the key path where the reference was found:

```
context: {
  prototype: "Array.prototype",
  changeType: "leaked-reference",
  keyPath: "x"           // dot-joined path from root, e.g. "x" or "x.y"
}
```

This makes it immediately clear in crash artifacts that the finding is a reference leak rather than a direct mutation, and the key path tells the user exactly where to look in the returned object.

## Risks / Trade-offs

- **Users must `return` from their target** - if the user writes `parse(input)` without `return`, the detector won't see the result. This is inherent to the approach and better than requiring a `shallowMerge` workaround, but should be documented clearly.
  - Mitigation: document the pattern in the prototype pollution detector section of the user guide; update the flatted example as a reference.

- **False positives from libraries that intentionally return prototype references** - e.g., `Object.getPrototypeOf()`. These are unusual fuzz targets and the detector is Tier 2 (opt-in), so this is acceptable.
  - Mitigation: none needed beyond the Tier 2 classification.

- **Walk cost in the hot loop** - the identity check runs on every Ok iteration. With 26 prototypes, depth 3, and small return values, this is a handful of `===` comparisons per iteration - negligible compared to target execution time.
  - Mitigation: the depth limit and `Object.keys()` (not `Reflect.ownKeys()`) keep the walk tight.

- **Async target return value requires `return`** - same as sync targets, but async targets that don't explicitly `return` resolve to `undefined`. The pattern `async (data) => { return await parse(data) }` works; `async (data) => { parse(data) }` does not.
  - Mitigation: document the `return` requirement; the pattern is natural for both sync and async targets.

- **Map/Set entries are not walked** - the walk uses `Object.keys()`, which returns `[]` for `Map`, `Set`, and other collection types that store entries internally rather than as own properties. A target returning `new Map([["x", Array.prototype]])` would not trigger detection. This is acceptable because the primary use case (parsed JSON output from libraries like flatted) always produces plain objects and arrays.
  - Mitigation: none needed; parsers do not produce Map/Set. If a future use case requires it, the walk can be extended to handle iterables.
