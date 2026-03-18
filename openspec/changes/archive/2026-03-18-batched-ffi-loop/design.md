## Context

Vitiate's fuzz loop currently runs in TypeScript (`loop.ts`), calling into Rust via NAPI for each iteration: `getNextInput()` to mutate, `stashInput()` to record the input in shared memory, and `reportResult()` to evaluate coverage. Each `getNextInput()` allocates a new `Buffer`. At 4,000 exec/s this is 12,000+ FFI crossings/second plus 4,000 Buffer allocations, all for the hot path where ~95% of iterations discover nothing new.

The existing stage system already demonstrates the target pattern: Rust generates candidates, JS executes them via `beginStage()`/`advanceStage()`. This change extends that pattern to the main loop.

### Current Per-Iteration Flow (5+ FFI crossings)

```
JS: fuzzer.getNextInput()           → Rust: schedule, mutate, alloc Buffer, return
JS: shmemHandle.stashInput(input)   → Rust: seqlock write
JS: executeTarget(target, input)    → JS (+ N × traceCmp → Rust during execution)
JS: fuzzer.reportResult(exit, time) → Rust: evaluate coverage, drain CmpLog, zero map
```

### Proposed Per-Iteration Flow Inside Batch (1 FFI crossing)

```
Rust: mutate into pre-allocated buffer
Rust: stash input (internal, no FFI)
Rust: measure time, call JS callback  → JS: execute target (+ traceCmp calls)
Rust: evaluate coverage, drain CmpLog, zero map (internal, no FFI)
```

## Goals / Non-Goals

**Goals:**

- Reduce hot-path FFI crossings from ~4/iteration to ~1/iteration (the target callback)
- Eliminate per-iteration Buffer allocation via a pre-allocated reusable input buffer
- Preserve existing calibration/stage behavior unchanged
- Maintain detector support within the batched path
- Keep the per-iteration API (`getNextInput`/`reportResult`) for calibration, stages, and fallback

**Non-Goals:**

- Multi-threaded fuzzing or parallel target execution
- Async target support in the batched path (async targets fall back to per-iteration loop)
- Moving calibration or stage orchestration into Rust (future work)
- Changing the coverage map layout, CmpLog pipeline, or mutation strategy
- Optimizing `traceCmp()` overhead (orthogonal; still crosses FFI during target execution regardless of loop architecture)

## Decisions

### D1: Rust Drives Batch Loop, Calls JS via Synchronous Callback

**Decision**: Add a `runBatch(callback, batchSize, timeoutMs)` method on `Fuzzer`. Rust drives a tight loop: mutate, stash (via owned ShmemHandle), arm watchdog (via owned Watchdog), call callback, disarm, evaluate coverage, zero map. The callback is a synchronous JS function.

**Alternatives considered**:
- *Batched input generation* (`getNextInputBatch(n) → Buffer[]`): Generates N inputs upfront but loses inter-iteration feedback. Mutation quality degrades because interesting inputs found in positions 1..N-1 don't influence subsequent mutations. Also requires N separate coverage maps or JS-side map snapshots.
- *Full Rust loop* (move entire fuzz loop to Rust): Maximum throughput but requires reimplementing reporter, detector integration, corpus persistence, signal handling in Rust. 4-8 week effort with high regression risk. The callback approach captures most of the benefit with a fraction of the complexity.

**Rationale**: The callback approach reduces FFI crossings to the minimum (one per target execution, unavoidable) while keeping all complex orchestration in JS. It matches the pattern `Watchdog.runTarget` already uses for calling target functions from NAPI.

### D2: Early Exit on Interesting/Solution

**Decision**: `runBatch` stops immediately and returns when the first interesting input or solution is found, rather than accumulating them across the full batch.

**Alternatives considered**:
- *Continue batch, collect interesting inputs*: More iterations per batch but delays calibration. Unstable edges aren't masked until calibration runs, so subsequent iterations may produce false "interesting" designations. Also complicates returning multiple corpus IDs for deferred calibration.

