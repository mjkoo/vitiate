## Why

The `traceCmp` NAPI function currently evaluates comparisons correctly but discards the operand values — it's a passthrough. This means the fuzzer is blind to what the target code compares against. When code checks `input === "admin"`, the mutator has to discover those bytes by random chance instead of learning them from comparison feedback. CmpLog (comparison logging) integration with LibAFL's mutation engine will dramatically improve the fuzzer's ability to get past magic-value checks, multi-byte comparisons, and string equality guards.

## What Changes

- Add a Rust-side CmpLog map that records comparison operands serialized to bytes, allocated and managed alongside the existing coverage map.
- Modify `traceCmp` to serialize JS comparison operands (strings, numbers) into the CmpLog map entries when a fuzzer is active, while preserving existing passthrough behavior when no fuzzer is running.
- Add a CmpLog observer and input-to-state (I2S) replacement mutator to the `Fuzzer` class so LibAFL can use recorded comparison data to guide mutations toward satisfying branch conditions.
- Zero the CmpLog map between iterations in `reportResult`, alongside the existing coverage map zeroing.

## Capabilities

### New Capabilities

- `cmplog-feedback`: CmpLog map allocation, operand recording from `traceCmp`, observer integration in the fuzzing engine, and I2S mutation strategy that uses comparison operands to guide input generation.

### Modified Capabilities

- `trace-cmp-bridge`: `traceCmp` gains CmpLog recording behavior when a fuzzer is active (currently specified as passthrough-only).
- `fuzzing-engine`: `Fuzzer` constructor accepts an optional CmpLog map, observer tuple expands to include CmpLog observer, mutator stack gains I2S replacement mutator.

## Impact

- **vitiate-napi crate only** — all changes are in Rust. No changes to `vitiate-instrument` (WASM plugin) or `vitiate` (TypeScript package).
- `trace.rs`: Gains CmpLog map write path with JS value serialization.
- `engine.rs`: Fuzzer type aliases change (observer tuple, mutator stack). Constructor signature gains optional cmplog map parameter. `reportResult` zeros cmplog map.
- New module (e.g., `cmplog.rs`): CmpLog map type, value serialization logic, observer wrapper.
- `types.rs`: `FuzzerConfig` may gain a `cmplogEnabled` or similar field.
- NAPI exports: `createCmpLogMap()` function added.
- Existing `traceCmp` signature unchanged — behavior changes internally.
- LibAFL feature flags in workspace `Cargo.toml` may need updating if CmpLog types require additional features.
