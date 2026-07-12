## Why

The bucketed-admission change (C3) regressed fuzzing effectiveness, measured directly on the
flatted prototype-pollution e2e canary: discovery rate at the CI-equivalent exec budget fell
from 92.5% to 60% (40-seed A/B, p = 0.0006), bisected per-commit and then isolated per-feature
to the admission classification alone (disabling only it restored 93%; the stage gating and
unstable-edge changes from the same commit had no measurable effect).

The root cause is a semantic mismatch. C3's goal was AFL/libFuzzer parity: admit an input when
it produces a new (edge, hit-count-bucket) *feature*. AFL (virgin bitmap) and libFuzzer
(feature set) both use **set** semantics: any never-seen bucket for an edge - including a
bucket *lower* than previous observations - is new coverage. The implementation instead fed
bucket lower-bound representatives through `MaxMapFeedback`, yielding **max** semantics: only a
new *higher* bucket admits. That is strictly coarser than both the raw-max admission it
replaced (which kept fine-grained upward loop-count stepping stones) and the model it claimed
to match (which keeps distinct lower-count behaviors). On loop-heavy targets the corpus loses
the intermediate inputs that lead to deep states, starving the search.

## What Changes

- **Feature-set admission.** The classification table maps each raw count to a one-hot bucket
  *bit* (AFL's `count_class_lookup8`: `1->0x01, 2->0x02, 3->0x04, 4-7->0x08, 8-15->0x10,
  16-31->0x20, 32-127->0x40, 128-255->0x80`), and the feedback becomes LibAFL's
  `AflMapFeedback` (OR-reduction). An input is interesting exactly when it contributes a bucket
  bit absent from the history, and the history map accumulates, per edge, the bitmask of all
  buckets seen.
- **Bitwise novelty.** The pre-feedback novelty scan changes from `map[i] > history[i]` to
  `map[i] & !history[i] != 0`.
- **True libFuzzer `ft`.** `coverageFeatures` becomes the popcount of the history map: the
  exact count of distinct (edge, bucket) features observed, replacing the "bucket index, lower
  buckets implicitly crossed" approximation. Reported `ft` values will read lower but are now
  directly comparable to libFuzzer's `ft`. `cov` (edges) is unchanged.
- **Calibration unchanged.** Snapshots are classified with the new table; equality of one-hot
  bits is the same bucket-change test as bucket representatives were, so unstable-edge
  detection (`power-scheduling`) needs no spec, logic, or comment change.

## Capabilities

### Modified Capabilities

- `fuzzing-engine`: the shared coverage-evaluation helper classifies hit counts into one-hot
  bucket bits and admits via OR-reduction on any never-seen (edge, bucket) feature; the
  `coverageFeatures` stat becomes the history-map popcount.
- `edge-coverage`: novelty is the bitwise test `map[i] & !history[i] != 0` against the
  accumulated bucket-bit history.

### New Capabilities

_None._

## Impact

- **Crates:** `vitiate-engine` only (`mod.rs`, `coverage.rs`; comment-level in
  `calibration.rs`). `FEATURE_BUCKET_INDEX` is removed; `CLASSIFY_COUNT` becomes
  `CLASSIFY_BUCKET_BIT`; `FuzzerFeedback` becomes `AflMapFeedback`.
- **No napi/TS surface change.** No new config; `index.d.ts` unchanged.
- **Behavior:** corpus admission gains lower-bucket novelty (a superset of the buckets the
  max-semantics version admitted); the displayed `ft` counts only features actually seen, so it
  reads lower than before at identical coverage.
- **Validation:** gated on the flatted-canary discovery sweep (30 seeds at the CI-equivalent
  exec budget) recovering to the pre-C3 rate, plus the existing engine/TS suites.
