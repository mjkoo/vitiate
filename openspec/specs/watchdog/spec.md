## Purpose

The watchdog subsystem provides timeout enforcement for fuzz targets. It manages a background Rust thread that can interrupt long-running JavaScript execution via V8's `TerminateExecution` API, with a fallback to `_exit()` for cases where V8 interruption is unavailable or ineffective.

## Requirements

### Requirement: Watchdog thread lifecycle

The system SHALL provide a `Watchdog` NAPI class that manages a background Rust thread for timeout enforcement. The thread SHALL be spawned once at construction and live for the `Watchdog` instance's lifetime. When not armed, the thread SHALL park on a condvar and consume zero CPU.

#### Scenario: Watchdog construction

- **WHEN** a `Watchdog` is constructed
- **THEN** a background thread is spawned
- **AND** the V8 isolate pointer is cached for later use
- **AND** the thread parks immediately (no timeout active)

#### Scenario: Watchdog is garbage collected

- **WHEN** the `Watchdog` instance is dropped
- **THEN** the background thread is signaled to exit and joined
- **AND** no resources are leaked

### Requirement: Arm and disarm

The `Watchdog` SHALL expose `arm(timeoutMs: number)` and `disarm()` methods. `arm` sets a deadline and wakes the watchdog thread. `disarm` clears the deadline. Both operations SHALL complete in under 100 nanoseconds (condvar signal, no syscalls in the hot path beyond futex wake).

#### Scenario: Arm before target execution

- **WHEN** `arm(5000)` is called
- **THEN** the watchdog thread wakes and begins timing the 5000ms deadline
- **AND** the method returns immediately without blocking

#### Scenario: Disarm after normal execution

- **WHEN** `disarm()` is called before the deadline expires
- **THEN** the watchdog thread cancels the pending deadline and parks
- **AND** no termination action is taken

#### Scenario: Disarm after termination fired

- **WHEN** the watchdog fired `TerminateExecution` and `disarm()` is subsequently called
- **THEN** `CancelTerminateExecution()` is called to clear V8's pending termination flag
- **AND** the watchdog thread parks
- **AND** subsequent JavaScript execution proceeds normally

### Requirement: V8 TerminateExecution as primary timeout

On all platforms (Linux, macOS, Windows), when the armed deadline expires and V8 symbols are available, the watchdog SHALL call `v8::Isolate::TerminateExecution()` via the C++ shim. This interrupts JavaScript execution at the next V8 safe point and produces a catchable exception.

The C++ shim SHALL be compiled on all targets. It SHALL use forward declarations of `v8::Isolate` with no dependency on V8 headers. The shim SHALL expose four `extern "C"` functions: `vitiate_v8_init() -> i32` (resolve symbols and cache isolate, return 1 on success), `vitiate_v8_terminate() -> i32`, `vitiate_v8_cancel_terminate() -> i32`, and `vitiate_run_target(env, target, input, fired, out) -> i32` (call the fuzz target, intercept V8 termination exceptions, and return a result struct with `exitKind`). `vitiate_run_target` SHALL return 0 if the shim is not initialized (symbols not resolved), signaling the caller to use the Rust fallback path.

On Unix, V8 and NAPI symbols SHALL be resolved at runtime via `dlsym(RTLD_DEFAULT, ...)` using Itanium ABI mangled names. On Windows, V8 symbols SHALL be resolved via `GetProcAddress(GetModuleHandle(NULL), ...)` using MSVC x64 mangled names, and NAPI symbols SHALL be resolved via `GetProcAddress` using plain C names. If any required symbol cannot be resolved, `vitiate_v8_init()` SHALL return 0 and the watchdog SHALL fall back to `_exit`-only mode.

#### Scenario: Synchronous target exceeds timeout on Unix

- **WHEN** a synchronous fuzz target blocks for longer than the armed timeout on Linux or macOS
- **THEN** the watchdog calls `TerminateExecution()`
- **AND** V8 throws a termination exception at the next safe point
- **AND** the fuzz loop catches the exception and reports `ExitKind.Timeout`
- **AND** the process survives and the fuzz loop continues with the next input

#### Scenario: Synchronous target exceeds timeout on Windows

- **WHEN** a synchronous fuzz target blocks for longer than the armed timeout on Windows
- **AND** V8 symbols were resolved successfully at init
- **THEN** the watchdog calls `TerminateExecution()`
- **AND** V8 throws a termination exception at the next safe point
- **AND** the fuzz loop catches the exception and reports `ExitKind.Timeout`
- **AND** the process survives and the fuzz loop continues with the next input

