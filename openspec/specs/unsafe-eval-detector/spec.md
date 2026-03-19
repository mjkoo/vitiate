## Purpose

Bug detector that hooks `eval()`, the `Function` constructor, and string-argument `setTimeout`/`setInterval` to detect fuzz input reaching code evaluation during fuzzing.

## Requirements

### Requirement: Unsafe eval detection via goal string

The unsafe eval detector SHALL hook `eval()` and the `Function` constructor on `globalThis` and check whether the code argument contains a detector-specific goal string. If the goal string is found, the detector SHALL throw a `VulnerabilityError` immediately (during target execution).

The detector SHALL have `name: "unsafe-eval"` and `tier: 1`.

The goal string SHALL be `"vitiate_eval_inject"`.

The detector SHALL hook the following in `setup()`:

- `globalThis.eval`: Replace with a wrapper that checks the first argument for the goal string before calling the original `eval`. The goal-string check SHALL only run when the first argument satisfies `typeof arg === "string"` - non-string arguments SHALL pass through to the original `eval` without checking.
- `globalThis.Function`: Replace the `Function` constructor with a wrapper that checks all string arguments (which form the function body and parameter list) for the goal string before calling the original constructor. The wrapper SHALL intercept both `new Function(...)` and `Function(...)` calling conventions (both produce the same result in JavaScript). The wrapper SHALL use `Reflect.construct(OriginalFunction, args, new.target || OriginalFunction)` to correctly handle both calling conventions and preserve prototype chain behavior.
- `Function.prototype.constructor`: Patch to point to the `Function` wrapper so that `(function(){}).constructor("code")` and `({}).constructor.constructor("code")` go through the goal-string check. The original `.constructor` value SHALL be saved and restored on teardown.
- `globalThis.setTimeout` and `globalThis.setInterval`: Replace with wrappers that check the first argument for the goal string when it is a string. Both APIs accept a string first argument that is `eval`'d, making them equivalent to `eval()` for code injection. Non-string first arguments (callback functions) SHALL pass through without checking.

Each wrapper SHALL check `isDetectorActive()` and pass through without checking when the iteration window is inactive.

Each wrapper SHALL use the module-hook stash helper (`stashAndRethrow`) when throwing a `VulnerabilityError`, so that findings swallowed by target try/catch are recoverable by `DetectorManager.endIteration()`.

`teardown()` SHALL restore the original `globalThis.eval`, `globalThis.Function`, `Function.prototype.constructor`, `globalThis.setTimeout`, and `globalThis.setInterval`.

**Known limitations:**

- **Indirect eval:** Expressions like `(0, eval)("code")` or `var e = eval; e("code")` may bypass the `globalThis.eval` wrapper in some engines because indirect eval resolves the original `eval` reference at call time. The goal-string approach still provides coverage - if fuzz input reaches any eval path containing the goal string, the finding is meaningful regardless of the call convention.

#### Scenario: Detect goal string in eval argument

- **WHEN** the fuzz target calls `eval("console.log('vitiate_eval_inject')")`
- **THEN** the detector SHALL throw a `VulnerabilityError` before the code is evaluated
- **AND** the error's `vulnerabilityType` SHALL be `"Unsafe Eval"`
- **AND** the error's `context` SHALL include the function name (`"eval"`) and the code string

#### Scenario: Detect goal string in Function constructor body

- **WHEN** the fuzz target calls `new Function("return 'vitiate_eval_inject'")`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the function name (`"Function"`) and the argument that contained the goal string

#### Scenario: Detect goal string in Function constructor parameters

- **WHEN** the fuzz target calls `new Function("vitiate_eval_inject", "return 1")`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the argument that contained the goal string

#### Scenario: No goal string present in eval

- **WHEN** the fuzz target calls `eval("1 + 1")`
- **AND** the code does not contain the goal string
- **THEN** the wrapper SHALL call through to the original `eval`

#### Scenario: Non-string argument to eval passes through

- **WHEN** the fuzz target calls `eval(42)`
- **THEN** the wrapper SHALL call through to the original `eval` without checking for the goal string
- **AND** no `VulnerabilityError` SHALL be thrown

#### Scenario: No goal string present in Function constructor

- **WHEN** the fuzz target calls `new Function("a", "b", "return a + b")`
- **AND** no argument contains the goal string
- **THEN** the wrapper SHALL call through to the original `Function` constructor

#### Scenario: Function called without new keyword

- **WHEN** the fuzz target calls `Function("return 'vitiate_eval_inject'")`  (without `new`)
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the behavior SHALL be identical to the `new Function(...)` case

#### Scenario: Hook inactive outside iteration window

- **WHEN** `eval()`, `new Function()`, `setTimeout(string)`, or `setInterval(string)` is called outside the iteration window
- **THEN** the wrapper SHALL call through to the original without checking for the goal string

#### Scenario: Teardown restores originals

- **WHEN** `teardown()` is called on the unsafe eval detector
- **THEN** `globalThis.eval` SHALL be restored to the original eval function
- **AND** `globalThis.Function` SHALL be restored to the original Function constructor
- **AND** `Function.prototype.constructor` SHALL be restored to its original value
- **AND** `globalThis.setTimeout` and `globalThis.setInterval` SHALL be restored to their originals

### Requirement: Unsafe eval dictionary tokens

The detector's `getTokens()` SHALL return:

- The goal string (`"vitiate_eval_inject"`)
- Code injection metacharacters: `"require("`, `"process.exit"`, `"import("`

#### Scenario: Tokens include goal string and metacharacters

- **WHEN** `getTokens()` is called
- **THEN** the returned array SHALL contain `"vitiate_eval_inject"` and the three code injection metacharacter tokens

### Requirement: Unsafe eval lifecycle hooks are no-ops

The `beforeIteration()`, `afterIteration()`, and `resetIteration()` methods SHALL be no-ops. The detector fires during target execution (inside the hook wrapper), not during post-execution checks.

#### Scenario: No-op lifecycle hooks

- **WHEN** `beforeIteration()` is called on the unsafe eval detector
- **THEN** no state SHALL be captured or modified
- **WHEN** `afterIteration()` is called on the unsafe eval detector
- **THEN** no checks SHALL be performed and no errors SHALL be thrown
