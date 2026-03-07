## Context

Vitiate's stage pipeline currently runs I2S (simple CmpLog replacement), generalization, Grimoire, and Unicode stages after calibration for each interesting corpus entry. The CmpLog data path collects comparison operands via the SWC plugin's `__vitiate_trace_cmp(left, right, cmpId, op)` calls, but discards the `cmpId` and `op` parameters after using `op` for evaluation. The data is stored as a flat `Vec<CmpValues>` in `CmpValuesMetadata`.

Full REDQUEEN requires three new pipeline stages (colorization, dual CmpLog tracing, REDQUEEN mutation) and enriched CmpLog data (operator type, site ID keying, dual-trace values). The generalization stage establishes the pattern for interactive multi-execution stages, and the Grimoire/Unicode auto-detection infrastructure provides the template for REDQUEEN auto-enablement.

## Goals / Non-Goals

**Goals:**

- Enable transform-aware comparison feedback (XOR, arithmetic, case, endianness) for binary/encoded targets
- Reuse LibAFL's `AflppRedQueen` mutator directly for the mutation logic
- Follow established patterns: generalization for interactive stages, deferred detection for auto-enablement
- Maintain backward compatibility: existing I2S, Grimoire, and Unicode behavior unchanged when REDQUEEN is disabled

**Non-Goals:**

- Incremental colorization (caching taint metadata across mutations of the same entry) — future optimization
- `is_const` detection at instrumentation time — optional enhancement, not required for correctness
- Custom transform detection beyond what `AflppRedQueen` already implements
- Changing the SWC plugin instrumentation — the `cmpId` and `op` parameters are already emitted

## Decisions

### D1: Extend the existing CmpLog accumulator rather than creating a parallel one

The thread-local `CMPLOG_ENTRIES` currently stores `Vec<CmpValues>`. Two options:

**Option A (chosen): Extend to `Vec<(CmpValues, u32, CmpLogOperator)>`** — store the comparison site ID and operator alongside each entry. The `push()` function gains two parameters. `drain()` returns the enriched tuples. I2S reads the `CmpValues` component and ignores the rest.

**Option B: Separate accumulator for enriched data.** Doubles the storage path, requires coordinating enable/disable/drain across two thread-locals, and forces callers to choose which to read.

Option A is simpler. The I2S mutator only reads operand values, so carrying extra fields is harmless. The `CmpLogOperator` is a small enum (Equal, Less, Greater, NotEqual) derived from the `op` string in `trace_cmp()`.

### D2: Site-keyed metadata via `AflppCmpValuesMetadata`

Replace `CmpValuesMetadata { list: Vec<CmpValues> }` with LibAFL's `AflppCmpValuesMetadata` which stores `orig_cmpvals: HashMap<usize, Vec<CmpValues>>` and `new_cmpvals: HashMap<usize, Vec<CmpValues>>` keyed by comparison site ID, plus `headers: Vec<(usize, AflppCmpLogHeader)>` recording operator attributes.

**Impact on I2S:** The I2S mutator (`I2SRandReplace`) reads from `CmpValuesMetadata`. To maintain compatibility, `report_result()` stores **both** metadata types on the state: `AflppCmpValuesMetadata` (site-keyed, for REDQUEEN) and `CmpValuesMetadata` (flat list, for I2S — synthesized by flattening `orig_cmpvals` values into a `Vec<CmpValues>` at drain time). This avoids any runtime adapter — both types are populated once during `report_result()`, and the I2S mutator code requires zero changes.

**Population timing:**
- `orig_cmpvals` and `headers` are populated during `report_result()` from the enriched CmpLog drain.
- `new_cmpvals` is populated during the dual tracing sub-stage (colorized input execution).

### D3: Fast coverage hashing for colorization using index-set hashing

Colorization needs to compare coverage patterns across hundreds of executions. SHA-256 (`artifact_hash`) is too expensive for per-execution use.

**Approach:** Hash only the set of nonzero coverage map indices using `DefaultHasher` (SipHash). This ignores hit counts (which fluctuate between runs) and focuses on which edges were hit — matching colorization's semantics (did the coverage *pattern* change?).

```
fn coverage_hash(map: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for (i, &val) in map.iter().enumerate() {
        if val > 0 {
            i.hash(&mut hasher);
        }
    }
    hasher.finish()
}
```

**Alternative considered:** Hash the full map bytes. Rejected because hit count fluctuation between identical inputs would produce false "changed" results, defeating colorization's binary search.

