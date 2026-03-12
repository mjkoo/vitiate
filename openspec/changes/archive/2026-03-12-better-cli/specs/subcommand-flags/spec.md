## ADDED Requirements

### Requirement: Fuzz subcommand flags

The `vitiate fuzz` subcommand SHALL accept the following flags via an `@optique` parser:

- `--fuzz-time <N>`: Total fuzzing time limit in seconds. SHALL be set as `VITIATE_FUZZ_TIME=<N>` in the environment of the spawned vitest process. When both `--fuzz-time` and the `VITIATE_FUZZ_TIME` environment variable are present, the CLI flag SHALL take precedence.
- `--fuzz-execs <N>`: Total fuzzing iterations. SHALL be set as `VITIATE_FUZZ_EXECS=<N>` in the environment of the spawned vitest process. When both `--fuzz-execs` and the `VITIATE_FUZZ_EXECS` environment variable are present, the CLI flag SHALL take precedence.
- `--max-crashes <N>`: Maximum crashes to collect. SHALL be set as `VITIATE_MAX_CRASHES=<N>` in the environment of the spawned vitest process. When both `--max-crashes` and the `VITIATE_MAX_CRASHES` environment variable are present, the CLI flag SHALL take precedence.
- `--detectors <spec>`: Comma-separated list of bug detectors to enable. SHALL use the same syntax and parsing logic as the libfuzzer subcommand's `-detectors` flag (see `standalone-cli` capability). The parsed value SHALL be serialized into the `VITIATE_FUZZ_OPTIONS` JSON environment variable.

All flag values for `--fuzz-time`, `--fuzz-execs`, and `--max-crashes` SHALL be positive integers (minimum 1).

#### Scenario: Fuzz with time limit

- **WHEN** `npx vitiate fuzz --fuzz-time 60` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_FUZZ_TIME=60` in its environment
- **AND** fuzzing SHALL stop after 60 seconds

#### Scenario: Fuzz with execution limit

- **WHEN** `npx vitiate fuzz --fuzz-execs 100000` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_FUZZ_EXECS=100000` in its environment
- **AND** fuzzing SHALL stop after 100,000 iterations

#### Scenario: Fuzz with crash limit

- **WHEN** `npx vitiate fuzz --max-crashes 5` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_MAX_CRASHES=5` in its environment

#### Scenario: CLI flag overrides environment variable

- **WHEN** `VITIATE_FUZZ_TIME=120 npx vitiate fuzz --fuzz-time 60` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_FUZZ_TIME=60` in its environment
- **AND** the environment variable value of 120 SHALL be overridden

#### Scenario: Environment variable used when no CLI flag

- **WHEN** `VITIATE_FUZZ_TIME=120 npx vitiate fuzz` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_FUZZ_TIME=120` in its environment (inherited, not overridden)

#### Scenario: Fuzz with detectors

- **WHEN** `npx vitiate fuzz --detectors prototypePollution,pathTraversal` is executed
- **THEN** vitest SHALL be spawned with a `VITIATE_FUZZ_OPTIONS` JSON containing `detectors: { prototypePollution: true, pathTraversal: true, ... }` with unlisted detectors set to false

#### Scenario: Multiple flags combined

- **WHEN** `npx vitiate fuzz --fuzz-time 60 --fuzz-execs 100000 --max-crashes 3` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_FUZZ_TIME=60`, `VITIATE_FUZZ_EXECS=100000`, and `VITIATE_MAX_CRASHES=3` in its environment

### Requirement: Detectors flag on regression and optimize subcommands

The `vitiate regression` and `vitiate optimize` subcommands SHALL each accept a `--detectors <spec>` flag. The flag SHALL use the same syntax and parsing logic as the fuzz subcommand's `--detectors` flag. The parsed value SHALL be serialized into the `VITIATE_FUZZ_OPTIONS` JSON environment variable on the spawned vitest process.

#### Scenario: Regression with detectors

- **WHEN** `npx vitiate regression --detectors prototypePollution` is executed
- **THEN** vitest SHALL be spawned with a `VITIATE_FUZZ_OPTIONS` JSON containing `detectors: { prototypePollution: true, ... }` with unlisted detectors set to false

#### Scenario: Optimize with detectors

- **WHEN** `npx vitiate optimize --detectors pathTraversal` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_OPTIMIZE=1` and a `VITIATE_FUZZ_OPTIONS` JSON containing `detectors: { pathTraversal: true, ... }` with unlisted detectors set to false

### Requirement: Vitest flag forwarding via passThrough

All three vitest-wrapper subcommands (`fuzz`, `regression`, `optimize`) SHALL use `@optique`'s `passThrough()` to collect unrecognized arguments. Unrecognized arguments SHALL be forwarded to the spawned vitest process, appended after `vitest run .fuzz.ts`.

The `--` separator SHALL be supported: all arguments after `--` SHALL be forwarded to vitest verbatim, bypassing vitiate flag parsing.

#### Scenario: Unknown flags forwarded to vitest

- **WHEN** `npx vitiate fuzz --reporter verbose --bail 1` is executed
- **THEN** `--reporter verbose --bail 1` SHALL be forwarded to vitest
- **AND** vitest SHALL be spawned as `vitest run .fuzz.ts --reporter verbose --bail 1`

#### Scenario: Mixed vitiate and vitest flags

- **WHEN** `npx vitiate fuzz --fuzz-time 60 --reporter verbose` is executed
- **THEN** `--fuzz-time 60` SHALL be parsed by vitiate and set as `VITIATE_FUZZ_TIME=60`
- **AND** `--reporter verbose` SHALL be forwarded to vitest

#### Scenario: Explicit separator

- **WHEN** `npx vitiate fuzz --fuzz-time 60 -- --reporter verbose` is executed
- **THEN** `--fuzz-time 60` SHALL be parsed by vitiate
- **AND** `--reporter verbose` SHALL be forwarded to vitest after the `--` separator

#### Scenario: Regression forwards unknown flags

- **WHEN** `npx vitiate regression --reporter dot` is executed
- **THEN** `--reporter dot` SHALL be forwarded to vitest

#### Scenario: No vitiate flags, all forwarded

- **WHEN** `npx vitiate fuzz --test-name-pattern 'parses URLs'` is executed
- **THEN** `--test-name-pattern 'parses URLs'` SHALL be forwarded to vitest in its entirety

### Requirement: Subcommand help

Each vitest-wrapper subcommand SHALL display help text when invoked with `--help`. The help output SHALL list all vitiate-specific flags accepted by that subcommand, with descriptions and type information. The help output SHALL note that unrecognized flags are forwarded to vitest.

#### Scenario: Fuzz help

- **WHEN** `npx vitiate fuzz --help` is executed
- **THEN** the output SHALL list `--fuzz-time`, `--fuzz-execs`, `--max-crashes`, and `--detectors` with descriptions
- **AND** the process SHALL exit with code 0

#### Scenario: Regression help

- **WHEN** `npx vitiate regression --help` is executed
- **THEN** the output SHALL list `--detectors` with a description
- **AND** the process SHALL exit with code 0
