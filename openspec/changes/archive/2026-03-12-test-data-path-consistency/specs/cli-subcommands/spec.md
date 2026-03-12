## ADDED Requirements

### Requirement: Subcommand dispatch

The CLI entry point (`npx vitiate`) SHALL accept a subcommand as the first positional argument. The system SHALL check `process.argv[2]` against known subcommand names before any argument parsing. Known subcommands: `init`, `fuzz`, `regression`, `optimize`, `libfuzzer`.

If no subcommand is provided or the argument does not match a known subcommand, the CLI SHALL print a usage summary listing all available subcommands and exit with code 0.

#### Scenario: Known subcommand dispatched

- **WHEN** `npx vitiate fuzz .fuzz.ts` is executed
- **THEN** the `fuzz` subcommand handler SHALL be invoked with the remaining arguments

#### Scenario: No subcommand shows help

- **WHEN** `npx vitiate` is executed with no arguments
- **THEN** a usage summary SHALL be printed listing all subcommands with brief descriptions
- **AND** the process SHALL exit with code 0

#### Scenario: Unknown subcommand shows help

- **WHEN** `npx vitiate unknown-command` is executed
- **THEN** a usage summary SHALL be printed listing all subcommands
- **AND** the process SHALL exit with code 1

### Requirement: fuzz subcommand

The `vitiate fuzz` subcommand SHALL set `VITIATE_FUZZ=1` in the environment, then spawn `vitest run` with `.fuzz.ts` as a positional filter followed by the remaining arguments. All arguments after `fuzz` SHALL be forwarded verbatim to vitest.

The subcommand SHALL spawn vitest with inherited stdio and forward the exit code.

#### Scenario: Basic fuzz invocation

- **WHEN** `npx vitiate fuzz` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned with `VITIATE_FUZZ=1`
- **AND** the exit code from vitest SHALL be forwarded

#### Scenario: Fuzz with vitest arguments

- **WHEN** `npx vitiate fuzz --reporter verbose --bail 1` is executed
- **THEN** `vitest run .fuzz.ts --reporter verbose --bail 1` SHALL be spawned with `VITIATE_FUZZ=1`

#### Scenario: Fuzz with test name filter

- **WHEN** `npx vitiate fuzz --test-name-pattern 'parses URLs'` is executed
- **THEN** the vitest `--test-name-pattern` flag SHALL be forwarded, filtering within `*.fuzz.ts` files

### Requirement: regression subcommand

The `vitiate regression` subcommand SHALL spawn `vitest run` with `.fuzz.ts` as a positional filter followed by the remaining arguments. No special environment variables SHALL be set (regression is vitest's default mode for fuzz tests).

All arguments after `regression` SHALL be forwarded verbatim to vitest.

#### Scenario: Basic regression invocation

- **WHEN** `npx vitiate regression` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned
- **AND** no `VITIATE_FUZZ` or `VITIATE_OPTIMIZE` environment variable SHALL be set

#### Scenario: Regression with vitest arguments

- **WHEN** `npx vitiate regression --reporter dot` is executed
- **THEN** `vitest run .fuzz.ts --reporter dot` SHALL be spawned

### Requirement: optimize subcommand

The `vitiate optimize` subcommand SHALL set `VITIATE_OPTIMIZE=1` in the environment, then spawn `vitest run` with `.fuzz.ts` as a positional filter followed by the remaining arguments. All arguments after `optimize` SHALL be forwarded verbatim to vitest.

#### Scenario: Basic optimize invocation

- **WHEN** `npx vitiate optimize` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned with `VITIATE_OPTIMIZE=1`

### Requirement: libfuzzer subcommand

The `vitiate libfuzzer` subcommand SHALL provide all current standalone CLI functionality. The argument parsing, parent/child supervisor model, shmem management, libFuzzer-compatible flags, merge mode, and all other existing CLI behavior SHALL be preserved unchanged under this subcommand.

Arguments after `libfuzzer` SHALL be parsed using the existing `@optique`-based parser with all current flags (`-max_len`, `-timeout`, `-runs`, `-seed`, `-max_total_time`, `-test`, `-artifact_prefix`, `-dict`, `-detectors`, `-fork`, `-jobs`, `-merge`, etc.).

#### Scenario: libfuzzer mode invocation

- **WHEN** `npx vitiate libfuzzer ./test.fuzz.ts -max_total_time=60` is executed
- **THEN** the existing CLI behavior SHALL execute (parent spawns child, supervisor loop, shmem)
- **AND** all libFuzzer-compatible flags SHALL be parsed and applied

#### Scenario: libfuzzer merge mode

- **WHEN** `npx vitiate libfuzzer ./test.fuzz.ts -merge=1 ./corpus/` is executed
- **THEN** corpus merge mode SHALL execute using the existing merge implementation

#### Scenario: OSS-Fuzz compatibility

- **WHEN** an OSS-Fuzz build script invokes `npx vitiate libfuzzer ./target.fuzz.ts ./corpus/ -max_total_time=600`
- **THEN** the fuzzer SHALL behave identically to the current `npx vitiate` invocation

### Requirement: Vitest wrapper execution

The `fuzz`, `regression`, and `optimize` subcommands SHALL resolve the `vitest` CLI entry point and spawn it as a child process. The resolution SHALL use the same mechanism as the current codebase (`resolveVitestCli()` or equivalent).

The spawn SHALL:

1. Use `process.execPath` (the current Node.js binary) as the executable.
2. Pass the resolved vitest CLI path as the first argument, followed by `run`, then `.fuzz.ts` as a positional filter, then any forwarded arguments.
3. Inherit stdio (`stdio: 'inherit'`).
4. Forward the child's exit code as the process exit code.

#### Scenario: Vitest resolution

- **WHEN** any vitest wrapper subcommand is executed
- **THEN** the vitest CLI entry point SHALL be resolved from the project's dependencies
- **AND** the resolved path SHALL be used to spawn vitest

#### Scenario: Exit code forwarding

- **WHEN** vitest exits with code 1 (test failure)
- **THEN** the vitiate process SHALL also exit with code 1

#### Scenario: Stdio inheritance

- **WHEN** a vitest wrapper subcommand runs
- **THEN** vitest's stdout, stderr, and stdin SHALL be inherited from the parent process
