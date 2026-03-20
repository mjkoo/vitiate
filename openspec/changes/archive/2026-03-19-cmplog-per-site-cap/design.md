## Context

The CmpLog accumulator (`cmplog.rs`) stores comparison operands observed during each fuzz iteration. The current design has a global 4096-entry cap but no per-site limiting. In targets with tight loops (e.g., binary parsers iterating over input bytes), a single comparison site like `i < length` can produce hundreds of entries per iteration, crowding out high-value entries from magic number checks and protocol parsing.

The expensive work happens in `trace_cmp_record` (trace.rs) which calls `serialize_to_cmp_values` - extracting JS values via NAPI, formatting numbers as strings via ryu_js, and allocating CmpValues entries - before passing them to `push()`. Currently, there is no way to skip this serialization work for sites that have already reached their budget.

## Goals / Non-Goals

**Goals:**
- Reduce CmpLog serialization overhead by skipping entries from sites that have already recorded enough data for the current iteration
- Provide the early-exit check before serialization so NAPI extraction and ryu_js formatting are avoided entirely for capped sites
- Preserve enough entries per site for REDQUEEN dual-trace and I2S mutation quality
- Keep the implementation simple and allocation-free on the hot path

**Non-Goals:**
- Changing the CmpLog entry format or serialization logic (Bytes emission for integers stays as-is)
- Modifying the SWC plugin instrumentation or NAPI interface
- Adding value-level deduplication (same operand pair at the same site) - this is a future optimization
- Tuning the cap value to a specific benchmark - pick a reasonable default, expose as a constant

## Decisions

### Decision 1: Fixed-size count array indexed by `cmp_id % N` (not HashMap)

The per-site count tracker uses a fixed-size `[u8; N]` array where `N` is a power of two (e.g., 512). Each slot is indexed by `cmp_id & (N - 1)`. The count saturates at the cap value (no overflow).

**Rationale:** A `HashMap<u32, u16>` would give exact per-site counts but adds allocation overhead and a hash lookup on every `trace_cmp_record` call - the hottest path in the system. A fixed-size array is:
- Zero-allocation (embedded in `CmpLogState`, which is `thread_local`)
- O(1) lookup (single array index, no hashing)
- Cache-friendly (sequential memory, fits in L1 at 512 bytes)

**Tradeoff:** Hash collisions cause two distinct sites sharing a slot to share a budget. Site A and site B both mapping to slot K means their combined entries are capped at N rather than N each. This is acceptable because:
- The cap is a performance heuristic, not a correctness invariant
- Under-recording is safe (records fewer entries, never more)
- With 512 slots and typical module sizes (tens to hundreds of comparison sites), collision rates are low
- The `cmp_id` values are FNV-1a hashes of source locations, providing good distribution

**Alternative considered:** Per-site HashMap. Rejected due to allocation overhead on every push in the hottest code path. The fixed array is measurably faster for the expected number of sites.

### Decision 2: Early-exit function checked before serialization

Add a public `is_site_at_cap(cmp_id: u32) -> bool` function that checks the per-site count against the cap. `trace_cmp_record` calls this *before* `serialize_to_cmp_values`, so the expensive NAPI extraction and ryu_js formatting are skipped entirely for capped sites.

The check must happen outside the `RefCell` borrow that `push()` uses, to avoid a double-borrow panic. `is_site_at_cap` does its own `borrow()` (immutable) and returns before `push()` does `borrow_mut()`.

**Rationale:** The whole point is to avoid the serialization work. If the check were inside `push()`, the caller would have already paid for NAPI calls and string formatting before learning the entry will be dropped.

**Alternative considered:** A closure-based API (`try_push(cmp_id, || serialize(...))`) that only invokes the closure if the site has room. This is cleaner conceptually but forces the serialization closure to capture the NAPI env and value handles, complicating lifetimes. The two-step check-then-push is safe because the accumulator is thread-local and single-threaded - no TOCTOU race.

### Decision 3: Cap value of 8 entries per site per iteration

The default cap is 8 entries per site. This is stored as a module-level constant (`MAX_ENTRIES_PER_SITE`).

**Rationale:**
- REDQUEEN dual-trace compares original vs colorized operands per site. It needs at least one entry per site from each execution, but benefits from a few more to capture operand diversity (e.g., a loop that iterates over different input bytes produces different operand pairs each iteration).
- I2S fallback picks random entries from the flat list. Capping at 8 means a 200-iteration loop contributes 8 entries instead of 200, dramatically improving the signal-to-noise ratio.
- Token extraction (`extract_tokens_from_cmplog`) saturates quickly - the first few string representations of integer comparisons are sufficient for dictionary seeding.
- 8 is consistent with AFL++'s practical observation that most useful I2S information comes from the first few executions of a comparison site.

Note: `serialize_number_pair` emits up to 2 `CmpValues` entries per call (one integer variant + one Bytes variant). The per-site cap counts entries, not calls, so a numeric comparison consumes 2 of the 8 slots. This means 4 distinct numeric operand pairs per site, which is sufficient.

### Decision 4: Count increment happens in `push()`, not in the check

`is_site_at_cap` is a read-only check. The count is incremented inside `push()` after the entry is actually stored. This keeps the count accurate even if the caller checks but decides not to push (e.g., `serialize_to_cmp_values` returns `None` for unsupported types).

### Decision 5: Counts reset in `drain()`, `enable()`, and `disable()`

Per-site counts are zeroed when the accumulator is drained (start of new iteration), when CmpLog is enabled (start of new fuzzing session), and when CmpLog is disabled (end of fuzzing session). This matches the existing lifecycle where `entries` is cleared at these points, and ensures stale counts do not persist across enable/disable cycles.

## Risks / Trade-offs

**[Collision-induced under-recording]** Two high-value sites that collide in the count array share a budget of 8 instead of 8 each. **Mitigation:** 512 slots with FNV-1a-distributed cmp_ids makes this rare. If it becomes an issue, increase the array size (1024 or 2048 bytes is still small).

**[Cap too low for some targets]** A target where the same comparison site sees many distinct, input-derived operand pairs (e.g., a table lookup in a loop) might benefit from more than 8 entries per site. **Mitigation:** The cap is a named constant, easy to tune. REDQUEEN's dual-trace handles this case well regardless because it compares orig vs colorized at the site level - it only needs the operands to differ between traces, not to see all possible values.

**[Cap too high for pathological targets]** A target with thousands of distinct comparison sites could still fill the 4096 global cap even with per-site capping (e.g., 512 sites x 8 = 4096). **Mitigation:** The global cap remains as the backstop. Per-site capping helps the common case (few hot sites dominating), not the pathological case (many cold sites).

**[Two-step check-then-push is not atomic]** Between `is_site_at_cap` returning false and `push` incrementing the count, another entry could theoretically be pushed. **Mitigation:** The accumulator is thread-local with no re-entrancy possible in the push path. The NAPI callback is synchronous and single-threaded. This is a non-issue.
