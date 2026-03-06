## Why

Vitiate's mutation engine operates on raw bytes — it has no understanding of input structure. For JavaScript fuzz targets that process structured text (JSON, HTML, URLs, configuration, source code), this means most havoc mutations produce syntactically invalid inputs that are rejected at the parsing boundary, never reaching deeper logic. Grimoire structure-aware fuzzing addresses this by learning which parts of an input are structural (fixed syntax) vs variable (replaceable content), then mutating at the structural level. This is the highest-impact gap identified in PARITY.md and the natural next step after the I2S stage infrastructure landed.

## What Changes

- **Track novel coverage indices per corpus entry.** When `evaluate_coverage` determines an input is interesting, record which coverage map positions are newly maximized. Store this as `MapNoveltiesMetadata` on the testcase, enabling the generalization algorithm to verify whether ablated inputs preserve the entry's coverage contribution.
- **Add a generalization stage.** After calibration and the I2S stage, run an interactive generalization pass on the new corpus entry. The stage systematically removes byte ranges (by offset, delimiter, and bracket-pair strategies) and re-executes to determine which bytes are structural vs gap. Produces `GeneralizedInputMetadata` (a sequence of `Bytes` and `Gap` items) stored on the testcase.
- **Add a Grimoire mutational stage.** After generalization, run 1–128 iterations of structure-aware mutations using LibAFL's four Grimoire mutators (`GrimoireExtensionMutator`, `GrimoireRecursiveReplacementMutator`, `GrimoireStringReplacementMutator`, `GrimoireRandomDeleteMutator`) directly. Each iteration generates a structural variant from the generalized template, converts to `BytesInput`, and evaluates coverage.
- **Auto-detect whether to enable Grimoire.** Scan existing corpus entries at fuzzer initialization to determine if the corpus is predominantly UTF-8 text. Enable generalization + Grimoire stages only when the corpus appears text-based. Support an explicit override option.
- **Extend the stage state machine.** Add `Generalization` and `Grimoire` variants to `StageState`. The `beginStage`/`advanceStage`/`abortStage` protocol drives these stages using the same JS-driven protocol as the existing I2S stage — JS executes the target, Rust evaluates coverage and generates the next candidate.

## Capabilities

### New Capabilities

- `grimoire-generalization`: The generalization stage that analyzes corpus entries to identify structural vs gap bytes via interactive target executions, producing `GeneralizedInputMetadata`.
- `grimoire-mutation`: The Grimoire mutational stage that applies structure-aware mutations (extension, recursive replacement, string replacement, random deletion) using `GeneralizedInputMetadata` and evaluates coverage.
- `grimoire-auto-detect`: Auto-detection logic that scans corpus content at initialization to decide whether to enable Grimoire, with explicit override support.

### Modified Capabilities

- `stage-execution`: The stage state machine gains `Generalization` and `Grimoire` variants. `beginStage` orchestrates the full stage pipeline (I2S → Generalization → Grimoire) rather than only I2S. `advanceStage` handles the interactive generalization protocol and Grimoire mutation generation in addition to I2S.
- `edge-coverage`: Coverage evaluation must track which map indices are novel for each interesting input (`MapNoveltiesMetadata`), used by the generalization algorithm to verify ablated inputs preserve novelty.

## Impact

- **`vitiate-napi/src/engine.rs`**: Major changes — `StageState` enum extension, `beginStage`/`advanceStage`/`abortStage` expansion for three stage types, `evaluate_coverage` enhanced with novelty tracking, Grimoire auto-detection at init, `GeneralizedInputMetadata` management on testcases.
- **`vitiate-napi/src/mutation.rs`** (or new module): Integration with LibAFL's four Grimoire mutators and `GeneralizedInputMetadata` type.
- **`vitiate/src/loop.ts`**: No changes expected — the JS stage loop is already generic (drives whatever `beginStage`/`advanceStage` produce). The generalization and Grimoire stages use the same protocol as I2S.
- **LibAFL dependency**: Uses existing `libafl::mutators::grimoire::*` mutators and `libafl::inputs::generalized::GeneralizedInputMetadata` directly. The generalization algorithm is reimplemented (tightly coupled to LibAFL's executor model) but uses the same metadata types.
- **Performance**: Generalization adds 10–30+ extra executions per interesting input (one-time cost). Grimoire mutation stage adds 1–128 executions (same as I2S). Both are gated behind auto-detection and only activate for text-based corpora.
