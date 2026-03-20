## 1. Per-site count tracking in CmpLogState

- [x] 1.1 Add `MAX_ENTRIES_PER_SITE` (8) and `SITE_COUNT_SLOTS` (512) constants to `cmplog.rs`
- [x] 1.2 Add `site_counts: [u8; SITE_COUNT_SLOTS]` field to `CmpLogState` struct, initialized to all zeros
- [x] 1.3 Update `push()` to check the per-site count and skip the entry (return early) when the count for `cmp_id & (SITE_COUNT_SLOTS - 1)` has reached `MAX_ENTRIES_PER_SITE`. When the entry is recorded, increment the per-site count after storing the entry
- [x] 1.4 Update `drain()` to zero the `site_counts` array alongside clearing entries
- [x] 1.5 Update `enable()` to zero the `site_counts` array alongside clearing entries
- [x] 1.6 Update `disable()` to zero the `site_counts` array alongside clearing entries

## 2. Early-exit check for trace_cmp_record

- [x] 2.1 Add public `is_site_at_cap(cmp_id: u32) -> bool` function that returns `true` when disabled, when the global cap is reached, or when the per-site count for the given `cmp_id` has reached `MAX_ENTRIES_PER_SITE`
- [x] 2.2 Update `trace_cmp_record` in `trace.rs` to replace the existing `is_enabled()` check with `is_site_at_cap(cmp_id)` (which subsumes the enabled check), called before `serialize_to_cmp_values`, returning early when `true`

## 3. Tests

- [x] 3.1 Test that entries within the per-site cap are recorded normally
- [x] 3.2 Test that entries beyond the per-site cap for a single site are dropped
- [x] 3.3 Test that different sites (non-colliding) have independent budgets
- [x] 3.4 Test that the global 4096 cap still applies when per-site caps are not hit
- [x] 3.5 Test that `drain()` resets per-site counts (entries accepted again after drain)
- [x] 3.6 Test that `enable()` resets per-site counts
- [x] 3.7 Test that `is_site_at_cap` returns `true` when disabled
- [x] 3.8 Test that `is_site_at_cap` returns `true` when the site is at cap
- [x] 3.9 Test that `is_site_at_cap` returns `false` when the site has room and accumulator is enabled
- [x] 3.10 Test that `is_site_at_cap` returns `true` when the global 4096 cap is reached but the per-site cap is not
- [x] 3.11 Test that multi-entry pushes (e.g., integer pair producing 2 entries) count both entries against the per-site cap, by pushing entries at the accumulator level and verifying the count
- [x] 3.12 Test that a partial multi-entry drop at the cap boundary records the first entry and drops the second (count = 7, two pushes for the same site)

## 4. Validation

- [x] 4.1 Run full test suite (`pnpm test`) and verify no regressions
- [x] 4.2 Run e2e tests (`pnpm test:e2e`) and verify no regressions
- [x] 4.3 Run all lints and checks (eslint, clippy, prettier, cargo fmt, cargo deny, cargo msrv)
