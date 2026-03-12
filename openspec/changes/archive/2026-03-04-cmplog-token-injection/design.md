## Context

The vitiate fuzzer uses LibAFL's `I2SRandReplace` mutator to apply CmpLog-guided mutations. When the SWC instrumentation inserts `__vitiate_trace_cmp(scheme, "javascript", ...)`, the runtime records `CmpValues::Bytes("http", "javascript")` (the actual input value vs. the comparison operand). `I2SRandReplace` then tries to replace "http" in the input with "javascript" - but it uses `buffer_copy` with `size` equal to the matched prefix length (4 bytes), so it only copies "java", producing "java://..." instead of "javascript://...". The mutator can never grow the input to accommodate the full replacement.

This is the same limitation present in `libafl_libfuzzer`'s pipeline. AFL++'s `AflppRedQueen` works around it by extracting CmpLog byte operands into the `Tokens` dictionary (lines 1861-1914 of LibAFL's `token_mutations.rs`). The `TokenInsert` mutator can then insert the full token at any position, growing the input buffer via `resize`.

The vitiate engine currently uses `havoc_mutations()` without `tokens_mutations()`, and never populates `Tokens` metadata. Both gaps need to be closed.

## Goals / Non-Goals

**Goals:**

- Enable the fuzzer to synthesize string values longer than what exists in the current input, using CmpLog comparison feedback.
- Follow the established LibAFL pattern (`AflppRedQueen`'s token gathering) rather than inventing a new mechanism.
- Keep the change minimal: no new crates, no public API changes, no SWC/TypeScript changes.

**Non-Goals:**

- Implementing splice-based I2S (replacing `I2SRandReplace` with a length-aware variant). This is a possible future improvement but not needed - token injection solves the immediate problem.
- Supporting user-provided dictionaries (libFuzzer `-dict` flag). This is a separate feature that would build on the same `Tokens` infrastructure but has different concerns (file parsing, CLI integration).
- Modifying LibAFL upstream. All changes are in the vitiate engine layer.

## Decisions

### Decision 1: Extract tokens in `report_result()` alongside CmpLog drain

**Choice:** After draining the CmpLog accumulator into `CmpValuesMetadata`, iterate over the drained entries, extract `CmpValues::Bytes` operands, and merge them into `Tokens` metadata on the state.

**Rationale:** This is the natural insertion point - the CmpLog entries are already available, and the state is mutable. Doing it here means tokens accumulate monotonically across iterations (new comparison operands discovered in later iterations get added to the dictionary). This matches `AflppRedQueen`'s approach.

**Alternative considered:** Extract tokens in `get_next_input()` by reading `CmpValuesMetadata`. Rejected because it would re-extract the same entries every iteration instead of accumulating.

### Decision 2: Merge `tokens_mutations()` into the havoc mutator

**Choice:** Change the `FuzzerMutator` type from `HavocScheduledMutator<HavocMutationsType>` to `HavocScheduledMutator<havoc_mutations().merge(tokens_mutations())>` - the same pattern used by `libafl_libfuzzer` (line 372 of its `lib.rs`).

**Rationale:** This gives the standard havoc scheduler equal probability of selecting `TokenInsert` or `TokenReplace` alongside other mutations (bit flips, byte flips, etc.). `TokenInsert` can grow the input and `TokenReplace` can overwrite with full token length, both solving the fixed-size limitation.

**Alternative considered:** Add token mutations as a separate stage (like I2S). Rejected because the havoc scheduler already handles mutation selection and stacking, and `libafl_libfuzzer` uses the merged approach.

### Decision 3: Deduplicate tokens via `Tokens::add_token()`

**Choice:** Use LibAFL's `Tokens::add_token()` which internally deduplicates (it checks if the token already exists before adding). Extract both operands from each `CmpValues::Bytes` entry. Skip empty byte sequences and sequences that are all null bytes or all 0xFF (matching `AflppRedQueen`'s `try_add_autotokens` filter).

**Rationale:** Without deduplication, the token list would grow unboundedly as the same comparisons fire every iteration. `Tokens::add_token()` handles this efficiently. The null/0xFF filter avoids polluting the dictionary with non-meaningful values.

### Decision 4: Also extract numeric CmpValues as string tokens

**Choice:** For `CmpValues::U8`, `U16`, `U32`, and `U64`, extract both operands as their decimal string representation and add as tokens. The CmpLog serializer already emits a `Bytes` entry for integer comparisons (with decimal string representations), so this happens naturally - no special handling needed for numeric types.

**Rationale:** The `cmplog` module already serializes integer comparisons as both a numeric `CmpValues` variant and a `CmpValues::Bytes` with decimal string representations. Token extraction from `Bytes` entries covers both string and numeric comparisons.

## Risks / Trade-offs

**[Risk: Token dictionary grows large]** → The 4096-entry CmpLog capacity limit bounds how many new tokens can be added per iteration. `Tokens::add_token()` deduplicates, so the dictionary converges quickly as the same comparisons are seen repeatedly. In practice, JavaScript programs have a bounded number of string comparisons. If this becomes an issue, a maximum dictionary size can be added later.

**[Risk: Token mutations dilute havoc effectiveness]** → Adding `TokenInsert` and `TokenReplace` to the havoc mutation list means each individual mutation type is selected less frequently. This is the same trade-off `libafl_libfuzzer` makes and is considered acceptable - the token mutations provide high-value guided mutations that compensate for the slight dilution.

**[Risk: Performance overhead scanning CmpLog entries]** → Iterating over up to 4096 CmpLog entries per `report_result()` call and calling `add_token()` (which does a linear scan for deduplication) adds overhead. With typical CmpLog entry counts (tens to low hundreds) and typical token dictionary sizes (tens to low hundreds), this is negligible compared to target execution time.
