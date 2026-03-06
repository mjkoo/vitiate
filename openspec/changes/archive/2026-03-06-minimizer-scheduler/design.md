## Context

The fuzzer currently uses `ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>` for corpus entry selection. This weights entries by execution speed, coverage size, depth, and path frequency (FAST schedule). However, it has no concept of coverage subsumption — it cannot identify that entry A's entire coverage footprint is a subset of entry B's. As the corpus grows, subsumed entries accumulate and dilute mutation budget.

LibAFL's `MinimizerScheduler` solves this by maintaining a greedy set-cover: for each observed coverage edge, it tracks the single best testcase (lowest `exec_time * input_length` penalty). Testcases that aren't the best for any edge are "non-favored" and skipped with high probability during selection. In libafl_libfuzzer, `IndexesLenTimeMinimizerScheduler` wraps a `PowerQueueScheduler` to combine both strategies.

The engine already iterates the full coverage map on every execution (in `MaxMapFeedback::is_interesting`) and stores `MapNoveltiesMetadata` (novel indices only). Collecting `MapIndexesMetadata` (all covered indices) is a trivial extension of this existing pass.

## Goals / Non-Goals

**Goals:**
- Maintain a minimal favored set of corpus entries that covers all observed edges
- Deprioritize subsumed entries (non-favored) during selection via probabilistic skipping
- Populate `IsFavoredMetadata` so `CorpusPowerTestcaseScore`'s existing 1.15x favored boost takes effect
- Collect `MapIndexesMetadata` piggy-backing on the existing coverage map iteration

**Non-Goals:**
- Corpus pruning or deletion of non-favored entries (entries remain in corpus, just selected less often)
- Changing the power scoring algorithm itself
- Exposing minimizer configuration (skip probability, penalty function) to users
- Replacing the `ProbabilitySamplingScheduler` — the minimizer wraps it

## Decisions

### 1. Wrap rather than replace the scheduler

The minimizer scheduler wraps the existing `ProbabilitySamplingScheduler` as its base scheduler. The `next()` method calls the base scheduler's `next()`, then probabilistically skips the result if non-favored.

**Alternative considered:** Merge minimizer logic directly into the power scoring function (e.g., score non-favored entries at 0). Rejected because it conflates two concerns — the minimizer's set-cover logic is independent of the power scoring factors and should compose cleanly.

### 2. Use LibAFL's `MinimizerScheduler` directly

Rather than reimplementing the minimizer, use LibAFL's existing `MinimizerScheduler<CS, LenTimeMulTestcasePenalty, I, MapIndexesMetadata, O>` type alias (`IndexesLenTimeMinimizerScheduler`). This gives us the tested `update_score`, `cull`, and skip logic.

**Alternative considered:** Custom implementation to avoid the `MapIndexesMetadata` storage. Rejected because the metadata cost is negligible (one `Vec<usize>` per corpus entry) and the LibAFL implementation is well-tested and handles edge cases (refcount management, re-scoring on replacement).

### 3. Collect MapIndexesMetadata during MaxMapFeedback evaluation

The `evaluate_coverage` helper already iterates the coverage map to detect novel edges and build `MapNoveltiesMetadata`. Extend this same pass to also collect all nonzero indices into `MapIndexesMetadata`. This adds zero additional coverage map iterations.

The metadata SHALL be stored on the testcase alongside `MapNoveltiesMetadata` when the input is added to the corpus (interesting). For non-interesting inputs, no metadata is stored.

### 4. Fixed 95% skip probability for non-favored entries

Use the same skip probability as libafl_libfuzzer (95%). Non-favored entries are still selectable 5% of the time, preserving some exploration of unusual edge combinations.

**Alternative considered:** Making the skip probability configurable. Rejected — this is an expert knob that most users would not tune, and 95% is well-validated in the libFuzzer/AFL ecosystem.

### 5. Penalty function: LenTimeMulTestcasePenalty

Use `exec_time_ms * input_length_bytes` as the penalty for deciding which testcase is "best" for a given edge. Lower penalty wins. This favors small, fast inputs — exactly the property we want for focused mutation targets.

This is the same penalty function used by libafl_libfuzzer's `IndexesLenTimeMinimizerScheduler`.

### 6. Seeds receive empty MapIndexesMetadata

LibAFL's `MinimizerScheduler::update_score()` returns `Err(key_not_found)` when the testcase lacks `MapIndexesMetadata`. Since `on_add()` calls `update_score()`, seeds must have `MapIndexesMetadata` before being added to the corpus. Seeds are given empty `MapIndexesMetadata` (no edge indices) in `addSeed()`. This means `update_score` iterates zero edges and succeeds without modifying `TopRatedsMetadata`.

Seeds are non-favored (they cover no edges in `TopRatedsMetadata`) and remain so until the fuzz loop discovers interesting inputs that populate `TopRatedsMetadata` with actual coverage data. This is effectively the same behavior as libafl_libfuzzer, where seed entries are progressively displaced as the fuzzer discovers better representatives.

## Risks / Trade-offs

**[Risk] Non-favored entries may contain unique edge combinations that are underexplored** → The 5% selection probability for non-favored entries mitigates this. Additionally, the power scheduler's FAST schedule already boosts entries whose edges have been fuzzed less, providing a secondary mechanism to surface underexplored paths.

**[Risk] Overhead of `update_score` on every corpus addition** → `update_score` iterates the new entry's `MapIndexesMetadata` (all covered edges) and compares penalty against the current best for each edge. For typical JS targets with coverage maps in the thousands-of-edges range, this is sub-millisecond. The `cull` pass (refreshing `IsFavoredMetadata`) iterates `TopRatedsMetadata` which is bounded by the number of unique edges.

**[Risk] Memory overhead of MapIndexesMetadata** → Each corpus entry stores a `Vec<usize>` of all covered edge indices. For a coverage map of 65536 entries and typical JS targets hitting ~1000-5000 edges per input, this is 8-40KB per corpus entry. With corpus sizes in the hundreds to low thousands, total overhead is single-digit megabytes.

**[Trade-off] Scheduler type complexity** → The scheduler type becomes `MinimizerScheduler<ProbabilitySamplingScheduler<...>, LenTimeMulTestcasePenalty, ...>` which is more complex. This is contained within `engine.rs` and doesn't leak into the NAPI interface.
