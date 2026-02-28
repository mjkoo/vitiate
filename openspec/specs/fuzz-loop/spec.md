## ADDED Requirements

### Requirement: Core fuzzing iteration cycle

The fuzz loop SHALL implement the following cycle for each iteration:

1. Call `fuzzer.getNextInput()` to get a mutated input.
2. Call the target function with the input buffer.
3. Determine `ExitKind`: `Ok` if the target returns normally, `Crash` if it throws, `Timeout` if per-execution timeout is exceeded.
4. Call `fuzzer.reportResult(exitKind)` which reads coverage, updates corpus, zeroes the map, and drains CmpLog.

The loop SHALL terminate when any of these conditions is met:

- A crash or timeout is detected (solution found).
- The time limit (`fuzzTime`) is reached.
- The iteration limit (`runs`) is reached.
- The process receives SIGINT.

#### Scenario: Normal iteration

- **WHEN** the target executes without throwing
- **THEN** `reportResult(ExitKind.Ok)` is called
- **AND** the loop continues to the next iteration

#### Scenario: Target throws

- **WHEN** the target throws an error during execution
- **THEN** `reportResult(ExitKind.Crash)` is called
- **AND** the error and input are captured for crash artifact writing

#### Scenario: Time limit reached

- **WHEN** the elapsed time exceeds the configured `fuzzTime`
- **THEN** the loop terminates and the test passes (no crash found)

#### Scenario: Iteration limit reached

- **WHEN** the iteration count reaches the configured `runs` limit
- **THEN** the loop terminates and the test passes (no crash found)

### Requirement: Seed loading

Before the fuzz loop begins, the system SHALL load all available seed inputs and add them to the fuzzer via `addSeed()`:

1. Read all files from the seed corpus directory (`testdata/fuzz/{testName}/`).
2. Read all files from the cached corpus directory (`.vitiate-corpus/{testName}/`).
3. Add each file's contents as a seed via `fuzzer.addSeed()`.

If no seeds are available, the fuzzer's auto-seed mechanism provides default starting inputs.

#### Scenario: Seeds from corpus directories

- **WHEN** the seed corpus contains 3 files and the cached corpus contains 5 files
- **THEN** 8 seeds are added to the fuzzer before the loop begins

#### Scenario: No seeds available

- **WHEN** neither corpus directory exists
- **THEN** the fuzzer auto-seeds with its default set and the loop begins normally

### Requirement: Async target support

The fuzz loop SHALL support async target functions. If the target returns a Promise, the loop SHALL await it before calling `reportResult()`.

#### Scenario: Async target completes normally

- **WHEN** the target returns a Promise that resolves
- **THEN** `reportResult(ExitKind.Ok)` is called after resolution

#### Scenario: Async target rejects

- **WHEN** the target returns a Promise that rejects
- **THEN** `reportResult(ExitKind.Crash)` is called with the rejection reason captured

### Requirement: Periodic event loop yield

The fuzz loop SHALL yield to the event loop periodically to prevent starvation. The yield SHALL occur every N iterations (default 1000) using `setImmediate` wrapped in a Promise.

#### Scenario: Event loop not starved

- **WHEN** the fuzz loop runs for 10000 iterations
- **THEN** `setImmediate` is called at least 9 times (every 1000 iterations)
- **AND** other pending microtasks and I/O callbacks have an opportunity to execute

### Requirement: Interesting input persistence

When `reportResult()` returns `Interesting`, the system SHALL write the input to the cached corpus directory so it persists across fuzzing sessions.

#### Scenario: Interesting input saved

- **WHEN** `reportResult()` returns `Interesting`
- **THEN** the input buffer is written to `.vitiate-corpus/{testName}/{hash}`
- **AND** subsequent fuzzing sessions can load it as a seed
