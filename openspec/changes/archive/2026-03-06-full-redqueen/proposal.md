## Why

Vitiate's comparison-feedback pipeline currently uses only simple I2S (Input-to-State) replacement: find comparison operands in the input, swap one for the other. This misses comparisons where the target applies a transform between input bytes and the comparison - XOR encoding, arithmetic offsets, case conversion, endianness swaps, base64 decoding. Full REDQUEEN adds colorization (identifying which input bytes are "free"), dual CmpLog tracing (detecting transforms), and targeted replacement with transform awareness. This is particularly impactful for binary/encoded JavaScript targets (protocol parsers, msgpack/protobuf, compression, crypto) where transforms are common and the current pipeline provides minimal stage investment.

## What Changes

- **New colorization stage**: Binary-search algorithm identifies input byte ranges that don't affect coverage ("free bytes"). These constrain the REDQUEEN search space from O(comparisons x input_length) to O(comparisons x taint_positions). Runs as an interactive stage (~2n executions for an n-byte input).
- **Enriched CmpLog data**: Comparison operator type (equal/less/greater), site ID keying, and dual-trace values (original vs. colorized) are recorded. Storage adds a site-keyed `HashMap<usize, Vec<CmpValues>>` format (LibAFL's `AflppCmpValuesMetadata`) alongside the existing flat list (`CmpValuesMetadata`) for I2S backward compatibility.
- **New REDQUEEN mutation stage**: Generates targeted replacements with transform awareness (XOR, arithmetic, case, endianness, float/integer +-1). Uses LibAFL's `AflppRedQueen::multi_mutate()` directly - all candidates generated at once, then yielded one per `advanceStage()` call.
- **Complementary auto-detection**: REDQUEEN auto-enables when the corpus is non-UTF-8, using the same deferred detection infrastructure as Grimoire/Unicode but with inverted polarity. This ensures binary targets get specialized stages (colorization + REDQUEEN) just as text targets get specialized stages (generalization + Grimoire + Unicode).
- **I2S/REDQUEEN coordination**: When REDQUEEN runs, I2S is skipped (REDQUEEN subsumes it). When REDQUEEN is skipped (input too large, or text target), I2S runs as before.

## Capabilities

### New Capabilities

- `colorization`: Binary-search algorithm to identify input byte ranges that don't affect coverage. Produces taint metadata consumed by the REDQUEEN mutation stage. Includes `type_replace` (type-preserving byte randomization) and coverage hashing.
- `redqueen-mutation`: Transform-aware targeted replacement mutation stage. Calls `AflppRedQueen::multi_mutate()`, stores candidates, yields them through the stage protocol. Handles XOR, arithmetic, case, endianness, and boundary (+-1) transforms.
- `redqueen-auto-detect`: Auto-enable REDQUEEN for non-UTF-8 (binary) targets using the same deferred detection scan as Grimoire/Unicode. Includes explicit override via `FuzzerConfig.redqueen: Option<bool>`.

### Modified Capabilities

- `stage-execution`: Pipeline ordering changes to accommodate colorization, dual tracing, and REDQUEEN mutation stages before I2S. I2S is conditionally skipped when REDQUEEN ran.
- `comparison-tracing`: The `cmp_id` and `op` parameters already passed to `trace_cmp()` must now be stored rather than discarded.
- `cmplog-feedback`: Enriched to record operator type (`CmpLogOperator`), key entries by comparison site ID, and support dual-trace capture. Storage format changes from `CmpValuesMetadata` (flat list) to `AflppCmpValuesMetadata` (site-keyed maps with headers). Both metadata types are stored for backward compatibility - `AflppCmpValuesMetadata` for REDQUEEN, `CmpValuesMetadata` (flattened) for I2S.

## Impact

- **vitiate-napi crate**: Core changes to `trace.rs` (CmpLog accumulation), `cmplog.rs` (metadata types), `engine/mod.rs` (stage dispatch), and new modules for colorization and REDQUEEN stages.
- **vitiate-napi public API**: New `redqueen` field on `FuzzerConfig`. No other API changes - colorization, dual tracing, and REDQUEEN mutation are internal to the stage pipeline.
- **SWC plugin**: No changes required. The `cmp_id` and `op` parameters are already emitted by instrumentation; they're just not consumed on the Rust side yet.
- **TypeScript side**: Minimal - add `redqueen?: boolean` to `FuzzOptions` and wire it through to `FuzzerConfig`.
- **Execution budget**: Full REDQUEEN adds ~200-6000 executions per interesting input (dominated by colorization cost scaling with input length). A size threshold (e.g., 4KB) caps worst-case colorization cost.
- **Dependencies**: Uses `AflppRedQueen` and `TaintMetadata` from LibAFL directly. The colorization algorithm is ported (not reused) since LibAFL's version requires executor/observer traits we don't use.
