## Why

Vitiate's havoc mutations operate on raw bytes and frequently produce invalid UTF-8, which text-processing fuzz targets reject at the parsing boundary before reaching deeper logic. Since JavaScript fuzz targets overwhelmingly process text inputs (JSON, HTML, URLs, source code, configuration), this wastes significant fuzzing effort. Unicode-aware mutations preserve encoding validity while varying content, reaching deeper code paths that byte-level mutations cannot.

## What Changes

- Add a **UTF-8 identification stage** that analyzes corpus entries to locate valid UTF-8 string regions and precompute character boundary metadata, cached per testcase.
- Add **Unicode category/subcategory mutations** that replace characters with random characters from the same Unicode category (e.g., letter → letter, digit → digit), preserving structural validity.
- Add **Unicode token replacement mutations** that replace category-contiguous regions with dictionary tokens from the CmpLog-promoted token set.
- Add a **unicode configuration option** (`unicode?: boolean`) to the `FuzzOptions`/`FuzzerConfig` interface, following the same tri-state pattern as Grimoire: `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
- Integrate the unicode mutation stage into the existing stage pipeline, running after I2S and alongside or after Grimoire stages.

## Capabilities

### New Capabilities
- `unicode-identification`: UTF-8 region identification and character boundary metadata extraction for corpus entries.
- `unicode-mutation`: Unicode category-aware and token replacement mutators that preserve UTF-8 encoding validity.
- `unicode-auto-detect`: Auto-enable/disable unicode mutations based on corpus UTF-8 content, with explicit override support.

### Modified Capabilities
- `stage-execution`: Pipeline extended with unicode identification and mutation stages.
- `grimoire-auto-detect`: Post-I2S pipeline completion updated — falls through to unicode (if enabled) instead of completing.

## Impact

- **vitiate-napi/src/engine.rs**: New `StageState` variant(s), unicode metadata types, mutator implementations, pipeline transitions, auto-detection integration with existing UTF-8 scanning.
- **vitiate-napi/index.d.ts**: Auto-generated — updated by `napi build` from new Rust `#[napi]` annotations.
- **vitiate/src/config.ts**: New `unicode` option in `FuzzOptions`, validation, passthrough to `FuzzerConfig`.
- **vitiate/src/loop.ts**: No changes expected — stage protocol is already generic.
- **Dependencies**: Point `libafl` git dependency at `mjkoo/LibAFL` branch `constructable-unicode-metadata` (adds `UnicodeIdentificationMetadata::new()` public constructor) and enable the `"unicode"` feature for category tables + mutator access. All 4 mutators (`UnicodeCategoryRandMutator`, `UnicodeSubcategoryRandMutator`, `UnicodeCategoryTokenReplaceMutator`, `UnicodeSubcategoryTokenReplaceMutator`) + category tables reused from LibAFL.
