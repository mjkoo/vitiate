## Context

Vitiate's mutation pipeline operates on raw bytes. When fuzzing text-processing JavaScript targets (JSON parsers, HTML sanitizers, URL validators, etc.), havoc mutations frequently produce invalid UTF-8 sequences. These are rejected at the target's parsing boundary, wasting execution budget on inputs that never reach deeper logic.

LibAFL's `libafl_libfuzzer_runtime` addresses this with a three-part unicode mutation pipeline: UTF-8 region identification, category-aware character replacement, and token-based replacement. Unicode mutations are enabled by default and account for ~80% subcategory-level replacement (finer-grained) vs ~20% category-level replacement.

Vitiate already has Grimoire structure-aware mutations (generalization + gap-based mutation) and a UTF-8 corpus scanning heuristic for auto-detection. The unicode mutation pipeline complements Grimoire by operating at the character level rather than the structural template level.

## Goals / Non-Goals

**Goals:**
- Preserve UTF-8 encoding validity during mutations for text-based fuzz targets
- Replace characters with category-compatible alternatives (letter→letter, digit→digit)
- Replace category-contiguous regions with dictionary tokens from CmpLog promotion
- Auto-enable when corpus is UTF-8 (sharing Grimoire's existing detection logic)
- Integrate into the stage pipeline with minimal protocol changes

**Non-Goals:**
- Full Unicode normalization or canonical equivalence handling
- Locale-aware or script-specific mutation strategies
- Modifying the havoc mutation path (unicode operates as a dedicated stage only)
- Supporting custom Unicode category tables or user-defined categories

## Decisions

### Decision 1: Implement unicode mutations as a new stage in the pipeline, not as havoc mutators

**Choice:** Add a `StageState::Unicode` variant that runs 1–128 iterations of unicode-aware mutations after Grimoire completes (or after I2S if Grimoire is disabled/skipped).

**Rationale:** This matches libafl_libfuzzer's architecture where unicode mutations run as `StdMutationalStage` instances separate from havoc. Keeping them as a dedicated stage means:
- The per-execution metadata extraction (UTF-8 identification) is amortized across iterations.
- The stage only runs on entries already known to be interesting (post-calibration).
- The existing `beginStage`/`advanceStage` protocol handles it without changes.

**Alternative considered:** Adding unicode mutators to the havoc mutation set. Rejected because havoc mutations are applied on every `getNextInput()` call, meaning UTF-8 identification metadata would need to be computed or cached on every input — not just interesting ones. The stage approach is more targeted.

### Decision 2: Two sub-stages — category mutations and token replacement mutations — combined into a single StageState variant

**Choice:** A single `StageState::Unicode` variant that internally manages two mutator sets: (1) category/subcategory random replacement and (2) category/subcategory token replacement. Each iteration randomly selects from the combined mutator pool using weights matching libafl_libfuzzer: subcategory mutators at 4x weight relative to category mutators.

**Rationale:** libafl_libfuzzer uses two separate `StdMutationalStage` instances (one for random replacement, one for token replacement), each with their own `HavocScheduledMutator`. This design collapses them into a single stage with a weighted mutator pool. The effect is equivalent — both approaches apply a mix of category-random and token-replacement mutations — but a single stage simplifies the state machine.

The `HavocScheduledMutator` for the unicode pool uses the default `max_stack_pow=7` (range 2..=128 stacked mutations per `mutate()` call). This is appropriate for character-level mutations where each individual mutation is small. This contrasts with Grimoire's `max_stack_pow=3` (range 2..=8) which uses fewer stacks because each Grimoire mutation (gap insertion/replacement) makes larger structural changes.

**Alternative considered:** Two separate stage variants (`UnicodeRandom` and `UnicodeTokenReplace`). Rejected because the state machine transitions would add complexity without meaningful benefit. The mutators share the same metadata and the same execution protocol.

### Decision 3: Reuse LibAFL's unicode types, mutators, and category tables

**Choice:** Point the `libafl` git dependency at `mjkoo/LibAFL` branch `constructable-unicode-metadata` and enable the `"unicode"` feature for access to all public unicode types. Use `UnicodeIdentificationMetadata::new(bytes)` to construct metadata directly — this branch adds `pub fn new(bytes: &[u8]) -> Self` on `UnicodeIdentificationMetadata` (the internal BFS extraction function is private). Call the four unicode mutators (`UnicodeCategoryRandMutator`, `UnicodeSubcategoryRandMutator`, `UnicodeCategoryTokenReplaceMutator`, `UnicodeSubcategoryTokenReplaceMutator`) via `.mutate()` directly, same pattern as Grimoire mutators. Reuse `libafl::mutators::unicode::unicode_categories` for category→codepoint-range lookups.

**Rationale:** The mutators are pure transformations with trait bounds (`HasRand + HasMaxSize + HasMetadata`) already satisfied by Vitiate's `FuzzerState`. No adaptation layer needed. The category tables are static data (~6500 lines of UCD 15.1.0 lookup arrays) already compiled into the LibAFL crate.

**Alternative considered:** Reimplementing the mutators or metadata extraction in a Vitiate-specific form. Rejected — the LibAFL implementations are well-tested and the trait bounds are satisfied. No reason to diverge.

### Decision 4: UTF-8 identification metadata computed once per corpus entry, cached on testcase

**Choice:** When the unicode stage begins for a corpus entry, compute `UnicodeIdentificationMetadata` (BFS-based UTF-8 region extraction with character boundary BitVecs) and store it on the testcase. Subsequent stage invocations for the same entry reuse the cached metadata. The metadata is recomputed after each mutation (since mutations change the byte layout) but the original entry's metadata is cached.

**Rationale:** Matches libafl_libfuzzer's `UnicodeIdentificationStage` which skips extraction if metadata already present. The BFS extraction is O(n) in input length — cheap for typical JS inputs but worth caching for entries that re-enter the pipeline.

### Decision 5: Unicode auto-detection shares Grimoire's UTF-8 scanning, with independent enable flag

**Choice:** Add a `unicode?: boolean` field to `FuzzerConfig`/`FuzzOptions` following the same tri-state pattern as `grimoire`:
- `true`: force enable
- `false`: force disable
- absent: auto-detect

Auto-detection uses the same `scan_corpus_utf8()` function and deferred detection threshold (10 interesting inputs) as Grimoire. The two features share the detection signal but have independent enable flags — a user can enable Grimoire but disable unicode, or vice versa.

**Rationale:** The detection heuristic is identical (majority-UTF-8 corpus → enable). Sharing it avoids scanning the corpus twice. Independent flags allow fine-grained control — unicode mutations are most useful for targets that process text but don't have strong structural patterns (where Grimoire's gap-finding adds less value).

