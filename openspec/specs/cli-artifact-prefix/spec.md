## Purpose

Controls where crash and timeout artifacts are written in CLI mode via the `-artifact_prefix` flag, matching libFuzzer's artifact output behavior.

## Requirements

### Requirement: Artifact prefix flag

The CLI SHALL accept a `-artifact_prefix=<path>` flag that controls where crash and timeout artifacts are written. The `<path>` value is a prefix string (not a directory) - the artifact filename is appended directly.

When `-artifact_prefix` is set:
- Crash artifacts SHALL be written to `{prefix}crash-{hash}`.
- Timeout artifacts SHALL be written to `{prefix}timeout-{hash}`.
- The prefix MAY include a trailing `/` to target a directory (e.g., `-artifact_prefix=./artifacts/` writes to `./artifacts/crash-{hash}`).

When `-artifact_prefix` is not set in CLI mode:
- Artifacts SHALL be written to the current working directory: `./crash-{hash}` or `./timeout-{hash}`. This matches libFuzzer's default behavior.

The artifact prefix SHALL be passed to both the fuzz loop (for JS-detected crashes/timeouts) and the supervisor (for native crashes and watchdog timeouts).

#### Scenario: Artifact prefix to directory

- **WHEN** `npx vitiate ./test.ts -artifact_prefix=./findings/` is executed
- **AND** the target crashes
- **THEN** the crash artifact is written to `./findings/crash-{hash}`

#### Scenario: Artifact prefix without trailing slash

- **WHEN** `npx vitiate ./test.ts -artifact_prefix=bug-` is executed
- **AND** the target crashes
- **THEN** the crash artifact is written to `bug-crash-{hash}` in the current directory

#### Scenario: Default artifact location (no prefix)

- **WHEN** `npx vitiate ./test.ts` is executed without `-artifact_prefix`
- **AND** the target crashes
- **THEN** the crash artifact is written to `./crash-{hash}` in the current working directory

#### Scenario: Timeout artifact with prefix

- **WHEN** `npx vitiate ./test.ts -artifact_prefix=./out/ -timeout=5` is executed
- **AND** the target times out
- **THEN** the timeout artifact is written to `./out/timeout-{hash}`

#### Scenario: Native crash with artifact prefix

- **WHEN** `npx vitiate ./test.ts -artifact_prefix=./out/` is executed
- **AND** the child process is killed by SIGSEGV
- **THEN** the parent supervisor writes the crash artifact to `./out/crash-{hash}`

### Requirement: Artifact prefix plumbing to child process

When `-artifact_prefix` is provided, the CLI parent SHALL pass the value to the child process via the `artifactPrefix` field in the `VITIATE_CLI_IPC` JSON blob. When `-artifact_prefix` is not provided, the CLI parent SHALL omit `artifactPrefix` from the IPC blob - the child defaults to `./` when `libfuzzerCompat` is true.

The fuzz loop SHALL resolve the artifact prefix as follows, using the `getArtifactPrefix()` and `isLibfuzzerCompat()` helpers from `config.ts`:
1. If `getArtifactPrefix()` returns a value → use it.
2. If `isLibfuzzerCompat()` is true but `getArtifactPrefix()` returns undefined → default to `./`.
3. If neither condition is met → use `testdata/fuzz/{sanitizedName}/` (Vitest behavior).

The artifact prefix SHALL also be passed to the supervisor via `SupervisorOptions.artifactPrefix` for native crash and watchdog timeout artifact writing.

#### Scenario: Child reads artifact prefix from env

- **WHEN** the CLI parent sets `artifactPrefix: "./out/"` in the `VITIATE_CLI_IPC` blob
- **AND** the child process starts and enters the fuzz loop
- **THEN** the fuzz loop writes artifacts to `./out/crash-{hash}` or `./out/timeout-{hash}`

#### Scenario: CLI child defaults to cwd when no prefix flag

- **WHEN** `libfuzzerCompat` is true in the CLI IPC config
- **AND** `artifactPrefix` is not set in the CLI IPC config
- **THEN** the fuzz loop writes artifacts to `./crash-{hash}` or `./timeout-{hash}`

#### Scenario: Vitest mode uses existing paths

- **WHEN** `VITIATE_CLI_IPC` is not set
- **THEN** the fuzz loop writes artifacts to `testdata/fuzz/{sanitizedName}/crash-{hash}` (existing behavior)
