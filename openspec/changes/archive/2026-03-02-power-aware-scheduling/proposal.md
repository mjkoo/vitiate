## Why

The fuzzer treats all corpus entries equally — every entry has the same probability of being selected for mutation regardless of execution speed, coverage contribution, or mutation depth. This wastes time re-mutating slow, low-coverage entries instead of focusing on entries that discovered novel coverage quickly. Additionally, JavaScript's non-determinism (JIT warmup, GC pauses, hash table ordering, async scheduling) causes flaky coverage edges that bloat the corpus with false positives. Power-aware scheduling with calibration addresses both problems.

## What Changes

- **BREAKING**: `reportResult()` gains a required `execTimeNs` parameter (execution time in nanoseconds as `f64`) so the engine can track per-iteration timing
- Replace `UniformScore` with `CorpusPowerTestcaseScore` in the existing `ProbabilitySamplingScheduler`, giving corpus entries selection weights based on execution speed, coverage size, mutation depth, recency, and fuzz count
- Add `SchedulerMetadata` (global averages) and `SchedulerTestcaseMetadata` (per-entry timing, bitmap size, depth) to the engine state
- Add a JS-side calibration loop: when `reportResult()` returns `Interesting`, re-run the input 3–7 additional times (4–8 total including the original iteration) via the existing watchdog to measure averaged timing and detect unstable (non-deterministic) coverage edges
- New NAPI methods `calibrateRun()` and `calibrateFinish()` to drive calibration from JS
- Mask unstable edges in the coverage map before feedback evaluation, preventing flaky edges from triggering false-positive corpus additions
- Track parent corpus entry across iterations for mutation depth computation

## Capabilities

### New Capabilities

- `power-scheduling`: Power-aware corpus scheduling with calibration and unstable edge masking. Covers the `CorpusPowerTestcaseScore` integration, `SchedulerMetadata`/`SchedulerTestcaseMetadata` lifecycle, the JS-side calibration protocol (`calibrateRun`/`calibrateFinish`), unstable edge detection and masking, and mutation depth tracking.

### Modified Capabilities

- `fuzzing-engine`: `reportResult()` signature changes to accept `execTimeNs`. New `calibrateRun()` and `calibrateFinish()` methods added. Unstable edge masking inserted before feedback evaluation. Auto-seeds require scheduler metadata.
- `fuzz-loop`: Iteration cycle gains execution timing measurement around target calls. Calibration loop added after `reportResult()` returns `Interesting`, re-running the input via watchdog before continuing to the next iteration.

## Impact

- **Rust (vitiate-napi)**: `engine.rs` — scheduler type alias, new fields on `Fuzzer`, metadata population in `report_result()`, two new `#[napi]` methods, unstable edge masking before feedback. New imports from `libafl::schedulers` and `libafl::corpus`.
- **TypeScript (vitiate)**: `loop.ts` — timing measurement wrapping target execution, calibration loop after `Interesting` results. NAPI type bindings regenerated.
- **NAPI interface**: Breaking change to `reportResult()` signature. All existing callers (fuzz loop, tests) must pass `execTimeNs`.
- **Memory**: One-time 8MB allocation for the `n_fuzz` frequency array (2^21 `u32` entries) in `SchedulerMetadata`. Calibration state adds two temporary `Vec<u8>` allocations (coverage map size each) per calibration cycle.
- **NAPI interface**: `addSeed()` now attaches `SchedulerTestcaseMetadata` (nominal 1ms, depth 0) to each seed so `CorpusPowerTestcaseScore` can score them.
- **Performance**: 3–7 extra target executions per new corpus entry for calibration. Negligible in practice — new corpus entries are typically <0.1% of total iterations.
