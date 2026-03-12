## Why

Vitiate's I2S (input-to-state) mutations are diluted: each fuzz iteration gets at most one I2S replacement attempt on a randomly-selected corpus entry, whereas libafl_libfuzzer runs 1-128 concentrated I2S mutations on the freshly-traced corpus entry immediately after it's found interesting. CmpLog data collected from entry A may be used to mutate entry B, where the comparison operands don't appear. This significantly reduces the effectiveness of comparison-guided mutation. Fixing this requires the ability to drive multiple target executions from the Rust engine after calibration - a capability the architecture currently lacks. This is also a prerequisite for Grimoire (grammar-aware structural mutations), which needs the same multi-execution infrastructure.

## What Changes

- Add a **JS-driven stage execution protocol** with three new NAPI methods on the `Fuzzer` class: `beginStage()`, `advanceStage()`, and `abortStage()`. These extend the proven calibration polling pattern into a general-purpose stage protocol where Rust generates candidate inputs and evaluates coverage, while JS drives target execution (preserving async target support and watchdog protection).
- Add an **I2S mutational stage state machine** inside the Rust `Fuzzer` struct. After calibration completes for a new interesting input, the stage generates 1-128 I2S-mutated variants of that corpus entry using the existing `I2SRandReplace`/`I2SSpliceReplace` mutators and evaluates each for new coverage.
- Add a **stage execution loop** in the TypeScript fuzz loop (`loop.ts`) that runs after calibration, calling `beginStage()` to get the first candidate, executing the target, then calling `advanceStage()` in a loop until the stage completes or a crash/timeout aborts it.
- **Factor out coverage evaluation** from `reportResult()` into a shared helper that both `reportResult()` and `advanceStage()` can use, avoiding duplication of the map-read/feedback-evaluate/map-zero logic.

## Capabilities

### New Capabilities
- `stage-execution`: The beginStage/advanceStage/abortStage NAPI protocol for driving multi-execution stages from JS. Covers the state machine lifecycle, coverage evaluation during stages, CmpLog accumulator handling, and crash/timeout abort semantics.

### Modified Capabilities
- `fuzz-loop`: The fuzz loop gains a stage execution loop after calibration that calls beginStage/advanceStage/abortStage with the same async target handling and watchdog protection as the main iteration cycle.
- `fuzzing-engine`: The Fuzzer class gains three new NAPI methods (beginStage, advanceStage, abortStage), a StageState enum for tracking stage progress, and a shared coverage evaluation helper factored out of reportResult.

## Impact

- **vitiate-napi/src/engine.rs**: New `StageState` enum, `begin_stage()`, `advance_stage()`, `abort_stage()` methods, shared `evaluate_coverage()` helper refactored from `report_result()`. The `I2SRandReplace`/`I2SSpliceReplace` mutators are reused directly - no new mutation logic.
- **vitiate/src/loop.ts**: New stage execution loop after the calibration block, following the same three-branch async pattern (sync crash/timeout, async Promise with re-arm/await/disarm, no-watchdog direct call).
- **vitiate-napi/index.d.ts**: TypeScript type declarations for the three new NAPI methods.
- **No breaking changes**: The existing `getNextInput()`/`reportResult()` protocol is unchanged. The stage loop is additive - it runs only when `reportResult()` returns `Interesting` and calibration completes.
