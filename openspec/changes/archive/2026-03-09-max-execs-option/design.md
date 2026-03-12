## Context

The fuzz loop currently uses `FuzzOptions.runs` as the iteration budget, with `0` meaning unlimited. The naming is inconsistent with `fuzzTimeMs` (the wall-clock budget) and ambiguous - "runs" could mean test runs, calibration runs, or main-loop iterations. The CLI exposes this via the libFuzzer-compatible `-runs=N` flag, and there is no dedicated environment variable override (unlike `VITIATE_FUZZ_TIME` for `fuzzTimeMs`).

## Goals / Non-Goals

**Goals:**

- Rename `FuzzOptions.runs` to `FuzzOptions.fuzzExecs` for naming consistency with `fuzzTimeMs`.
- Add `VITIATE_FUZZ_EXECS` environment variable with a `getFuzzExecs()` helper, mirroring `VITIATE_FUZZ_TIME` / `getFuzzTime()`.
- Keep the libFuzzer CLI flag as `-runs=N` but map it to `fuzzExecs` internally.
- Maintain identical semantics: 0 = unlimited, counts main-loop iterations only.

**Non-Goals:**

- Changing what counts as an "exec" (calibration, minimization, and stage executions remain uncounted).
- Adding new CLI flags (the existing `-max_total_time` and `-runs` flags already cover wall-clock and iteration budgets respectively).
- Making the overshoot behavior more precise - calibration/minimization/stage work after the last qualifying iteration is acceptable.

## Decisions

### Decision 1: Field name `fuzzExecs` (not `fuzzIterations`, `maxExecs`, etc.)

`fuzzExecs` parallels `fuzzTimeMs` - both use the `fuzz` prefix to indicate they are campaign-level budgets, distinguishing them from per-execution settings like `timeoutMs`. "Execs" is the standard term in fuzzing literature (AFL, libFuzzer both report "execs/sec").

Alternatives considered:
- `fuzzIterations`: More precise but longer; "execs" is the established fuzzing term.
- `maxExecs`: Breaks the naming pattern - `fuzzTimeMs` is not called `maxTimeMs`.
- `executions`: Unnecessarily verbose.

### Decision 2: `VITIATE_FUZZ_EXECS` as a plain integer (no unit conversion)

Unlike `VITIATE_FUZZ_TIME` which accepts seconds and converts to milliseconds, `VITIATE_FUZZ_EXECS` accepts a plain integer count. No conversion is needed since the unit is already "executions". Invalid values (non-integer, negative) produce a stderr warning and are ignored, matching `getFuzzTime()` behavior.

### Decision 3: `getFuzzExecs()` overrides `fuzzExecs` in `getCliOptions()`

The env var override follows the same pattern as `getFuzzTime()` overriding `fuzzTimeMs`: if `VITIATE_FUZZ_EXECS` is set, it takes precedence over any value in `VITIATE_FUZZ_OPTIONS`. This is applied at the end of `getCliOptions()`.

### Decision 4: CLI `-runs=N` maps to `fuzzExecs` (no flag rename)

The `-runs` flag is part of the libFuzzer CLI contract required for OSS-Fuzz compatibility. Renaming it would break OSS-Fuzz harness scripts. The mapping changes from `FuzzOptions.runs` to `FuzzOptions.fuzzExecs` in the CLI flag parser.

## Risks / Trade-offs

- **[Breaking change]** → No external users yet; internal references are fully enumerable via grep. Low risk.
- **[Overshoot on termination]** → If the iteration count hits `fuzzExecs` but calibration, stage execution (I2S, Generalization, Grimoire), or minimization is in-flight, those operations complete before the loop checks the condition again. This is by design - interrupting these operations mid-flight would corrupt internal state. The overshoot is bounded by calibration iterations (3-7) plus stage executions (variable, depends on CmpLog data) plus minimization budget (default 10,000, but that's a separate budget with its own limit).
