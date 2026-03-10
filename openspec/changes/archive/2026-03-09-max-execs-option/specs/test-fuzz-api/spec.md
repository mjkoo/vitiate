## MODIFIED Requirements

### Requirement: fuzz test registrar function

The system SHALL export a `fuzz(name, target, options?)` function that registers a fuzz test with Vitest. The function SHALL follow the same pattern as Vitest's `bench()` - a top-level test registrar that appears in test output and integrates with Vitest's runner.

Signature:

```ts
fuzz(name: string, target: (data: Buffer) => void | Promise<void>, options?: FuzzOptions)
```

The `FuzzOptions` SHALL support:

- `maxLen` (number, optional): Maximum input length in bytes.
- `timeoutMs` (number, optional): Per-execution timeout in milliseconds.
- `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
- `fuzzExecs` (number, optional): Maximum number of fuzzing iterations.
- `seed` (number, optional): RNG seed for reproducible fuzzing.
- `detectors` (object, optional): Per-detector enable/disable and configuration. Each field accepts `boolean` or a detector-specific options object. Absent key = tier default (Tier 1 on, Tier 2 off).

#### Scenario: Register a fuzz test

- **WHEN** `fuzz("my parser", (data) => parse(data))` is called in a test file
- **THEN** a test named "my parser" is registered with Vitest's runner

#### Scenario: Async fuzz target

- **WHEN** `fuzz("async target", async (data) => { await process(data) })` is called
- **THEN** the fuzz target is awaited on each execution
