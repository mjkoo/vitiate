## 1. JSON Byte Scanning Primitives (Rust)

- [x] 1.1 Implement `find_string_slots(bytes: &[u8]) -> Vec<(usize, usize)>` - escape-aware scanner that returns content ranges of all double-quoted strings in a byte buffer
- [x] 1.2 Implement `find_value_range(bytes: &[u8], pos: usize) -> Option<(usize, usize)>` - given a position at the start of a JSON value, returns its full byte range (bracket-matching for objects/arrays, token extent for primitives)
- [x] 1.3 Implement `is_object_key(bytes: &[u8], string_end: usize) -> bool` - checks if the byte after a string's closing quote (skipping whitespace) is `:`
- [x] 1.4 Unit tests for scanning primitives: escaped quotes, escaped backslashes, nested structures, empty strings, no-string inputs, bracket matching with strings containing brackets, unterminated strings, unbalanced brackets

## 2. JSON Mutators (Rust)

- [x] 2.1 Implement `JsonTokenReplaceString` mutator - finds random string value slot, replaces content with dictionary token
- [x] 2.2 Implement `JsonTokenReplaceKey` mutator - finds random object key slot, replaces content with dictionary token
- [x] 2.3 Implement `JsonReplaceValue` mutator - finds random value, replaces with token string / type-changed value / copy from same input
- [x] 2.4 Unit tests for each mutator: successful mutation, skip on non-JSON, skip on empty dictionary, key/value distinction, length-changing replacements

## 3. JSON Mutation Stage (Rust)

- [x] 3.1 Add `StageState::Json { corpus_id, iteration, max_iterations }` variant to the `StageState` enum
- [x] 3.2 Create JSON stage `HavocScheduledMutator` wrapping the 3 JSON mutators with `max_stack_pow = 3`, instantiate in `Fuzzer::new()`
- [x] 3.3 Add `json_mutator` field to `Fuzzer` struct (type: `HavocScheduledMutator<JsonMutationsType>`)
- [x] 3.4 Add `JsonMutationsType` type alias for the JSON mutator tuple
- [x] 3.5 Implement JSON stage logic in `begin_stage()`: after Unicode, if `json_mutations_enabled`, check the corpus entry with `looks_like_json()`; if true, transition to `StageState::Json`; if false, skip the JSON stage
- [x] 3.6 Implement JSON stage logic in `advance_stage()`: clone original entry, apply JSON mutations, evaluate coverage, drain CmpLog, decrement iterations, transition to `None` when exhausted
- [x] 3.7 Implement JSON stage logic in `abort_stage()`: drain CmpLog, transition to `None`
- [x] 3.8 Update all stage transition paths per stage-execution delta spec: Unicode -> Json (when enabled) or Unicode -> None (when disabled); Grimoire -> Json (when unicode not applicable); I2S -> Json (when Grimoire and unicode not applicable); REDQUEEN -> Json (when all prior post-REDQUEEN stages not applicable); and `begin_stage()` fall-through to Json when all prior stages skipped
- [x] 3.9 Unit tests for stage lifecycle: iterations are non-cumulative, CmpLog is drained, coverage evaluation adds to corpus, stage skipped when disabled or no string slots

## 4. JSON Auto-Detection (Rust)

- [x] 4.1 Implement `looks_like_json(bytes: &[u8]) -> bool` heuristic - starts-like-JSON, has brackets, balanced brackets (string-aware), control character density > 5%
- [x] 4.2 Extend `FeatureDetection` with `json_mutations_enabled`, `json_mutations_override` fields
- [x] 4.3 Extend corpus scan to classify UTF-8 entries as JSON-like, computing `json_like_count` alongside `utf8_count`; auto-seeds are excluded from the scan (only user seeds and fuzzer-discovered inputs inform detection)
- [x] 4.4 Update `FeatureDetection::new()` to accept `json_mutations_override: Option<bool>` and update `record_interesting()` to resolve `json_mutations_enabled` when deferred detection fires
- [x] 4.5 Retain `auto_seed_count` on `FeatureDetection` to exclude auto-seeds from the detection scan (auto-seeds are guesses, not signal for inferring target characteristics)
- [x] 4.6 Unit tests for heuristic: valid JSON objects/arrays, plain text, unbalanced brackets, brackets inside strings, bare values, low density

