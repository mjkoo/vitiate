## 1. Create I2SSpliceReplace struct

- [x] 1.1 Define `I2SSpliceReplace` struct in `engine.rs` wrapping `I2SRandReplace` as an inner field
- [x] 1.2 Implement `Mutator<BytesInput, FuzzerState>` for `I2SSpliceReplace`: select one random `CmpValuesMetadata` entry via `state.rand_mut().below(cmps_len)`. If `Bytes`, handle directly with splice/overwrite logic. If non-`Bytes`, delegate the entire `mutate()` call to inner `I2SRandReplace`. Return `MutationResult::Skipped` if metadata is absent/empty or input is empty.
- [x] 1.3 Implement the splice path for `CmpValues::Bytes` matches: 50/50 choice via `state.rand_mut().below(2)` between overwrite (`buffer_copy` with `matched_prefix_len` bytes of the replacement) and splice (`resize` + `buffer_self_copy` + `buffer_copy` with full replacement), skipping the choice when operand lengths are equal (always overwrite)
- [x] 1.4 Add `max_size` guard: before splicing, check `current_len - matched_prefix_len + replacement_len <= max_size`, fall back to overwrite if exceeded
- [x] 1.5 Implement bidirectional operand matching: scan for both `v.0` (replace with `v.1`) and `v.1` (replace with `v.0`), first match from random offset wins
- [x] 1.6 Implement partial prefix matching: try decreasing prefix lengths (`n`, `n-1`, ..., `1`) at each position; splice uses full replacement regardless of prefix match length

## 2. Integrate into mutation pipeline

- [x] 2.1 Replace `i2s_mutator: I2SRandReplace` field with `i2s_mutator: I2SSpliceReplace` in the `Fuzzer` struct
- [x] 2.2 Update `Fuzzer::new()` to construct `I2SSpliceReplace` wrapping `I2SRandReplace`
- [x] 2.3 Verify `get_next_input()` pipeline requires no changes beyond the type swap (the `.mutate()` call site should work unchanged)

## 3. Tests

All unit tests MUST use a seeded `StdRand` to make RNG-dependent behavior deterministic. Choose seeds that produce the desired code path (e.g., a seed where `below(2) == 0` for splice tests, `below(2) == 1` for overwrite tests). Document the chosen seed values and verify them in each test's setup.

- [x] 3.1 Write unit test: splice replaces shorter match with longer operand (e.g., `"http"` → `"javascript"` in `"http://example.com"` produces `"javascript://example.com"`)
- [x] 3.2 Write unit test: splice replaces longer match with shorter operand (e.g., `"javascript"` → `"ftp"` in `"javascript://x"` produces `"ftp://x"`)
- [x] 3.3 Write unit test: overwrite truncates longer replacement to matched prefix length (e.g., `"http"` → `"javascript"` with overwrite produces `"java://example.com"`)
- [x] 3.4 Write unit test: equal-length operands always use overwrite regardless of RNG state
- [x] 3.5 Write unit test: non-`Bytes` entry selected → delegates entire call to inner `I2SRandReplace`
- [x] 3.6 Write unit test: splice exceeding `max_size` falls back to overwrite
- [x] 3.7 Write unit test: splice within `max_size` proceeds normally
- [x] 3.8 Write unit test: bidirectional matching - forward (`v.0` found → replace with `v.1`) and reverse (`v.1` found → replace with `v.0`)
- [x] 3.9 Write unit test: partial prefix match with splice uses full replacement operand
- [x] 3.10 Write unit test: empty `CmpValuesMetadata` or empty input returns `MutationResult::Skipped`

## 4. Verification

- [x] 4.1 Run `cargo clippy --workspace --all-targets` - no warnings
- [x] 4.2 Run `cargo fmt --all --check` - clean
- [x] 4.3 Run full test suite (`pnpm test`) - all pass (pre-existing example-url-parser failure unrelated to this change)
- [x] 4.4 Run fuzz-pipeline e2e test to confirm validate-scheme target now passes (currently failing due to havoc stacking corrupting token-injected mutations)
