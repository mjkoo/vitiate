## Why

The standalone CLI (`npx vitiate`) targets OSS-Fuzz as a primary deployment environment. The CLI always operates as the equivalent of libFuzzer with `-fork=1` — a supervisor parent watching a single worker child. Two gaps block production use: (1) OSS-Fuzz infrastructure passes `-fork=N`, `-jobs=N`, and `-merge=1` flags that the CLI rejects with parse errors, and (2) crash artifacts are written verbatim without minimization, producing unnecessarily large reproducers that are harder to debug and triage. Both are called out in the existing standalone-cli spec (flags) and PRD (minimization) but not yet implemented.

## What Changes

- **Accept and warn on `-fork`, `-jobs`, `-merge` CLI flags.** The parser will accept these libFuzzer-compatible flags. Since the standalone CLI already operates as `-fork=1`, that value is silently accepted as the default. Values requesting unsupported behavior (`-fork=N` with N > 1, `-jobs=N` with N > 1, `-merge=1`) print a warning and are ignored. No behavioral change — fuzzing continues with a single worker child.
- **Add crash input minimization for JS exceptions.** When the fuzz loop finds a crashing input (JS exception), it will attempt to shrink it in-process before writing the artifact. The minimizer re-runs the target with progressively smaller inputs, keeping the smallest that still triggers the crash. The final artifact is the minimal reproducer. If minimization itself fails or times out, the original unminimized input is written as a fallback. Native signal crashes (detected by the supervisor) are written as raw artifacts without inline minimization, matching libFuzzer fork mode behavior. Post-hoc minimization for native crashes is deferred to a future standalone `vitiate-tmin` tool.

## Capabilities

### New Capabilities

- `crash-minimization`: Shrink crashing inputs to minimal reproducers before writing crash artifacts. Covers the minimization loop, shrinking strategies, timeout/retry policy, and integration with the fuzz loop's crash-handling path.

### Modified Capabilities

- `standalone-cli`: The spec already requires `-fork`, `-jobs`, `-merge` to be accepted and warned. The implementation needs to match the spec. No spec-level requirement changes needed.
- `fuzz-loop`: The crash-handling path gains a minimization step between crash detection and artifact writing. The spec needs a delta to describe the new minimization behavior.

## Impact

- **vitiate/src/cli.ts**: Add flag definitions for `-fork`, `-jobs`, `-merge` to the argument parser.
- **vitiate/src/loop.ts**: Insert in-process minimization step after `IterationResult.Solution` with `ExitKind.Crash` and before `writeCrashArtifact()`.
- **vitiate/src/minimize.ts** (new): Minimization loop implementation — two-pass strategy (truncation + byte deletion) with `testCandidate` callback, iteration cap, and wall-clock time limit.
- **vitiate/src/supervisor.ts**: No changes — supervisor writes raw artifacts for native crashes, matching libFuzzer fork mode.
- **vitiate-napi/**: No Rust changes expected. In-process minimization re-uses `Watchdog.runTarget()`.
- **vitiate/src/corpus.ts**: No changes — `writeCrashArtifact()` is called with the minimized input, same interface.
