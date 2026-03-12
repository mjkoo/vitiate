## MODIFIED Requirements

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

- **WHEN** `npx vitiate libfuzzer ./test.ts -artifact_prefix=./findings/` is executed
- **AND** the target crashes
- **THEN** the crash artifact is written to `./findings/crash-{hash}`

#### Scenario: Artifact prefix without trailing slash

- **WHEN** `npx vitiate libfuzzer ./test.ts -artifact_prefix=bug-` is executed
- **AND** the target crashes
- **THEN** the crash artifact is written to `bug-crash-{hash}` in the current directory

#### Scenario: Default artifact location (no prefix)

- **WHEN** `npx vitiate libfuzzer ./test.ts` is executed without `-artifact_prefix`
- **AND** the target crashes
- **THEN** the crash artifact is written to `./crash-{hash}` in the current working directory

#### Scenario: Timeout artifact with prefix

- **WHEN** `npx vitiate libfuzzer ./test.ts -artifact_prefix=./out/ -timeout=5` is executed
- **AND** the target times out
- **THEN** the timeout artifact is written to `./out/timeout-{hash}`

#### Scenario: Native crash with artifact prefix

- **WHEN** `npx vitiate libfuzzer ./test.ts -artifact_prefix=./out/` is executed
- **AND** the child process is killed by SIGSEGV
- **THEN** the parent supervisor writes the crash artifact to `./out/crash-{hash}`
