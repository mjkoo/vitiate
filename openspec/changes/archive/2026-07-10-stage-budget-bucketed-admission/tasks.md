## 1. Bucketed corpus admission (C3)

- [x] 1.1 Add `CLASSIFY_COUNT[256]` (bucket-representative table, a fixed point of `FEATURE_BUCKET_INDEX`) and `classify_counts_in_place` in `vitiate-engine/src/engine/mod.rs`.
- [x] 1.2 Apply classification in place at the top of `evaluate_coverage` (`coverage.rs`), before observer construction and the novelty scan, so `MaxMapFeedback` and `compute_novel_indices` key on buckets.
- [x] 1.3 Add tests: table consistency/idempotence, and admission rejecting a same-bucket count increase while admitting a new-bucket increase (`tests/basic_feedback.rs`).

## 2. Down-weight unstable edges (C4)

- [x] 2.1 In `calibration.rs`, classify each rerun snapshot before comparison and replace the `u8::MAX` marker map with a per-edge disagreement counter (`disagreements: Option<Vec<u16>>`).
- [x] 2.2 At `calibrate_finish`, flag an edge flaky-for-entry only on a strict majority of comparisons (`count * 2 > comparisons`, `comparisons = iterations - 2`).
- [x] 2.3 Add `edge_flaky_entries: HashMap<usize, u32>` on `Fuzzer`; add an edge to `unstable_entries` only at `UNSTABLE_ENTRY_THRESHOLD` (2) distinct entries.
- [x] 2.4 Replace the stale calibration simulation tests with integration tests: single-entry flaky edge tracked-but-not-masked, masked after two entries, within-bucket jitter not flaky (`tests/calibration.rs`).

## 3. Cap + gate expensive stages (C2)

- [x] 3.1 Add `MAX_GENERALIZATION_EXECS` (2048) and a `generalization_execs` counter on `Fuzzer`; reset in `begin_generalization`, increment in `advance_generalization`, and finalize early via `finalize_generalization` on cap outside the Verify phase (`generalization.rs`).
- [x] 3.2 Add `should_run_expensive_stages()` (warmup `EXPENSIVE_STAGE_WARMUP` then seeded-RNG sample) and gate colorization/REDQUEEN and the post-I2S stages in `begin_stage_impl`, leaving I2S ungated (`stages.rs`).
- [x] 3.3 Add tests: generalization finalizes early at the cap (`tests/generalization.rs`); gate warms up then samples (`tests/stage_lifecycle.rs`).

## 4. Verification

- [x] 4.1 `cargo test --workspace` green (358 engine tests incl. new C2/C3/C4 tests), clippy `-D warnings` clean.
- [x] 4.2 Rebuild the napi addon; `turbo run test` (core) green (947 passed) - confirms behavior across the FFI boundary.
- [x] 4.3 Re-run `benchmarks/` full protocol (300s x2), all 20 runs valid, 0 crashes. Vitiate before -> after: throughput flat (within run noise), edges/ft unchanged, corpus leaner where bucketed admission prunes same-bucket redundancy (ipuz 546 -> 472 at identical edges/ft). Confirms the gate/cap did not regress throughput and no coverage was lost.
