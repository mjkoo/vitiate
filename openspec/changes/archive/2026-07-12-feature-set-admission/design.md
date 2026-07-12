## Context

Commit `5fb91eb` (change `stage-budget-bucketed-admission`, C3) replaced raw-max corpus
admission with hit-count-bucket admission by classifying the coverage map into bucket
lower-bound representatives (`CLASSIFY_COUNT`) before `MaxMapFeedback`. A controlled experiment
on the flatted prototype-pollution canary showed this cut discovery rate from 92.5% to 60% at
the CI-equivalent exec budget; per-feature isolation confirmed the admission classification
alone was responsible (the same commit's stage gating and unstable-edge downweighting measured
no effect).

Mechanism: `MaxMapFeedback` over bucket representatives yields **max-over-buckets** semantics -
an input is admitted only when some edge reaches a strictly *higher* bucket than the running
maximum. That is strictly coarser than both:

- the raw-max admission it replaced, which admitted every new per-edge max raw count and thereby
  kept fine-grained "stepping stone" inputs on loop-heavy targets (each deeper/longer parse
  admitted); and
- the AFL/libFuzzer model C3 cited, which is **set** semantics: AFL's virgin bitmap and
  libFuzzer's feature set both treat any never-seen (edge, bucket) pair as new coverage,
  including buckets *lower* than previously observed (an input that hits an edge 2 times when
  history has only ever seen 100 is a distinct behavior worth keeping).

So the shipped implementation delivered neither raw-max's upward gradient nor true parity's
lower-bucket novelty. This change implements the real feature-set model.

## Goals / Non-Goals

**Goals:**

- Admit an input exactly when it produces a never-seen (edge, hit-count-bucket) feature - AFL's
  virgin-bitmap / libFuzzer's feature-set semantics, higher or lower bucket alike.
- Make the reported `ft` stat the exact count of distinct features observed (libFuzzer's `ft`).
- Restore the canary discovery rate to the pre-C3 baseline (validated by sweep).
- Keep the unstable-edge (C4) semantics untouched: calibration still classifies snapshots and a
  disagreement is still exactly a bucket change.

**Non-Goals:**

- Reverting to raw-max admission (validated as a working fallback, but abandons the libFuzzer
  model this project targets).
- A config knob to select admission semantics (one model, no dead code paths).
- Switching to LibAFL's `HitcountsMapObserver` executor hook (the engine reconstructs observers
  from a raw pointer per exec; in-place classification remains the smaller, equivalent change).
- libFuzzer-style entry reduction / `-reduce_inputs` (separate concern; `MinimizerScheduler`
  favoring already keys on the binary index set and is unaffected).

## Decisions

### 1. One-hot bucket bits + OR-reduction feedback

`CLASSIFY_COUNT` (bucket representatives) becomes `CLASSIFY_BUCKET_BIT`, AFL's exact
`count_class_lookup8`: `0->0, 1->0x01, 2->0x02, 3->0x04, 4-7->0x08, 8-15->0x10, 16-31->0x20,
32-127->0x40, 128-255->0x80`. `classify_counts_in_place` applies it at the top of
`evaluate_coverage` (and to calibration snapshots) exactly as before.

`FuzzerFeedback` becomes LibAFL's `AflMapFeedback` (`MapFeedback` with `OrReducer`; the SIMD
variant is selected automatically when the `simd` feature is on). Interesting =
`(cur | hist) != hist`, i.e. some edge contributes a bucket bit the history lacks;
`append_metadata` ORs the run's bits into the history. The history map therefore accumulates,
per edge, the bitmask of all buckets ever seen - a direct virgin-bitmap analog (inverted).

Nonzero counts still classify to nonzero values, so `bitmap_size`, covered-index counts, and
`MapIndexesMetadata` (what `MinimizerScheduler` keys on) are unaffected.

### 2. Bitwise novelty scan

`compute_novel_indices` changes from `map[i] > history[i]` to `map[i] & !history[i] != 0`: an
index is novel when the (classified) run contributes a bucket bit the history has never seen.
Consumers (`MapNoveltiesMetadata` -> generalization) are unchanged.

### 3. `ft` = history-map popcount

`compute_coverage_features` becomes `sum(popcount(history[i]))`: the exact number of distinct
(edge, bucket) features observed. This replaces the `FEATURE_BUCKET_INDEX` "bucket index, lower
buckets implicitly crossed" approximation, which is deleted. Consequences:

- `ft` now matches libFuzzer's definition precisely (features actually seen), improving
  benchmark comparability with jazzer.
- Reported `ft` values read lower at identical coverage (an edge seen only at count 200
  contributes 1 feature, not 8) and can now grow when *lower* buckets are discovered.
- `cov` (nonzero history indices) is unchanged.

### 4. Classification is no longer idempotent - and doesn't need to be

The old representatives were fixed points (`classify(classify(x)) == classify(x)`) so `ft` could
be computed over a classified history with the raw-count table. With one-hot bits neither
property is needed: the coverage map is zeroed after every evaluation, calibration classifies
fresh snapshots, and `ft` reads the bitmask history directly. The function's doc comment states
the raw-counts-only precondition.

### 5. Calibration untouched in substance

Calibration compares classified snapshots for equality; with one-hot bits, "values differ" is
still exactly "bucket changed", so within-bucket jitter remains a non-disagreement and all C4
thresholds/majority rules are unchanged.

## Risks / Trade-offs

- **Upward gradient stays bucket-coarse.** Set semantics does not restore raw-max's per-count
  stepping stones (33 -> 100 hits is still the same bucket); it adds lower-bucket novelty
  instead. Whether that suffices on loop-heavy targets is an empirical question - hence the
  sweep gate below. Fallback if the gate fails: revert admission to raw-max (measured 93%).
- **`ft` display shift.** Users comparing `ft` across vitiate versions will see lower numbers;
  release notes should mention the redefinition. Historical benchmark `ft` columns are not
  directly comparable (edges/`cov` remain comparable).
- **Corpus growth.** Set semantics admits strictly more than max-over-buckets (lower-bucket
  variants). AFL/libFuzzer live with the same property; `MinimizerScheduler` favoring bounds
  scheduling cost.

## Validation

1. Engine unit tests, including a new lower-bucket admission case (history at count 100, then
   count 2 must admit; count 2 again must not re-admit).
2. Existing engine + TS/e2e suites green.
3. **Hard gate:** flatted-canary discovery sweep, 30 seeds x 490k execs, identical committed
   warm start per run: accept at >= 26/30 (~87%, statistically indistinguishable from the
   92.5% baseline); stop and reconsider (raw-max fallback) below 24/30.
