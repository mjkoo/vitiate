## Purpose

Bug detector that hooks regex execution methods to attribute regular expression denial-of-service (ReDoS) timeouts to specific patterns and inputs during fuzzing.

## ADDED Requirements

### Requirement: ReDoS detection via regex method timing

The ReDoS detector SHALL wrap regex execution methods on built-in prototypes and measure wall-clock time per call using `performance.now()`. If a single regex operation exceeds a configurable threshold, the detector SHALL throw a `VulnerabilityError` with the regex pattern, the input string, and the elapsed time.

The detector SHALL have `name: "redos"` and `tier: 2`.

The default threshold SHALL be 100 milliseconds.

The detector SHALL wrap the following methods in `setup()` by replacing them on their respective prototypes:

- `RegExp.prototype.exec`
- `RegExp.prototype.test`
- `String.prototype.match`
- `String.prototype.matchAll`
- `String.prototype.replace`
- `String.prototype.replaceAll`
- `String.prototype.search`
- `String.prototype.split`

Each wrapper SHALL:
1. Check the iteration-window flag (`isDetectorActive()`). If inactive, call the original method directly.
2. Record `performance.now()` before calling the original method.
3. Call the original method with the same `this` context and arguments. If the original method throws (e.g., `replaceAll` TypeError for non-global regex), let the exception propagate immediately — steps 4-5 are skipped.
4. Record `performance.now()` after the call returns successfully.
5. If elapsed time exceeds the threshold, throw a `VulnerabilityError`.

`performance.now()` is available globally in all supported Node.js versions (16+).

The wrapper SHALL use the module-hook stash helper (`stashAndRethrow`) when throwing a `VulnerabilityError`, so that findings swallowed by target try/catch are recoverable by `DetectorManager.endIteration()`.

The detector only fires for regex operations that return within the iteration timeout. If V8's `TerminateExecution` fires before the operation completes (watchdog timeout), the iteration is classified as a timeout and the ReDoS detector does not fire — the timing check runs after the original call returns.

The wrappers SHALL be installed by storing the original method reference and replacing the prototype property. `teardown()` SHALL restore the original methods.

#### Scenario: Detect slow regex execution on RegExp.prototype.exec

- **WHEN** the ReDoS detector is enabled with default threshold (100ms)
- **AND** the fuzz target calls a regex `.exec()` that takes longer than 100ms
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `vulnerabilityType` SHALL be `"ReDoS"`
- **AND** the error's `context` SHALL include the regex pattern (`source`), the regex flags, the input string, and the elapsed time in milliseconds

#### Scenario: Detect slow regex execution on String.prototype.match

- **WHEN** the fuzz target calls `someString.match(someRegex)` that takes longer than the threshold
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the regex pattern, the input string, and the elapsed time

#### Scenario: Fast regex execution passes through

- **WHEN** the fuzz target calls `someRegex.exec(someString)` that completes in under 100ms
- **THEN** the wrapper SHALL return the original result
- **AND** no `VulnerabilityError` SHALL be thrown

#### Scenario: Timing wrapper is inactive outside iteration window

- **WHEN** a regex method is called outside the `beforeIteration()`/`endIteration()` window
- **THEN** the wrapper SHALL call the original method directly without timing

#### Scenario: Custom threshold via options

- **WHEN** the ReDoS detector is configured with `{ thresholdMs: 50 }`
- **AND** the fuzz target calls a regex operation that takes 70ms
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Watchdog timeout preempts ReDoS detection

- **WHEN** a regex operation triggers the watchdog timeout before completing
- **THEN** the iteration SHALL be classified as a timeout, not a ReDoS finding
- **AND** the ReDoS timing check SHALL not run (it executes after the original call returns)

#### Scenario: Prototype methods restored on teardown

- **WHEN** `teardown()` is called on the ReDoS detector
- **THEN** all eight prototype methods SHALL be restored to their original values
- **AND** subsequent regex calls SHALL not be timed

