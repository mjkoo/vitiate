## MODIFIED Requirements

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
- **Vitest:** `spawn(process.execPath, [vitestCliPath, "run", testFile, "--test-name-pattern", pattern, "--config", configPath], { env: { VITIATE_SUPERVISOR: "1", VITIATE_FUZZ: "1" } })` where `configPath` is the resolved config file path captured by the plugin's `configResolved` hook. When the config file path is available, the child SHALL always receive the `--config` flag. When the config file path is `undefined` (no config file used), the `--config` flag SHALL be omitted.

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
