## Purpose

The parent supervisor manages the fuzzing child process lifecycle. It provides native crash detection, child respawn after crashes or timeouts, and an exit code protocol for cross-process coordination.

## Requirements

### Requirement: Shared supervisor module

The supervisor wait loop, crash handling, shmem management, and exit code protocol SHALL be extracted into a shared module (`supervisor.ts`) reusable from both the CLI entry point and the `fuzz()` test callback. The shared module SHALL export a function with this interface:

```typescript
interface SupervisorOptions {
  shmem: ShmemHandle;
  relativeTestFilePath: string;
  testName: string;
  spawnChild: () => ChildProcess;
  maxRespawns?: number;
}

interface SupervisorResult {
  crashed: boolean;
  crashArtifactPath?: string;
  signal?: string;
  exitCode?: number;
}

function runSupervisor(options: SupervisorOptions): Promise<SupervisorResult>;
```

The caller provides a `spawnChild` function that encapsulates the entry-point-specific spawning logic:

- **CLI:** `spawn(process.execPath, process.argv.slice(1), { env: { VITIATE_SUPERVISOR: "1" } })`
- **Vitest:** `spawn(process.execPath, [vitestCliPath, "run", testFile, "--test-name-pattern", pattern], { env: { VITIATE_SUPERVISOR: "1", VITIATE_FUZZ: "1" } })`

Everything else - wait loop, exit code interpretation, shmem read, artifact write, respawn logic, SIGINT handling - SHALL be shared.

#### Scenario: CLI uses shared supervisor

- **WHEN** the CLI entry point detects it is not running as a child (no `VITIATE_SUPERVISOR`)
- **THEN** it calls `runSupervisor()` with a `spawnChild` that re-executes itself
- **AND** the supervisor wait loop, crash handling, and exit protocol are identical to the shared implementation

#### Scenario: Vitest fuzz callback uses shared supervisor

- **WHEN** `fuzz("parse", target)` enters parent mode
- **THEN** it calls `runSupervisor()` with a `spawnChild` that spawns a filtered Vitest child
- **AND** the supervisor wait loop, crash handling, and exit protocol are identical to the shared implementation

#### Scenario: Behavioral parity between entry points

- **GIVEN** the same fuzz target crashing on the same input
- **WHEN** run via the CLI supervisor
- **AND** run via the Vitest fuzz callback supervisor
- **THEN** both produce crash artifacts in the same format
- **AND** both use the same exit code protocol
- **AND** both use the same shmem read and respawn logic

### Requirement: Parent process lifecycle

The system SHALL provide a parent process supervisor that manages the fuzzing child process lifecycle. The parent SHALL:

1. Allocate a cross-process shared memory region via the shared-memory-stash capability.
2. Spawn a child process via the caller-provided `spawnChild` function with the shmem identifier passed via the `VITIATE_SUPERVISOR` environment variable.
3. Pipe the child's stdout and stderr to its own stdout and stderr.
4. Enter a platform-specific wait loop (`waitpid` on Unix, `WaitForSingleObject` on Windows).
5. Interpret the child's exit status to determine the outcome (see exit code protocol requirement).

On CLI invocation, `spawnChild` re-executes the same CLI command as a child. On Vitest invocation, `spawnChild` spawns a filtered Vitest process targeting only the active fuzz test.

The parent SHALL add zero overhead to the fuzz loop hot path. It SHALL consume no CPU while the child runs (blocking wait).

#### Scenario: Normal campaign completion

- **WHEN** the child process exits with code 0
- **THEN** `runSupervisor` returns `{ crashed: false, exitCode: 0 }`
- **AND** no crash artifact is written by the parent

#### Scenario: Child finds JS crash

- **WHEN** the child process exits with code 1 (JS crash found)
- **THEN** `runSupervisor` returns `{ crashed: true, exitCode: 1 }`
- **AND** the crash artifact was already written by the child

#### Scenario: Child watchdog timeout

- **WHEN** the child process exits with code 77 (watchdog `_exit`)
- **THEN** the parent attempts backup recovery of the stashed input from shmem (the watchdog may have already written an artifact)
- **AND** the parent resets the shmem generation counter
- **AND** the parent respawns the child to continue the campaign (subject to respawn limit)

### Requirement: Native crash detection

On Unix, the parent SHALL detect native crashes by checking `WIFSIGNALED(status)` after `waitpid` returns. The signal number SHALL be read from `WTERMSIG(status)`. No signal handlers SHALL be installed in the child process on Unix.

On Windows, the parent SHALL detect crashes by checking the child's exit code against known `NTSTATUS` exception codes (e.g., `0xC0000005` for access violation). The child SHALL install a vectored exception handler via `AddVectoredExceptionHandler` that writes crash metadata to shmem before the process terminates.

#### Scenario: Native crash on Unix

- **WHEN** the child process is killed by a signal (SIGSEGV, SIGBUS, SIGABRT, SIGILL, or SIGFPE)
- **THEN** the parent detects the signal death via `WIFSIGNALED(status)`
- **AND** the parent reads the signal number from `WTERMSIG(status)`
- **AND** the parent reads the crashing input from the shmem stash
- **AND** the parent writes a crash artifact using the resolved artifact format
- **AND** the crash artifact metadata includes the signal number

#### Scenario: Native crash on Windows

- **WHEN** the child process crashes with a Windows exception (e.g., `EXCEPTION_ACCESS_VIOLATION`)
- **THEN** the child's vectored exception handler writes crash metadata to shmem
- **AND** the parent detects the abnormal exit code
- **AND** the parent reads the crashing input from the shmem stash
- **AND** the parent writes a crash artifact using the resolved artifact format

#### Scenario: V8 Wasm trap not misidentified as crash

