## Why

LibAFL's `I2SRandReplace` mutator can only do same-length byte overwrites via `buffer_copy(dst, src, 0, pos, matched_prefix_len)`. When a CmpLog operand is longer than the matched region (e.g., replacing 4-byte "http" with 10-byte "javascript"), it truncates to the matched length, producing "java" instead of "javascript". The fuzzer gets permanently stuck — the next iteration sees `("java", "javascript")` and again writes only 4 bytes.

We proved this empirically: standard libfuzzer finds the identical bug in <1 second (~18K execs) via a length-changing CMP splice, while LibAFL's `I2SRandReplace` (used by both libafl_libfuzzer and vitiate) fails after 4.66M execs. The `cmplog-token-injection` change added dictionary promotion, but `TokenInsert` runs inside havoc stacking where subsequent mutations corrupt the insertion — the `validate-scheme` fuzz-pipeline e2e test still fails because the token-injected "javascript" is reliably destroyed by subsequent havoc mutations before the iteration completes.

Inspection of libfuzzer's source (`compiler-rt/lib/fuzzer/FuzzerMutate.cpp:183-203`) confirms it uses a coin-flip between INSERT (splice with `memmove` + `memcpy`, growing the buffer) and OVERWRITE (same-length `memcpy`). LibAFL's I2S only has the overwrite path. Adding the splice path to I2S is the correct fix: it runs post-havoc (unstacked), so splice results are not corrupted by subsequent mutations.

## What Changes

- Add a new `I2SSpliceReplace` mutator that extends `I2SRandReplace`'s `CmpValues::Bytes` handling with a splice path: when the replacement operand differs in length from the matched region, randomly choose between in-place overwrite (current behavior) and splice (delete matched bytes, insert replacement bytes, changing input length).
- Replace `I2SRandReplace` with `I2SSpliceReplace` in the post-havoc mutation pipeline in `engine.rs`.
- Reuse LibAFL's existing `CmpValuesMetadata`, `buffer_copy`, `buffer_self_copy`, and `ResizableMutator` traits — no new LibAFL infrastructure needed.

## Capabilities

### New Capabilities

- `i2s-splice-mutation`: A post-havoc mutator that extends I2S byte replacement with length-changing splice operations, matching libfuzzer's `ApplyDictionaryEntry` behavior for `CmpValues::Bytes`.

### Modified Capabilities

- `fuzzing-engine`: The post-havoc I2S mutator changes from `I2SRandReplace` to `I2SSpliceReplace`. `getNextInput()` mutation pipeline is updated.
- `cmplog-feedback`: No requirement changes — the existing `CmpValuesMetadata` and token promotion are consumed as-is.

## Impact

- **Code:** `vitiate-napi/src/engine.rs` (new mutator struct, mutation pipeline update).
- **Dependencies:** No new crate dependencies — uses existing LibAFL `CmpValuesMetadata`, `buffer_copy`, `buffer_self_copy`, `ResizableMutator`, `HasMutatorBytes`, `HasMaxSize`.
- **API:** No public API changes. The `Fuzzer` class interface is unchanged.
- **Performance:** Negligible — the splice path adds one resize + memmove per I2S hit vs the current memcpy. I2S fires at most once per iteration.
- **Tests:** The `validate-scheme` fuzz-pipeline e2e test (currently failing despite `cmplog-token-injection`) should pass once this is implemented, as the post-havoc splice path avoids the stacking corruption that defeats `TokenInsert`.
