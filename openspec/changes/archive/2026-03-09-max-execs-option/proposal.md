## Why

The current `runs` option controls the maximum iteration count for a fuzz campaign, but the name is ambiguous - it could refer to test runs, calibration runs, or fuzzing iterations. Renaming it to `fuzzExecs` aligns it with the `fuzzTimeMs` naming convention and makes the semantics immediately clear: this is the execution budget for the main fuzz loop. A consistent naming pattern (`fuzzTimeMs` for wall-clock budget, `fuzzExecs` for iteration budget) makes the API self-documenting and enables reliable benchmarking of mutation strategies independent of target performance.

## What Changes

- **BREAKING** Rename `FuzzOptions.runs` to `FuzzOptions.fuzzExecs` across the config schema, fuzz loop, and all consumers.
- The libFuzzer-compat CLI flag `-runs=N` is unchanged (required for OSS-Fuzz compatibility) but now maps to `FuzzOptions.fuzzExecs` internally instead of `FuzzOptions.runs`.
- Add `VITIATE_FUZZ_EXECS` environment variable with a `getFuzzExecs()` config helper, mirroring the `VITIATE_FUZZ_TIME` / `getFuzzTime()` pattern. Value is a plain integer (no unit conversion needed, unlike the seconds→ms conversion for `VITIATE_FUZZ_TIME`).
- Update the fuzz loop termination check to use the renamed field.
- Semantics unchanged: 0 means unlimited (default), counts main-loop iterations only (calibration and minimization may cause slight overshoot).

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `fuzz-loop`: Termination condition references change from `runs` to `fuzzExecs`. Add `VITIATE_FUZZ_EXECS` env var override as a new requirement (applies universally, not just CLI mode).
- `standalone-cli`: The `-runs=N` libFuzzer flag now maps to `FuzzOptions.fuzzExecs` instead of `FuzzOptions.runs`.
- `test-fuzz-api`: `FuzzOptions.runs` field renamed to `fuzzExecs` in the API signature documentation.
- `vitest-plugin`: `FuzzOptions.runs` field renamed to `fuzzExecs` in the plugin options documentation.

## Impact

- **Config**: `vitiate/src/config.ts` - rename field in `FuzzOptionsSchema`, add `getFuzzExecs()` helper, add to `KNOWN_VITIATE_ENV_VARS`.
- **Fuzz loop**: `vitiate/src/loop.ts` - rename `maxRuns` variable to use `fuzzExecs`.
- **CLI**: `vitiate/src/cli.ts` (or wherever `-runs` is parsed) - map to new field name.
- **Tests**: `vitiate/src/loop.test.ts`, any config tests - update field references.
- **Specs**: `openspec/specs/fuzz-loop/spec.md`, `openspec/specs/standalone-cli/spec.md` - update terminology.
