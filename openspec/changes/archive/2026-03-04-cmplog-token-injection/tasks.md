## 1. Mutator pipeline: add token mutations

- [x] 1.1 Change `FuzzerMutator` type alias from `HavocScheduledMutator<HavocMutationsType>` to use `havoc_mutations().merge(tokens_mutations())` in `vitiate-napi/src/engine.rs`
- [x] 1.2 Update `Fuzzer::new()` constructor to build the mutator with `havoc_mutations().merge(tokens_mutations())`
- [x] 1.3 Add `use libafl::mutators::{Tokens, tokens_mutations}` imports
- [x] 1.4 Update test helpers that construct `HavocScheduledMutator` (search for `havoc_mutations()` in test code) to use the merged form

## 2. Token extraction in report_result

- [x] 2.1 Add a helper function `extract_tokens_from_cmplog(entries: &[CmpValues]) -> Vec<Vec<u8>>` that iterates `CmpValues::Bytes` entries and collects both operands, filtering out empty, all-null, and all-0xFF sequences
- [x] 2.2 In `Fuzzer::report_result()`, after draining CmpLog into `CmpValuesMetadata`, call the extraction helper and merge results into `Tokens` metadata on the state using `Tokens::add_token()`

## 3. Tests

- [x] 3.1 Write unit test: token extraction helper correctly extracts byte operands from mixed `CmpValues` entries
- [x] 3.2 Write unit test: token extraction filters out empty, all-null, and all-0xFF operands
- [x] 3.3 Write unit test: `report_result()` populates `Tokens` metadata from CmpLog entries
- [x] 3.4 Write unit test: tokens accumulate across multiple `report_result()` calls (not replaced)
- [x] 3.5 Write unit test: tokens are deduplicated across iterations
- [x] 3.6 Write integration test: end-to-end fuzzing loop with string comparison discovers token and uses it in mutations

## 4. Verification

- [x] 4.1 Run full test suite (`pnpm test`) - no regressions
- [x] 4.2 Run lints and checks (clippy, eslint, prettier, cargo fmt, cargo deny)
- [x] 4.3 Verify fuzzer finds validate-scheme planted bug - found "javascript" scheme crash in ~28.5K execs (0.6s)
- [x] 4.4 Run fuzz-pipeline e2e test (`pnpm test:e2e`) - both fuzz targets pass