### D4: Colorization as a new `StageState::Colorization` variant following the generalization pattern

The colorization algorithm is interactive (O(n log n) executions) and maps directly to the generalization stage's pattern: maintain state across `advance_stage()` calls, execute candidates, check coverage, refine.

**State shape:**

```
StageState::Colorization {
    corpus_id: CorpusId,
    original_hash: u64,
    original_input: Vec<u8>,
    changed_input: Vec<u8>,
    pending_ranges: Vec<(usize, usize)>,  // ranges to test, sorted largest-first
    taint_ranges: Vec<Range<usize>>,      // confirmed free ranges
    executions: usize,
    max_executions: usize,                // 2 * input_len
    awaiting_dual_trace: bool,            // true after binary search, before dual trace
}
```

**Algorithm:**
1. `begin_colorization()`: Return the original input for execution (baseline). Apply `type_replace()` to produce `changed_input`. Push the full range `[0, len)` to `pending_ranges`.
2. First `advance_colorization()`: Compute `original_hash` from the coverage map left by the baseline execution. Zero the map. Apply the first pending range's changed bytes and yield the candidate.
3. Subsequent `advance_colorization()`: Check if the coverage hash of the last execution matches `original_hash`.
   - **Match:** The tested range is "free" — add to `taint_ranges`.
   - **Mismatch:** Revert, split into two halves, push both to `pending_ranges`.
4. When `pending_ranges` is empty or `max_executions` reached: merge adjacent `taint_ranges`, transition to dual tracing. `TaintMetadata` is NOT stored yet — it is deferred until the dual trace completes successfully, ensuring a clean abort path.

**Size threshold:** Skip colorization for inputs larger than `MAX_COLORIZATION_LEN` (4096 bytes). Fall back to I2S for oversized inputs.

### D5: Dual tracing as the final step of colorization, not a separate stage

After colorization completes, one more execution is needed: run the colorized input (free bytes randomized) with CmpLog capture enabled. This produces the `new_cmpvals` that reveal transforms.

**Approach:** Make the dual trace the terminal step of the Colorization stage state. When `pending_ranges` is exhausted, instead of immediately transitioning to REDQUEEN, generate the fully-colorized input (all taint ranges randomized) and yield it as the next candidate. The following `advance_stage()` call captures CmpLog from that execution, stores it as `new_cmpvals`, and stores `TaintMetadata` on the fuzzer state (containing both the merged free byte ranges and the colorized input vector). Deferring `TaintMetadata` storage to this point ensures a clean abort path — if the dual trace crashes, no stale metadata remains.

**Why not a separate stage:** A 1-execution stage adds unnecessary state machine complexity. The colorized input is already available in the Colorization state. A boolean flag (`awaiting_dual_trace: bool`) on the Colorization state distinguishes the final dual-trace execution from normal colorization iterations.

**CmpLog capture during stages:** Currently, stages drain and discard CmpLog data (`let _ = crate::cmplog::drain()`) because stage mutations produce noise. For the dual trace execution specifically, `advance_colorization()` will drain and *retain* the CmpLog data instead of discarding it. This is the only stage execution that captures CmpLog.

### D6: REDQUEEN mutation stage with pre-generated candidate list

LibAFL's `AflppRedQueen` implements `MultiMutator` — it returns all candidates at once via `multi_mutate()`. The stage protocol expects one input per `advanceStage()` call.

**Approach:** Call `multi_mutate()` once in `begin_redqueen()`, store the full `Vec<BytesInput>`, yield one per `advance_redqueen()`. This matches the stage protocol without requiring changes to LibAFL's API.

**State shape:**

```
StageState::Redqueen {
    corpus_id: CorpusId,
    candidates: Vec<BytesInput>,
    index: usize,
}
```

**Candidate cap:** Pass `max_count: Some(MAX_REDQUEEN_CANDIDATES)` (2048) to `multi_mutate()` to bound worst-case stage length.

### D7: Complementary auto-detection with inverted polarity

REDQUEEN auto-enables when the corpus is non-UTF-8, using the same deferred detection infrastructure as Grimoire/Unicode.

**Implementation:**
- Add `redqueen_override: Option<bool>` and `redqueen_enabled: bool` to `Fuzzer`.
- In the deferred detection trigger (after `DEFERRED_DETECTION_THRESHOLD` interesting inputs), add:
  ```
  if self.redqueen_override.is_none() {
      self.redqueen_enabled = !is_utf8;
  }
  ```
