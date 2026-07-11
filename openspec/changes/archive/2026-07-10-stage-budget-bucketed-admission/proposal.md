## Why

With C1/C5/C6 shipped, the design review's remaining fuzzing-effectiveness gaps are C2, C3,
and C4 - all in the engine's stage-scheduling, feedback-admission, and calibration paths:

- **C2 (stage amplification).** Every interesting entry runs colorization -> REDQUEEN ->
  generalization -> grimoire/unicode/json, and generalization's Offset/Delimiter/Bracket sweep
  is uncapped. A single large entry can spend >10,000 target calls before havoc resumes, the
  likely cause of the review's throughput outlier.
- **C3 (raw-max admission).** Corpus admission keys on `map[i] > history[i]` (raw per-edge
  maximum). libFuzzer/AFL admit on new (edge, hit-count-bucket) features, so loop-count-sensitive
  progress (parsers, length-prefixed formats) that vitiate should keep is silently dropped. The
  bucket table already exists but feeds only the `ft` display stat, not admission.
- **C4 (one-way unstable masking).** An edge that differs on a *single* calibration rerun is
  permanently zeroed for the whole campaign. JS nondeterminism (`Date.now`, `Math.random`,
  iteration order) is pervasive and often co-located with interesting logic, so this blinds the
  fuzzer to whole regions on thin evidence.

## What Changes

- **Cap generalization (C2).** Bound the generalization stage to `MAX_GENERALIZATION_EXECS`
  target executions per entry; on exhaustion it finalizes early (preserving
  `GeneralizedInputMetadata` and the normal transition to grimoire/unicode) instead of running
  the sweep to completion.
- **Gate expensive stages (C2).** The first `EXPENSIVE_STAGE_WARMUP` interesting entries run the
  full expensive pipeline (colorization/REDQUEEN + structure-aware stages); afterward those
  stages run on a sampled fraction of entries, decided by the seeded RNG (deterministic under a
  fixed seed). The cheap, bounded I2S stage stays available regardless.
- **Bucketed admission (C3).** Coverage counts are classified into AFL hit-count buckets in
  place before feedback and novelty evaluation, so `MaxMapFeedback` admits on a new
  (edge, bucket) rather than a raw per-edge maximum. The classification is a fixed point of the
  existing `FEATURE_BUCKET_INDEX`, so the `ft` stat stays consistent.
- **Down-weight unstable edges (C4).** Calibration compares *classified* snapshots (within-bucket
  count jitter is no longer instability) and records per-edge disagreement counts across reruns;
  an edge is flaky *for an entry* only on a strict majority of reruns. An edge is masked globally
  only after `UNSTABLE_ENTRY_THRESHOLD` distinct entries independently find it flaky - a single
  entry's noise never blinds an edge.

## Capabilities

### Modified Capabilities

- `stage-execution`: expensive stages (colorization/REDQUEEN and the structure-aware post-I2S
  stages) are gated by a warmup-then-sample budget instead of running on every interesting entry.
- `grimoire-generalization`: the generalization sweep is bounded by a per-entry exec cap and
  finalizes early when exhausted.
- `fuzzing-engine`: the shared coverage-evaluation helper classifies hit counts into AFL buckets
  before feedback, so admission keys on a new (edge, bucket).
- `edge-coverage`: novelty is computed against the classified (bucketed) history rather than raw
  per-edge counts.
- `power-scheduling`: unstable-edge detection compares classified snapshots, requires a majority
  of reruns per entry, and masks an edge only after multiple distinct entries corroborate it -
  replacing the prior single-sample, single-entry, only-grows rule.

### New Capabilities

_None._

## Impact

- **Crates:** `vitiate-engine` only (`stages.rs`, `generalization.rs`, `coverage.rs`,
  `calibration.rs`, `mod.rs`). New internal constants; new `Fuzzer` fields
  (`generalization_execs`, `expensive_stage_entries`, `edge_flaky_entries`); the calibration
  state's per-edge marker becomes a disagreement counter.
- **No napi/TS surface change.** The gate/cap/threshold are internal engine tunables, not user
  config; `index.d.ts` and plugin options are unchanged.
- **Behavior:** corpus admission and calibration masking change (more loop-count features
  admitted, fewer edges wrongly masked); expensive-stage cost drops after warmup. Edge ids and
  artifact formats are unchanged.
- **Determinism preserved:** the stage-gate sampling uses the seeded engine RNG, so a fixed seed
  yields identical runs.
