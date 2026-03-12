## MODIFIED Requirements

### Requirement: CLI entry point

The system SHALL provide a `bin` entry (`npx vitiate`) that dispatches to subcommands. The first positional argument SHALL be the subcommand name.

Usage: `npx vitiate <subcommand> [args...]`

The CLI SHALL:

1. Check `process.argv[2]` against known subcommand names: `init`, `fuzz`, `regression`, `optimize`, `libfuzzer`.
2. If a known subcommand is matched, dispatch to that subcommand's handler with the remaining arguments (`process.argv.slice(3)`).
3. If no argument is provided or the argument does not match a known subcommand, print a usage summary and exit.

The previous behavior (accepting a test file path as the first positional argument and directly entering the fuzzer) SHALL be available exclusively via the `libfuzzer` subcommand.

#### Scenario: Subcommand dispatch

- **WHEN** `npx vitiate fuzz` is executed
- **THEN** the `fuzz` subcommand handler SHALL be invoked

#### Scenario: libfuzzer subcommand preserves existing behavior

- **WHEN** `npx vitiate libfuzzer ./tests/parser.fuzz.ts` is executed
- **THEN** the CLI SHALL behave identically to the previous `npx vitiate ./tests/parser.fuzz.ts`
- **AND** shmem SHALL be allocated, child SHALL be spawned with `VITIATE_SUPERVISOR`

#### Scenario: No arguments shows help

- **WHEN** `npx vitiate` is executed with no arguments
- **THEN** a usage summary SHALL be printed listing all subcommands
- **AND** the process SHALL exit with code 0

#### Scenario: Child mode invocation (libfuzzer)

- **WHEN** `npx vitiate libfuzzer ./tests/parser.fuzz.ts` is executed with `VITIATE_SUPERVISOR` set
- **THEN** the CLI attaches to the shmem region
- **AND** Vitest starts in fuzzing mode
- **AND** the vitiate plugin is loaded for instrumentation

### Requirement: libFuzzer-compatible flags

All existing libFuzzer-compatible flags SHALL continue to be accepted exclusively under the `libfuzzer` subcommand. The flag parsing, validation, and behavior SHALL remain unchanged.

The flags (`-max_len`, `-timeout`, `-runs`, `-seed`, `-max_total_time`, `-test`, `-artifact_prefix`, `-dict`, `-detectors`, `-fork`, `-jobs`, `-merge`, `-minimize_budget`, `-minimize_time_limit`) SHALL NOT be accepted by the `fuzz`, `regression`, `optimize`, or `init` subcommands.

#### Scenario: Flags under libfuzzer subcommand

- **WHEN** `npx vitiate libfuzzer ./test.ts -timeout=10 -runs=100000 -seed=42` is executed
- **THEN** the flags SHALL be parsed and applied identically to the previous CLI behavior

#### Scenario: Flags not accepted by other subcommands

- **WHEN** `npx vitiate fuzz -timeout=10` is executed
- **THEN** `-timeout=10` SHALL be forwarded to vitest as-is (vitest will handle or reject it)
- **AND** vitiate SHALL NOT interpret it as a libFuzzer flag