- At initialization, when the corpus is empty (deferred), default `redqueen_enabled = false`.
- When explicitly configured (`redqueen: true` or `redqueen: false`), use the override directly.

This creates complementary specialization: text targets get Grimoire/Unicode, binary targets get REDQUEEN.

### D8: Skip I2S when REDQUEEN ran for the same corpus entry

REDQUEEN subsumes I2S — it tries all I2S replacements plus transform-aware variants. Running both is redundant.

**Approach:** In `begin_stage()`, after colorization + REDQUEEN complete, skip I2S and proceed directly to generalization (if enabled). If colorization was skipped (input too large or REDQUEEN disabled), run I2S as before.

The `begin_stage()` dispatch already chains stages in order. The modification is: when transitioning from REDQUEEN to the next stage, skip I2S. A simple flag (`redqueen_ran_for_entry: bool`, reset in `begin_stage()`) tracks this.

### D9: Revised stage pipeline ordering

```
Per interesting corpus entry:
  1. Calibration                              (existing, unchanged)
  2. Colorization + dual trace                (NEW, if redqueen_enabled && input <= MAX_COLORIZATION_LEN)
  3. REDQUEEN mutations                       (NEW, if colorization produced taint metadata)
  4. I2S mutations                            (existing, SKIPPED if REDQUEEN ran)
  5. Generalization                           (existing, if grimoire_enabled)
  6. Grimoire mutations                       (existing, if grimoire_enabled)
  7. Unicode mutations                        (existing, if unicode_enabled)
```

REDQUEEN stages run before I2S because they need the original CmpLog data (captured during `report_result()`) before I2S mutations could alter the corpus entry's metadata. Generalization/Grimoire/Unicode run after because they operate on structural properties independent of CmpLog.

### D10: `type_replace` ported from LibAFL

LibAFL's `type_replace` function performs byte-level type-preserving randomization with the key invariant that every byte is replaced with a value guaranteed to differ from the original. Digits stay digits, hex letters stay hex letters, whitespace pairs swap, and other bytes use XOR-based replacement. This preserves the character class structure of the input while changing values, which is important for JavaScript string comparisons that operate on UTF-8 bytes.

**Approach:** Port the function directly (~50 lines). The byte-level semantics are identical for JavaScript targets — the SWC plugin instruments UTF-8 source, and JavaScript string comparisons are serialized as UTF-8 in CmpLog.

## Risks / Trade-offs

**[Execution budget increase] → Size threshold + candidate cap.** Full REDQUEEN adds ~200-6000 executions per interesting input. The `MAX_COLORIZATION_LEN` (4096 bytes) threshold and `MAX_REDQUEEN_CANDIDATES` (2048) cap bound worst-case cost. For targets with small inputs (common in JavaScript fuzzing), the cost is modest (~200-500 additional executions).

**[CmpLog metadata format change is invasive] → Dual metadata storage for I2S.** Changing from `CmpValuesMetadata` to `AflppCmpValuesMetadata` touches `trace.rs`, `cmplog.rs`, `engine/mod.rs`, and the I2S path. Storing both `AflppCmpValuesMetadata` and `CmpValuesMetadata` (flattened from `orig_cmpvals`) during `report_result()` isolates the I2S mutator from the storage change with zero runtime cost. Token extraction continues to work on `CmpValues` regardless of keying.

**[LibAFL fork dependency] → Verify `AflppRedQueen` availability.** The current LibAFL dependency uses a custom fork (`constructable-unicode-metadata` branch). `AflppRedQueen`, `AflppCmpValuesMetadata`, and `TaintMetadata` must be available in this fork. If not, they may need to be cherry-picked or the fork updated. These types are in LibAFL's main branch and should be available.

**[Hash collisions in coverage hashing] → Acceptable for colorization.** SipHash u64 collisions are astronomically unlikely for coverage patterns. A false "same hash" result would incorrectly mark bytes as free, producing slightly larger taint ranges. This wastes REDQUEEN search effort but doesn't produce incorrect mutations — REDQUEEN validates candidates by execution.

**[Dynamic typing confuses dual tracing] → Graceful degradation.** JavaScript values can change type between runs, producing comparison entries with different types in original vs. colorized traces. `AflppRedQueen` handles this by doing byte-level matching — type mismatches produce fewer candidates (no transform detected), not incorrect ones.

**[REDQUEEN on text targets may be wasteful] → Auto-detection handles this.** With inverted-polarity auto-detection, REDQUEEN only auto-enables for binary targets. Users can explicitly enable it for text targets that use encoding (e.g., base64) if needed.
