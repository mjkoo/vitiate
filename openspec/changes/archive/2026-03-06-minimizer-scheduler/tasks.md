## 1. MapIndexesMetadata Collection

- [x] 1.1 Extend `evaluate_coverage()` to collect all nonzero coverage map indices into `MapIndexesMetadata` during the existing coverage map iteration (alongside `MapNoveltiesMetadata`)
- [x] 1.2 Store `MapIndexesMetadata` on the testcase when the input is added to the corpus
- [x] 1.3 Write tests verifying `MapIndexesMetadata` contains all nonzero indices (not just novel) for interesting inputs, and is absent for non-interesting inputs

## 2. Scheduler Type Change

- [x] 2.1 Change the `FuzzerScheduler` type alias from `ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>` to `MinimizerScheduler<ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>, LenTimeMulTestcasePenalty, BytesInput, MapIndexesMetadata, StdMapObserver<...>>`
- [x] 2.2 Initialize `TopRatedsMetadata` on the fuzzer state during `Fuzzer` construction (part of the constructor changes in the fuzzing-engine delta spec)
- [x] 2.3 Add empty `MapIndexesMetadata` to seeds in `addSeed()` so `MinimizerScheduler::update_score()` succeeds without error
- [x] 2.4 Update all sites that reference the scheduler type to use the new wrapped type
- [x] 2.5 Verify compilation and existing tests still pass with the type change

## 3. Integration Testing

- [x] 3.1 Write tests verifying `TopRatedsMetadata` is populated when corpus entries are added (best entry per edge tracked)
- [x] 3.2 Write tests verifying `IsFavoredMetadata` is set on entries that are the best representative for at least one edge
- [x] 3.3 Write tests verifying non-favored entries are skipped with high probability during selection
- [x] 3.4 Write tests verifying that entry displacement works correctly (smaller/faster entry replaces larger/slower for a shared edge)
- [x] 3.5 Write tests verifying seeds have empty `MapIndexesMetadata` and that `on_add` succeeds without modifying `TopRatedsMetadata`
- [x] 3.6 Run full test suite and verify no regressions

## 4. Update Specifications and Documentation

- [x] 4.1 Update PARITY.md to move "Corpus minimizer scheduler" from remaining gaps to implemented features
