## 1. Unicode Identification Metadata

- [x] 1.1 Use `UnicodeIdentificationMetadata` type from LibAFL - `Rc<Vec<(usize, BitVec)>>` storing UTF-8 region start offsets and character boundary bitvecs (this is LibAFL's type, used directly)
- [x] 1.2 Use `UnicodeIdentificationMetadata::new(bytes)` from LibAFL - BFS-based UTF-8 region extraction (`mjkoo/LibAFL` branch `constructable-unicode-metadata` adds `pub fn new(bytes: &[u8]) -> Self` constructor; no reimplementation needed)
- [x] 1.3 Add tests for metadata extraction - fully valid UTF-8, embedded invalid bytes, multi-byte characters, empty input, entirely non-UTF-8 input

## 2. Unicode Mutators

- [x] 2.1 Update `libafl` dependency and enable `unicode` feature - change workspace `Cargo.toml` git dependency from `AFLplusplus/LibAFL` `main` to `mjkoo/LibAFL` branch `constructable-unicode-metadata`, and add `"unicode"` to the features list. This provides access to `UnicodeIdentificationMetadata::new()`, all unicode mutator types, and `unicode_categories` lookup tables
- [x] 2.2 Integrate `UnicodeCategoryRandMutator` from LibAFL - call `.mutate()` directly, same pattern as Grimoire mutators
- [x] 2.3 Integrate `UnicodeSubcategoryRandMutator` from LibAFL - same as category mutator but uses subcategory-level selection (finer-grained)
- [x] 2.4 Integrate `UnicodeCategoryTokenReplaceMutator` from LibAFL - replaces category-contiguous range with a random dictionary token from `Tokens` metadata
- [x] 2.5 Integrate `UnicodeSubcategoryTokenReplaceMutator` from LibAFL - same as category token mutator but uses subcategory-level range selection
- [x] 2.6 Add tests for each mutator - letter→letter replacement, digit→digit replacement, subcategory preservation, token replacement, skipped on empty input, skipped on no UTF-8 region, skipped when exceeding max size, skipped when no tokens available

## 3. Unicode Configuration

- [x] 3.1 Add `unicode` field to `FuzzerConfig` struct and `FuzzOptions` TypeScript interface - tri-state `Option<bool>` matching Grimoire pattern
- [x] 3.2 Add `unicode` validation in `validateFuzzOptions()` in config.ts
- [x] 3.3 Implement shared auto-detection - `scan_corpus_utf8()` result resolves both Grimoire and unicode enable states; deferred detection threshold shared
- [x] 3.4 Pass `unicode` config through from TypeScript `FuzzOptions` to Rust `FuzzerConfig`
- [x] 3.5 Add tests for auto-detection - explicit enable/disable, immediate detection, deferred detection, independent Grimoire/unicode control, shared deferred threshold

## 4. Unicode Stage Integration

- [x] 4.1 Add `StageState::Unicode { corpus_id, iteration, max_iterations }` variant to the state machine
- [x] 4.2 Implement `begin_unicode()` - compute/cache `UnicodeIdentificationMetadata`, select 1-128 iterations, generate first mutation using `HavocScheduledMutator` with `max_stack_pow=7` (2..=128 stacked mutations per `mutate()` call) and weighted mutator pool (1x category + 4x subcategory for both random and token replacement). If `mutate()` returns `Skipped`, return unmodified clone for execution
- [x] 4.3 Implement `advance_unicode()` - evaluate coverage, drain CmpLog, generate next mutation or transition to `None` when iterations exhausted
- [x] 4.4 Implement `abort_unicode()` - drain CmpLog, zero coverage map, increment exec counter, transition to `None`
- [x] 4.5 Add pipeline transitions - I2S→Unicode (when Grimoire stages not applicable: disabled, OR entry does not qualify for generalization and has no pre-existing `GeneralizedInputMetadata`), Grimoire→Unicode (when both enabled), None→Unicode (when I2S skipped and Grimoire stages not applicable). Generalization failure transitions to `None` (not Unicode)
- [x] 4.6 Add tests for unicode stage - iteration counting, non-cumulative mutations, coverage evaluation, CmpLog draining, max input length enforcement, abort handling

## 5. Pipeline Integration Tests

- [x] 5.1 Add tests for full four-stage pipeline lifecycle: I2S → Generalization → Grimoire → Unicode → None
- [x] 5.2 Add tests for I2S → Unicode pipeline (Grimoire disabled, unicode enabled)
- [x] 5.3 Add tests for Grimoire-enabled-but-not-applicable gap case (I2S skipped, Grimoire enabled, entry does not qualify for generalization and has no `GeneralizedInputMetadata`, unicode enabled → transitions to Unicode)
- [x] 5.4 Add tests for Grimoire → Unicode transition (both enabled)
- [x] 5.5 Add tests for unicode-only begin (no CmpLog, Grimoire stages not applicable, unicode enabled)
- [x] 5.6 Add tests for pipeline with unicode disabled (existing transitions unchanged)
- [x] 5.7 Add tests for generalization failure → None (not Unicode) - verify unstable inputs do not proceed to unicode stage

## 6. Unicode Auto-Detection

- [x] 6.1 Add auto-detection integration tests - verify `unicode_enabled` state drives stage transitions correctly
- [x] 6.2 Add tests for unicode stage skipped when no valid UTF-8 regions (metadata empty → return null)
