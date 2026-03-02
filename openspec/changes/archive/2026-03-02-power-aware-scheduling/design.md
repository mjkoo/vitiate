## Context

The fuzzer engine (`vitiate-napi`) uses LibAFL's `ProbabilitySamplingScheduler` with a custom `UniformScore` that returns 1.0 for every corpus entry — all entries have equal selection probability. LibAFL provides power scheduling primitives (`CorpusPowerTestcaseScore`, `SchedulerMetadata`, `SchedulerTestcaseMetadata`, `CalibrationStage`) that weight entries by execution speed, coverage contribution, mutation depth, and recency.

The standard LibAFL integration path is `CalibrationStage` → `PowerQueueScheduler` → `PowerMutationalStage`, but this assumes Rust controls the execution loop. In vitiate, execution is JS-side: the fuzz loop in `loop.ts` calls `getNextInput()`, runs the target via the watchdog, then calls `reportResult()`. The Rust engine cannot re-execute testcases for calibration.

However, the fuzz loop already supports JS-side re-execution — crash minimization replays inputs via `watchdog.runTarget()` after `reportResult()` returns. The same pattern can drive calibration.

### Current architecture (relevant types)

```
Fuzzer struct fields:
  state:     StdState<InMemoryCorpus<BytesInput>, BytesInput, StdRand, InMemoryCorpus<BytesInput>>
  scheduler: ProbabilitySamplingScheduler<UniformScore>   ← replaced by this change
  feedback:  MaxMapFeedback<StdMapObserver<'static, u8, false>, ...>
  mutator:   HavocScheduledMutator<HavocMutationsType>
  i2s_mutator: I2SRandReplace
  map_ptr/map_len: raw pointer to shared coverage map Buffer
```

The JS fuzz loop drives the engine with two calls per iteration:
1. `getNextInput()` — scheduler selects a corpus entry, mutators produce a variant, returns `Buffer`
2. `reportResult(exitKind)` — reconstructs observer from `map_ptr`, evaluates feedback, updates corpus, zeroes map

The observer is not stored on the Fuzzer — it is reconstructed from the raw pointer each time in `reportResult()` because it borrows the map mutably and is consumed within the method.

### LibAFL power scheduling primitives (available in libafl 0.16.0)

- **`CorpusPowerTestcaseScore`** — implements `TestcaseScore<I, S>`. Computes a score from per-testcase metadata (exec_time, bitmap_size, depth, handicap, n_fuzz_entry) and global metadata (average exec_time, average bitmap_size, queue_cycles). Requires `entry.exec_time()` to be set or it returns an error.
- **`SchedulerMetadata`** — global state: running totals of exec_time, cycles, bitmap_size, bitmap_size_log, bitmap_entries, queue_cycles, and `n_fuzz: Vec<u32>` (2^21 entries for path frequency tracking).
- **`SchedulerTestcaseMetadata`** — per-testcase: bitmap_size, handicap, depth, n_fuzz_entry, cycle_and_time. All fields are private with public getters/setters. Constructors: `new(depth)` and `with_n_fuzz_entry(depth, hash)`.
- **`CalibrationStage`** — re-runs testcases 4–8 times to measure timing and detect unstable edges. Cannot be used directly (requires Rust-side execution control).
- **`UnstableEntriesMetadata`** — LibAFL's built-in `HashSet<usize>` of unstable coverage map indices. Not used in vitiate; the `Fuzzer` struct stores unstable entries directly as a `HashSet<usize>` field (see Decision 5).

## Goals / Non-Goals

**Goals:**

- Weight corpus entry selection using AFL++'s power scoring algorithm (`CorpusPowerTestcaseScore`):
  - Execution speed relative to average (fast entries boosted up to 3x, slow penalized to 0.1x)
  - Coverage size relative to average (high-coverage entries boosted up to 3x)
  - Mutation depth (deeper entries boosted, up to 5x at depth 25+)
  - Handicap — queue cycles behind when added (recently-added entries boosted)
  - Fuzz count — entries fuzzed many times deprioritized (FAST schedule: logarithmic decay)