#### Scenario: Async target exceeds timeout

- **WHEN** an async fuzz target's promise does not resolve within the armed timeout
- **THEN** the watchdog calls `TerminateExecution()`
- **AND** the pending JavaScript execution is interrupted
- **AND** the fuzz loop reports `ExitKind.Timeout` and continues

#### Scenario: V8 shim unavailable at runtime

- **WHEN** `vitiate_v8_init()` returns 0 (symbols not found or isolate pointer is null)
- **THEN** the watchdog falls back to `_exit`-only mode
- **AND** a diagnostic message is logged

#### Scenario: V8 symbols unavailable on Windows

- **WHEN** `GetProcAddress` cannot resolve one or more V8 MSVC-mangled symbols (e.g., custom or embedded Node.js build)
- **THEN** `vitiate_v8_init()` returns 0
- **AND** the watchdog falls back to `_exit`-only mode with no crash or abort

### Requirement: `_exit` fallback with input capture

When `TerminateExecution` is unavailable or ineffective (V8 symbols not found on static Node.js builds, embedded environments, or native code hang that does not return to V8), the watchdog SHALL call `_exit()` to terminate the process. Before exiting, the watchdog SHALL read the current input from the shmem region and write it to disk as a timeout artifact.

When V8 termination is available, the `_exit` deadline SHALL be 5x the configured timeout (giving `TerminateExecution` ample time to propagate through JS frames). When V8 termination is unavailable, the `_exit` deadline SHALL equal the configured timeout (since `_exit` is the primary mechanism). This multiplier SHALL be determined by the result of `vitiate_v8_init()`, not by the target OS.

The `Watchdog` constructor and `installExceptionHandler` SHALL accept an `artifactPrefix` string parameter (replacing the previous `artifactDir` directory parameter). The artifact prefix is a path prefix — not necessarily a directory — and the artifact filename is appended directly to it:

- The timeout artifact path SHALL be `{artifactPrefix}timeout-{contentHash}`.
- The crash artifact path (SEH handler) SHALL be `{artifactPrefix}crash-{contentHash}`.
- If the prefix includes a directory component, the parent directory of the full artifact path SHALL be created recursively before writing.

The artifact prefix passed to the `Watchdog` constructor and `installExceptionHandler` SHALL be determined by the caller based on the active path convention:

- **When `artifactPrefix` is resolved** (CLI mode): Pass the resolved prefix directly (e.g., `./` for default, `./out/` for `-artifact_prefix=./out/`, `bug-` for `-artifact_prefix=bug-`).
- **Otherwise** (Vitest mode): Pass `testdata/fuzz/{sanitizedTestName}/` (trailing slash) so that artifacts are written as `testdata/fuzz/{sanitizedTestName}/timeout-{contentHash}`, preserving existing behavior.

#### Scenario: Timeout with V8 unavailable

