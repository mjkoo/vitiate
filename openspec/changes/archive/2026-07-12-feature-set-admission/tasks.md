## 1. Feature-set admission (engine)

- [x] 1.1 Replace `CLASSIFY_COUNT` (bucket representatives) with `CLASSIFY_BUCKET_BIT` (AFL `count_class_lookup8` one-hot bits: `1->0x01, 2->0x02, 3->0x04, 4-7->0x08, 8-15->0x10, 16-31->0x20, 32-127->0x40, 128-255->0x80`) in `vitiate-engine/src/engine/mod.rs`; update `classify_counts_in_place` doc (raw-counts-only precondition, no longer idempotent).
- [x] 1.2 Change `FuzzerFeedback` from `MaxMapFeedback` to `AflMapFeedback` (OR-reduction) and swap the constructor + test-helper feedbacks (`mod.rs`, `tests/helpers.rs`).
- [x] 1.3 Change `compute_novel_indices` in `coverage.rs` from `map[i] > hist[i]` to `map[i] & !hist[i] != 0`; update the `evaluate_coverage` comment.
- [x] 1.4 Delete `FEATURE_BUCKET_INDEX`; make `compute_coverage_features` the popcount of the history map (`sum(v.count_ones())`).

## 2. Tests (engine)

- [x] 2.1 Rewrite `test_classify_counts_bucketing_is_consistent` -> `test_classify_counts_bucket_bits`: exact one-hot mapping per boundary, nonzero-preservation, one-bit-per-nonzero-count (`tests/basic_feedback.rs`).
- [x] 2.2 Extend the admission test to feature-set semantics: same-bucket increase not admitted, upward-bucket crossing admitted, and the distinguishing case - a never-seen *lower* bucket admitted, then the same bucket not re-admitted (`tests/basic_feedback.rs`).
- [x] 2.3 Update `tests/features.rs` ft assertions to popcount semantics (per-edge seen-bucket bitmask; `[1,5,200]` distinct-bucket edges -> 3 features, not 13).

## 3. Test reliability (core)

- [x] 3.1 Restructure the flatted prototype-pollution e2e (`vitiate-core/test/e2e-detectors.test.ts`): move the fuzz run out of `beforeAll` into a single `it(..., { retry: 2 })` with `beforeEach` cleanup, so each retry is an independent draw (per-run miss rate ~10% -> ~0.1%). Aggregate-rate regression tracking stays with the 30-seed sweep.

## 4. Docs

- [x] 4.1 Update `docs/src/content/docs/concepts/how-it-works.md` admission description from raw-max wording to feature-set (never-seen (edge, bucket) pair) wording.

## 5. Verification

- [x] 5.1 `cargo test -p vitiate-engine` green (360 tests incl. the new lower-bucket admission case); `cargo fmt --check` and clippy `-D warnings` clean.
- [x] 5.2 `turbo run build` (engine + core) and the core suite green (1020 passed); restructured flatted e2e passes via `test/vitest.e2e.config.ts`.
- [x] 5.3 Canary discovery sweep (30 seeds x 490k execs, identical committed warm start per run): **27/30 = 90%**, above the >= 26/30 gate and statistically indistinguishable from the pre-regression 92.5% baseline (was 60% under max-over-buckets); median time-to-crash ~2s on found runs.
- [x] 5.4 Full `benchmarks/` re-baseline (300s x2 x5 targets vs jazzer, results/2026-07-12-02-39-10-full.md, 0 INVALID / 0 crashes). vs the pre-5fb91eb raw-max baseline: edges FLAT all targets (no coverage lost); corpus much LEANER (-32% to -88%, now in line with jazzer) since set admission is far more selective than raw-max; throughput has no regression attributable to the change (absolute exec/s fell but the jazzer control fell proportionally = host load; jazzer/vitiate ratio flat-to-better on 4/5, ipuz ~7% relative within noise); `ft` reads lower by design (parse 4215->2288 = -46% on loop-heavy targets) - popcount of buckets seen vs old bucket-index sum, not a coverage change.