- Calibrate new corpus entries (4–8 re-executions) to get stable timing averages and detect non-deterministic coverage edges
- Mask unstable edges before feedback evaluation to prevent corpus bloat from flaky coverage
- Track mutation depth across parent → child corpus entries

**Non-Goals:**

- `PowerMutationalStage` (variable mutation count per entry) — see Decision 3
- User-configurable `PowerSchedule` strategy — see Decision 4
- Retroactive corpus pruning when new unstable edges are discovered
- Multi-run calibration for auto-seeds (they get replaced by discovered inputs quickly)

## Decisions

### Decision 1: ProbabilitySamplingScheduler with power scoring vs. PowerQueueScheduler

**Chosen: Keep `ProbabilitySamplingScheduler`, swap `UniformScore` → `CorpusPowerTestcaseScore`**

**Alternative: `PowerQueueScheduler`** — sequential round-robin through corpus entries within a "cycle," incrementing `queue_cycles` when all entries are visited.

**Rationale:** `PowerQueueScheduler` is designed for tight Rust-side execution loops where the scheduler controls iteration. Its `next()` returns entries in FIFO order with no scoring — the "power" comes from `PowerMutationalStage` determining how many mutations to apply per entry. In vitiate's one-iteration-at-a-time model, sequential round-robin provides no benefit over weighted random sampling. `ProbabilitySamplingScheduler` already exists in the codebase and accepts any `TestcaseScore` implementation, making `CorpusPowerTestcaseScore` a type-level drop-in replacement.

### Decision 2: JS-side calibration loop vs. Rust-side callback vs. single-shot timing

**Chosen: JS-side calibration loop driven by `calibrateRun()` / `calibrateFinish()`**

**Alternative A: Single-shot timing (no calibration)** — use the execution time from the single fuzz iteration that discovered the entry. Simpler but noisy (JIT warmup makes first runs 2–10x slower) and provides no coverage stability analysis.

**Alternative B: Rust-side callback via `napi_call_function`** — the Fuzzer calls the JS target function directly from `report_result()` for calibration. The watchdog already calls JS from C++ via `napi_call_function`, proving the FFI path works. However, `report_result()` would need to accept the target function on every call (or store a persistent reference), and replicating V8 termination interception in a second code path adds surface area for no benefit.

**Alternative C: Lazy/deferred calibration** — flag uncalibrated entries, calibrate when selected. Changes `getNextInput()` semantics (sometimes means "replay for calibration" instead of "mutated input") and delays scoring accuracy.

**Rationale:** The JS-side loop is the simplest option that provides both timing accuracy and stability analysis. The pattern is already proven by crash minimization. Calibration state lives on the Rust `Fuzzer` struct; JS just calls `calibrateRun()` in a loop and `calibrateFinish()` to commit. The `calibrateRun()` return value signals whether more runs are needed (extending from 4 to 8 if unstable edges are detected), keeping the protocol self-contained.

### Decision 3: No PowerMutationalStage (variable mutation count)

**Chosen: Fixed mutation count per iteration, rely on probability weighting**

In AFL++, `PowerMutationalStage` commits to N consecutive mutations of the same parent in a tight inner loop. The power score determines N. Vitiate's architecture is one-mutation-per-`getNextInput()` call — each cycle crosses the JS/Rust boundary with target execution in between.

Probability-weighted selection converges to the same mutation distribution over many iterations: if entry A scores 4x higher than entry B, it's selected ~4x more often. The only difference is stochastic vs. consecutive, and consecutive mutation's main benefit (CPU cache locality from running the same code paths) matters less in JS where V8's JIT handles hot paths independently.

To replicate consecutive mutations, we'd need to either batch mutations (restructuring the JS/Rust boundary) or make the scheduler deterministically return the same entry N times (fighting the probabilistic model). Neither fits naturally.