- **WHEN** V8 handles a Wasm out-of-bounds access via its own SIGSEGV/SIGBUS handler
- **THEN** the child process does not die (V8 converts the signal to a catchable exception)
- **AND** the parent's `waitpid` does not return
- **AND** no crash artifact is written by the parent
- **AND** zero false positive crash artifacts are produced

### Requirement: Child respawn after crash or timeout

After detecting a native crash or watchdog timeout, writing the crash/timeout artifact, and logging the event, the parent SHALL respawn the child process to continue the fuzzing campaign. The respawned child SHALL:

1. Attach to the same shmem region.
2. Reload the corpus (including any newly-written crash artifacts).
3. Resume fuzzing from the beginning of the corpus.

The parent SHALL continue the spawn/wait/respawn loop until the child exits normally (code 0 or 1), the parent receives SIGINT, or the respawn limit (`MAX_RESPAWNS`) is reached. The respawn limit SHALL use `>=` semantics: after exactly `MAX_RESPAWNS` respawns the parent exits with code 1.

#### Scenario: Campaign continues after crash

- **WHEN** the child crashes with SIGSEGV
- **THEN** the parent writes the crash artifact
- **AND** the parent spawns a new child process
- **AND** the new child loads the corpus including the crash artifact
- **AND** fuzzing continues

#### Scenario: Multiple crashes in a campaign

- **WHEN** the child crashes, is respawned, and crashes again on a different input
- **THEN** each crash produces a distinct artifact file (different hash)
- **AND** the parent respawns after each crash

#### Scenario: Parent receives SIGINT

- **WHEN** the parent receives SIGINT while the child is running
- **THEN** the parent forwards SIGINT to the child
- **AND** the parent waits for the child to exit
- **AND** the parent exits cleanly

### Requirement: Exit code protocol

The parent SHALL interpret the child's exit status according to this protocol:

| Child exit status | Meaning | Parent action |
|---|---|---|
| Code 0 | Campaign complete (no crash found, or limits reached) | Exit 0 |
| Code 1 | JS crash found, artifact written by child | Exit 1 |
| Code 77 | Watchdog `_exit` (timeout), artifact written by watchdog | Read shmem (backup recovery), reset generation, respawn |
| Killed by signal (Unix) / exception exit code (Windows) | Native crash | Read shmem, write artifact, reset generation, respawn |

#### Scenario: Exit code 0 forwarded

- **WHEN** the child exits with code 0
- **THEN** the parent exits with code 0

#### Scenario: Exit code 1 forwarded

- **WHEN** the child exits with code 1
- **THEN** the parent exits with code 1

#### Scenario: Exit code 77 triggers respawn

- **WHEN** the child exits with code 77
- **THEN** the parent recognizes this as a watchdog timeout
- **AND** the parent reads the stashed input from shmem (backup recovery -- the watchdog may have already written an artifact)
- **AND** the parent resets the shmem generation counter
- **AND** the parent respawns the child (subject to respawn limit)

#### Scenario: Signal death triggers respawn

- **WHEN** the child is killed by SIGSEGV on Unix
- **THEN** the parent reads shmem, writes the crash artifact, and respawns the child

### Requirement: Crash artifact format

The parent SHALL write crash artifacts in the same format as the fuzz loop's existing crash artifact writing. The artifact path depends on whether `artifactPrefix` is set in `SupervisorOptions`:

- **When `artifactPrefix` is set** (CLI mode): The artifact SHALL be written to `{prefix}{kind}-{contentHash}` where `kind` is `"crash"` or `"timeout"` and `contentHash` is the full SHA-256 hex digest of the input data. If the prefix includes a directory component, the parent directory SHALL be created if it does not exist.
- **When `artifactPrefix` is not set** (Vitest mode): The artifact SHALL be written to `<dataDir>/testdata/<hashdir>/crashes/crash-{contentHash}` where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

In both cases, the file contents SHALL be the raw input bytes. The parent SHALL also log the crash to stderr with the signal/exception type and artifact path.

The `SupervisorOptions` SHALL accept `relativeTestFilePath` and `testName` for Vitest-mode artifact path resolution (replacing the previous `testDir` + `testName` pattern).

#### Scenario: Crash artifact written by parent with artifact prefix

- **WHEN** the parent writes a crash artifact after a native crash
- **AND** `artifactPrefix` is set to `./out/`
- **THEN** the artifact file path is `./out/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes

#### Scenario: Crash artifact written by parent without artifact prefix

- **WHEN** the parent writes a crash artifact after a native crash
- **AND** `artifactPrefix` is not set
- **THEN** the artifact file path is `<dataDir>/testdata/<hashdir>/crashes/crash-{contentHash}`
- **AND** the file contains the raw crashing input bytes

#### Scenario: Crash artifact is idempotent

- **WHEN** the same input causes a crash on respawn
- **THEN** the parent writes to the same artifact path (same content hash)
- **AND** the file is overwritten with identical contents (no corruption)

#### Scenario: CLI with default artifact prefix

- **WHEN** the standalone CLI runs without `-artifact_prefix`
- **AND** `artifactPrefix` is set to `./` (CLI default)
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `./crash-{contentHash}`

#### Scenario: CLI with explicit artifact prefix

- **WHEN** the standalone CLI runs with `-artifact_prefix=./findings/`
- **AND** the child is killed by a signal
- **THEN** the parent writes crash artifact to `./findings/crash-{contentHash}`

#### Scenario: Vitest supervisor uses global test data root

- **WHEN** the Vitest `fuzz()` parent mode detects a native crash
- **AND** `artifactPrefix` is not set in `SupervisorOptions`
- **THEN** the parent writes crash artifact to `.vitiate/testdata/<hashdir>/crashes/crash-{contentHash}`