### Decision 6: Pipeline position — unicode runs after Grimoire (or after I2S if Grimoire disabled)

**Choice:** Pipeline ordering becomes: I2S → Generalization → Grimoire → Unicode → None.

When Grimoire is disabled but unicode is enabled: I2S → Unicode → None.

**Rationale:** Unicode mutations are complementary to Grimoire — Grimoire operates at the structural template level (gap insertion/deletion), while unicode operates at the character level (category-preserving replacement). Running unicode last means it can operate on entries that were already generalized and Grimoire-mutated, potentially refining character-level details within structurally-valid inputs. Running it before Grimoire would mean unicode mutations on inputs that haven't been structurally analyzed yet — less targeted.

**Alternative considered:** Running unicode before Grimoire. This would allow generalization to benefit from unicode-mutated inputs, but the generalization algorithm doesn't depend on character-level content (it cares about coverage novelty, not Unicode validity). The ordering difference is minor in practice.

## Risks / Trade-offs

**[Risk] Pipeline length increases execution time per interesting input** → The full pipeline (I2S + Generalization + Grimoire + Unicode) could run 400+ executions per interesting input. For fast JS targets this is fine, but for slow targets it delays main-loop progress. Mitigation: each stage independently draws 1–128 iterations, and the pipeline only runs on interesting inputs (a small fraction of total executions).

**[Risk] Unicode category tables add binary size** → The `unicode_categories.rs` data is ~6500 lines of static arrays. This is already compiled into LibAFL and doesn't add new dependencies. The binary size increase is negligible relative to the WASM SWC plugin.

**[Risk] Metadata recomputation after each mutation adds overhead** → `UnicodeIdentificationMetadata::new()` runs BFS over the input bytes to identify UTF-8 regions. This is O(n) per mutation iteration. For typical JS inputs (<10KB), this is sub-microsecond. For very large inputs, the `maxInputLen` cap already limits the cost.

**[Risk] Halved iteration budget vs libafl_libfuzzer** → libafl_libfuzzer runs 2 separate stages (random + token), each drawing 1..=128 iterations (total 2..=256 per corpus entry). Vitiate's single stage draws 1..=128 from the combined pool. This is a deliberate simplification — it trades ~50% fewer unicode mutations per entry for a simpler state machine and shorter pipeline duration. If unicode mutation coverage proves insufficient, the single stage can be split without protocol changes.

**[Trade-off] Single stage vs two stages** → Combining category mutations and token replacement into one stage slightly reduces control (can't independently tune iteration counts). The benefit is simpler state machine transitions. If finer control is needed later, the single stage can be split without protocol changes.