**Rationale**: During steady state (~95%+ of iterations), no interesting inputs are found and batches complete fully - this is where batching provides maximum benefit. During discovery phases, early exit degrades gracefully to near-per-iteration behavior, which is acceptable because calibration and stages dominate that phase's cost anyway. The early-exit model preserves the current calibration timing without additional complexity.

### D3: Pre-Allocated Input Buffer Owned by Fuzzer

**Decision**: `Fuzzer` constructor allocates a `Buffer` of `maxInputLen` bytes. The `runBatch` loop writes mutated bytes into this buffer and passes it to the callback along with the actual input length. The callback receives `(buffer: Buffer, length: number)` and must not retain a reference to the buffer after returning.

For the existing `getNextInput()` API (used during calibration/stages/fallback), continue allocating a new Buffer per call. Buffer reuse for `getNextInput` is a future optimization.

**Alternatives considered**:
- *Buffer reuse for getNextInput too*: Changes the return type contract (caller must copy before next call). Complicates existing callsites in calibration and stage loops. Low priority since these paths are infrequent.
- *Pass only length, share buffer via constructor*: JS would access the buffer directly from a stored reference. Slightly more fragile (requires JS to remember which buffer to read from) but avoids passing the buffer as a callback argument.

**Rationale**: The callback already receives the buffer as an argument, making the contract explicit. `Buffer.subarray(0, length)` creates a zero-copy view that the target function can use as `Uint8Array`. The no-retain contract is safe because the callback is synchronous - JS cannot hold the reference past the return without explicitly copying.

### D4: Timing Measured in Rust

**Decision**: Rust measures execution time around the callback call using `std::time::Instant`, replacing JS-side `performance.now()` measurement for the batched path.

**Rationale**: More accurate (excludes JS loop overhead from measurement), simpler (no need to pass timing back from JS), and consistent with how libFuzzer measures execution time. The per-iteration API continues using JS-provided timing for backwards compatibility.

### D5: Fuzzer Owns Watchdog and ShmemHandle

**Decision**: `Fuzzer` constructor accepts optional `Watchdog` and `ShmemHandle` parameters, taking ownership. `runBatch` uses them internally: before each callback invocation, Rust stashes the input into shared memory (if handle provided) and arms the watchdog (if provided). After the callback returns or throws, Rust disarms the watchdog.

**Alternatives considered**:
- *Pass watchdog/shmem to runBatch per-call*: Simpler ownership model but adds parameters to every `runBatch` call and prevents Rust from managing their lifecycle holistically.
- *Skip watchdog in batch, rely on parent supervisor*: Simpler but loses in-process timeout detection. A stuck execution would hang the entire batch until the parent supervisor kills the process.
- *JS-side watchdog wrapping in the callback*: Adds FFI crossings back (arm/disarm are NAPI calls when called from JS). Moving them into Rust eliminates this overhead.

**Rationale**: Consolidating ownership into `Fuzzer` removes parameters from `runBatch`, makes arm/disarm and stash calls Rust-internal (no FFI), and ensures consistent lifecycle management. `Watchdog.arm()` and `disarm()` are cheap atomic writes. `ShmemHandle.stashInput()` is similarly cheap (seqlock write). Both become Rust-internal operations, eliminating 2 FFI crossings per iteration.

**Pass-through methods for JS-orchestrated paths**: Since Fuzzer owns the Watchdog and ShmemHandle, calibration/stage/minimization code can no longer access them directly. Fuzzer exposes:
- `stashInput(input: Buffer)` - delegates to owned ShmemHandle (no-op if absent)
- `runTarget(target, input, timeoutMs)` - delegates to owned Watchdog's `runTarget` (arms, calls target at NAPI C level with V8 termination handling, disarms, returns `{ exitKind, error? }`). If no Watchdog, calls target directly and wraps in the same return shape.

