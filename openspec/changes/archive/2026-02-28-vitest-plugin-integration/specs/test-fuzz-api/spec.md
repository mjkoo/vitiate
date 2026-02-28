## ADDED Requirements

### Requirement: fuzz test registrar function

The system SHALL export a `fuzz(name, target, options?)` function that registers a fuzz test with Vitest. The function SHALL follow the same pattern as Vitest's `bench()` - a top-level test registrar that appears in test output and integrates with Vitest's runner.

Signature:

```ts
fuzz(name: string, target: (data: Buffer) => void | Promise<void>, options?: FuzzOptions)
```

The `FuzzOptions` SHALL support:

- `maxLen` (number, optional): Maximum input length in bytes.
- `timeout` (number, optional): Per-execution timeout in milliseconds.
- `fuzzTime` (number, optional): Total fuzzing time limit in milliseconds.
- `runs` (number, optional): Maximum number of fuzzing iterations.
- `seed` (number, optional): RNG seed for reproducible fuzzing.

#### Scenario: Register a fuzz test

- **WHEN** `fuzz("my parser", (data) => parse(data))` is called in a test file
- **THEN** a test named "my parser" is registered with Vitest's runner

#### Scenario: Async fuzz target

- **WHEN** `fuzz("async target", async (data) => { await process(data) })` is called
- **THEN** the fuzz target is awaited on each execution

### Requirement: Regression mode behavior

In regression mode (no `VITIATE_FUZZ`), the `fuzz()` function SHALL load the corpus for the test and run each entry as a sub-test via Vitest. Each corpus entry produces a separate assertion - if the target throws for any entry, the test fails.

If no corpus directory exists or the directory is empty, the test SHALL run the target once with an empty `Buffer` as a smoke test.

#### Scenario: Replay corpus entries

- **WHEN** `fuzz("parse", target)` runs in regression mode
- **AND** `testdata/fuzz/parse/` contains files `seed1` and `seed2`
- **THEN** `target` is called with the contents of `seed1` and `seed2`
- **AND** both executions are reported in Vitest's test output

#### Scenario: Corpus entry triggers error

- **WHEN** a corpus entry causes the target to throw
- **THEN** the test fails with the error message and the corpus entry filename

#### Scenario: No corpus directory

- **WHEN** `fuzz("new-target", target)` runs in regression mode
- **AND** no `testdata/fuzz/new-target/` directory exists
- **THEN** `target` is called once with an empty Buffer
- **AND** the test passes if the target does not throw

### Requirement: Fuzzing mode behavior

In fuzzing mode (`VITIATE_FUZZ` is set), the `fuzz()` function SHALL enter the LibAFL-driven mutation loop. It SHALL create a `Fuzzer` instance, load seeds, and run the fuzz loop until a termination condition is met.

If `VITIATE_FUZZ` contains a non-`1` value, it SHALL be treated as a regex filter - only fuzz tests whose name matches the pattern SHALL enter the fuzz loop. Non-matching tests SHALL fall back to regression behavior.

#### Scenario: Enter fuzz loop

- **WHEN** `fuzz("parse", target)` runs with `VITIATE_FUZZ=1`
- **THEN** a Fuzzer instance is created with the global coverage map
- **AND** the mutation loop runs until a termination condition is met

#### Scenario: Filter by pattern

- **WHEN** `VITIATE_FUZZ=parse` is set
- **AND** two fuzz tests exist: "parse" and "serialize"
- **THEN** only "parse" enters the fuzz loop
- **AND** "serialize" runs in regression mode

#### Scenario: Crash found during fuzzing

- **WHEN** the target throws during a fuzz iteration
- **THEN** the crash input is written as a crash artifact
- **AND** the test fails with the error message and crash file path

### Requirement: fuzz.skip, fuzz.only, fuzz.todo modifiers

The `fuzz` function SHALL support `.skip`, `.only`, and `.todo` modifiers matching Vitest's `test` modifiers.

#### Scenario: Skip a fuzz test

- **WHEN** `fuzz.skip("disabled", target)` is called
- **THEN** the test is registered but skipped during execution

#### Scenario: Only run specific fuzz test

- **WHEN** `fuzz.only("focused", target)` is called
- **THEN** only this test runs (standard Vitest `.only` behavior)

#### Scenario: Todo fuzz test

- **WHEN** `fuzz.todo("planned")` is called
- **THEN** the test appears as a todo in Vitest output