## 5. Config Plumbing (Rust + TypeScript)

- [x] 5.1 Add `json_mutations: Option<bool>` to `FuzzerConfig` in `types.rs` and wire through NAPI boundary
- [x] 5.2 Add `jsonMutations?: boolean` to `FuzzOptions` schema in `config.ts` (flat, consistent with `grimoire`/`unicode`/`redqueen`)
- [x] 5.3 Wire `fuzzOptions.jsonMutations` through to `FuzzerConfig.json_mutations` in `loop.ts`
- [x] 5.4 Add `auto_seed: Option<bool>` to `FuzzerConfig` in `types.rs` (default `true` when absent) and wire through NAPI boundary; store as `auto_seed_enabled` flag on `Fuzzer`
- [x] 5.5 Add `autoSeed?: boolean` to `FuzzOptions` schema in `config.ts`
- [x] 5.6 Wire `fuzzOptions.autoSeed` through to `FuzzerConfig.auto_seed` in `loop.ts`
- [x] 5.7 Add `detector_seeds: Option<Vec<Buffer>>` to `FuzzerConfig` in `types.rs`; store on `Fuzzer` for deferred queuing during seed composition

## 6. Extended Default Seeds and Seed Composition (Rust)

- [x] 6.1 Add `b"[]"`, `b"null"`, `b"[{}]"`, `b"{\"a\":\"b\"}"` to `DEFAULT_SEEDS` array
- [x] 6.2 Update existing tests that assert on the number of default auto-seeds (now 10 instead of 6)
- [x] 6.3 Implement seed composition in `getNextInput()`: on first call, queue detector seeds from config (the array is already empty when `autoSeed` is `false` on the TypeScript side), then default auto-seeds (if `!has_user_seeds && auto_seed_enabled`), then empty fallback (if queue still empty)
- [x] 6.4 Change auto-seed trigger from corpus emptiness check to `has_user_seeds == false && auto_seed_enabled` check

## 7. Detector Auto-Seeding Interface (TypeScript)

- [x] 7.1 Add `getSeeds(): Uint8Array[]` method to the `Detector` interface in `detectors/types.ts`
- [x] 7.2 Add `getSeeds()` to `DetectorManager` - collects seeds from all active detectors
- [x] 7.3 Implement `getSeeds()` on each existing detector: empty array for command-injection, path-traversal, unsafe-eval, ssrf, redos
- [x] 7.4 Implement `getSeeds()` on prototype pollution detector: return `{"__proto__":1}`, `[{"__proto__":1}]`, `{"constructor":{"prototype":{}}}`, `["__proto__"]`

## 8. Detector Seeds Wiring (TypeScript)

- [x] 8.1 In `loop.ts`, collect detector seeds via `detectorManager.getSeeds()` and pass as `FuzzerConfig.detectorSeeds` when constructing the `Fuzzer`; pass empty array when `autoSeed` is `false`
- [x] 8.2 Verify detector seeds are queued during seed composition and coexist with default auto-seeds when no user corpus is present

## 9. Integration Testing

- [x] 9.1 Unit test: JSON stage produces `__proto__` replacement from `{"x":"1"}` seed with detector tokens
- [x] 9.2 Unit test: JSON auto-detection enables mutations for JSON-heavy corpus, disables for text corpus
- [x] 9.3 Unit test: Detector seeds (from config) are queued during seed composition and coexist with default auto-seeds when no user seeds present
- [x] 9.4 Unit test: autoSeed false omits detector seeds and default auto-seeds, starts with single empty seed when no user corpus
- [x] 9.5 E2E validation: add a flatted prototype pollution test to `e2e-detectors.test.ts` that runs with default config for 120 seconds and verifies the vulnerability is detected (generous budget since this depends on seed composition + auto-detection + JSON mutations working end-to-end; tune down after confirming reliability)

## 10. Lints and Checks

- [x] 10.1 Ensure all new Rust code passes `clippy::all`, `cargo fmt`, `cargo deny`, `cargo msrv`
- [x] 10.2 Ensure all new TypeScript code passes `eslint`, `prettier`, `tsc`
- [x] 10.3 Run full test suite (`pnpm test`) and verify no regressions
