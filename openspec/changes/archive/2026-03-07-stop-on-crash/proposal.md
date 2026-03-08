## Why

The fuzz loop always terminates after finding the first crash, preventing discovery of multiple distinct bugs in a single fuzzing campaign. This is a prerequisite for defect deduplication — the fuzzer must be able to continue past crashes to collect and deduplicate multiple defects. Continuing after crashes is also a saner default for both vitest integration (where a timed CI run should maximize bug discovery) and libfuzzer fork mode (which is designed for crash-resilient operation).

## What Changes

- Add `stopOnCrash` option (tri-state: `true | false | "auto"`) to `FuzzOptions`. Default `"auto"` resolves to `false` (continue after crash) in vitest fuzz mode and libfuzzer fork mode, and `true` (stop on first crash) in libfuzzer non-fork mode for compatibility.
- Add `maxCrashes` option (non-negative integer, default 1000, 0 = unlimited) to `FuzzOptions`. Acts as a safety valve — warns and stops when the limit is reached.
- Modify the fuzz loop to continue iterating after `IterationResult.Solution` when `stopOnCrash` is false, recording each crash artifact and incrementing a crash counter.
- Modify `FuzzLoopResult` to report multiple crashes (crash count, list of artifact paths).
- Modify vitest reporting to report crash count and artifact directory when multiple crashes are found (test still fails if any crash was found, gating CI).
- Add `forkExplicit` field to `CliIpc` so the fuzz loop can resolve `auto` correctly for libfuzzer mode.

## Capabilities

### New Capabilities
- `crash-continuation`: Controls whether the fuzzer continues or stops after finding crashes, including the `stopOnCrash` tri-state option, `maxCrashes` limit, and multi-crash fuzz loop behavior.

### Modified Capabilities
- `fuzz-loop`: Termination conditions change — crash/timeout no longer unconditionally terminates the loop. New `stopOnCrash` and `maxCrashes` parameters control crash termination. `FuzzLoopResult` gains multi-crash fields.
- `test-fuzz-api`: Vitest reporting changes — error message reports crash count and artifact directory instead of single artifact path when multiple crashes found.
- `standalone-cli`: `CliIpc` gains `forkExplicit` field. Auto resolution of `stopOnCrash` uses fork flag presence.

## Impact

- **vitiate/src/config.ts**: New `stopOnCrash` and `maxCrashes` fields in `FuzzOptionsSchema`. New `forkExplicit` field in `CliIpcSchema`.
- **vitiate/src/loop.ts**: `FuzzLoopResult` type changes (multi-crash fields). Fuzz loop crash handling branch becomes conditional on `stopOnCrash`. Crash counter and `maxCrashes` enforcement.
- **vitiate/src/fuzz.ts**: Child-mode crash reporting updated for multi-crash results. `translateSupervisorResult` verified unchanged (parent mode only sees exit code, not crash count).
- **vitiate/src/cli.ts**: `toCliArgs` sets `forkExplicit` in `CliIpc`. `stopOnCrash`/`maxCrashes` forwarded through `VITIATE_FUZZ_OPTIONS`.
- **vitiate-napi/**: No changes required — the Rust engine already supports multiple solutions in its solutions corpus.
