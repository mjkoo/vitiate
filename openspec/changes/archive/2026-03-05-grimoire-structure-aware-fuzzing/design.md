## Context

Vitiate's I2S stage infrastructure (`beginStage`/`advanceStage`/`abortStage`) provides a general JS-driven stage execution protocol. The `StageState` enum currently has two variants (`None`, `I2S`) and was designed for extension. LibAFL provides four Grimoire mutators as pure input transformations (no executor dependency) and a `GeneralizedInputMetadata` type that both the generalization algorithm and Grimoire mutators operate on. The generalization algorithm itself is tightly coupled to LibAFL's executor model and must be reimplemented, but the algorithm is well-defined (~150 lines of core logic).

The `Fuzzer` struct holds `FuzzerState` (`StdState<InMemoryCorpus<BytesInput>, ...>`) with per-testcase metadata support, a `MaxMapFeedback` for coverage evaluation, and a `ProbabilitySamplingScheduler`. Coverage evaluation happens in the shared `evaluate_coverage()` method used by both the main loop and stage executions.

## Goals / Non-Goals

**Goals:**

- Enable Grimoire structure-aware fuzzing for text-based JavaScript fuzz targets via the existing stage protocol.
- Track coverage novelties per corpus entry to support the generalization algorithm.
- Reuse LibAFL's Grimoire mutators and `GeneralizedInputMetadata` type directly - no reimplementation of mutator logic.
- Auto-detect text-based corpora and enable Grimoire transparently.
- Maintain the JS-driven stage protocol (no architectural change to the JS/Rust boundary).

**Non-Goals:**

- Full AFL++ REDQUEEN (colorization stage, transform detection, `AflppRedQueen` multi-mutator). These can be layered on the same stage infrastructure later but are not part of this change.
- Grimoire for binary protocols. Grimoire's gap-finding uses text-oriented delimiters (`.`, `;`, `\n`, brackets, quotes). Binary inputs are unlikely to benefit and are excluded via auto-detection.
- Unicode-aware mutations. While related to text-based fuzzing, unicode mutations are an independent feature with different implementation requirements (see PARITY.md).
- Changes to the TypeScript fuzz loop. The existing stage loop in `loop.ts` is already generic - it drives whatever `beginStage`/`advanceStage` produce without knowing the stage type.

## Decisions

### D1: Stage pipeline ordering - I2S → Generalization → Grimoire

The three stages run sequentially after calibration for each interesting input:

1. **I2S** (existing) - uses CmpLog data from the triggering `reportResult()` to generate targeted byte replacements.
2. **Generalization** - executes ablated variants of the corpus entry to identify structural vs gap bytes. Requires novelty metadata from `evaluate_coverage`.
3. **Grimoire** - uses `GeneralizedInputMetadata` produced by generalization to generate structure-aware mutations.

This differs from `libafl_libfuzzer_runtime`, where generalization runs before tracing and I2S (immediately after calibration). We run I2S first because generalization is expensive (10-30+ target executions) and should not delay I2S mutations which are cheap and immediately useful. Since generalization only requires novelty metadata (stored on the testcase by `evaluate_coverage`) and a calibrated/stable input (guaranteed after calibration), running it after I2S is safe. The Grimoire position after generalization is the same as `libafl_libfuzzer_runtime`.

`beginStage()` orchestrates the pipeline: it starts with I2S (if CmpLog data exists), and when I2S completes, `advanceStage()` transitions to generalization (if Grimoire is enabled and the input qualifies), then to Grimoire (if generalization produced metadata or the entry already has pre-existing `GeneralizedInputMetadata`). If any stage is skipped (no CmpLog data, Grimoire disabled, input too large, etc.), the pipeline advances to the next eligible stage or completes.

### D2: Novelty tracking via manual computation in `evaluate_coverage`

When `MaxMapFeedback::is_interesting()` returns true, we need to know *which* coverage map indices are newly maximized. These "novel indices" are stored as `MapNoveltiesMetadata` on the testcase and used by generalization to verify ablated inputs.

**Approach:** Compute novelties by comparing the coverage map against the feedback's internal history *before* calling `is_interesting()`. Specifically:

