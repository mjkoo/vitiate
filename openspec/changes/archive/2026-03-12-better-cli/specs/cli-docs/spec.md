## ADDED Requirements

### Requirement: CLI guide structure

The CLI guide page (`docs/src/content/docs/guides/cli.md`) SHALL present `vitiate fuzz`, `vitiate regression`, and `vitiate optimize` as the primary CLI interface. The page SHALL be organized in the following section order:

1. Introduction with subcommand summary table
2. Fuzzing (`vitiate fuzz`) - primary workflow, flags, examples
3. Regression testing (`vitiate regression`)
4. Corpus optimization (`vitiate optimize`)
5. Project setup (`vitiate init`)
6. libFuzzer compatibility (`vitiate libfuzzer`) - motivation, flags, corpus directories, merge mode, supervisor
7. Output format
8. Environment variables

The `vitiate fuzz` section SHALL be the most prominent, with examples showing `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors` flags.

#### Scenario: Primary interface is vitiate fuzz

- **WHEN** a user reads the CLI guide
- **THEN** the first usage examples SHALL use `vitiate fuzz` (not `vitiate libfuzzer`)
- **AND** `vitiate fuzz` SHALL be presented as the recommended way to run fuzz tests

#### Scenario: libFuzzer section covers motivation

- **WHEN** a user reads the libFuzzer compatibility section
- **THEN** the section SHALL explain that `vitiate libfuzzer` exists for OSS-Fuzz and platform integration
- **AND** the section SHALL document all libFuzzer-compatible flags
- **AND** the section SHALL cover corpus directories, merge mode, and the supervisor architecture

### Requirement: CLI flags reference structure

The CLI flags reference page (`docs/src/content/docs/reference/cli-flags.md`) SHALL organize flags by subcommand rather than as a single flat list. Each subcommand SHALL have its own section listing accepted flags.

The `fuzz` section SHALL document `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors`. The `regression` and `optimize` sections SHALL document `--detectors`. The `libfuzzer` section SHALL document all libFuzzer-compatible flags. All sections for vitest-wrapper subcommands SHALL note that unrecognized flags are forwarded to vitest.

#### Scenario: Flags organized by subcommand

- **WHEN** a user reads the CLI flags reference
- **THEN** flags SHALL be grouped under their respective subcommand headings
- **AND** the `fuzz` subcommand section SHALL list `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors`

#### Scenario: Vitest forwarding documented

- **WHEN** a user reads the flags reference for any vitest-wrapper subcommand
- **THEN** the section SHALL note that unrecognized flags are forwarded to vitest

### Requirement: Environment variable reference

The CLI guide SHALL include a complete environment variable reference section. Each environment variable SHALL note whether it has a CLI flag equivalent and which flag takes precedence.

The following variables SHALL be documented: `VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`, `VITIATE_FUZZ`, `VITIATE_OPTIMIZE`, `VITIATE_DEBUG`.

Internal variables (`VITIATE_SUPERVISOR`, `VITIATE_SHMEM`, `VITIATE_FUZZ_OPTIONS`, `VITIATE_CLI_IPC`) SHALL NOT be documented in the user-facing guide.

#### Scenario: Env var with CLI equivalent

- **WHEN** a user reads the environment variable reference for `VITIATE_FUZZ_TIME`
- **THEN** the entry SHALL note that `--fuzz-time` is the CLI equivalent
- **AND** the entry SHALL state that the CLI flag takes precedence when both are set

#### Scenario: Env var without CLI equivalent

- **WHEN** a user reads the environment variable reference for `VITIATE_DEBUG`
- **THEN** the entry SHALL document the variable without referencing a CLI flag equivalent

### Requirement: Environment variable precedence update

The environment variable reference page (`docs/src/content/docs/reference/environment-variables.md`) SHALL document that CLI flags take precedence over environment variables for the `fuzz`, `regression`, and `optimize` subcommands. The precedence order SHALL be:

1. CLI flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes`)
2. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults

For the `libfuzzer` subcommand, the existing precedence (environment variables override CLI flags) SHALL be preserved and documented separately.

#### Scenario: Precedence for fuzz subcommand

- **WHEN** a user reads the precedence section
- **THEN** CLI flags SHALL be listed above environment variables for the `fuzz`/`regression`/`optimize` subcommands

#### Scenario: libfuzzer precedence preserved

- **WHEN** a user reads the precedence section for the `libfuzzer` subcommand
- **THEN** environment variables SHALL be listed above CLI flags (existing behavior)

### Requirement: Consistent CLI examples across docs

All documentation pages that show CLI invocations SHALL use conventions consistent with the CLI guide. Specifically:

- `vitiate fuzz` SHALL NOT be shown with a positional file path argument (the subcommand runs all `*.fuzz.ts` files automatically).
- Pages showing detector configuration SHALL include `vitiate fuzz --detectors` examples alongside or instead of `vitiate libfuzzer -detectors` examples.
- Pages showing time/execution limits SHALL show `--fuzz-time`/`--fuzz-execs` flags as the primary approach, with environment variables as an alternative.

#### Scenario: Quickstart and tutorial examples

- **WHEN** a user reads the quickstart or tutorial
- **THEN** `vitiate fuzz` examples SHALL NOT include a file path positional argument
- **AND** the examples SHALL work by running all discovered `*.fuzz.ts` files

#### Scenario: CI fuzzing examples

- **WHEN** a user reads the CI fuzzing guide
- **THEN** examples SHALL show `--fuzz-time` as the primary way to set time limits
- **AND** environment variable usage SHALL be shown as an alternative

#### Scenario: Detector examples

- **WHEN** a user reads the detectors guide
- **THEN** `vitiate fuzz --detectors` SHALL be shown as the primary invocation
- **AND** `vitiate libfuzzer -detectors` SHALL be shown in the libFuzzer compatibility context
