## MODIFIED Requirements

### Requirement: fuzz test registrar function

`fuzz(name, target, options?)` SHALL register a Vitest test that runs the provided target function as a fuzz test. The function signature SHALL be:

```typescript
fuzz(name: string, target: (data: Buffer) => void | Promise<void>, options?: FuzzOptions)
```

The `FuzzOptions` SHALL support:

- `maxLen` (number, optional): Maximum input length in bytes.
- `timeoutMs` (number, optional): Per-execution timeout in milliseconds.
- `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
- `runs` (number, optional): Maximum number of fuzzing iterations.
- `seed` (number, optional): RNG seed for reproducible fuzzing.
- `detectors` (object, optional): Per-detector enable/disable and configuration. Each field accepts `boolean` or a detector-specific options object. Absent key = tier default (Tier 1 on, Tier 2 off).

#### Scenario: Register a fuzz test with detector configuration

- **WHEN** `fuzz("parser", (data) => parse(data), { detectors: { prototypePollution: true, commandInjection: true } })` is called
- **THEN** a test named "parser" SHALL be registered with Vitest's runner
- **AND** the detector configuration SHALL be passed to the fuzz loop

#### Scenario: Register a fuzz test with detectors disabled

- **WHEN** `fuzz("sheller", (data) => shell(data), { detectors: { commandInjection: false } })` is called
- **THEN** the command injection detector SHALL be disabled for this test
- **AND** other Tier 1 detectors SHALL remain enabled

#### Scenario: Detector options object passed through

- **WHEN** `fuzz("server", (data) => serve(data), { detectors: { pathTraversal: { sandboxRoot: "./uploads" } } })` is called
- **THEN** the path traversal detector SHALL be enabled with `sandboxRoot` set to `"./uploads"`

### Requirement: Multiple crashes found in child mode

When the child-mode fuzz loop finds one or more crashes (including detector findings) before the campaign ends:

- The child's `fuzz()` callback SHALL throw an error.
- The error message SHALL include the total finding count (crashes + detector findings combined).
- The error message SHALL include the artifact directory or first artifact path.

Detector findings (`VulnerabilityError`) SHALL be counted alongside ordinary crashes in the finding total. They produce standard `crash-{hash}` artifacts.

#### Scenario: Mixed crashes and detector findings

- **WHEN** `stopOnCrash` is `false`
- **AND** the fuzz loop finds 2 ordinary crashes and 1 prototype pollution finding
- **THEN** the error message SHALL report "3 crashes found" (detector findings count as crashes)
- **AND** the artifact directory SHALL contain `crash-{hash}` files for all three findings
