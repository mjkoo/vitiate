## Purpose

Stack trace normalization, dedup key computation, and crash dedup map/suppression to avoid writing duplicate crash artifacts during fuzzing campaigns.

## Requirements

### Requirement: Stack trace normalization for dedup

The system SHALL provide a `normalizeStackForDedup(stack: string): string | undefined` function that extracts a stable, hashable signature from a V8 `Error.stack` string.

The normalization SHALL:

1. Parse the V8 stack trace format. Recognized frame formats:
   - `at functionName (filePath:line:col)` — named function
   - `at filePath:line:col` — anonymous function (no name before the path)
   - `at Type.method (filePath:line:col)` — method call (preserve `Type.method` as the function name)
   - `at new Constructor (filePath:line:col)` — constructor call (preserve `new Constructor` as the function name)
   - `at Object.<anonymous> (filePath:line:col)` — anonymous in object context (preserve `Object.<anonymous>`)
   - `at async functionName (filePath:line:col)` — async frame (strip `async` prefix, keep function name)
2. Strip line numbers and column numbers from each frame, keeping only `functionName@fileName`.
3. Strip `async` prefixes from frame descriptors (e.g., `at async foo (...)` → function name is `foo`).
4. For `eval` frames (`at eval (eval at fn (filePath:line:col), <anonymous>:line:col)`), use `eval` as the function name and the outer file path as the file name. If the eval frame cannot be parsed, treat it as a regular frame.
5. Take at most the top 5 frames after the first `at` line.
6. Join the normalized frames with newline separators.
7. Return the resulting string, or `undefined` if no parseable frames are found.

Anonymous functions (no function name) SHALL use an empty string for the function name component (producing `@fileName`).

#### Scenario: Standard V8 stack with named functions

- **WHEN** `normalizeStackForDedup` is called with a stack containing `at foo (/path/to/file.js:10:5)` and `at bar (/other/file.js:20:3)`
- **THEN** the result SHALL be `"foo@/path/to/file.js\nbar@/other/file.js"`

#### Scenario: Anonymous function frame

- **WHEN** a stack frame is `at /path/to/file.js:10:5` (no function name)
- **THEN** the normalized frame SHALL be `"@/path/to/file.js"`

#### Scenario: Async frames stripped

- **WHEN** a stack frame is `at async processTicksAndRejections (node:internal/process/task_queues:95:5)`
- **THEN** the `async` prefix SHALL be stripped
- **AND** the frame SHALL be normalized as `"processTicksAndRejections@node:internal/process/task_queues"`

#### Scenario: Top 5 frames limit

- **WHEN** the stack contains 10 parseable frames
- **THEN** only the first 5 frames SHALL be included in the normalized output

#### Scenario: Same bug with different line numbers produces same key

- **WHEN** two stacks differ only in line/column numbers (same function names and file paths)
- **THEN** `normalizeStackForDedup` SHALL return identical strings for both

#### Scenario: Unparseable stack returns undefined

- **WHEN** the stack string contains no lines matching the V8 stack frame format
- **THEN** `normalizeStackForDedup` SHALL return `undefined`

#### Scenario: Error message line is excluded

- **WHEN** the stack string starts with `Error: some message` followed by `at` frames
- **THEN** the error message line SHALL NOT be included in the normalized output

#### Scenario: Method call frame preserves type and method

- **WHEN** a stack frame is `at MyClass.doSomething (/path/to/file.js:10:5)`
- **THEN** the normalized frame SHALL be `"MyClass.doSomething@/path/to/file.js"`

#### Scenario: Constructor call frame preserves new keyword

- **WHEN** a stack frame is `at new MyClass (/path/to/file.js:10:5)`
- **THEN** the normalized frame SHALL be `"new MyClass@/path/to/file.js"`

#### Scenario: Object anonymous frame preserved

- **WHEN** a stack frame is `at Object.<anonymous> (/path/to/file.js:10:5)`
- **THEN** the normalized frame SHALL be `"Object.<anonymous>@/path/to/file.js"`

#### Scenario: Eval frame uses outer file path

- **WHEN** a stack frame is `at eval (eval at myFunc (/path/to/file.js:10:5), <anonymous>:1:1)`
- **THEN** the normalized frame SHALL be `"eval@/path/to/file.js"`

### Requirement: Crash dedup key computation

The system SHALL compute a dedup key for each crash based on the exit kind and error object.

