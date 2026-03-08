## Context

The fuzz loop (`loop.ts`) unconditionally breaks on `IterationResult.Solution`, terminating the campaign after the first crash. The supervisor (`supervisor.ts`) has asymmetric crash handling: signal deaths and watchdog timeouts trigger respawn (up to `MAX_RESPAWNS`), but JS crashes (exit code 1) cause immediate termination. This prevents multi-bug discovery in a single campaign and blocks the defect deduplication feature.

The fuzzer operates in two modes — vitest integration (fuzz tests alongside unit tests) and standalone CLI (libfuzzer-compatible). Both modes always run under a parent/child supervisor architecture. The child runs the fuzz loop; the parent detects crashes and respawns.

## Goals / Non-Goals

**Goals:**
- Allow the fuzzer to continue after crashes and discover multiple bugs in a single campaign
- Provide a configurable `stopOnCrash` option with sensible defaults for both vitest and CLI modes
- Add a `maxCrashes` safety valve to prevent runaway crash collection
- Maintain libfuzzer compatibility: non-fork invocations stop on first crash
- Preserve regression mode behavior (always stop on first failure)
- Gate CI correctly: vitest tests still fail if any crash was found

**Non-Goals:**
- Defect deduplication — that is a separate downstream change that depends on this one
- Crash minimization optimization (e.g., batched or deferred minimization) — current per-crash minimization is retained
- Multi-worker parallelism (`-fork=N` for N>1)
- New CLI flags for `stopOnCrash` or `maxCrashes` — VITIATE_FUZZ_OPTIONS and per-test options are sufficient initially

## Decisions

### Decision 1: Tri-state `stopOnCrash` with mode-aware `auto` resolution

The option is `true | false | "auto"` (default `"auto"`).

`auto` resolution:
- **Vitest fuzz mode**: resolves to `false` (continue). The primary use case — timed CI runs — benefits from discovering as many bugs as possible.
- **libFuzzer CLI with `-fork` flag**: resolves to `false`. Fork mode is designed for crash-resilient operation; continuing is the expected behavior.
- **libFuzzer CLI without `-fork` flag**: resolves to `true`. Preserves vanilla libfuzzer semantics where the process stops on the first crash.

Resolution happens before entering the fuzz loop. The CLI parent forwards `forkExplicit` via `CliIpc`, and the child resolves `auto` using `resolveStopOnCrash()`. Vitest mode resolves in `registerFuzzTest` (where `libfuzzerCompat` is always false, so `auto` → `false`). The fuzz loop itself only sees `true | false`.

**Alternative considered**: Boolean-only option with different defaults per mode. Rejected because the tri-state makes the "use the right default for my mode" behavior explicit and avoids requiring users to know which mode-specific default they're overriding.

### Decision 2: `maxCrashes` default of 1000

Default 1000, with 0 meaning unlimited. A high default allows extensive multi-bug campaigns without configuration, while protecting against "supercrasher" inputs that trigger crashes on nearly every input — which would dominate the campaign with minimization overhead and fill the artifact directory. When the limit is reached, a warning is printed to stderr and the loop terminates.

**Alternative considered**: No limit (unlimited by default). Rejected because a pathological crash rate (e.g., target crashes on >50% of inputs) would make the fuzzer effectively useless without a cap, spending all time on minimization rather than exploration.

### Decision 3: Continue in-process for JS crashes, rely on supervisor for native crashes

When `stopOnCrash=false`, the fuzz loop continues iterating after a JS crash (`ExitKind.Crash`). The exception was already caught, the process state is clean, and there's no reason to exit and respawn. For native crashes (signal death), the process is dead and the supervisor already handles respawn — no change needed there.

The supervisor does NOT need changes for exit code 1. When `stopOnCrash=false`, the child handles JS crashes in-process and only exits with code 1 when the full campaign completes with crashes found (the vitest callback throws). Respawning at that point would restart the entire campaign, which is incorrect for bounded campaigns (time/iteration limits).

**Alternative considered**: Always exit-and-respawn on crash (delegate to supervisor). Rejected because: (a) respawn overhead is significant (Vitest startup), (b) doesn't work in vitest mode without the CLI supervisor, (c) JS exceptions are cleanly caught — no corrupted state to recover from.

**Alternative considered**: Respawn on exit code 1 when `stopOnCrash=false` as a safety net. Rejected because: the child only exits 1 after the campaign is fully complete (all crashes handled in-process). Respawning would restart a finished campaign. Non-fuzz errors (config issues) would also trigger unhelpful respawn loops bounded only by MAX_RESPAWNS.

### Decision 4: Still minimize each crash

Crash minimization (up to 10K iterations / 5s per crash) is retained even when continuing. Each crash artifact should be minimal for usability. The `maxCrashes` cap bounds the total minimization time.

**Alternative considered**: Skip minimization when continuing, or only minimize the first crash. Rejected because minimal reproducers are valuable for triage, and the bounded minimization budget (per crash) keeps overhead predictable. Future deduplication will skip minimization for duplicate crashes, which is the right place to optimize.

### Decision 5: Forward `forkExplicit` via `CliIpc`

The CLI parser knows whether `-fork` was explicitly passed. This information is forwarded to the child via a `forkExplicit` boolean in the `CliIpc` JSON blob. The fuzz loop uses this to resolve `auto` correctly: `forkExplicit === true` → resolve to `false` (continue), `forkExplicit === undefined/false` → resolve to `true` (stop).

This avoids the fuzz loop needing to parse CLI flags or have complex mode detection logic.

### Decision 6: `FuzzLoopResult` accumulates multiple crashes

`FuzzLoopResult` gains:
- `crashCount: number` — total crashes found (0 if none)
- `crashArtifactPaths: string[]` — all artifact paths written

The existing `crashed: boolean` is derived from `crashCount > 0`. The existing `error` field retains the first crash error for vitest reporting. The existing `crashInput` and `crashArtifactPath` (singular) retain the first crash data for backward compatibility.

## Risks / Trade-offs

**[Minimization overhead with many crashes]** → Bounded by `maxCrashes` default (1000) and per-crash time limit (5s). Worst case: ~83 minutes of minimization at max. In practice, most campaigns find far fewer crashes, and deduplication (future) will skip duplicate minimization.

**[Breaking change to `FuzzLoopResult` type]** → All consumers of `FuzzLoopResult` need updating. There are only two: `fuzz.ts` (vitest mode) and `loop.ts` internal usage. The `cli.ts` parent mode doesn't consume `FuzzLoopResult` directly (it uses `SupervisorResult`). Low risk.
