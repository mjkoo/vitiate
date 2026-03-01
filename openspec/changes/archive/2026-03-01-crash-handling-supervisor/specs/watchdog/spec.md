## MODIFIED Requirements

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

### Requirement: `_exit` fallback with input capture

When `TerminateExecution` is unavailable (Windows) or ineffective (native code hang on Unix), the watchdog SHALL call `_exit()` to terminate the process. Before exiting, the watchdog SHALL read the current input from the shmem region and write it to disk as a timeout artifact.

On Unix, the `_exit` deadline SHALL be 5x the configured timeout (giving TerminateExecution ample time to handle JS hangs). On Windows, the `_exit` deadline SHALL equal the configured timeout (since it is the primary mechanism).

#### Scenario: Timeout on Windows

- **WHEN** a synchronous fuzz target blocks for longer than the armed timeout on Windows
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `testdata/fuzz/{testName}/timeout-{hash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process

#### Scenario: Native code hang on Unix

- **WHEN** a fuzz target hangs in native addon code that does not return to V8 within 5x the timeout
- **THEN** the watchdog reads the current input from the shmem region
- **AND** writes the input to `testdata/fuzz/{testName}/timeout-{hash}`
- **AND** the watchdog calls `_exit(77)` to terminate the process

#### Scenario: Input capture before exit

- **WHEN** the watchdog decides to call `_exit()`
- **THEN** it reads the current input from the shmem region
- **AND** writes it to disk with `fsync` before calling `_exit(77)`
- **AND** the timeout artifact is recoverable after process termination