- If the exit kind is `Crash` and the error has a `.stack` property, the dedup key SHALL be the SHA-256 hex digest of the normalized stack string (from `normalizeStackForDedup`).
- If the normalized stack is `undefined` (unparseable), the dedup key SHALL be `undefined` (fail open).
- For all other exit kinds (Timeout) or when no error is available, the dedup key SHALL be `undefined` (fail open).

#### Scenario: JS exception with valid stack produces dedup key

- **WHEN** a crash occurs with `ExitKind.Crash` and the error has a parseable `.stack`
- **THEN** a SHA-256 hex string dedup key SHALL be computed from the normalized stack

#### Scenario: JS exception without stack fails open

- **WHEN** a crash occurs with `ExitKind.Crash` and the error has no `.stack` property
- **THEN** the dedup key SHALL be `undefined`

#### Scenario: Timeout fails open

- **WHEN** a timeout occurs (`ExitKind.Timeout`)
- **THEN** the dedup key SHALL be `undefined` regardless of any error object

### Requirement: Crash dedup map and duplicate suppression

The fuzz loop SHALL maintain a `Map<string, { path: string, size: number }>` of seen crash signatures, keyed by dedup key.

When a crash is detected and a dedup key is computed:

- If the dedup key is `undefined`: the crash SHALL always be saved (fail open).
- If the dedup key is not in the map: the crash SHALL be saved and the key added to the map with the artifact path and input size.
- If the dedup key is already in the map and the new input is smaller: the existing artifact SHALL be replaced atomically via `replaceArtifact` (from corpus-management), and the map entry SHALL be updated with the new path and size returned by `replaceArtifact`.
- If the dedup key is already in the map and the new input is not smaller: the crash SHALL be suppressed (not written to disk) and the `duplicateCrashesSkipped` counter SHALL be incremented.

#### Scenario: First crash with known dedup key is saved

- **WHEN** a crash produces dedup key `"abc123"` for the first time
- **THEN** the crash artifact SHALL be written to disk
- **AND** the dedup map SHALL contain an entry for `"abc123"` with the artifact path and input size

#### Scenario: Duplicate crash with larger input is suppressed

- **WHEN** a crash produces dedup key `"abc123"` that already exists in the map
- **AND** the new input size is >= the existing entry's size
- **THEN** no artifact SHALL be written
- **AND** the `duplicateCrashesSkipped` counter SHALL be incremented

#### Scenario: Duplicate crash with smaller input replaces artifact

- **WHEN** a crash produces dedup key `"abc123"` that already exists in the map
- **AND** the new input size is < the existing entry's size
- **THEN** the existing artifact SHALL be atomically replaced via `replaceArtifact`
- **AND** the map entry SHALL be updated with the new path and size returned by `replaceArtifact`

#### Scenario: Unknown dedup key always saves

- **WHEN** a crash produces an `undefined` dedup key
- **THEN** the crash artifact SHALL always be written to disk
- **AND** the dedup map SHALL NOT be updated

#### Scenario: Dedup map resets on process respawn

- **WHEN** the child process is killed by a native signal and respawned by the supervisor
- **THEN** the new child process SHALL start with an empty dedup map
- **AND** this is acceptable because native crashes are fail-open (dedup key is always `undefined` for supervisor-written artifacts)

### Requirement: FuzzLoopResult includes dedup counter

The `FuzzLoopResult` interface SHALL include a `duplicateCrashesSkipped: number` field that reports the total number of crashes suppressed by dedup during the campaign. This field SHALL be `0` when no duplicates were suppressed.

#### Scenario: FuzzLoopResult reports dedup activity

- **WHEN** the fuzz loop completes after suppressing 5 duplicate crashes
- **THEN** `FuzzLoopResult.duplicateCrashesSkipped` SHALL be `5`

#### Scenario: FuzzLoopResult reports zero when no dedup

- **WHEN** the fuzz loop completes without any duplicate suppression
- **THEN** `FuzzLoopResult.duplicateCrashesSkipped` SHALL be `0`

### Requirement: Duplicate crashes skipped counter

The system SHALL maintain a `duplicateCrashesSkipped` counter that is incremented each time a crash is suppressed by dedup.

This counter SHALL be reported by the progress reporter alongside existing stats so users can observe dedup effectiveness.

#### Scenario: Counter incremented on suppression

- **WHEN** a duplicate crash is suppressed (not written to disk)
- **THEN** the `duplicateCrashesSkipped` counter SHALL be incremented by 1

#### Scenario: Counter reported in progress output

- **WHEN** the progress reporter prints stats
- **AND** `duplicateCrashesSkipped` is greater than 0
- **THEN** the counter value SHALL be included in the output
