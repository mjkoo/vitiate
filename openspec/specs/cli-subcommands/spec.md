# CLI Subcommands

## Purpose

Defines the subcommand-based CLI dispatch for vitiate, providing `init`, `fuzz`, `regression`, `optimize`, and `libfuzzer` subcommands as the primary user interface.

## Requirements

### Requirement: Subcommand dispatch

The CLI entry point (`npx vitiate`) SHALL use `@optique`'s `command()` primitive and `or()` combinator to dispatch subcommands. Known subcommands: `init`, `fuzz`, `regression`, `optimize`, `libfuzzer`. Each subcommand SHALL be registered with a brief description for help text generation.

If no subcommand is provided, the CLI SHALL print an auto-generated usage summary listing all available subcommands with their descriptions and exit with code 0.

If an unknown subcommand is provided, the CLI SHALL print an error message. If the unknown subcommand is similar to a known subcommand, a "Did you mean...?" suggestion SHALL be included. The CLI SHALL exit with code 1.

#### Scenario: Known subcommand dispatched

- **WHEN** `npx vitiate fuzz --fuzz-time 60` is executed
- **THEN** the `fuzz` subcommand handler SHALL be invoked with the remaining arguments

#### Scenario: No subcommand shows help

- **WHEN** `npx vitiate` is executed with no arguments
- **THEN** an auto-generated usage summary SHALL be printed listing all subcommands with brief descriptions
- **AND** the process SHALL exit with code 0

#### Scenario: Unknown subcommand shows error with suggestion

- **WHEN** `npx vitiate fuz` is executed
- **THEN** an error message SHALL be printed indicating `fuz` is not a valid subcommand
- **AND** a "Did you mean...?" suggestion SHALL include `fuzz`
- **AND** the process SHALL exit with code 1

#### Scenario: Unknown subcommand with no close match

- **WHEN** `npx vitiate unknown-command` is executed
- **THEN** an error message SHALL be printed indicating `unknown-command` is not a valid subcommand
- **AND** the process SHALL exit with code 1

#### Scenario: Top-level help flag

- **WHEN** `npx vitiate --help` is executed
- **THEN** the auto-generated usage summary SHALL be printed listing all subcommands
- **AND** the process SHALL exit with code 0

### Requirement: fuzz subcommand

