## 1. LibAFL Dependencies and Type Setup

- [x] 1.1 Enable required libafl crate features in `vitiate-napi/Cargo.toml` for Grimoire mutator types, `GeneralizedInputMetadata`, `GeneralizedItem`, `MapNoveltiesMetadata`, and `HavocScheduledMutator`
- [x] 1.2 Add imports and verify that `GeneralizedInputMetadata`, `GeneralizedItem`, `MapNoveltiesMetadata`, all four Grimoire mutators, and `HavocScheduledMutator` resolve correctly

## 2. MapNoveltiesMetadata Tracking

- [x] 2.1 Write tests for novelty computation in `evaluate_coverage`: novel indices recorded when interesting, no metadata for non-interesting, only newly-maximized indices included (not all covered indices)
- [x] 2.2 Implement novelty computation in `evaluate_coverage` — before calling `MaxMapFeedback::is_interesting()`, compare the coverage map against the feedback's internal `MapFeedbackMetadata` history to identify indices where `map[i] > history[i]`
- [x] 2.3 Store the identified novel indices as `MapNoveltiesMetadata` on the testcase when `is_interesting()` returns true (applies to both main loop via `reportResult` and stage executions via `evaluate_coverage`)

## 3. Grimoire Auto-Detection

- [x] 3.1 Write tests for auto-detection: majority UTF-8 enables, majority non-UTF-8 disables, equal counts disable, explicit override bypasses scanning, empty corpus defers detection, deferred triggers after 10 interesting inputs
- [x] 3.2 Add optional `grimoire` field to `FuzzerConfig` NAPI config type (accepts `true`, `false`, or absent/undefined)
- [x] 3.3 Add `grimoire_enabled: bool` field to `Fuzzer` struct
- [x] 3.4 Implement corpus UTF-8 scanning at `Fuzzer::new()` — iterate testcases, check `std::str::from_utf8`, enable if `utf8_count > non_utf8_count`; skip scanning when explicit override provided
- [x] 3.5 Implement deferred detection for empty corpus — track interesting input count, re-scan after 10 interesting inputs added via `reportResult`, set `grimoire_enabled` based on scan result, do not re-evaluate after that point

## 4. Generalization Stage — State Machine

- [x] 4.1 Write tests for generalization state machine: verification pass/fail, offset-based gap finding marks correct ranges, delimiter-based gap finding splits on delimiters, bracket-based gap finding handles paired brackets (including same-character pairs like quotes), consecutive gap trimming, output format (leading/trailing gaps, no consecutive gaps), skipping conditions (>8192 bytes, no novelties, already generalized, Grimoire disabled), coverage evaluation does NOT occur during verification phase but DOES occur during gap-finding (ablated inputs triggering new coverage are added to corpus)
- [x] 4.2 Define `GeneralizationPhase` enum with variants: `Verify`, `Offset { level: u8, pos: usize }`, `Delimiter { index: u8, pos: usize }`, `Bracket { pair_index: u8, pos: usize, open_pos: usize }`, `Done`
- [x] 4.3 Add `StageState::Generalization` variant with fields: `corpus_id`, `novelties: Vec<usize>`, `payload: Vec<Option<u8>>`, `phase: GeneralizationPhase`, `candidate_range: (usize, usize)`
- [x] 4.4 Implement candidate construction — given the current `payload` (with `None` gaps), construct a `BytesInput` with the `candidate_range` bytes removed (skipping already-gapped positions)
- [x] 4.5 Implement verification phase — execute original corpus entry, check all novelty indices are nonzero in coverage map; abort generalization if any are zero
- [x] 4.6 Implement offset-based gap finding (5 passes with offsets `[255, 127, 63, 31, 0]`) — iterate payload, compute candidate ranges, mark as gaps or structural based on novelty survival
- [x] 4.7 Implement delimiter-based gap finding (7 passes with delimiters `['.', ';', ',', '\n', '\r', '#', ' ']`) — scan forward for delimiter, remove range before delimiter, verify novelties
- [x] 4.8 Implement bracket-based gap finding (6 passes with pairs `['(' ')', '[' ']', '{' '}', '<' '>', '\'' '\'', '"' '"']`) — scan forward for opening, backward for closing, remove between
- [x] 4.9 Implement `trim_payload` — after each pass, remove consecutive `None` entries in the payload
- [x] 4.10 Implement generalization output conversion — convert `Vec<Option<u8>>` payload to `GeneralizedInputMetadata` via `generalized_from_options()`, ensuring leading/trailing `Gap`, no consecutive gaps, no empty `Bytes`
- [x] 4.11 Store produced `GeneralizedInputMetadata` on the testcase when generalization completes successfully

