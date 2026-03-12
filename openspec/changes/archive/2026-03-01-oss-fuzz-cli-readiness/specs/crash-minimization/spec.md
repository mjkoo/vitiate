## ADDED Requirements

### Requirement: Crash input minimization

When the fuzz loop detects a crashing input (`IterationResult.Solution` with `ExitKind.Crash`), the system SHALL attempt to minimize the input in-process before writing the crash artifact. Minimization reduces the input to the smallest byte sequence that still triggers the same crash (the target throws an exception).

Minimization SHALL use `Watchdog.runTarget()` to re-execute candidates, enforcing the configured per-execution timeout on every attempt.

If minimization produces a smaller crashing input, the minimized input SHALL be written as the crash artifact. If minimization fails to reduce the input (the target stops crashing on all smaller candidates), the original unminimized input SHALL be written.

Minimization SHALL NOT be attempted for:

- **Timeout artifacts** (`ExitKind.Timeout`). Timeout behavior is timing-dependent and may not reproduce with shorter inputs.
- **Native signal crashes** detected by the supervisor (SIGSEGV, SIGBUS, etc.). The child process is dead; the supervisor writes raw artifacts from shmem without inline minimization, matching libFuzzer fork mode behavior. Post-hoc minimization of native crashes is deferred to a future standalone tool.

#### Scenario: JS exception crash is minimized in-process

- **WHEN** the fuzz loop detects a crash (`IterationResult.Solution` with `ExitKind.Crash`)
- **THEN** the minimizer attempts to shrink the crashing input in-process via `Watchdog.runTarget()`
- **AND** the minimized input is written as the crash artifact

#### Scenario: Minimization fails to reduce input

- **WHEN** the minimizer cannot find a smaller input that still crashes
- **THEN** the original unminimized input is written as the crash artifact

#### Scenario: Timeout artifacts are not minimized

- **WHEN** a timeout is detected (`ExitKind.Timeout`)
- **THEN** the original input is written as the artifact without minimization

#### Scenario: Native signal crashes are not minimized inline

- **WHEN** the parent supervisor detects a child killed by a signal
- **THEN** the supervisor writes the raw input from shmem as the crash artifact without minimization
- **AND** the supervisor respawns the child to continue fuzzing

### Requirement: Two-pass minimization strategy

The minimizer SHALL use a two-pass strategy:

1. **Truncation pass.** Binary search on input length. The minimizer tests progressively shorter prefixes of the input. If a prefix still crashes, it becomes the new candidate and the search continues. This eliminates trailing bytes in O(log n) executions.

2. **Byte deletion pass.** Walk the post-truncation input. For each position, remove one byte and test. If the target still crashes, keep the deletion and continue from the same position (the next byte now occupies the same index). If not, restore the byte and advance to the next position. This removes interior bytes in O(n) executions.

Each pass SHALL immediately adopt any successful reduction as the new candidate for subsequent attempts.

The strategy SHALL be implemented as a function that accepts a `testCandidate` callback, allowing the core logic to be reused by a future standalone minimization tool with a different execution backend.

#### Scenario: Truncation removes trailing bytes

- **WHEN** a 1024-byte input crashes and the first 128 bytes alone also trigger the crash
- **THEN** the truncation pass reduces the candidate to 128 bytes
- **AND** the byte deletion pass operates on the 128-byte candidate

#### Scenario: Byte deletion removes interior bytes

- **WHEN** a 10-byte crashing input has 3 interior bytes that are irrelevant to the crash
- **THEN** the byte deletion pass removes those 3 bytes
- **AND** the final artifact is 7 bytes

#### Scenario: Both passes contribute

- **WHEN** a 2048-byte input has significant trailing and interior bloat
- **THEN** truncation first reduces the length
- **AND** byte deletion further removes unnecessary interior bytes
- **AND** the final artifact is smaller than either pass alone would achieve

### Requirement: Minimization execution budget

The minimizer SHALL enforce two limits, whichever is reached first:

1. **Iteration cap** - maximum number of target re-executions. Default: 10,000.
2. **Wall-clock time limit** - maximum elapsed real time for the entire minimization phase. Default: 5 seconds.

The minimizer SHALL check both limits before each candidate test. When either limit is reached, minimization SHALL stop and write the best (smallest) crashing input found so far.

Both limits SHALL be configurable via `FuzzOptions`.

A limit of 0 means unlimited for that dimension. With iteration cap 0, minimization runs both passes to completion. With time limit 0, only the iteration cap applies (and vice versa). If both are 0, minimization runs to completion uncapped.

#### Scenario: Iteration cap exhausted

- **WHEN** the minimizer exhausts its iteration cap before the time limit
- **THEN** the smallest crashing input found so far is written as the artifact
- **AND** the standard completion message is printed (minimization is best-effort; the completion message is the same regardless of whether budget was exhausted)

#### Scenario: Wall-clock time limit reached

- **WHEN** the minimizer reaches the wall-clock time limit before the iteration cap
- **THEN** the smallest crashing input found so far is written as the artifact
- **AND** the standard completion message is printed (minimization is best-effort; the completion message is the same regardless of whether budget was exhausted)

#### Scenario: Minimization completes within both limits

- **WHEN** both passes complete before either the iteration cap or the time limit is reached
- **THEN** the fully minimized input is written as the artifact

### Requirement: Minimization progress reporting

The minimizer SHALL print progress messages to stderr:

1. When minimization starts: the original input size.
2. When minimization completes: the final minimized size and the number of executions used.

#### Scenario: Progress messages printed

- **WHEN** a 1024-byte crash is minimized to 42 bytes in 350 executions
- **THEN** stderr shows a message indicating minimization started at 1024 bytes
- **AND** stderr shows a message indicating the result is 42 bytes after 350 executions

### Requirement: Crash reproduction check

The minimizer SHALL verify that a candidate input "still crashes" by calling `Watchdog.runTarget()` and checking that the result is `exitKind=1` (exception thrown). An `exitKind=0` (normal return) or `exitKind=2` (timeout) means the candidate does not reproduce the crash.

If the target returns a Promise, the minimizer SHALL await it and check for rejection, using the same timeout enforcement as the fuzz loop.

#### Scenario: Candidate reproduces crash

- **WHEN** a shortened input is tested and the target throws an exception
- **THEN** the candidate is accepted as a valid reduction

#### Scenario: Candidate does not reproduce

- **WHEN** a shortened input is tested and the target returns normally
- **THEN** the candidate is rejected and the previous best candidate is retained

#### Scenario: Candidate times out

- **WHEN** a shortened input is tested and the watchdog fires (timeout)
- **THEN** the candidate is rejected (timeout is not a crash reproduction)