The `vitiate fuzz` subcommand SHALL parse vitiate-specific flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes`, `--detectors`) via an `@optique` parser. Parsed flags SHALL be converted to environment variables on the spawned vitest process (see `subcommand-flags` capability). Unrecognized arguments SHALL be forwarded to vitest via `passThrough()`. Both positional arguments (e.g. test file paths) and unrecognized option-like arguments SHALL be forwarded to vitest. The `--` separator SHALL force all subsequent tokens to be forwarded verbatim, even if they shadow vitiate flags.

The subcommand SHALL set `VITIATE_FUZZ=1` in the environment, then spawn `vitest run` with `.fuzz.ts` prepended to the forwarded arguments.

The subcommand SHALL spawn vitest with inherited stdio and forward the exit code.

#### Scenario: Basic fuzz invocation

- **WHEN** `npx vitiate fuzz` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned with `VITIATE_FUZZ=1`
- **AND** the exit code from vitest SHALL be forwarded

#### Scenario: Fuzz with vitiate flags and vitest arguments

- **WHEN** `npx vitiate fuzz --fuzz-time 60 --reporter verbose --bail 1` is executed
- **THEN** `--fuzz-time 60` SHALL be parsed by vitiate and set as `VITIATE_FUZZ_TIME=60`
- **AND** `vitest run .fuzz.ts --reporter verbose --bail 1` SHALL be spawned

#### Scenario: Fuzz with positional test file

- **WHEN** `npx vitiate fuzz test/specific.fuzz.ts` is executed
- **THEN** `vitest run .fuzz.ts test/specific.fuzz.ts` SHALL be spawned with `VITIATE_FUZZ=1`

#### Scenario: Fuzz with mixed positional and option args

- **WHEN** `npx vitiate fuzz --fuzz-time 60 test/foo.fuzz.ts --reporter verbose` is executed
- **THEN** `VITIATE_FUZZ_TIME=60` SHALL be set in the environment
- **AND** `test/foo.fuzz.ts`, `--reporter`, and `verbose` SHALL be forwarded to vitest
- **AND** `--fuzz-time` SHALL NOT appear in the forwarded arguments

#### Scenario: Fuzz with test name filter

- **WHEN** `npx vitiate fuzz --test-name-pattern 'parses URLs'` is executed
- **THEN** the vitest `--test-name-pattern` flag SHALL be forwarded, filtering within `*.fuzz.ts` files

#### Scenario: Fuzz with -- separator shadowing vitiate flags

- **WHEN** `npx vitiate fuzz --fuzz-time 60 -- --fuzz-time 999 --reporter verbose` is executed
- **THEN** `VITIATE_FUZZ_TIME=60` SHALL be set from the pre-separator flag
- **AND** `--fuzz-time`, `999`, `--reporter`, and `verbose` SHALL all be forwarded verbatim to vitest

### Requirement: regression subcommand

The `vitiate regression` subcommand SHALL parse vitiate-specific flags (`--detectors`) via an `@optique` parser. Unrecognized arguments SHALL be forwarded to vitest via `passThrough()`.

The subcommand SHALL spawn `vitest run` with `.fuzz.ts` prepended to the forwarded arguments. No special environment variables SHALL be set beyond those derived from parsed flags (regression is vitest's default mode for fuzz tests).

Both positional arguments and unrecognized option-like arguments SHALL be forwarded to vitest. The `--` separator SHALL force all subsequent tokens to be forwarded verbatim.

#### Scenario: Basic regression invocation

- **WHEN** `npx vitiate regression` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned
- **AND** no `VITIATE_FUZZ` or `VITIATE_OPTIMIZE` environment variable SHALL be set

#### Scenario: Regression with vitest arguments

- **WHEN** `npx vitiate regression --reporter dot` is executed
- **THEN** `vitest run .fuzz.ts --reporter dot` SHALL be spawned

#### Scenario: Regression with positional test file

- **WHEN** `npx vitiate regression test/specific.fuzz.ts` is executed
- **THEN** `vitest run .fuzz.ts test/specific.fuzz.ts` SHALL be spawned

### Requirement: optimize subcommand

The `vitiate optimize` subcommand SHALL parse vitiate-specific flags (`--detectors`) via an `@optique` parser. Unrecognized arguments SHALL be forwarded to vitest via `passThrough()`.

The subcommand SHALL set `VITIATE_OPTIMIZE=1` in the environment, then spawn `vitest run` with `.fuzz.ts` prepended to the forwarded arguments.

Both positional arguments and unrecognized option-like arguments SHALL be forwarded to vitest. The `--` separator SHALL force all subsequent tokens to be forwarded verbatim.

#### Scenario: Basic optimize invocation

- **WHEN** `npx vitiate optimize` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned with `VITIATE_OPTIMIZE=1`

### Requirement: libfuzzer subcommand

The `vitiate libfuzzer` subcommand SHALL provide all current standalone CLI functionality. The argument parsing, parent/child supervisor model, shmem management, libFuzzer-compatible flags, merge mode, and all other existing CLI behavior SHALL be preserved unchanged under this subcommand.

Arguments after `libfuzzer` SHALL be parsed using the existing `@optique`-based parser with all current flags (`-max_len`, `-timeout`, `-runs`, `-seed`, `-max_total_time`, `-test`, `-artifact_prefix`, `-dict`, `-detectors`, `-fork`, `-jobs`, `-merge`, `-minimize_budget`, `-minimize_time_limit`).

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
2. Pass the resolved vitest CLI path as the first argument, followed by `run`, then `.fuzz.ts` as a positional file pattern, then any forwarded arguments from the `passThrough()` parser.
3. Set environment variables derived from parsed vitiate flags (e.g., `VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`, `VITIATE_OPTIONS`).
4. Inherit stdio (`stdio: 'inherit'`).
5. Forward the child's exit code as the process exit code.

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
