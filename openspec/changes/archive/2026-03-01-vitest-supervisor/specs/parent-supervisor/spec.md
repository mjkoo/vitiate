## MODIFIED Requirements

### Requirement: Shared supervisor module

The supervisor wait loop, crash handling, shmem management, and exit code protocol SHALL be extracted into a shared module (`supervisor.ts`) reusable from both the CLI entry point and the `fuzz()` test callback. The shared module SHALL export a function with this interface:

```typescript
interface SupervisorOptions {
  shmem: ShmemHandle;
  testDir: string;
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

Everything else — wait loop, exit code interpretation, shmem read, artifact write, respawn logic, SIGINT handling — SHALL be shared.

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
