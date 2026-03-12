## 1. CmpLog Enrichment

- [x] 1.1 Define `CmpLogOperator` enum (Equal, NotEqual, Less, Greater) in `cmplog.rs` with conversion from `op` string
- [x] 1.2 Change thread-local accumulator from `Vec<CmpValues>` to `Vec<(CmpValues, u32, CmpLogOperator)>` - update `push()` signature to accept site ID and operator, update `drain()` return type
- [x] 1.3 Update `trace_cmp()` in `trace.rs` to pass `cmp_id` and parsed `CmpLogOperator` to `push()` (remove `_` prefix from `_cmp_id`)
- [x] 1.4 Add `AflppCmpValuesMetadata` and `AflppCmpLogHeader` imports from LibAFL (verify availability in the fork, cherry-pick if needed)
- [x] 1.5 Update `report_result()` to build `AflppCmpValuesMetadata` from enriched drain: group by site ID into `orig_cmpvals`, derive `headers` from operator/size, initialize `new_cmpvals` empty. Also store `CmpValuesMetadata` (flattened from `orig_cmpvals`) for I2S compatibility - no runtime adapter needed, both types populated at drain time
- [x] 1.6 Update token extraction to work on enriched drain tuples (extract `CmpValues` component)
- [x] 1.7 Write tests for CmpLogOperator parsing, enriched accumulator push/drain, site-keyed grouping, dual metadata storage (AflppCmpValuesMetadata + CmpValuesMetadata), and token extraction

## 2. Colorization Stage

- [x] 2.1 Implement `type_replace()` function: port LibAFL's `type_replace` algorithm (digit→digit, hex letter→hex letter, whitespace swaps, deterministic special cases, XOR fallbacks for non-class bytes - every byte guaranteed to differ from original)
- [x] 2.2 Implement `coverage_hash()` function: fast u64 hash of nonzero coverage map indices using `DefaultHasher`
- [x] 2.3 Add `StageState::Colorization` variant with fields: corpus_id, original_hash, original_input, changed_input, pending_ranges, taint_ranges, executions, max_executions, awaiting_dual_trace
- [x] 2.4 Implement `begin_colorization()`: check REDQUEEN enabled + input size ≤ MAX_COLORIZATION_LEN, execute original for baseline hash, apply type_replace, push full range to pending_ranges
- [x] 2.5 Implement `advance_colorization()`: binary search logic - compare coverage hash, split or accept ranges, process pending_ranges largest-first
- [x] 2.6 Implement colorization termination: merge adjacent taint_ranges, store `TaintMetadata` on fuzzer state (containing both merged free byte ranges and colorized input vector)
- [x] 2.7 Implement dual trace terminal step: set `awaiting_dual_trace = true`, generate fully-colorized candidate, drain and retain CmpLog as `new_cmpvals`
- [x] 2.8 Write tests for type_replace, coverage_hash, binary search convergence (all free, none free, partial), taint range merging, dual trace CmpLog capture

## 3. REDQUEEN Mutation Stage

- [x] 3.1 Add `AflppRedQueen` and `TaintMetadata` imports from LibAFL (verify availability, add `"redqueen"` feature flag if needed)
- [x] 3.2 Add `StageState::Redqueen` variant with fields: corpus_id, candidates, index
- [x] 3.3 Implement `begin_redqueen()`: call `state.set_corpus_id(corpus_id)` (required by `HasCurrentCorpusId` trait bound), check both `AflppCmpValuesMetadata` and `TaintMetadata` present, call `multi_mutate()` with max_count=2048, store candidates, yield first
- [x] 3.4 Implement `advance_redqueen()`: evaluate coverage, yield next candidate, transition to next stage (skipping I2S) when exhausted
- [x] 3.5 Handle empty candidates: skip REDQUEEN and transition to next stage
- [x] 3.6 Write tests for REDQUEEN stage begin/advance/complete lifecycle, empty candidates path, max input length truncation

## 4. Stage Pipeline Integration

- [x] 4.1 Add `redqueen_ran_for_entry: bool` flag to Fuzzer struct, reset in `begin_stage()`
- [x] 4.2 Update `begin_stage()` dispatch: attempt colorization first (if REDQUEEN enabled + input size ok), then I2S, then generalization, Grimoire, unicode
- [x] 4.3 Update `advance_stage()` dispatch: add Colorization and Redqueen arms
- [x] 4.4 Update `abort_stage()`: handle Colorization and Redqueen variants (transition to None, clean up state)
- [x] 4.5 Implement I2S skip logic: when `redqueen_ran_for_entry` is true, skip I2S and fall through to generalization/Grimoire/unicode
- [x] 4.6 Wire colorization → REDQUEEN → (skip I2S) → generalization → Grimoire → unicode transition chain
- [x] 4.7 Write tests for full pipeline ordering, I2S skip when REDQUEEN ran, fallback to I2S when colorization skipped

## 5. Auto-Detection

- [x] 5.1 Add `redqueen: Option<bool>` field to `FuzzerConfig` (Rust) and `redqueen?: boolean` to `FuzzOptions` (TypeScript)
- [x] 5.2 Add `redqueen_override: Option<bool>` and `redqueen_enabled: bool` fields to Fuzzer struct
- [x] 5.3 Update deferred detection trigger in `report_result()`: include REDQUEEN with inverted polarity (`redqueen_enabled = !is_utf8`)
- [x] 5.4 Update `new()` initialization: resolve explicit override, or default to false for deferred detection
- [x] 5.5 Include REDQUEEN in the `needs_deferred` check so its `None` state triggers deferred detection
- [x] 5.6 Write tests for explicit enable/disable, auto-detect binary corpus, auto-detect UTF-8 corpus, complementary specialization (Grimoire+Unicode vs REDQUEEN), mixed explicit/auto

## 6. TypeScript Integration

- [x] 6.1 Add `redqueen?: boolean` to the TypeScript `FuzzOptions` type definition
- [x] 6.2 Wire the `redqueen` option through to `FuzzerConfig` in the Vitest plugin and standalone CLI
- [x] 6.3 Verify the napi-rs build regenerates `index.d.ts` with the new field