### Requirement: ReDoS context extraction

The `VulnerabilityError` context SHALL include sufficient information to identify the vulnerable regex and reproduce the issue:

- `pattern` (string): The regex source (`RegExp.prototype.source`)
- `flags` (string): The regex flags (`RegExp.prototype.flags`)
- `input` (string): The input string that triggered backtracking (truncated to 1024 characters if longer)
- `elapsedMs` (number): The wall-clock time of the regex call in milliseconds
- `method` (string): The method name that was called (e.g., `"exec"`, `"test"`, `"match"`)

For `String.prototype` methods, the regex is extracted from the first argument. If the first argument is a string (not a RegExp), the method is NOT timed — only RegExp arguments trigger timing, since string-to-regex conversion produces simple patterns that cannot cause catastrophic backtracking. If the first argument is `undefined` or missing, the wrapper SHALL call the original method directly without timing (letting the original method handle the error case).

Note: `String.prototype.replaceAll` throws a `TypeError` if the first argument is a `RegExp` without the `g` flag. The wrapper times the call by wrapping the original method invocation; if the original method throws (including this `TypeError`), the exception propagates naturally — the timing check only runs after the original call returns successfully.

#### Scenario: String.prototype.match with string argument is not timed

- **WHEN** the fuzz target calls `"hello".match("world")`
- **THEN** the wrapper SHALL call the original method without timing
- **AND** no `VulnerabilityError` SHALL be thrown regardless of duration

#### Scenario: String.prototype.match with RegExp argument is timed

- **WHEN** the fuzz target calls `someString.match(someRegex)` where `someRegex` is a `RegExp` instance
- **THEN** the wrapper SHALL time the call and check against the threshold

#### Scenario: String.prototype method with undefined argument is not timed

- **WHEN** the fuzz target calls `"hello".match(undefined)` or `"hello".match()` (missing argument)
- **THEN** the wrapper SHALL call the original method without timing
- **AND** no `VulnerabilityError` SHALL be thrown regardless of duration

#### Scenario: replaceAll with non-global regex propagates TypeError

- **WHEN** the fuzz target calls `"hello".replaceAll(/h/, "x")` (regex without `g` flag)
- **THEN** the original method SHALL throw a `TypeError`
- **AND** the wrapper SHALL let the `TypeError` propagate without timing or throwing a `VulnerabilityError`

#### Scenario: Long input is truncated in context

- **WHEN** the detector fires on an input string longer than 1024 characters
- **THEN** the `context.input` SHALL contain the first 1024 characters of the input

### Requirement: ReDoS dictionary tokens

The detector's `getTokens()` SHALL return generic backtracking payloads:

- `"aaaaaaaaaaaaaaaaaaaaaaaaaaaa!"` (28 `a` characters followed by `!`)
- `"a]a]a]a]a]a]a]a]a]a]a]a]a]!"` (character-class-breaking pattern)
- `"\t\t\t\t\t\t\t\t\t\t\t\t\t!"` (13 tabs followed by `!`)
- `"                              !"` (30 spaces followed by `!`)

These tokens provide building blocks for the havoc mutator to construct inputs that trigger catastrophic backtracking in common vulnerable patterns.

#### Scenario: Tokens include backtracking payloads

- **WHEN** `getTokens()` is called
- **THEN** the returned array SHALL contain the four generic backtracking payloads listed above

### Requirement: ReDoS lifecycle hooks are no-ops

The `beforeIteration()`, `afterIteration()`, and `resetIteration()` methods SHALL be no-ops. The detector fires during target execution (inside the timing wrapper), not during post-execution checks.

#### Scenario: No-op lifecycle hooks

- **WHEN** `beforeIteration()` is called on the ReDoS detector
- **THEN** no state SHALL be captured or modified
- **WHEN** `afterIteration()` is called on the ReDoS detector
- **THEN** no checks SHALL be performed and no errors SHALL be thrown