1. Before `is_interesting()`, iterate the coverage map and the feedback's internal `MapFeedbackMetadata` history to identify indices where `map[i] > history[i]` (newly maximized).
2. Call `is_interesting()` which updates the history.
3. If interesting, store the identified indices as `MapNoveltiesMetadata` on the testcase.

This avoids changing the observer type (which would ripple through `FuzzerFeedback`, `CovObserver`, and all related type aliases) while still capturing the exact set of novel indices.

**Alternative considered:** Enabling LibAFL's built-in novelty tracking via `observer.track_novelties()`. This wraps the observer in a tracking decorator that changes its type from `StdMapObserver<u8, false>` to `StdMapObserver<u8, true>`, which would require updating `CovObserver`, `FuzzerFeedback`, and all code that constructs observers from raw pointers. The type cascade is significant. Manual computation avoids this and gives us precise control over when novelties are recorded.

**Alternative considered:** Tracking all covered indices (nonzero entries) instead of novel indices. This would be overly conservative - an input may cover many edges that other corpus entries already cover, and generalization would refuse to mark those bytes as gaps even when they aren't structurally important for the input's unique contribution. Novel-only tracking matches LibAFL's behavior and produces tighter generalization.

### D3: Generalization state machine

The generalization algorithm is interactive: each execution's result determines whether bytes are marked as gaps. This requires a state machine within the `advanceStage` protocol.

**State structure:**

```
StageState::Generalization {
    corpus_id: CorpusId,
    novelties: Vec<usize>,           // Novel coverage map indices to verify
    payload: Vec<Option<u8>>,        // Working buffer: Some(byte) = structural, None = gap
    phase: GeneralizationPhase,      // Current pass within the algorithm
    candidate_range: (usize, usize), // Byte range removed in the current candidate
}
```

**Phases (18 gap-finding passes + verification + done):**

```
enum GeneralizationPhase {
    Verify,                                       // Initial stability check (1 execution)
    Offset { level: u8, pos: usize },             // 5 passes: offsets 255, 127, 63, 31, 0
    Delimiter { index: u8, pos: usize },          // 7 passes: '.', ';', ',', '\n', '\r', '#', ' '
    Bracket { pair_index: u8, pos: usize, open_pos: usize },  // 6 passes: (), [], {}, <>, '', ""
    // pair_index = which bracket pair (0..5) - maps to spec's "index" in the bracket pairs array
    // pos = outer loop progress variable - maps to spec's "index" variable (advances with both opening-bracket scan and inner backward scan)
    // open_pos = position of current opening bracket - maps to spec's "start" variable (reset to closing bracket position via start = end after each match)
    Done,                                         // All passes complete, build metadata
}
```

**Protocol flow:**

1. `advanceStage()` after I2S completes → transitions to `Generalization` if Grimoire enabled and input qualifies.
2. First call generates the verification input (the original corpus entry, unmodified).
3. JS executes it. Next `advanceStage()` reads the coverage map, checks if all novelty indices are nonzero.
4. If verification fails (unstable input), skip generalization entirely → transition to Grimoire or Done.
5. If verification passes, begin gap-finding: construct the first candidate (original with a byte range removed), return it.
6. Each subsequent `advanceStage()`:
   - Read coverage map, check novelties survival.
   - If novelties survived: mark `candidate_range` as gaps in `payload`.
   - Advance position within current phase. If phase exhausted, move to next phase.
   - Construct next candidate input from `payload` with the next range removed. Return it.
7. When all phases complete: convert `payload` to `GeneralizedInputMetadata`, store on testcase, transition to Grimoire stage.

