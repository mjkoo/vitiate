## Why

LibAFL's `I2SRandReplace` mutator performs fixed-size byte overwrites when applying CmpLog-guided mutations. When a comparison operand in the input is shorter than the replacement value (e.g., "http" vs "javascript"), the mutator copies only the matched prefix length and cannot grow the input. This creates a deadlock where the fuzzer can never synthesize string values longer than what already exists at the match position. We confirmed experimentally: "data" (4 bytes, same as "http") is found in 2.2s, but "javascript" (10 bytes) is never found after 500K+ executions.

## What Changes

- Extract `CmpValues::Bytes` operands from the CmpLog accumulator during `report_result()` and merge them into the LibAFL `Tokens` metadata on the fuzzer state.
- Add `tokens_mutations()` (`TokenInsert` + `TokenReplace`) to the havoc mutator's mutation list so dictionary tokens are used during mutation. `TokenInsert` can grow the input buffer via `resize`, solving the length mismatch.
- Deduplicate and filter injected tokens (skip empty, skip tokens exceeding max input length) to avoid bloating the dictionary.

## Capabilities

### New Capabilities

- `cmplog-dictionary`: Extraction of CmpLog comparison operands into the LibAFL token dictionary, enabling length-changing mutations from comparison feedback.

### Modified Capabilities

- `fuzzing-engine`: The mutation pipeline changes from `havoc_mutations()` to `havoc_mutations().merge(tokens_mutations())`, and `report_result()` gains token extraction logic.
- `cmplog-feedback`: `report_result()` now extracts `Bytes` operands into `Tokens` metadata in addition to `CmpValuesMetadata`.

## Impact

- **Code:** `vitiate-napi/src/engine.rs` (mutation pipeline, report_result token extraction), potentially `vitiate-napi/src/cmplog.rs` (helper for token extraction).
- **Dependencies:** No new crate dependencies — `Tokens`, `tokens_mutations`, `TokenInsert`, `TokenReplace` are already in `libafl::mutators`.
- **API:** No public API changes. The `Fuzzer` class interface is unchanged.
- **Performance:** Marginal overhead per iteration to scan CmpLog entries and deduplicate tokens. Token count grows monotonically but is bounded by the 4096-entry CmpLog capacity limit and deduplication.
