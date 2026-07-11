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
- **Vitest:** `spawn(process.execPath, [vitestCliPath, "run", testFile, "--test-name-pattern", pattern, "--pool=forks", "--config", configPath], { env: { VITIATE_SUPERVISOR: "1", VITIATE_FUZZ: "1" } })` where `configPath` is the resolved config file path captured by the plugin's `configResolved` hook. When the config file path is available, the child SHALL always receive the `--config` flag. When the config file path is `undefined` (no config file used), the `--config` flag SHALL be omitted.

The child vitest SHALL be pinned to the forks pool (via `--pool=forks` in the Vitest spawn, or `pool: "forks"` in the CLI child mode's programmatic vitest config) so the fuzz loop always runs in a forked pool worker process regardless of the user's configured pool. This keeps the process topology the supervisor's recovery protocol assumes deterministic and matches the pool used for replay by the `reproduce` subcommand.

Everything else - wait loop, exit code interpretation, shmem read, artifact write, respawn logic, SIGINT handling - SHALL be shared.

#### Scenario: CLI uses shared supervisor

- **WHEN** the CLI entry point detects it is not running as a child (no `VITIATE_SUPERVISOR`)
- **THEN** it calls `runSupervisor()` with a `spawnChild` that re-executes itself
- **AND** the supervisor wait loop, crash handling, and exit protocol are identical to the shared implementation

#### Scenario: Vitest fuzz callback uses shared supervisor

- **WHEN** `fuzz("parse", target)` enters parent mode
- **THEN** it calls `runSupervisor()` with a `spawnChild` that spawns a filtered Vitest child
- **AND** the supervisor wait loop, crash handling, and exit protocol are identical to the shared implementation

#### Scenario: Vitest child receives parent's config file

- **WHEN** `fuzz("parse", target)` enters parent mode
- **AND** the plugin's `configResolved` hook captured a config file path of `/project/vitest.config.ts`
- **THEN** the `spawnChild` callback includes `"--config", "/project/vitest.config.ts"` in the child's argv
- **AND** the child vitest process uses the same config as the parent

#### Scenario: Vitest child without config file

- **WHEN** `fuzz("parse", target)` enters parent mode
- **AND** the plugin's `configResolved` hook captured `undefined` (no config file)
- **THEN** the `spawnChild` callback does NOT include `--config` in the child's argv
- **AND** the child vitest process uses default config resolution

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

### Requirement: Abrupt worker-death detection via shmem stash

The direct child the supervisor waits on is a vitest orchestrator; the fuzz loop, watchdog, and native engine run in the orchestrator's forks-pool worker one process level below. The orchestrator absorbs the worker's death - signal, watchdog `_exit`, or SIGKILL - and reports plain exit code 1, so those events are not observable through the direct child's exit status. The supervisor SHALL therefore detect abrupt worker deaths through the shmem stash:

1. Every input is stashed to shmem before execution (shared-memory-stash capability), and the child SHALL clear the stash on orderly shutdown (the fuzz loop's finally block). A stash that survives the child's exit is a death certificate: the worker died mid-execution.
2. When the child exits with code 1 and the stash contains a valid input, the supervisor SHALL classify the death via new artifacts: if all new artifacts are `timeout-*` (the watchdog writes its timeout artifact before `_exit`), the finding is a hard timeout; otherwise it is a crash.
3. The supervisor SHALL then recover the input, write the artifact, reset the generation counter, and respawn - identically to a directly-observed signal death or watchdog `_exit`.
4. When the child exits with code 1 and the stash is empty, the exit is an in-band finding or an infrastructure failure and SHALL be handled by the existing exit-code-1 protocol.

A worker-level OOM SIGKILL is indistinguishable from a native crash through the orchestrator; it classifies as a crash with the input preserved in the crashes bucket. The `ooms/` diagnosis applies only when the direct child itself is SIGKILLed.

#### Scenario: Absorbed native crash recovered via stash

- **WHEN** the pool worker dies from SIGSEGV mid-execution and the orchestrator exits with code 1
- **AND** the shmem stash still contains the in-flight input
- **THEN** the supervisor writes a crash artifact from the stash
- **AND** resets the generation counter and respawns the child to continue the campaign

#### Scenario: Absorbed hard watchdog timeout recovered via stash

- **WHEN** the watchdog `_exit(77)`s the pool worker after writing a `timeout-*` artifact and the orchestrator exits with code 1
- **AND** the shmem stash still contains the in-flight input
- **THEN** the supervisor classifies the finding as a timeout (new artifacts are all `timeout-*`)
- **AND** recovers the input, resets the generation counter, and respawns; on respawn exhaustion the final exit code is the timeout code (default 70)

#### Scenario: Orderly exit clears the stash

- **WHEN** the fuzz loop completes its campaign (clean completion or in-band findings) and reaches its finally block
- **THEN** the engine's shutdown clears the shmem stash generation
- **AND** the supervisor's subsequent exit-code-1 handling takes the in-band path (no stash-based recovery)

### Requirement: Native crash detection

On Unix, the parent SHALL detect native crashes of its direct child by checking `WIFSIGNALED(status)` after `waitpid` returns. The signal number SHALL be read from `WTERMSIG(status)`. No signal handlers SHALL be installed in the child process on Unix. Native crashes of the orchestrator's pool worker do not surface as direct-child signals and SHALL be detected via the shmem stash (see the abrupt worker-death requirement).

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
| Code 1, surviving shmem stash | Absorbed abrupt worker death (native crash, or hard timeout when new artifacts are all `timeout-*`) | Read shmem, write artifact, reset generation, respawn (see abrupt worker-death requirement) |
| Code 1, empty stash | JS crash found, artifact written by child | Terminate; final exit code is the crash code (`-error_exitcode`, default 77), or the timeout code (`-timeout_exitcode`, default 70) when the new artifact is a `timeout-*` |
| Code 77 | Watchdog `_exit` (timeout), artifact written by watchdog | Read shmem (backup recovery), reset generation, respawn; on respawn exhaustion the final exit code is the timeout code (default 70) |
| Killed by signal (Unix) / exception exit code (Windows) | Native crash | Read shmem, write artifact, reset generation, respawn |

The parent follows libFuzzer's exit-code conventions: a crash maps to `error_exitcode` (default 77) and a timeout to `timeout_exitcode` (default 70), both overridable via CLI flags; an OOM/SIGKILL maps to 137 and an engine panic to 78. These are the parent's final process codes and are distinct from the internal child exit codes above (which the parent translates).

#### Scenario: Exit code 0 forwarded

- **WHEN** the child exits with code 0
- **THEN** the parent exits with code 0

#### Scenario: Exit code 1 maps to the crash exit code

- **WHEN** the child exits with code 1 having written a `crash-*` artifact
- **THEN** the parent exits with the crash code (`-error_exitcode`, default 77)

#### Scenario: A timeout maps to the timeout exit code

- **WHEN** the child exits with code 1 having written only `timeout-*` artifacts (a soft timeout)
- **THEN** the parent exits with the timeout code (`-timeout_exitcode`, default 70)

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