**Shutdown lifecycle**: `Fuzzer.shutdown()` shuts down the owned Watchdog thread (if present). Called from the fuzz loop's finally block, replacing the current `watchdog.shutdown()` call. The Watchdog's Rust `Drop` implementation also signals the thread to exit as a safety net, but explicit shutdown is preferred for deterministic cleanup.

### D6: Detector Hooks Wrapped in JS Callback

**Decision**: The JS callback wraps the target function with detector lifecycle calls:

```typescript
const batchCallback = (inputBuffer: Buffer, inputLength: number): number => {
  const input = inputBuffer.subarray(0, inputLength);
  detectorManager.beforeIteration();
  try {
    target(input);
    const vuln = detectorManager.endIteration(true);
    if (vuln) return 1; // ExitKind.Crash (detector finding)
    return 0; // ExitKind.Ok
  } catch (error) {
    detectorManager.endIteration(false);
    return 1; // ExitKind.Crash (all target exceptions are crashes)
  }
};
```

**Alternatives considered**:
- *Multiple callbacks* (`runBatch(target, beforeIter, afterIter, ...)`): Adds 2 extra FFI crossings per iteration, defeating the purpose.
- *Skip detectors in batch path*: Loses detector coverage for the majority of iterations.

**Rationale**: Detectors require per-iteration `beforeIteration`/`endIteration` hooks. Wrapping them in the callback keeps the per-iteration contract while costing only JS-internal overhead (no additional FFI crossings). The detector hooks are cheap - setting/checking flags and comparing states.

### D7: Callback Returns ExitKind, Throws on Unrecoverable Crash

**Decision**: The callback returns an `ExitKind` number (0=Ok, 1=Crash). All exceptions from the target - whether `VulnerabilityError` (detector findings) or regular errors (target crashes) - result in the callback returning 1. The callback never re-throws target exceptions. The `exitReason: "error"` path in `BatchResult` is reserved for infrastructure-level NAPI failures that bypass the callback's try/catch entirely (e.g., V8 out-of-memory).

On watchdog timeout, V8 terminates the callback's execution, and Rust handles the resulting error as `ExitKind.Timeout`.

**Rationale**: This separates recoverable crashes (where the batch can continue evaluating - but we exit early anyway per D2) from unrecoverable ones (where NAPI error propagation provides the signal). The callback's try/catch in D6 naturally handles detector findings as returns rather than throws.

### D8: BatchResult Return Type

**Decision**: `runBatch` returns a structured result:

```typescript
interface BatchResult {
  /** Number of iterations completed in this batch */
  executionsCompleted: number;
  /** Why the batch ended */
  exitReason: "completed" | "interesting" | "solution" | "error";
  /** The interesting/solution input bytes (if exitReason !== "completed") */
  triggeringInput?: Buffer;
  /** The ExitKind that triggered a solution (present when exitReason === "solution") */
  solutionExitKind?: number;
}
```

When `exitReason` is `"interesting"`, the Fuzzer's calibration state is already initialized (same as after `reportResult` returns `Interesting`). JS proceeds with the existing `calibrateRun`/`calibrateFinish`/stage flow.

When `exitReason` is `"solution"`, the input has already been added to Rust's solutions corpus. `solutionExitKind` indicates whether the solution was a crash (1) or timeout (2). For timeouts, JS writes the artifact directly without replay or minimization. For crashes, JS replays the input to obtain the Error object and classify the error type (JS crash vs detector finding), then minimizes if applicable.

**Rationale**: Minimal data crossing the boundary. The `triggeringInput` is always a copy of the input bytes - the pre-allocated buffer will be reused on the next `runBatch` call, so JS must own the data for calibration/stage processing. One allocation per interesting/solution input is negligible given their rarity. Calibration state is already set up inside `runBatch`'s internal `report_result` call, so JS can immediately call `calibrateRun` without additional setup.

### D9: Batch Size Selection

**Decision**: Default batch size of 256 iterations. Configurable via `runBatch`'s `batchSize` parameter. The JS loop calculates batch size based on the reporter's update interval:

```typescript
const batchSize = Math.max(
  16,
  Math.min(1024, Math.floor(recentExecsPerSec * REPORT_INTERVAL_SECONDS))
);
```

This targets approximately one batch per reporting interval, ensuring stats updates remain responsive.

**Alternatives considered**:
- *Fixed batch size*: Simpler but either too large (sluggish reporting for slow targets) or too small (insufficient FFI reduction for fast targets).
- *Very large batches (10,000+)*: Delays signal handling and stats reporting unacceptably. Current YIELD_INTERVAL is 1,000.

**Rationale**: Adaptive sizing ensures responsive reporting regardless of target speed. The 16-1024 clamp prevents degenerate cases (extremely slow or fast targets). The floor of 16 ensures batching always provides some benefit.

### D10: Async Target Fallback

**Decision**: Detect whether the target function returns a Promise. If so, fall back to the existing per-iteration loop (`getNextInput`/`reportResult`). `runBatch` is sync-only.

Detection happens once during the first few iterations: if `executeTarget` observes a Promise return, set a flag and never use `runBatch` for this target.

**Rationale**: Calling async functions from Rust's synchronous batch loop would require blocking the thread on Promise resolution, which deadlocks the Node.js event loop (V8 can't resolve microtasks while JS is blocked in a NAPI call). Supporting async would require `napi::threadsafe_function` with an async Rust runtime, adding significant complexity for minimal benefit (fuzz targets should be synchronous).

## Risks / Trade-offs

**[Risk] Callback overhead may not be significantly less than current per-iteration overhead**
Mitigation: Profile with `--prof` before implementing. If NAPI function call overhead (Rust→JS) is similar to JS→Rust, the batch approach saves less than expected. The Buffer allocation elimination is a guaranteed win regardless.

**[Risk] Detector false negatives in batch path**
Mitigation: The callback wraps detectors identically to the current per-iteration path (D6). No behavioral change. Test by running e2e-detectors test suite with batched path enabled.

**[Risk] Solution replay for error classification adds latency**
Mitigation: Solutions are rare (typically 0-5 per fuzzing session). Replaying one input to get the Error object is negligible. If this becomes a concern, the callback could stash the last Error object in a closure-scoped variable for retrieval after `runBatch` returns.

**[Risk] Pre-allocated buffer contract violation (JS retains reference)**
Mitigation: The `Buffer.subarray()` view shares the same backing memory. If the target or a detector stores the input buffer, it will be silently corrupted on the next iteration. Document the contract clearly. In debug mode, consider zeroing the buffer after callback return to surface violations early.

**[Risk] Watchdog interaction with NAPI callback**
Mitigation: `Watchdog.runTarget` already handles calling JS functions from Rust with V8 termination protection. Reuse the same mechanism within `runBatch`. If the watchdog fires during a callback, V8 terminates execution and Rust receives a NAPI error, which triggers early batch exit.

**[Risk] Event loop starvation during large batches**
Mitigation: Batch size is bounded (max 1024 per D9). The current YIELD_INTERVAL of 1000 iterations already blocks the event loop for similar durations. Between batches, JS yields to the event loop via `setImmediate`.

## Resolved Questions

1. **Fuzzer owns the Watchdog.** The constructor accepts an optional `Watchdog` (moving ownership into `Fuzzer`). This consolidates the two NAPI objects, removes the `watchdog` parameter from `runBatch`, and makes the Rust-internal arm/disarm calls straightforward. The constructor API changes but the overall surface is cleaner.

2. **`triggeringInput` is a copy.** One allocation per interesting/solution input is negligible - these events are rare (a few hundred over a fuzzing session at most) compared to the per-iteration allocation this change eliminates. A view into the pre-allocated buffer would create a correctness risk: JS holds the view for calibration/stage processing while Rust may reuse the buffer, leading to silent data corruption.

3. **Profile after implementation.** The rearchitecture is warranted based on the structural analysis. Profiling will be used post-implementation to validate the improvement and tune batch sizes, not as a gate for the work.