## 5. Grimoire Mutational Stage

- [x] 5.1 Write tests for Grimoire stage: correct mutator composition (5 entries with RandomDelete doubled, max_stack_pow=3), each iteration clones from original metadata not previous iteration, mutated metadata converted to BytesInput via `generalized_to_bytes`, max input length enforced, CmpLog drained and discarded, new coverage adds to corpus with MapNoveltiesMetadata, cross-corpus metadata accessible (Extension/RecursiveReplacement can read other entries' GeneralizedInputMetadata, StringReplacement/Extension can read Tokens, StringReplacement returns Skipped when Tokens empty), MutationResult::Skipped still counts iteration and returns unmutated input for execution, abort during Grimoire transitions to None and skips remaining iterations with total_execs incremented by 1
- [x] 5.2 Create `HavocScheduledMutator<GeneralizedInputMetadata, ...>` wrapping 5 Grimoire mutator entries (Extension ×1, RecursiveReplacement ×1, StringReplacement ×1, RandomDelete ×2) with `max_stack_pow = 3`; store as `grimoire_mutator` field on `Fuzzer` (note: parameterized on `GeneralizedInputMetadata`, not `BytesInput`)
- [x] 5.3 Add `StageState::Grimoire` variant with fields: `corpus_id: CorpusId`, `iteration: usize`, `max_iterations: usize` (1–128 randomly chosen)
- [x] 5.4 Implement Grimoire stage iteration logic — clone `GeneralizedInputMetadata` from corpus entry, apply `grimoire_mutator.mutate()`, convert result to `BytesInput` via `generalized_to_bytes()`, enforce `max_input_len` truncation, return as `Buffer`

## 6. Stage Pipeline Orchestration

- [x] 6.1 Write tests for full pipeline transitions: I2S → Generalization → Grimoire → None, I2S → Grimoire (pre-existing GeneralizedInputMetadata, generalization skipped), I2S → None (Grimoire disabled), None → Generalization (no CmpLog, Grimoire enabled), None → Grimoire (no CmpLog, pre-existing metadata), generalization fail → None, abort from any variant → None
- [x] 6.2 Update `beginStage` — after attempting I2S, fall through to generalization if CmpLog is empty and Grimoire is enabled and input qualifies (≤8192 bytes, has non-empty MapNoveltiesMetadata, not already generalized), or fall through to Grimoire if entry already has `GeneralizedInputMetadata`
- [x] 6.3 Update `advanceStage` for `StageState::I2S` completion — when iterations exhausted, transition to `Generalization` if Grimoire enabled and input qualifies, or to `Grimoire` if Grimoire enabled and entry has pre-existing `GeneralizedInputMetadata`, otherwise to `None`
- [x] 6.4 Implement `advanceStage` for `StageState::Generalization` — read coverage map for novelty verification, mark gaps/structural in payload, advance phase, construct next candidate; on phase completion trim payload and advance to next phase; on all phases done convert to metadata and transition to `Grimoire`
- [x] 6.5 Implement `advanceStage` for `StageState::Grimoire` — drain CmpLog, evaluate coverage via `evaluate_coverage`, generate next mutation or transition to `None` when iterations exhausted
- [x] 6.6 Update `abortStage` to handle `Generalization` and `Grimoire` variants — drain CmpLog, zero coverage map, increment counters, transition to `None`
- [x] 6.7 Implement CmpLog and coverage handling during generalization executions — drain and discard CmpLog, read coverage map for novelty verification then zero, evaluate for corpus addition during gap-finding phases only (NOT during verification phase), do NOT set `last_interesting_corpus_id` for stage-found entries

## 7. Integration Verification

- [x] 7.1 Verify `grimoire_enabled` is checked in `beginStage` and stage transitions — when false, I2S completes to `None`, generalization and Grimoire stages are fully skipped
- [x] 7.2 Verify all lints pass: clippy, cargo fmt, cargo deny, eslint, prettier, tsc, cargo msrv, cargo autoinherit
- [x] 7.3 Run full test suite (existing + new tests) and confirm all pass
