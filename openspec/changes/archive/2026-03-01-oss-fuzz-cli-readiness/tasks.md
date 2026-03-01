## 1. CLI Flags

- [x] 1.1 Add `-fork`, `-jobs`, `-merge` as optional integer flags to `cliParser` in `cli.ts`
- [x] 1.2 Print a warning to stderr only for unsupported values: `-fork=0` (non-fork mode not supported), `-fork=N` with N > 1, `-jobs=N` with N > 1, `-merge=1`. Silently accept `-fork=1` and `-jobs=1` (these match our default architecture)
- [x] 1.3 Add tests for CLI flag handling: `-fork=1` parses without warning, `-fork=4` parses with warning, `-merge=1` parses with warning, unknown flags still cause parse errors (ensure we didn't break existing behavior)

## 2. Minimization Core

- [x] 2.1 Create `vitiate/src/minimize.ts` with the two-pass minimization function: `minimize(input, testCandidate, options) => Buffer`
- [x] 2.2 Implement truncation pass: binary search on input prefix length, accept shorter candidate if `testCandidate` returns true
- [x] 2.3 Implement byte deletion pass: walk from start to end, remove one byte at each position, keep deletion if `testCandidate` returns true
- [x] 2.4 Implement budget tracking: count each `testCandidate` call and check elapsed wall-clock time, stop when either the iteration cap or time limit (default 5s) is reached, return best so far
- [x] 2.5 Add progress reporting: print start message (original size) and completion message (final size, executions used) to stderr
- [x] 2.6 Write unit tests for minimization logic using a mock `testCandidate` callback (deterministic, no real target execution)

## 3. Fuzz Loop Integration

- [x] 3.1 Create a `testCandidate` wrapper that calls `Watchdog.runTarget()` and returns true if `exitKind=1`
- [x] 3.2 Integrate into `loop.ts`: after `IterationResult.Solution` with `ExitKind.Crash`, call `minimize()` with the wrapper before `writeCrashArtifact()`
- [x] 3.3 Skip minimization for `ExitKind.Timeout` — write the original input directly
- [x] 3.4 Write integration test: fuzz target that crashes on inputs containing a specific byte pattern, verify the artifact is smaller than the original mutated input

## 4. Configuration

- [x] 4.1 Add `minimizeBudget` (iteration cap, default 10,000) and `minimizeTimeLimitMs` (wall-clock limit, default 5s) to `FuzzOptions` interface in `config.ts`
- [x] 4.2 Wire both options through CLI flag parsing and plugin options
