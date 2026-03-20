## Why

Byte-level mutations cannot reliably produce structurally valid JSON with specific string values in the right positions. In a 5-minute run (4.9M executions) against flatted@3.4.1, the fuzzer discovered only 20 edges and never found the prototype pollution vulnerability. The mutation needed - "replace string value `"1"` with `"__proto__"`" - is trivial conceptually but unreachable via byte flips, which either break JSON syntax or produce structurally identical variants. The existing `TokenInsert`/`TokenReplace` mutators splice dictionary tokens into raw bytes without respecting JSON quoting/structure, so they break validity too.

## What Changes

- **Add a JSON mutation stage to the per-corpus-entry pipeline.** A dedicated `HavocScheduledMutator` wrapping three JSON-aware mutators runs as a stage after Unicode in the pipeline (... → Unicode → Json → None). The mutators operate directly on the byte buffer by identifying JSON structural boundaries (string slots, value ranges) via fast scanning and performing targeted replacements without full JSON deserialization. Running as a stage (not in havoc) ensures byte-level stacking doesn't destroy JSON structure.

- **Auto-detect JSON-like corpus and enable JSON mutations automatically.** Extend the existing `FeatureDetection` infrastructure (which already classifies corpus as UTF-8 vs binary) to further classify UTF-8 inputs as "JSON-like" vs "freeform text." Use a lightweight statistical heuristic per corpus entry: first non-whitespace byte is a JSON value starter, brackets are roughly balanced, and JSON control characters (`"`, `:`, `,`) appear at above-baseline frequency. If a majority of UTF-8 corpus entries pass the heuristic, auto-enable JSON mutations. Follows the same tri-state pattern as Grimoire/Unicode/REDQUEEN: explicit `true`/`false` override, or `None` for auto-detect via deferred detection.

- **Add detector auto-seeding.** Extend the detector interface so detectors can contribute seed corpus entries in addition to dictionary tokens. The prototype pollution detector would seed inputs like `{"__proto__":1}`, `[{"__proto__":1}]`, etc. - general shapes that exercise prototype-sensitive code paths. These seeds give JSON mutations valid starting material to work from. Detector seeds coexist with default auto-seeds - they do not suppress each other. When a user provides their own corpus, default auto-seeds are suppressed but detector seeds are still added.

- **Extend default seeds with common JSON shapes.** The current default seeds include only `"{}"` as JSON. Add `"[]"`, `"null"`, `"[{}]"`, `"{\"a\":\"b\"}"` to provide more starting points for JSON-consuming targets. Low-value seeds are deprioritized quickly by the scheduler, so over-approximation is preferred.

- **Add `autoSeed` config toggle.** Allow users to disable all automatic seeding (both detector seeds and default auto-seeds) via `autoSeed: false`. When disabled and no user corpus exists, the fuzzer starts with a single empty seed as the minimum viable starting point.

## Capabilities

### New Capabilities

- `json-byte-mutations`: JSON mutation stage in the per-corpus-entry pipeline. Three mutators (string replacement, key replacement, value replacement) operate at the byte level via fast scanning, performing targeted replacements without full JSON parse/serialize. Runs as a dedicated `HavocScheduledMutator` stage after Unicode, with stacking limited to JSON-only mutations. Includes auto-detection via a corpus heuristic that classifies UTF-8 inputs as "JSON-like" vs "freeform text," extending the existing `FeatureDetection` tri-state pattern.

- `detector-auto-seeding`: Extends the detector interface with a `getSeeds()` method alongside the existing `getTokens()`. Detectors return seed corpus entries that exercise their target bug class. Seeds are passed to the engine via `FuzzerConfig.detectorSeeds` alongside detector tokens. Each detector produces general-purpose seeds for its bug class, not target-specific inputs.

### Modified Capabilities

- `fuzzing-engine`: Add JSON mutation stage mutator to `Fuzzer`, add `StageState::Json` variant, add `jsonMutations` tri-state (`Option<bool>`) to `FuzzerConfig` following the Grimoire/Unicode/REDQUEEN pattern. Extend `FeatureDetection` to resolve JSON auto-detect alongside existing features. Extend default seeds with common JSON shapes. Accept detector seeds via `FuzzerConfig.detectorSeeds`. Add `autoSeed` boolean config to control automatic seeding. Change auto-seed trigger from corpus emptiness to `has_user_seeds` check so detector seeds and default auto-seeds coexist. Auto-seeds (both detector and default) are excluded from the feature detection scan to avoid biasing detection toward text-mode features.

- `stage-execution`: Extend the stage pipeline to include the JSON stage after Unicode. Modify `begin_stage()` fall-through, `advance_stage()` Unicode completion transition, and pipeline ordering.

- `grimoire-auto-detect`: Update pipeline fallback chain in "Grimoire state accessible to stage pipeline" to include Json after Unicode. When Grimoire is disabled, I2S now falls through to Unicode, then Json, then None.

- `unicode-auto-detect`: Feature detection scan excludes auto-seeds (detector seeds + default seeds) to avoid biasing detection. User seeds and fuzzer-discovered inputs inform the detection vote.

- `redqueen-auto-detect`: Feature detection scan excludes auto-seeds from all three detection contexts (inverted-polarity auto-detection, deferred detection integration, immediate detection). Same rationale as unicode-auto-detect.

## Impact

- **vitiate-engine/src/engine/**: New module for JSON byte mutation and stage implementations. New `StageState::Json` variant. Stage transition logic in `stages.rs` and new `json.rs` module. Default seeds list extends.
- **vitiate-engine/src/engine/feature_detection.rs**: `FeatureDetection` gains `json_mutations_enabled` and `json_mutations_override` fields. `scan_corpus_utf8` extends to also classify JSON-like inputs, returning a richer result. `auto_seed_count` retained to exclude auto-seeds from feature detection (auto-seeds are guesses, not signal).
- **vitiate-engine/src/types.rs**: `FuzzerConfig` gains `jsonMutations: Option<bool>`, `autoSeed: Option<bool>`, and `detectorSeeds: Vec<Buffer>` fields.
- **vitiate-core/src/detectors/types.ts**: `Detector` interface gains `getSeeds()` method.
- **vitiate-core/src/detectors/prototype-pollution.ts**: Implements `getSeeds()` with prototype-pollution-relevant JSON shapes.
- **vitiate-core/src/loop.ts**: Collects detector seeds and passes to engine via `FuzzerConfig.detectorSeeds` alongside detector tokens.
- **vitiate-core/src/config.ts**: `FuzzOptions` gains `jsonMutations` and `autoSeed` options.
- No breaking changes. JSON mutations are additive and opt-in (or auto-detected).
