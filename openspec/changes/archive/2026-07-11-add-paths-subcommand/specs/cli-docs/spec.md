## MODIFIED Requirements

### Requirement: CLI guide structure

The CLI guide page (`docs/src/content/docs/guides/cli.md`) SHALL present `vitiate fuzz`, `vitiate regression`, and `vitiate optimize` as the primary CLI interface. The page SHALL be organized in the following section order:

1. Introduction with subcommand summary table
2. Fuzzing (`vitiate fuzz`) - primary workflow, flags, examples
3. Regression testing (`vitiate regression`)
4. Corpus optimization (`vitiate optimize`)
5. Project setup (`vitiate init`)
6. Inspecting corpus directories (`vitiate paths`) - test-to-directory mapping, filtering, `--dir`/`--json`/`--absolute`, orphan detection and pruning
7. libFuzzer compatibility (`vitiate libfuzzer`) - motivation, flags, corpus directories, merge mode, supervisor
8. Output format
9. Environment variables

The `vitiate fuzz` section SHALL be the most prominent, with examples showing `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors` flags.

#### Scenario: Primary interface is vitiate fuzz

- **WHEN** a user reads the CLI guide
- **THEN** the first usage examples SHALL use `vitiate fuzz` (not `vitiate libfuzzer`)
- **AND** `vitiate fuzz` SHALL be presented as the recommended way to run fuzz tests

#### Scenario: libFuzzer section covers motivation

- **WHEN** a user reads the libFuzzer compatibility section
- **THEN** the section SHALL explain that `vitiate libfuzzer` exists for fuzzing platform integration
- **AND** the section SHALL document all libFuzzer-compatible flags
- **AND** the section SHALL cover corpus directories, merge mode, and the supervisor architecture

#### Scenario: paths section covers mapping and pruning

- **WHEN** a user reads the `vitiate paths` section
- **THEN** the section SHALL explain that `paths` is a read-only inspector mapping tests to their directories with per-bucket counts
- **AND** the section SHALL document the `pattern` filter, `--dir`, `--json`, and `--absolute`
- **AND** the section SHALL document orphan detection (`--orphans`) and pruning (`--prune`, `--all`, `--force`), including the confirmation prompt and non-TTY behavior

### Requirement: CLI flags reference structure

The CLI flags reference page (`docs/src/content/docs/reference/cli-flags.md`) SHALL organize flags by subcommand rather than as a single flat list. Each subcommand SHALL have its own section listing accepted flags.

The `fuzz` section SHALL document `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors`. The `regression` and `optimize` sections SHALL document `--detectors`. The `libfuzzer` section SHALL document all libFuzzer-compatible flags. The `paths` section SHALL document the optional `pattern` positional argument and the `--json`, `--absolute`, `--dir`, `--orphans`, `--prune`, `--all`, and `--force`/`-f` flags. All sections for vitest-wrapper subcommands SHALL note that unrecognized flags are forwarded to vitest.

#### Scenario: Flags organized by subcommand

- **WHEN** a user reads the CLI flags reference
- **THEN** flags SHALL be grouped under their respective subcommand headings
- **AND** the `fuzz` subcommand section SHALL list `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors`

#### Scenario: paths flags documented

- **WHEN** a user reads the `paths` section of the flags reference
- **THEN** the `pattern` positional and the `--json`, `--absolute`, `--dir`, `--orphans`, `--prune`, `--all`, and `--force`/`-f` flags SHALL be documented

#### Scenario: Vitest forwarding documented

- **WHEN** a user reads the flags reference for any vitest-wrapper subcommand
- **THEN** the section SHALL note that unrecognized flags are forwarded to vitest
