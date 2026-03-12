## Context

Vitiate has two operational modes:

1. **Vitest plugin mode** (`it.fuzz()`): Integrated into the test framework, mirroring Go's native fuzzing support. Fuzz tests live alongside unit tests and run via `vitest`.
2. **Standalone CLI mode** (`npx vitiate`): A libFuzzer-compatible interface targeting OSS-Fuzz. This mirrors the pattern of taking a native fuzz test and driving it with libFuzzer for CI/production fuzzing.

Both modes use a supervisor + child process architecture. The standalone CLI always operates as the equivalent of libFuzzer with `-fork=1` - a supervisor parent watching a single worker child via waitpid. There is no "non-fork" standalone mode; that use case is served by the Vitest plugin. When we eventually support multiple worker children (`-fork=N`), the architecture extends naturally.

Two gaps remain before the standalone CLI works in OSS-Fuzz:

1. **CLI flags.** OSS-Fuzz infrastructure passes `-fork=N`, `-jobs=N`, and `-merge=1` to the fuzzer binary. The existing `standalone-cli` spec already requires these to be accepted and warned about, but the implementation rejects unknown flags via `@optique/core`'s parser.

2. **Crash minimization.** When the fuzz loop finds a crashing input (via `IterationResult.Solution`), it writes the raw mutated input as the crash artifact. Fuzzer-generated inputs are often much larger than necessary to trigger the bug. All major fuzzers (libFuzzer, AFL++, go-fuzz) minimize crashes before writing artifacts.

The fuzz loop crash path is at `loop.ts:219-230`. The watchdog (`Watchdog.runTarget()`) already provides safe target re-execution with timeout enforcement, which the minimizer can reuse. The fuzz loop is shared by both modes, so minimization benefits both.

## Goals / Non-Goals

**Goals:**

- Accept `-fork`, `-jobs`, `-merge` flags without erroring, with a warning that they're not yet supported.
- After detecting an in-process JS exception crash, attempt to shrink the input to a minimal reproducer before writing the artifact and exiting.
- Minimization must respect the configured timeout per re-execution attempt.
- If minimization fails entirely (target stops crashing, minimizer hits budget), write the original unminimized input as fallback.

**Non-Goals:**