- **WHEN** a fuzz target blocks for longer than the armed timeout
- **AND** V8 termination is unavailable (`vitiate_v8_init()` returned 0)
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `{artifactPrefix}timeout-{contentHash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process at 1x the configured timeout

#### Scenario: Native code hang with V8 available

- **WHEN** a fuzz target hangs in native addon code that does not return to V8 within 5x the timeout
- **AND** V8 termination is available but ineffective (native code does not reach a V8 safe point)
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `{artifactPrefix}timeout-{contentHash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process

#### Scenario: Input capture before exit

- **WHEN** the watchdog decides to call `_exit()`
- **THEN** it reads the current input from the shmem region
- **AND** writes it to disk with `fsync` before calling `_exit(77)`
- **AND** the timeout artifact is recoverable after process termination

#### Scenario: Non-directory prefix in watchdog

- **WHEN** the watchdog is constructed with `artifactPrefix` = `bug-`
- **AND** the target times out
- **THEN** the timeout artifact is written to `bug-timeout-{contentHash}` in the current directory

#### Scenario: Directory prefix in watchdog

- **WHEN** the watchdog is constructed with `artifactPrefix` = `./out/`
- **AND** the target times out
- **AND** `./out/` does not exist
- **THEN** `./out/` is created before writing
- **AND** the timeout artifact is written to `./out/timeout-{contentHash}`

#### Scenario: Vitest mode preserves existing behavior

- **WHEN** the watchdog is constructed with `artifactPrefix` = `testdata/fuzz/{sanitizedTestName}/`
- **AND** the target times out
- **THEN** the timeout artifact is written to `testdata/fuzz/{sanitizedTestName}/timeout-{contentHash}`
- **AND** the behavior is identical to the pre-change implementation

#### Scenario: SEH crash with non-directory prefix

- **WHEN** `installExceptionHandler` is called with `artifactPrefix` = `bug-`
- **AND** a native crash occurs on Windows
- **THEN** the crash artifact is written to `bug-crash-{contentHash}` in the current directory

### Requirement: Rust fallback path V8 termination safety

When the C++ shim's `vitiate_run_target` is unavailable (returns 0, indicating the shim is not initialized) and the Rust fallback path handles target execution, the fallback path SHALL read the watchdog's `fired` flag BEFORE calling `disarm()`, and SHALL use the saved value for exit kind classification. When the saved `fired` value is true, the fallback path SHALL call `CancelTerminateExecution()` before making any NAPI calls to build the result object.

This addresses two interacting bugs in the current fallback path:
1. `disarm()` atomically resets `fired` to false before the classification code reads it, causing timeouts to be silently misclassified as crashes.
2. The fallback path does not call `CancelTerminateExecution()` before NAPI calls, so V8's internal termination flag remains set and subsequent NAPI operations may fail.

#### Scenario: Rust fallback handles V8 termination

- **WHEN** the C++ shim's `vitiate_run_target` returns 0 (not initialized)
- **AND** the Rust fallback calls `napi_call_function` which returns `napi_pending_exception`
- **AND** the watchdog's `fired` flag is true (V8 termination was requested)
- **THEN** the fallback path reads `fired` before `disarm()` resets it
- **AND** the fallback path calls `CancelTerminateExecution()` before any subsequent NAPI calls
- **AND** the fallback path calls `disarm()` to stop the watchdog timer
- **AND** the fallback path clears the pending NAPI exception
- **AND** the fallback path returns `exitKind=2` (timeout)

#### Scenario: Rust fallback handles regular crash

- **WHEN** the C++ shim's `vitiate_run_target` returns 0 (not initialized)
- **AND** the Rust fallback calls `napi_call_function` which returns `napi_pending_exception`
- **AND** the watchdog's `fired` flag is false (no timeout)
- **THEN** the fallback path calls `disarm()` to stop the watchdog timer
- **AND** the fallback path clears the pending NAPI exception
- **AND** the fallback path returns `exitKind=1` (crash) with the exception as the error
- **AND** `CancelTerminateExecution()` is NOT called

### Requirement: Input pre-stash

The `Watchdog` SHALL read the current input from the cross-process shmem region (shared-memory-stash capability) instead of from the in-process `InputStash`. The shmem region is written by the fuzz loop before each iteration and is readable by both the watchdog thread (same process) and the parent process (cross-process).

The watchdog SHALL use atomic operations to read `generation` before and after copying the input data, verifying consistency (the fuzz loop did not start writing a new input mid-read).

#### Scenario: Input stashed before execution

- **WHEN** the fuzz loop calls `stashInput(input)` before executing the target
- **THEN** the input bytes and length are copied to the shmem region
- **AND** the generation counter is incremented atomically

#### Scenario: Watchdog reads stashed input from shmem

- **WHEN** the watchdog needs to write a timeout artifact (during `_exit` path)
- **THEN** it reads the input length and bytes from the shmem region
- **AND** the read is consistent (generation counter matches before and after read)

### Requirement: V8 termination exception identity

The fuzz loop MUST be able to distinguish a V8 termination exception (from `TerminateExecution`) from a regular exception thrown by the fuzz target. The watchdog SHALL set an atomic flag when it fires `TerminateExecution`. The fuzz loop SHALL check this flag when classifying caught exceptions to determine `ExitKind.Timeout` vs `ExitKind.Crash`.

#### Scenario: Termination exception classified as timeout

- **WHEN** the watchdog fires `TerminateExecution` and the fuzz loop catches the resulting exception
- **THEN** the exception is classified as `ExitKind.Timeout` (not `ExitKind.Crash`)

#### Scenario: Regular exception not misclassified

- **WHEN** a fuzz target throws a normal `Error` before the watchdog deadline expires
- **THEN** the exception is classified as `ExitKind.Crash`
- **AND** the watchdog's "fired" flag is not set
