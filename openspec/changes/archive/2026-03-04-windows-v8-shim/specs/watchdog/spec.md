## RENAMED Requirements

### Requirement: V8 TerminateExecution as primary timeout (Unix)
FROM: V8 TerminateExecution as primary timeout (Unix)
TO: V8 TerminateExecution as primary timeout

## MODIFIED Requirements

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

#### Scenario: Timeout with V8 unavailable

- **WHEN** a fuzz target blocks for longer than the armed timeout
- **AND** V8 termination is unavailable (`vitiate_v8_init()` returned 0)
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `testdata/fuzz/{testName}/timeout-{hash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process at 1x the configured timeout

#### Scenario: Native code hang with V8 available

- **WHEN** a fuzz target hangs in native addon code that does not return to V8 within 5x the timeout
- **AND** V8 termination is available but ineffective (native code does not reach a V8 safe point)
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `testdata/fuzz/{testName}/timeout-{hash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process

#### Scenario: Input capture before exit

- **WHEN** the watchdog decides to call `_exit()`
- **THEN** it reads the current input from the shmem region
- **AND** writes it to disk with `fsync` before calling `_exit(77)`
- **AND** the timeout artifact is recoverable after process termination

## ADDED Requirements

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
