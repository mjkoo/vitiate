## MODIFIED Requirements

### Requirement: Artifact prefix plumbing to child process

When `-artifact_prefix` is provided, the CLI parent SHALL pass the value to the child process via the `artifactPrefix` field in the `VITIATE_CLI_IPC` JSON blob. When `-artifact_prefix` is not provided, the CLI parent SHALL omit `artifactPrefix` from the IPC blob - the child defaults to `./` when `libfuzzerCompat` is true.

The fuzz loop SHALL resolve the artifact prefix as follows, using the `getArtifactPrefix()` and `isLibfuzzerCompat()` helpers from `config.ts`:
1. If `getArtifactPrefix()` returns a value, use it.
2. If `isLibfuzzerCompat()` is true but `getArtifactPrefix()` returns undefined, default to `./`.
3. If neither condition is met (Vitest mode), write crash artifacts to `<dataDir>/testdata/<hashdir>/crashes/` and timeout artifacts to `<dataDir>/testdata/<hashdir>/timeouts/`, where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

The artifact prefix SHALL also be passed to the supervisor via `SupervisorOptions.artifactPrefix` for native crash and watchdog timeout artifact writing.

#### Scenario: Child reads artifact prefix from env

- **WHEN** the CLI parent sets `artifactPrefix: "./out/"` in the `VITIATE_CLI_IPC` blob
- **AND** the child process starts and enters the fuzz loop
- **THEN** the fuzz loop writes artifacts to `./out/crash-{hash}` or `./out/timeout-{hash}`

#### Scenario: CLI child defaults to cwd when no prefix flag

- **WHEN** `libfuzzerCompat` is true in the CLI IPC config
- **AND** `artifactPrefix` is not set in the CLI IPC config
- **THEN** the fuzz loop writes artifacts to `./crash-{hash}` or `./timeout-{hash}`

#### Scenario: Vitest mode uses global test data root

- **WHEN** `VITIATE_CLI_IPC` is not set
- **THEN** the fuzz loop writes crash artifacts to `<dataDir>/testdata/<hashdir>/crashes/crash-{hash}`
- **AND** timeout artifacts to `<dataDir>/testdata/<hashdir>/timeouts/timeout-{hash}`
