## Context

LibAFL's `I2SRandReplace` mutator handles `CmpValues::Bytes` by finding one operand in the input (using decreasing prefix lengths) and overwriting it with `matched_prefix_len` bytes of the other operand. This means a 4-byte match can never be replaced by a 10-byte operand - only 4 bytes of the replacement are written.

Standard libfuzzer's equivalent (`ApplyDictionaryEntry` in `FuzzerMutate.cpp:183-203`) randomly chooses between INSERT (splice: shift tail right, write full replacement, grow buffer) and OVERWRITE (same-length memcpy). This INSERT path is what allows it to find bugs requiring length-changing string comparisons in <1 second.

Vitiate's mutation pipeline in `get_next_input()` runs two mutators sequentially:
1. `FuzzerMutator` (havoc + token mutations, stacked)
2. `I2SRandReplace` (post-havoc, unstacked)

The I2S mutator runs post-havoc and operates on `CmpValuesMetadata` populated by `report_result()`. This is the correct place to add the splice path - it won't be corrupted by havoc stacking.

## Goals / Non-Goals

**Goals:**

- Add a splice (insert) path to I2S byte replacement so the fuzzer can construct length-changing operand substitutions from CmpLog data.
- Match libfuzzer's behavior: 50/50 coin flip between splice and overwrite for `CmpValues::Bytes` matches.
- Unblock the `validate-scheme` fuzz-pipeline e2e test.
- Reuse as much existing LibAFL machinery as possible (`buffer_copy`, `buffer_self_copy`, `ResizableMutator`, `CmpValuesMetadata`).

**Non-Goals:**

- Implementing `AflppRedQueen` (requires taint tracking and two-run CmpLog protocol - architectural mismatch with vitiate's JS execution model).
- Implementing Grimoire (same architectural mismatch - requires Rust-side target re-execution).
- Adding splice to integer `CmpValues` variants (U8/U16/U32/U64 are fixed-width by nature).
- Changing `TokenInsert`/`TokenReplace` or their placement inside havoc stacking.

## Decisions

### Decision 1: New struct wrapping I2SRandReplace rather than forking

**Choice:** Create `I2SSpliceReplace` in `engine.rs` that delegates to `I2SRandReplace` for all `CmpValues` variants except `Bytes`, where it adds the splice path.

**Alternatives considered:**

- *Fork `I2SRandReplace` entirely:* Copies ~160 lines of integer handling code (U8/U16/U32/U64) that we don't need to modify. Creates maintenance burden when LibAFL updates the integer paths.
- *Monkeypatch / trait override:* Not possible - `I2SRandReplace::mutate` is a concrete method, not a trait default.

**Rationale:** Wrapping minimizes code duplication. The integer variants are delegated unchanged. Only the `CmpValues::Bytes` path is reimplemented with the added splice logic. If LibAFL ever adds a splice path upstream, we drop our wrapper with no other changes.

### Decision 2: Implementation approach - single random entry, splice before delegate

**Choice:** `I2SSpliceReplace::mutate()` follows `I2SRandReplace`'s single-entry selection strategy: it reads `CmpValuesMetadata`, picks one random entry via `state.rand_mut().below(cmps_len)`, and picks a random starting offset in the input. If the selected entry is `CmpValues::Bytes`, the wrapper handles it directly using its own matching loop (with the splice/overwrite coin flip). If the selected entry is a non-`Bytes` variant (U8/U16/U32/U64), the wrapper delegates the entire call to `I2SRandReplace::mutate()`, which performs its own independent random entry selection and matching.

**Rationale:** The wrapper only needs to intercept `CmpValues::Bytes`. All other variants pass through to the inner `I2SRandReplace` unchanged, avoiding reimplementation of integer replacement logic and its endianness handling. The delegation for non-`Bytes` entries means the inner mutator picks its own random entry - it might select a `Bytes` entry and apply the overwrite-only path, or it might select an integer entry. This is acceptable: over many iterations, the splice path fires whenever the outer selection happens to land on a `Bytes` entry (proportional to the fraction of `Bytes` entries in the metadata).

### Decision 3: 50/50 coin flip between splice and overwrite

**Choice:** For `CmpValues::Bytes` matches where operand lengths differ, use `state.rand_mut().below(2) == 0` to choose between:
- **Splice:** Resize input, shift tail via `buffer_self_copy`, write full replacement via `buffer_copy`. Input length changes by `replacement_len - matched_prefix_len`.
- **Overwrite:** `buffer_copy` with `matched_prefix_len` bytes of the replacement (matching `I2SRandReplace`'s existing behavior). Input length unchanged.

When operand lengths are equal, always overwrite (splice and overwrite are identical for same-length operands).

**Rationale:** Matches libfuzzer's `ApplyDictionaryEntry` behavior. The 50/50 split ensures both strategies are explored - overwrite preserves input structure, splice enables length-changing substitution. Uses `below(2)` rather than a `coinflip` method because LibAFL's `StdRand` exposes `below(N)` for uniform random selection.

### Decision 4: Respect `max_size` for splice

**Choice:** Before splicing, check that `current_len - matched_prefix_len + replacement_len <= max_size`. If the splice would exceed `max_size`, fall back to overwrite.

**Rationale:** Matches libfuzzer's guard (`if (Size + W.size() > MaxSize) return 0`). Prevents unbounded input growth. The subsequent `bytes.truncate(max_input_len)` in `get_next_input()` provides a second safety net, but checking upfront avoids wasted splice operations.

### Decision 5: Bidirectional matching preserved

**Choice:** Like `I2SRandReplace`, scan for both `v.0` in the input (replace with `v.1`) and `v.1` in the input (replace with `v.0`). The splice path applies to whichever direction matches first.

**Rationale:** CmpLog captures `(left_operand, right_operand)`. The input might contain either side. Bidirectional matching doubles the chance of finding a useful replacement.

## Risks / Trade-offs

**[Risk] Input bloat from repeated splicing** → The splice path can only grow the input. Over many iterations, inputs could trend larger. Mitigated by: (1) the 50/50 coin flip means half of I2S mutations don't grow, (2) `max_size` check prevents exceeding the limit, (3) havoc includes `BytesDeleteMutator` (4x weighted in LibAFL) which counteracts growth, (4) `get_next_input()` truncates to `max_input_len`.

**[Risk] Maintenance burden of wrapping I2SRandReplace** → If LibAFL changes the `CmpValuesMetadata` structure or `I2SRandReplace` API, our wrapper needs updating. Mitigated by: the wrapper is thin (~60 lines of splice logic), delegates all non-Bytes handling, and the `CmpValues` enum is stable.

**[Risk] Decreased match rate from partial matching** → `I2SRandReplace` uses decreasing `size` to find partial prefix matches (e.g., matching 3 of 4 bytes). With splice, a partial match might splice in the full replacement at a location where only a prefix matched. This could produce less useful mutations. Mitigated by: the 50/50 coin flip ensures the overwrite path (which handles partial matches well) is still used half the time.
