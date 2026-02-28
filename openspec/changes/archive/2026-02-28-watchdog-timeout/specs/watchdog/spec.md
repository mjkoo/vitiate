## ADDED Requirements

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

### Requirement: V8 TerminateExecution as primary timeout (Unix)

On Unix platforms (Linux, macOS), when the armed deadline expires, the watchdog SHALL call `v8::Isolate::TerminateExecution()` via the C++ shim. This interrupts JavaScript execution at the next V8 safe point and produces a catchable exception.

The C++ shim SHALL be compiled only on Unix targets (`cfg(unix)`). It SHALL use forward declarations of `v8::Isolate` with no dependency on V8 headers. The shim SHALL expose three C functions: `vitiate_v8_init() -> i32` (cache isolate, return 1 on success), `vitiate_v8_terminate() -> i32`, and `vitiate_v8_cancel_terminate() -> i32`.

#### Scenario: Synchronous target exceeds timeout on Unix

- **WHEN** a synchronous fuzz target blocks for longer than the armed timeout on Linux or macOS
- **THEN** the watchdog calls `TerminateExecution()`
- **AND** V8 throws a termination exception at the next safe point
- **AND** the fuzz loop catches the exception and reports `ExitKind.Timeout`
- **AND** the process survives and the fuzz loop continues with the next input

#### Scenario: Async target exceeds timeout on Unix

- **WHEN** an async fuzz target's promise does not resolve within the armed timeout on Linux or macOS
- **THEN** the watchdog calls `TerminateExecution()`
- **AND** the pending JavaScript execution is interrupted
- **AND** the fuzz loop reports `ExitKind.Timeout` and continues

#### Scenario: V8 shim unavailable at runtime

- **WHEN** `vitiate_v8_init()` returns 0 (isolate pointer is null)
- **THEN** the watchdog falls back to `_exit`-only mode
- **AND** a diagnostic message is logged

### Requirement: `_exit` fallback with input capture

When `TerminateExecution` is unavailable (Windows) or ineffective (native code hang on Unix), the watchdog SHALL call `_exit()` to terminate the process. Before exiting, the watchdog SHALL write the current input to disk as a timeout artifact.

On Unix, the `_exit` deadline SHALL be 5x the configured timeout (giving TerminateExecution ample time to handle JS hangs). On Windows, the `_exit` deadline SHALL equal the configured timeout (since it is the primary mechanism).

#### Scenario: Timeout on Windows

- **WHEN** a synchronous fuzz target blocks for longer than the armed timeout on Windows
- **THEN** the watchdog writes the current input to `testdata/fuzz/{testName}/timeout-{hash}`
- **AND** the watchdog calls `_exit()` to terminate the process

#### Scenario: Native code hang on Unix

- **WHEN** a fuzz target hangs in native addon code that does not return to V8 within 5x the timeout
- **THEN** the watchdog writes the current input to `testdata/fuzz/{testName}/timeout-{hash}`
- **AND** the watchdog calls `_exit()` to terminate the process

#### Scenario: Input capture before exit

- **WHEN** the watchdog decides to call `_exit()`
- **THEN** it reads the current input from the pre-stash buffer
- **AND** writes it to disk with `fsync` before calling `_exit()`
- **AND** the timeout artifact is recoverable after process termination

### Requirement: Input pre-stash

The `Watchdog` SHALL maintain a pre-allocated input stash buffer accessible to both the main thread (writer) and the watchdog thread (reader). Before each fuzz iteration, the fuzz loop SHALL call a method to copy the current input into the stash. The stash SHALL use atomic operations for the generation counter and length so the watchdog can read a consistent snapshot without blocking the main thread.

#### Scenario: Input stashed before execution

- **WHEN** the fuzz loop calls `stashInput(input)` before executing the target
- **THEN** the input bytes and length are copied to the shared stash buffer
- **AND** the generation counter is incremented atomically

#### Scenario: Watchdog reads stashed input

- **WHEN** the watchdog needs to write a timeout artifact (during `_exit` path)
- **THEN** it reads the input length and bytes from the stash buffer
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