**Trimming:** After each gap-finding pass completes, trim consecutive `None` entries in `payload` (matching LibAFL's `trim_payload`).

**Size limit:** Skip generalization for inputs > 8192 bytes (`MAX_GENERALIZED_LEN`), matching LibAFL. This bounds the execution cost.

**Alternative considered:** Running generalization as a single blocking NAPI call (Option B/D from REDQUEEN.md). Rejected because generalization can require 30+ executions and would starve the event loop. The JS-driven protocol allows event loop yields between executions.

### D4: Grimoire mutator integration - use LibAFL mutators directly

All four Grimoire mutators (`GrimoireExtensionMutator`, `GrimoireRecursiveReplacementMutator`, `GrimoireStringReplacementMutator`, `GrimoireRandomDeleteMutator`) require only `HasMetadata + HasRand + HasCorpus` - already satisfied by `FuzzerState`. They operate on `GeneralizedInputMetadata` and are called via `.mutate()`.

**Approach:**

1. Create a `HavocScheduledMutator` wrapping the four Grimoire mutators (with `GrimoireRandomDeleteMutator` doubled for weight, matching `libafl_libfuzzer`'s configuration) with `max_stack_pow = 3`. This mutator is parameterized on `GeneralizedInputMetadata` as its input type (not `BytesInput` like the existing `mutator` and `i2s_mutator`), since the Grimoire mutators operate on generalized inputs.
2. Store this as a `grimoire_mutator` field on `Fuzzer` (alongside the existing `mutator` and `i2s_mutator`). The concrete type is `HavocScheduledMutator<GeneralizedInputMetadata, ...>`.
3. In the Grimoire stage: clone `GeneralizedInputMetadata` from the testcase, apply the scheduled mutator via `.mutate()`, convert to `BytesInput` via `generalized_to_bytes()`, return for execution. This is analogous to LibAFL's `MutatedTransform` pattern but done manually since Vitiate doesn't use LibAFL's executor/stage framework.

**Stage state:**

```
StageState::Grimoire {
    corpus_id: CorpusId,
    iteration: usize,
    max_iterations: usize,   // 1-128, randomly chosen
}
```

This is structurally identical to `StageState::I2S` - a simple counted loop with a mutator call per iteration. The only difference is the mutator and input type.

**Metadata flow:** Grimoire mutators read `GeneralizedInputMetadata` from the corpus entry being mutated, `Tokens` from global state (for string replacement and extension), and other corpus entries' `GeneralizedInputMetadata` (for cross-entry extension and recursive replacement). All of this is already accessible through `FuzzerState`.

**Alternative considered:** Implementing Grimoire mutators from scratch. Rejected - the LibAFL implementations are well-tested, satisfy our state's trait bounds, and can be used directly.

### D5: Auto-detection - corpus UTF-8 scanning

At `Fuzzer::new()`, scan all existing corpus entries to determine if the corpus is predominantly UTF-8 text:

1. Iterate all testcases in `state.corpus()`.
2. For each, attempt `std::str::from_utf8(input.bytes())`.
3. Count UTF-8 vs non-UTF-8 entries.
4. Enable Grimoire if `utf8_count > non_utf8_count`.

Store the decision as a `grimoire_enabled: bool` field on `Fuzzer`. The decision persists for the fuzzer's lifetime (not re-evaluated as corpus grows).

**Override:** Accept an explicit `grimoire` option in `FuzzerConfig` (the existing NAPI config object). Values: `true` (force enable), `false` (force disable), `undefined` (auto-detect).

**Empty corpus:** If the corpus is empty at startup (common for first runs), defer the decision. Re-evaluate after the first N interesting inputs (e.g., 10) have been found. Until the decision is made, skip generalization and Grimoire stages.

**Alternative considered:** Checking the fuzz target's parameter type (e.g., `string` vs `Buffer`). This would be more precise for Vitest integration but doesn't work for the libFuzzer-compatible CLI where targets always receive `Buffer`. Corpus scanning works for both entry points.

### D6: Generalization skipping conditions

Generalization is skipped for a corpus entry when any of these conditions hold:

- **Grimoire disabled** (auto-detection determined non-text corpus, or explicit override).
- **Input exceeds 8192 bytes** (`MAX_GENERALIZED_LEN`). Generalization cost scales with input size; very large inputs produce too many candidates.
- **No novelty metadata** on the testcase. This shouldn't happen if novelty tracking is implemented correctly, but is a safety check.
- **Verification fails** (the original input doesn't stably reproduce its novel coverage). Unstable inputs produce unreliable generalization.
- **Entry already has `GeneralizedInputMetadata`**. Generalization is a one-time analysis per corpus entry. (LibAFL uses `testcase.scheduled_count() > 0` for this check, which skips entries that have been scheduled at least once. Vitiate checks for the presence of `GeneralizedInputMetadata` instead, which is more precise - it skips entries that have already been successfully generalized but allows re-attempting entries that failed verification on a prior run. Since Vitiate's stage pipeline runs immediately after calibration before scheduling, both approaches achieve the same "once per entry" guarantee for the success case.)

When generalization is skipped, the pipeline transitions directly to the Grimoire stage (if the entry already has `GeneralizedInputMetadata` from a prior generalization) or completes (if no metadata exists).

### D7: CmpLog and token handling during generalization and Grimoire stages

Matching the I2S stage behavior:

- **Generalization stage:** CmpLog accumulator is drained and discarded after each execution. Generalization doesn't use or produce CmpLog data.
- **Grimoire stage:** CmpLog accumulator is drained and discarded after each execution. Grimoire mutations are structure-driven, not comparison-driven.
- **Token promotion:** Does not occur during any stage execution. Tokens are only promoted during the main loop's `reportResult()`.

This prevents stage mutations (which produce noise in comparisons) from polluting the CmpLog dictionary used by I2S.

### D8: Corpus entries found during stages

When a generalization or Grimoire stage execution triggers new coverage:

- The input is added to the corpus (same as I2S stage behavior).
- `SchedulerTestcaseMetadata` is set with depth, bitmap_size, exec_time.
- Calibration is NOT triggered inline (deferred to when the entry is next selected by the scheduler).
- Novelty metadata IS computed and stored (so the new entry can itself be generalized later).
- `last_interesting_corpus_id` is NOT set (stages don't re-trigger the stage pipeline recursively).

## Risks / Trade-offs

**Event loop starvation during generalization** - Generalization can require 30+ target executions for a single corpus entry. At ~1ms per execution, this blocks the event loop for ~30ms. This is comparable to calibration (4-8 executions) and I2S (1-128 executions), which are already accepted. For slow targets (>10ms), the total could reach 300ms+, which may cause watchdog or timeout issues in Vitest's test runner. **Mitigation:** The 8192-byte size limit bounds the worst case. If event loop starvation becomes a problem, the JS loop could yield (via `setImmediate`) every N stage executions.

**Generalization state machine complexity** - The generalization algorithm has 18 phases with different iteration patterns (offset-based, delimiter-based, bracket-based). Expressing this as a state machine in `advanceStage` is more complex than the simple counted loops for I2S and Grimoire. **Mitigation:** Factor the state machine into a dedicated `GeneralizationState` struct with a `next_candidate()` method that encapsulates all phase logic. This keeps `advanceStage` itself clean - it just calls `next_candidate()` and handles the verify/mark/advance cycle.

**Memory overhead for `GeneralizedInputMetadata`** - Every generalized corpus entry stores a `Vec<GeneralizedItem>`, roughly proportional to input size. For a corpus of 1000 entries averaging 1KB each, this adds ~1MB of metadata. **Mitigation:** Acceptable. The corpus is in-memory already; metadata is a small fraction of total memory usage.

**Grimoire mutator dependency on `Tokens`** - `GrimoireStringReplacementMutator` and `GrimoireExtensionMutator` read `Tokens` metadata. If the dictionary is empty (no CmpLog data, no manual dictionary), these mutators return `Skipped`. **Mitigation:** Vitiate's token promotion mechanism populates `Tokens` from CmpLog observations over time. The Grimoire extension mutator falls back to whole-entry extension when tokens are unavailable. String replacement gracefully degrades to no-op. This matches LibAFL's behavior.

**Auto-detection false positives** - A corpus containing mostly UTF-8 content that happens to be binary-meaningful (e.g., base64-encoded data) would enable Grimoire unnecessarily. Generalization would find few gaps (the entire input is structural), and Grimoire mutations would be ineffective but not harmful. **Mitigation:** The cost is wasted stage executions. The explicit override (`grimoire: false` in config) provides an escape hatch.

**Deferred auto-detection for empty corpora** - First-run fuzzers start with an empty corpus and must wait for initial findings before deciding. During this window, potentially text-based targets miss out on Grimoire's benefits. **Mitigation:** The window is typically short (seconds). Once 10+ interesting inputs are found, the decision is made. This matches `libafl_libfuzzer`'s behavior (it also can't auto-detect without corpus).