- Implementing `-fork`, `-jobs`, or `-merge` behavior. These are accepted and ignored.
- Minimizing timeout artifacts. Timeout inputs are inherently timing-dependent and may not reproduce reliably with shorter inputs.
- **Inline minimization of native signal crashes in the supervisor.** The supervisor operates in fork mode - it writes raw crash artifacts from shmem and respawns the child. Minimizing native crashes inline would stall the fuzzing campaign and risks wasting cycles on duplicate crashes (the same shallow bug hit repeatedly). This matches libFuzzer fork mode, which does not minimize inline. Native crash minimization is deferred to a future standalone `vitiate-tmin` tool (analogous to libFuzzer's `-minimize_crash=1`).
- Rust-side minimization. LibAFL has `StdMinimizer` but it operates at the engine level with its own feedback loop. Our minimization is simpler: re-run the JS target with shrunk inputs and check if it still throws. This keeps the logic in TypeScript where the target function and watchdog are directly accessible.
- Coverage-guided minimization. We shrink by input size, not by coverage delta. Coverage-guided approaches (finding the minimal input that preserves the same edge set) are more sophisticated but require coupling to the coverage map, which adds complexity. Size-based minimization catches the majority of bloat.

## Decisions

### Decision 1: Minimization strategy - two-pass (truncation + byte deletion)

**Chosen approach:** A two-pass minimization loop:

1. **Truncation pass.** Binary search on input length. Test `input[0..len/2]`, if it still crashes keep the shorter version and continue halving. If not, try `input[0..3*len/4]`, etc. This quickly eliminates trailing bytes that don't contribute to the crash. O(log n) target invocations.

2. **Byte deletion pass.** Walk the minimized input from start to end. For each position, try removing one byte (or a small chunk). If the target still crashes, keep the deletion. If not, restore and advance. This catches interior bytes that are irrelevant. O(n) target invocations where n is the post-truncation length.

**Alternatives considered:**

- **libFuzzer's approach** (try removing each byte, then each pair, then each 4-byte chunk, etc.): More thorough but O(n * log(n)) invocations. Too slow for large inputs without a budget cap. We get most of the benefit from the two-pass approach.
- **Random deletion** (repeatedly remove random chunks until the target stops crashing): Non-deterministic and hard to test. The sequential approach is predictable.
- **AFL-tmin** (whole tool with multiple strategies): Too complex for an initial implementation. The two-pass approach is the core of what tmin does.

### Decision 2: In-process minimization only - supervisor writes raw artifacts

**Chosen approach:** Minimization only happens in-process, in the fuzz loop, for JS exception crashes (`ExitKind.Crash`). Native signal crashes detected by the supervisor are written as raw (unminimized) artifacts.

**Rationale - two crash paths within fork mode:**

The standalone CLI always operates in fork mode (supervisor + single worker child). Within this architecture, there are two distinct crash paths:

- **JS exception crash (child catches it):** The child's fuzz loop detects the exception, and the loop is about to `break` and exit. The child can minimize before exiting - this is free because the child is about to die and be respawned anyway. One minimization per child lifecycle, no dedup concern. After the child exits, the supervisor respawns it to continue fuzzing.
- **Native signal crash (child is dead):** The supervisor observes the child's death via waitpid, reads the last stashed input from shmem, and writes the raw artifact. The supervisor does not attempt to minimize - it would need to spawn repro children for each candidate (~100-300ms per spawn), stalling the campaign, and risks wasting the entire budget on a duplicate of a shallow crash.

This matches libFuzzer fork mode (`-fork=N`), where the parent records raw crash artifacts from dead children with **no inline minimization**, and continues running workers. Minimization is a separate post-hoc step (`-minimize_crash=1`). OSS-Fuzz follows the same pattern: run fuzzers in fork mode, collect raw artifacts, then dedup and minimize as separate pipeline steps.

The Vitest plugin mode shares the same fuzz loop code, so minimization of JS exception crashes applies there as well.

**Future work:** A standalone `vitiate-tmin` tool for post-hoc minimization of any crash artifact (JS or native). This matches libFuzzer's `-minimize_crash=1` and AFL's `afl-tmin`.

### Decision 3: Minimization budget - iteration cap + wall-clock time limit

**Chosen approach:** Minimization is bounded by two limits, whichever is hit first:

1. **Iteration cap** - maximum number of target re-executions. Default: 10,000.
2. **Wall-clock time limit** - maximum elapsed real time. Default: 5 seconds.

The iteration cap alone doesn't bound wall time predictably - a target that takes 50ms per execution would turn 10,000 iterations into 8+ minutes. Conversely, the time limit alone doesn't prevent runaway iteration counts against trivially fast targets. Both limits together give a hard guarantee.

A value of 0 for either limit means unlimited (no cap for that dimension). This convention is consistent with all other duration/count parameters in the CLI and configuration.

The 5-second default is intentionally aggressive - this is inline minimization inside an active fuzz loop, not a standalone tool. The truncation pass (O(log n)) completes in well under a second for any realistic input size, and even the byte deletion pass on a post-truncation ~100 byte input needs only ~100 attempts. If users need deeper minimization, a standalone `vitiate-tmin` mode (analogous to `afl-tmin`) can be introduced later with a higher budget.

The minimizer checks both limits before each `testCandidate` call. If either is exceeded, minimization stops and writes the best (smallest) crashing input found so far. The user always gets an artifact - minimization is best-effort.

Both limits SHALL be configurable via `FuzzOptions`.

### Decision 4: Crash verification - exceptions via runTarget

**Chosen approach:** A candidate input is considered to "still crash" if `Watchdog.runTarget()` returns `exitKind=1` (exception thrown). `exitKind=0` (normal return) or `exitKind=2` (timeout) means the candidate does not reproduce.

If the target returns a Promise, the minimizer SHALL await it and check for rejection, using the same timeout enforcement as the fuzz loop.

### Decision 5: Ignored CLI flags - parse and warn selectively

**Chosen approach:** Add `-fork`, `-jobs`, `-merge` to the `@optique/core` parser as optional integer flags. Print warnings only for unsupported values:

- `-fork=0`: Warn that non-fork mode is not supported (vitiate always uses fork mode).
- `-fork=N` with N > 1: Warn that multi-worker mode is not yet supported. `-fork=1` (or no flag) is our default architecture - no warning needed.
- `-jobs=N` with N > 1: Warn that parallel jobs are not yet supported.
- `-merge=1`: Warn that corpus merge mode is not yet supported.

Do not pass any of these to `FuzzOptions`. The standalone CLI always operates as `-fork=1` (supervisor + single worker child); these flags exist solely so OSS-Fuzz infrastructure doesn't error when it passes them.

This matches the existing spec requirement (which specifies "warn if N > 1" for `-fork` and `-jobs`).

## Risks / Trade-offs

**[Risk] In-process minimization changes process state** → The fuzz loop's coverage map, CmpLog state, and fuzzer corpus are still active during minimization. Each re-execution writes to the coverage map and may accumulate CmpLog entries. **Mitigation:** Zero the coverage map before each minimization execution (same as the normal fuzz loop does via `reportResult`). CmpLog state is irrelevant since we're not feeding results back to the mutation engine. Alternatively, call `fuzzer.reportResult(ExitKind.Ok)` after each minimization attempt to reset state cleanly.

**[Risk] Minimized input doesn't reproduce in regression mode** → The target may rely on global state accumulated during fuzzing (e.g., module-level caches, global variables mutated by earlier inputs). A minimized input that crashes during fuzzing might not crash in isolation. **Mitigation:** This is inherent to in-process fuzzing and affects unminimized artifacts equally. Document that crash artifacts should be verified in regression mode.

**[Risk] Native crash artifacts are unminimized** → Supervisor-detected crashes (signals) are written raw. These may be bloated. **Mitigation:** This matches libFuzzer fork mode behavior. OSS-Fuzz has its own minimization pipeline. A future `vitiate-tmin` standalone tool will address post-hoc minimization for users who need it outside of OSS-Fuzz.

**[Risk] Minimization adds latency before crash reporting** → Users see a delay between "crash found" and "artifact written." **Mitigation:** Bounded to 5 seconds by wall-clock limit. Print a message when minimization starts and completes. The child is about to exit and be respawned by the supervisor anyway (the fuzz loop `break`s on crash), so minimization doesn't cost fuzzing cycles - it uses time that would otherwise be spent on process teardown and respawn.
