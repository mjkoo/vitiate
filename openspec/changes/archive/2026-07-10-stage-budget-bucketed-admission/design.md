## Context

The engine drives one supervised worker through a batched FFI loop. When `report_result`
finds new coverage it admits the input via `MaxMapFeedback` (`coverage.rs::evaluate_coverage`),
calibrates it over 4-8 reruns (`calibration.rs`), then `begin_stage` runs a fixed pipeline:
colorization -> REDQUEEN (or I2S) -> generalization -> grimoire -> unicode -> json
(`stages.rs::begin_stage_impl`, `generalization.rs`). Three parts of this path are the design
review's C2/C3/C4:

- Admission compares raw per-edge counts (`map[i] > history[i]`); the AFL bucket table
  (`FEATURE_BUCKET_INDEX`) exists but feeds only the `ft` display stat.
- Generalization's Offset/Delimiter/Bracket sweep has no exec cap, and every expensive stage
  runs on every interesting entry.
- Calibration marks an edge unstable (permanently zeroing it via `unstable_entries`) on the
  first differing rerun of a single entry.

This change implements C2, C3, and C4 together because C3's classification defines what
"differs" means for C4's instability detection, and both live in the same feedback/calibration
path.

## Goals / Non-Goals

**Goals:**

- Admit corpus entries on new (edge, hit-count-bucket), not raw per-edge max.
- Stop a single entry's calibration noise from permanently blinding an edge.
- Bound generalization cost per entry and stop running expensive stages on every entry.
- Preserve determinism under a fixed seed; no napi/TS surface change; no edge-id churn.

**Non-Goals:**

- Swapping to LibAFL's `HitcountsMapObserver` (the engine reconstructs observers from a raw
  pointer per exec; in-place classification is the smaller, equivalent change).
- User-facing config knobs for the gate/cap/threshold (kept as internal tunables; can be
  promoted later if needed).
- Per-statement basic-block coverage (C1a, out of scope) and multi-worker parallelism (A2).

## Decisions

### 1. In-place hit-count classification for bucketed admission (C3)

A `CLASSIFY_COUNT[256]` table maps each raw count to its AFL bucket's lower-bound representative
(`0,1,2,3,4,8,16,32,128`). `classify_counts_in_place` is applied to the coverage map at the top
of `evaluate_coverage`, before the observer and novelty scan read it, so `MaxMapFeedback`'s
`map[i] > history[i]` becomes a new-bucket test and the history stores classified values.

The representatives are chosen as fixed points of the existing display table:
`CLASSIFY_COUNT[CLASSIFY_COUNT[n]] == CLASSIFY_COUNT[n]` and
`FEATURE_BUCKET_INDEX[CLASSIFY_COUNT[n]] == FEATURE_BUCKET_INDEX[n]`. So `compute_coverage_features`
(the `ft` stat) stays correct over a classified history map, and nonzero counts stay nonzero, so
`bitmap_size` and `MapIndexesMetadata` are unaffected. The map is zeroed after each eval, so
classification never leaks across executions.

### 2. Majority-per-entry, corroborated-across-entries unstable masking (C4)

Calibration classifies each rerun snapshot before comparing, so within-bucket count jitter (a
loop running 5 vs 6 times) is not a disagreement. The calibration state replaces its
`u8::MAX`-marker map with a per-edge disagreement counter. At `calibrate_finish` an edge is
flaky *for this entry* only when it differed in a strict majority of the baseline comparisons
(`count * 2 > comparisons`, where `comparisons = iterations - 2`). Seeing any disagreement still
extends the run budget to `CALIBRATION_STAGE_MAX` so there are enough samples to judge by
majority.

A new `edge_flaky_entries: HashMap<usize, u32>` counts how many distinct entries found each edge
flaky. An edge joins the globally-masked `unstable_entries` set only at
`UNSTABLE_ENTRY_THRESHOLD` (2) entries. This is the review's "down-weight, don't delete on a
single sample": one entry's noise is tracked but never masks an edge; masking requires
independent corroboration. Masking application (zeroing masked edges before feedback) is
unchanged.

### 3. Per-entry generalization exec cap (C2)

A `generalization_execs` counter on `Fuzzer` is reset in `begin_generalization` and incremented
per exec in `advance_generalization`. Once it reaches `MAX_GENERALIZATION_EXECS` (2048, mirroring
the REDQUEEN candidate cap) outside the Verify phase, the stage calls `finalize_generalization`
with the payload generalized so far - preserving `GeneralizedInputMetadata` and the normal
transition to grimoire/unicode rather than hard-aborting. The Verify exec is never cut short.

### 4. Warmup-then-sample gate for expensive stages (C2)

`begin_stage_impl` calls `should_run_expensive_stages()` once per interesting entry. The first
`EXPENSIVE_STAGE_WARMUP` (64) entries always run the expensive stages; afterward the seeded RNG
samples a fixed fraction (`rand_below(DENOM) < NUMER`, currently 1/2). When gated out, the entry
skips colorization/REDQUEEN and the structure-aware post-I2S stages (returning `None` -> havoc),
but the bounded I2S stage still runs when CmpLog data exists. The warmup guarantees the many
single-entry stage tests are unaffected and gives thorough early exploration; the sample bounds
long-tail amplification, mirroring AFL++ running cmplog/REDQUEEN on a fraction of the queue.

## Risks / Trade-offs

- **Under-masking noise (C4):** until two entries corroborate an edge, its calibration noise can
  admit a few junk corpus entries. This is the intended trade vs. the old behavior blinding whole
  regions; admitting a little noise is far less harmful than deleting real coverage.
- **Missed expensive-stage work after warmup (C2):** sampling skips the expensive stages on some
  entries. Acceptable and the point - the cap/gate target the amplification the review flagged;
  the fraction is a conservative 1/2 and can be tuned.
- **Internal tunables, not config:** deviates from the plan's "expose as config knobs" to avoid
  napi/TS/docs surface creep. Determinism is preserved via the seed regardless; promoting to
  config later is a small follow-up if users need it.

## Migration

None. No config, artifact, or edge-id changes. Corpus admission and calibration behavior change
in-place; existing corpora and control files remain valid.
