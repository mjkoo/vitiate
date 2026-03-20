## Why

CmpLog serialization accounts for ~47% of wall time in profiled benchmarks. The dominant cost is volume: a tight loop like `for (i = 0; i < length; i++)` fires `trace_cmp_record` on every iteration, producing hundreds of entries per comparison site that are useless for I2S mutations (neither operand is input-derived). These entries flood the 4096-entry accumulator, crowd out high-value comparisons like magic number checks, and waste mutation budget when the I2S fallback stage picks from them uniformly at random.

## What Changes

- Add per-site entry capping to the CmpLog accumulator. Each comparison site (identified by `cmp_id`) is limited to a configurable maximum number of entries per iteration (e.g., 8). Entries beyond the cap for a given site are silently dropped. The global 4096-entry cap remains as an overall ceiling.
- The per-site cap is enforced both via an early-exit check in `trace_cmp_record` (before serialization, avoiding NAPI extraction and `ryu_js` formatting entirely) and in `push()` (as a backstop). Serialization work for excess entries is avoided entirely.
- Per-site counts are reset on `drain()`, so each fuzz iteration starts with a fresh budget.

## Capabilities

### New Capabilities

(none - this is an internal optimization to an existing capability)

### Modified Capabilities

- `cmplog-feedback`: The accumulator's push behavior changes to enforce a per-site cap in addition to the existing global cap. The `CmpLogState` gains per-site count tracking. The global 4096-entry cap remains, but the effective number of entries per site is bounded. All downstream consumers (metadata building, token extraction, I2S, REDQUEEN) are unaffected - they receive fewer but higher-quality entries.

## Impact

- **vitiate-engine/src/cmplog.rs**: `CmpLogState` struct gains per-site count tracking (small HashMap or fixed-size structure). `push()` checks per-site count before recording. `drain()` resets per-site counts.
- **vitiate-engine/src/trace.rs**: `trace_cmp_record` replaces its existing `is_enabled()` early-exit check with `is_site_at_cap(cmp_id)`, which subsumes the enabled check and adds per-site and global cap checks before serialization.
- **No changes to**: SWC plugin, JS runtime, NAPI interface, metadata consumers, mutators, or stage pipeline. The optimization is entirely within the accumulator layer.
- **Behavioral change**: Fuzz targets with many iterations of the same comparison site will produce fewer CmpLog entries. This is intentional - REDQUEEN's dual-trace only needs a few entries per site to detect I2S correspondence, and the I2S fallback benefits from a higher signal-to-noise ratio in the entry list.