### Decision 4: Hardcode PowerSchedule::fast()

**Chosen: `PowerSchedule::fast()` with no user configuration**

AFL++ offers six schedule strategies: `fast`, `explore`, `exploit`, `coe`, `lin`, `quad`. `fast()` is the recommended default — it uses logarithmic fuzz-count decay to deprioritize entries that have been fuzzed many times while maintaining broad exploration.

The other strategies are specialized: `exploit` aggressively focuses on known-good paths (risks getting stuck), `coe` skips non-favored entries (requires favoritism metadata we don't track), `lin`/`quad` use linear/quadratic scaling (niche). Exposing configuration means adding a `FuzzOptions` field, env var propagation, validation, and per-variant testing for a knob that <1% of users would touch. We can add it if there's evidence a different schedule performs better for JS targets.

### Decision 5: Unstable edge masking in report_result() before feedback

**Chosen: Zero unstable edge indices in the coverage map before constructing the observer**

**Alternative: Custom feedback wrapper** that filters unstable edges during `is_interesting()`. Cleaner separation but requires wrapping LibAFL's `MaxMapFeedback`, adding a generic parameter and maintenance burden.

**Alternative: Bitmask array** (`Vec<bool>`) ANDed with coverage map. O(map_len) but cache-friendly. Better for very large unstable sets.

**Rationale:** Direct map zeroing is the simplest approach — ~7 lines of code, O(unstable_count) per iteration. For typical targets, unstable edges are a small fraction of total edges, so the HashSet iteration cost is negligible. The masking happens before the observer is constructed, so the observer (and feedback) never sees unstable edges. If the unstable set grows large enough for the HashSet iteration to matter, switching to a bitmask is a straightforward optimization that doesn't change the architecture.

The unstable entries are stored as a `HashSet<usize>` field on the `Fuzzer` struct rather than as `UnstableEntriesMetadata` on the LibAFL state. The simpler field-based approach avoids the overhead of LibAFL's metadata system (type-erased HashMap lookups) for a value that is only accessed by the Fuzzer itself, never by LibAFL's internal components.

### Decision 6: exec_time_ns as f64, not u64

**Chosen: `f64` parameter on `reportResult()`**

NAPI doesn't natively support `u64` — it maps to JavaScript's `BigInt`, which requires explicit `n` suffixes, doesn't interop cleanly with `Number`, and adds friction to every call site. `f64` represents integers exactly up to 2^53, which covers ~104 days in nanoseconds — more than sufficient for single-iteration timing.

### Decision 7: Include original execution in calibration totals

**Chosen: Count the initial fuzz iteration as calibration run #1**

The fuzz iteration that discovered the interesting input already provides one timing measurement and one coverage run. Including it in the calibration totals means `cal_iterations` starts at 1 and `cal_total_time` includes the original exec time. This reduces the number of additional calibration runs needed (3–7 instead of 4–8) and avoids discarding a valid data point.

The first `calibrateRun()` call captures the coverage map baseline (since `reportResult()` zeroed the map before returning). Subsequent calls compare against this baseline to detect unstable edges.

## Calibration Protocol

When `reportResult()` returns `Interesting`, the JS fuzz loop enters a calibration loop before continuing to the next iteration. The coverage map is already zeroed by `reportResult()`, so the map is clean for calibration runs.

```
reportResult(exitKind, execTimeNs)  →  returns Interesting
                                        (coverage map zeroed internally)

    ┌─── calibration loop (3–7 additional runs) ──┐
    │  JS: wd.runTarget(target, input, timeoutMs)  │  target writes to coverage map
    │  JS: fuzzer.calibrateRun(execTimeNs)         │  Rust reads map, compares with
    │       → returns needsMoreRuns: boolean        │  first run, tracks unstable edges,
    │                                               │  zeros map for next run
    └──────────────────────────────────────────────┘
    JS: fuzzer.calibrateFinish()            Rust finalizes averaged metadata,
                                            updates global SchedulerMetadata,
                                            merges unstable edges, re-scores entry
```

### Why calibration matters for JS

JavaScript has multiple sources of non-determinism that make single-shot measurements unreliable:

- **JIT warmup** — first execution of a path is often 2–10x slower than subsequent runs
- **GC pauses** — V8 garbage collection introduces timing jitter
- **Hash table ordering** — V8's internal hash tables may iterate differently between runs
- **Async scheduling** — microtask queue ordering can vary

Without stability tracking, flaky edges cause the feedback to think inputs are "interesting" when they're not, bloating the corpus with false positives. This is the primary value of calibration — timing accuracy is secondary.

### Calibration run count

The original fuzz iteration counts as run #1 (see Decision 7). Additional runs start at 3 (for a total of 4 = `CAL_STAGE_START`). If unstable edges are detected, extend by 2, up to a total of 8 (`CAL_STAGE_MAX`). The `calibrateRun()` return value (`true` = needs more runs) drives this from JS.

### What calibration measures

**Per run:**
1. Execution time (passed from JS via `process.hrtime.bigint()`)
2. Coverage map snapshot (read from shared memory by Rust)
3. Comparison against first calibration run's map to detect unstable edges

**Accumulated across runs:**
1. Total execution time → averaged for `testcase.exec_time` and `SchedulerTestcaseMetadata.cycle_and_time`
2. Bitmap size from first run → `SchedulerTestcaseMetadata.bitmap_size`
3. Set of unstable edge indices → merged into the fuzzer's unstable entries set (`HashSet<usize>` field)

### Crash/timeout during calibration

If a calibration run crashes or times out, the JS loop breaks out of the calibration loop and calls `calibrateFinish()` with partial data. The entry remains in the corpus with metadata derived from the completed calibration runs. Partial calibration (e.g., 2 runs instead of 4) gives less accurate timing and fewer opportunities for unstable edge detection, but is preferable to disabling the entry — the entry's coverage contribution is already committed to the feedback state, and the crash during re-execution may be environmental (memory pressure, accumulated state) rather than intrinsic to the input. Unlike LibAFL's `CalibrationStage` (which can prevent an entry from being added), vitiate's protocol commits the entry to the corpus before calibration starts, so disabling would only affect scheduling — a weaker and more complex operation for marginal benefit.

### Unstable edge masking

Calibration detects unstable edges; masking uses that data to prevent corpus bloat. Before evaluating `feedback.is_interesting()` in `report_result()`, zero out coverage map entries at indices known to be unstable. This prevents non-deterministic edges from triggering false-positive "interesting" evaluations.

The masking runs before the observer is constructed, so the observer (and feedback) never sees unstable edges. Cost is O(unstable_count) per iteration — negligible since unstable edges are typically a small fraction of total edges.

Limitations:
- **No retroactive pruning.** Entries already in the corpus when an edge is first identified as unstable are not removed. Entry N's calibration benefits entry N+1 and beyond.
- **Growing set.** The unstable set only grows; edges are never removed. Once observed to be non-deterministic, an edge should always be treated as unreliable.
- **Corpus pruning** (re-evaluating existing entries against the current unstable set) is a follow-up.

## Implementation Reference

### Rust changes (`vitiate-napi/src/engine.rs`)

**New Fuzzer fields:**

```rust
last_corpus_id: Option<CorpusId>,       // parent tracking for depth computation

// Calibration state (populated between calibrate_run / calibrate_finish)
cal_corpus_id: Option<CorpusId>,        // entry being calibrated
cal_first_map: Option<Vec<u8>>,         // first run's coverage snapshot
cal_history_map: Option<Vec<u8>>,       // unstable edge tracker (u8::MAX = unstable)
cal_total_time: Duration,               // accumulated execution time
cal_iterations: usize,                  // number of calibration runs completed
cal_has_unstable: bool,                 // whether unstable edges were detected
```

**Type alias change:**

```rust
// Before:
type FuzzerScheduler = ProbabilitySamplingScheduler<UniformScore>;
// After:
type FuzzerScheduler = ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>;
```

Remove `UniformScore` entirely.

**State initialization (`Fuzzer::new()`):**

```rust
state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));
```

**`report_result()` signature change:**

```rust
pub fn report_result(&mut self, exit_kind: ExitKind, exec_time_ns: f64) -> Result<IterationResult>
```

**Unstable edge masking (first operation in `report_result()`, before observer construction):**

```rust
if !self.unstable_entries.is_empty() {
    let map = unsafe { std::slice::from_raw_parts_mut(self.map_ptr, self.map_len) };
    for &idx in &self.unstable_entries {
        if idx < self.map_len {
            map[idx] = 0;
        }
    }
}
```

**`report_result()` is_interesting path — metadata population:**

```rust
// Set preliminary execution time (will be overwritten by calibration)
let exec_time = Duration::from_nanos(exec_time_ns as u64);
testcase.set_exec_time(exec_time);

// Compute depth from parent
let depth = match self.last_corpus_id {
    Some(parent_id) => {
        let parent = self.state.corpus().get(parent_id)?;
        let parent_tc = parent.borrow();
        match parent_tc.metadata::<SchedulerTestcaseMetadata>() {
            Ok(meta) => meta.depth() + 1,
            Err(_) => 0,
        }
    }
    None => 0,
};

// Create per-testcase scheduler metadata with preliminary values
let bitmap_size = observer.count_bytes() as u64;
let n_fuzz_entry = hash_corpus_id_to_index(id);
let queue_cycles = self.state.metadata::<SchedulerMetadata>()?.queue_cycles();

let mut sched_meta = SchedulerTestcaseMetadata::new(depth);
sched_meta.set_bitmap_size(bitmap_size);
sched_meta.set_n_fuzz_entry(n_fuzz_entry);
sched_meta.set_handicap(queue_cycles);
sched_meta.set_cycle_and_time((exec_time, 1));
testcase.add_metadata(sched_meta);

// ... add to corpus, call scheduler.on_add() ...

// Prepare calibration state for upcoming calibrate_run() calls
self.cal_corpus_id = Some(id);
self.cal_total_time = exec_time;  // include the original execution
self.cal_iterations = 1;
self.cal_has_unstable = false;
self.cal_first_map = None;        // first calibrate_run() sets this
self.cal_history_map = None;
```

**`get_next_input()` — stash selected corpus ID:**

```rust
let corpus_id = self.scheduler.next(&mut self.state)?;
self.last_corpus_id = Some(corpus_id);
```

**New method `calibrate_run(exec_time_ns: f64) -> bool`:**

```rust
#[napi]
pub fn calibrate_run(&mut self, exec_time_ns: f64) -> Result<bool> {
    let exec_time = Duration::from_nanos(exec_time_ns as u64);
    self.cal_total_time += exec_time;
    self.cal_iterations += 1;

    // Read current coverage map into a snapshot
    let current_map = unsafe {
        std::slice::from_raw_parts(self.map_ptr, self.map_len)
    }.to_vec();

    if self.cal_first_map.is_none() {
        // First calibration run — store as baseline
        self.cal_first_map = Some(current_map.clone());
        self.cal_history_map = Some(vec![0u8; self.map_len]);
    } else {
        // Compare with first run to detect unstable edges
        let first = self.cal_first_map.as_ref().unwrap();
        let history = self.cal_history_map.as_mut().unwrap();

        for (idx, (&first_val, &cur_val)) in first.iter().zip(current_map.iter()).enumerate() {
            if first_val != cur_val && history[idx] != u8::MAX {
                history[idx] = u8::MAX;  // mark as unstable
                self.cal_has_unstable = true;
            }
        }
    }

    // Zero coverage map for next run
    unsafe { std::ptr::write_bytes(self.map_ptr, 0, self.map_len); }

    // Signal whether more runs are needed
    let target_runs = if self.cal_has_unstable {
        CAL_STAGE_MAX  // 8
    } else {
        CAL_STAGE_START  // 4
    };
    Ok(self.cal_iterations < target_runs)
}
```

**New method `calibrate_finish()`:**

```rust
#[napi]
pub fn calibrate_finish(&mut self) -> Result<()> {
    let corpus_id = self.cal_corpus_id.take()
        .ok_or_else(|| Error::from_reason("calibrate_finish called without pending calibration"))?;
    let iterations = self.cal_iterations;
    let total_time = self.cal_total_time;
    let avg_time = total_time / (iterations as u32);

    // Update per-testcase metadata with calibrated values
    let mut tc = self.state.corpus().get(corpus_id)?.borrow_mut();
    tc.set_exec_time(avg_time);
    if let Ok(sched_meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
        sched_meta.set_cycle_and_time((total_time, iterations));
    }
    drop(tc);

    // Update global SchedulerMetadata with calibrated totals
    let bitmap_size = self.cal_first_map.as_ref()
        .map(|m| m.iter().filter(|&&b| b > 0).count() as u64)
        .unwrap_or(0);

    if let Ok(psmeta) = self.state.metadata_mut::<SchedulerMetadata>() {
        psmeta.set_exec_time(psmeta.exec_time() + total_time);
        psmeta.set_cycles(psmeta.cycles() + (iterations as u64));
        psmeta.set_bitmap_size(psmeta.bitmap_size() + bitmap_size);
        psmeta.set_bitmap_size_log(
            psmeta.bitmap_size_log() + (bitmap_size as f64).log2()
        );
        psmeta.set_bitmap_entries(psmeta.bitmap_entries() + 1);
    }

    // Merge newly discovered unstable edges into the fuzzer's global set.
    if let Some(history) = self.cal_history_map.take() {
        for (idx, &v) in history.iter().enumerate() {
            if v == u8::MAX {
                self.unstable_entries.insert(idx);
            }
        }
    }

    // Re-score the entry now that metadata is calibrated
    self.scheduler.on_replace(&mut self.state, corpus_id)?;

    // Clear calibration state
    self.cal_first_map = None;
    self.cal_history_map = None;
    self.cal_total_time = Duration::ZERO;
    self.cal_iterations = 0;
    self.cal_has_unstable = false;

    Ok(())
}
```

**Seed metadata:** All seeds — both explicit seeds added via `addSeed()` and auto-seeds — need `SchedulerTestcaseMetadata` with `exec_time` set to a nominal value (1ms), depth 0, and `cycle_and_time` set to (1ms, 1). Seeds are not calibrated. This ensures `CorpusPowerTestcaseScore` can compute scores without erroring on missing `exec_time`. The cleanest place to add metadata is in `addSeed()` itself — if auto-seeds use `addSeed()` internally they get metadata for free; if they add to the corpus directly, they need their own metadata addition.

### TypeScript changes (`vitiate/src/loop.ts`)

**Execution timing (both watchdog and no-timeout paths):**

```typescript
const startNs = Number(process.hrtime.bigint());
// ... run target (watchdog or direct) ...
const execTimeNs = Number(process.hrtime.bigint()) - startNs;

const iterResult = fuzzer.reportResult(exitKind, execTimeNs);
```

**Calibration loop (after reportResult returns Interesting):**

```typescript
if (iterResult === IterationResult.Interesting) {
  let needsMore = true;
  while (needsMore) {
    const calStart = Number(process.hrtime.bigint());

    if (timeoutMs !== undefined && timeoutMs > 0 && watchdog) {
      const result = watchdog.runTarget(target, input, timeoutMs);
      if (result.exitKind !== 0) {
        // Crash or timeout during calibration — finalize with partial data.
        break;
      }
    } else {
      try {
        const maybePromise = target(input);
        if (maybePromise instanceof Promise) await maybePromise;
      } catch {
        break;
      }
    }

    const calTimeNs = Number(process.hrtime.bigint()) - calStart;
    needsMore = fuzzer.calibrateRun(calTimeNs);
  }
  fuzzer.calibrateFinish();
}
```

### NAPI type definitions

Auto-generated by napi-rs from the `#[napi]` annotations:

- `reportResult(exitKind: ExitKind, execTimeNs: number): IterationResult`
- `calibrateRun(execTimeNs: number): boolean`
- `calibrateFinish(): void`

## Testing Strategy

1. **Unit: calibrate_run accumulates timing** — Call `calibrate_run()` N times with known exec_time_ns values. Verify `calibrate_finish()` sets the testcase's `exec_time` to the correct average.
2. **Unit: unstable edge detection** — Set up a coverage map that differs between calibration runs. Verify `calibrate_run()` returns `true` (needs more runs) and that `calibrate_finish()` records the unstable edges.
3. **Unit: unstable edge masking** — Add an edge to the fuzzer's unstable entries set, then call `report_result()` with that edge set in the coverage map. Verify the input is NOT considered interesting (masked). Repeat without the entry and verify it IS interesting.
4. **Unit: scoring affects selection** — Add two corpus entries with different calibrated exec_times and bitmap_sizes. Verify that over N selections, the faster/higher-coverage entry is selected more frequently (statistical test with wide margin).
5. **Unit: depth tracking** — Verify depth increments correctly across parent → child corpus entries.
6. **Unit: crash during calibration** — Simulate a crash exit kind during calibration. Verify `calibrate_finish()` completes without error and the entry remains in the corpus with partial calibration metadata.
7. **E2E: calibration loop runs** — Verify the JS calibration loop executes after `reportResult()` returns `Interesting`, and that the entry's metadata is populated with calibrated values.
8. **Regression: existing tests pass** — The behavioral contract (`getNextInput` → `reportResult` → `IterationResult`) gains a new parameter but the semantics don't change.

## Risks / Trade-offs

**[8MB n_fuzz allocation]** → One-time cost at Fuzzer construction. Acceptable for a fuzzing engine that already allocates coverage maps of similar size.

**[Calibration overhead: 4–8 extra executions per interesting input]** → New corpus entries are typically <0.1% of total iterations, so the amortized cost is <0.8% of total execution time. During early fuzzing when many entries are discovered quickly, the overhead is higher but this phase is short-lived.

**[Nominal timing for seeds]** → All seeds (explicit and auto) get nominal 1ms exec_time and are not calibrated. Their scores will be inaccurate until replaced by discovered inputs. This is acceptable because seeds are starting material, not optimized entries. Calibrating seeds up front would add startup latency proportional to corpus size (4 target executions per seed) and would require the target function and watchdog to be available during seed loading — restructuring the initialization order for marginal benefit.

**[Unstable masking ordering]** → Masking must happen before observer construction and `feedback.is_interesting()`. Wrong ordering lets flaky edges through. Enforced by code structure (masking is the first operation in `report_result()`), not the type system. A misplaced refactor could break this invariant — the ordering should be documented with a comment.

**[No retroactive corpus pruning]** → When a new unstable edge is discovered, entries already in the corpus based on that edge remain. Over time, this means the corpus may contain some entries that are only "interesting" because of a flaky edge discovered later. In practice, these entries are harmless — they participate in mutation but don't dominate selection (their scores reflect their actual coverage contribution minus the unstable edges).

**[Calibration during async targets]** → The calibration loop awaits async targets the same way the normal fuzz loop does. Watchdog timeout protection applies — the `runTarget()` call in the calibration loop is identical to the one in the main iteration.

**[Depth tracking depends on InMemoryCorpus]** → `last_corpus_id` assumes corpus entries are never evicted. If corpus eviction is added in the future, the parent reference could become stale. Safe with the current `InMemoryCorpus` design.
