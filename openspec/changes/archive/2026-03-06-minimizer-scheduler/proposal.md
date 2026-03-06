## Why

The `ProbabilitySamplingScheduler` with `PowerSchedule::fast()` weights corpus entry selection by execution speed, coverage size, and path frequency — but it has no mechanism to identify or deprioritize entries whose coverage is entirely subsumed by other entries. As the corpus grows, redundant entries accumulate and dilute mutation budget across inputs that contribute no unique coverage. A minimizer scheduler wrapping the existing power scheduler would maintain a minimal favored set covering all observed edges, focusing mutation effort on the most efficient representatives.

## What Changes

- Collect `MapIndexesMetadata` (all covered edge indices) during `MaxMapFeedback` evaluation, piggy-backing on the existing coverage map iteration that already detects novel edges.
- Add `TopRatedsMetadata` state tracking the best testcase per coverage edge, scored by `exec_time * input_length` (lower is better).
- Add `IsFavoredMetadata` marker on testcases that are the best representative for at least one edge.
- Wrap the existing `ProbabilitySamplingScheduler` with minimizer logic: `update_score` on corpus addition, `cull` to refresh favored marks, and probabilistic skipping of non-favored entries during `next()`.
- `CorpusPowerTestcaseScore` already applies a 1.15x boost to entries with `IsFavoredMetadata`, so the power scheduler naturally integrates with the minimizer's favored marks.

## Capabilities

### New Capabilities
- `corpus-minimizer`: Minimizer scheduler that maintains a minimal favored set of corpus entries covering all observed edges, wrapping the existing power scheduler.

### Modified Capabilities
- `power-scheduling`: The scheduler is now wrapped by the minimizer; `IsFavoredMetadata` is populated by the minimizer rather than being absent. Selection behavior changes: non-favored entries are skipped with high probability before power-weighted sampling occurs.
- `fuzzing-engine`: `evaluate_coverage()` additionally collects and stores `MapIndexesMetadata` on interesting inputs. `Fuzzer` constructor initializes `TopRatedsMetadata` on state.

## Impact

- **`vitiate-napi/src/engine.rs`**: Scheduler type changes from bare `ProbabilitySamplingScheduler` to minimizer-wrapped. `evaluate_coverage` collects `MapIndexesMetadata` alongside `MapNoveltiesMetadata`. Corpus addition calls `update_score`. New `cull` pass before `next()`.
- **Memory**: Each corpus entry stores an additional `Vec<usize>` of all covered edge indices. One global `HashMap<usize, CorpusId>` maps edges to best testcases.
- **No JS-side changes**: All changes are internal to the Rust engine. The NAPI interface is unchanged.
- **No breaking changes**: The fuzzer produces the same outputs (crashes, corpus entries). Only the selection strategy changes.
