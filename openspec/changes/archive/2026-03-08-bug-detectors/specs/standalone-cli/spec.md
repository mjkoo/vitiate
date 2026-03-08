## ADDED Requirements

### Requirement: -detectors CLI flag

The standalone CLI SHALL accept a `-detectors` flag (single-hyphen, consistent with the existing libFuzzer-compatible flag convention) that configures which bug detectors are active. When `-detectors` is specified, ALL detector defaults are disabled — only explicitly listed detectors are enabled. This makes the flag self-contained: you get exactly what you list.

The flag value SHALL be a comma-separated list of directives:

- `<name>`: Enable a detector (e.g., `pathTraversal`)
- `<name>.<key>=<value>`: Enable a detector with an option (e.g., `pathTraversal.sandboxRoot=/var/www`)

When the flag is absent, tier defaults apply (Tier 1 enabled, Tier 2 disabled). When the flag is present, the parsed configuration SHALL be passed via the `VITIATE_FUZZ_OPTIONS` JSON to the child process.

Detector names SHALL match the camelCase field names in `FuzzOptions.detectors` (e.g., `prototypePollution`, `commandInjection`, `pathTraversal`). An unknown detector name SHALL cause the CLI to print an error and exit.

#### Scenario: Enable specific detector (others disabled)

- **WHEN** `npx vitiate ./test.ts -detectors=prototypePollution` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: true, commandInjection: false, pathTraversal: false }` in its fuzz options

#### Scenario: Disable all detectors

- **WHEN** `npx vitiate ./test.ts -detectors=` is executed (empty value)
- **THEN** the child process SHALL receive `detectors: { prototypePollution: false, commandInjection: false, pathTraversal: false }` in its fuzz options

#### Scenario: Enable multiple detectors

- **WHEN** `npx vitiate ./test.ts -detectors=prototypePollution,commandInjection` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: true, commandInjection: true, pathTraversal: false }` in its fuzz options

#### Scenario: Detector option with dotted syntax

- **WHEN** `npx vitiate ./test.ts -detectors=pathTraversal.sandboxRoot=/var/www` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: false, commandInjection: false, pathTraversal: { sandboxRoot: "/var/www" } }` in its fuzz options

#### Scenario: Combined enable and option

- **WHEN** `npx vitiate ./test.ts -detectors=pathTraversal,pathTraversal.sandboxRoot=/var/www` is executed
- **THEN** the child process SHALL receive `detectors: { prototypePollution: false, commandInjection: false, pathTraversal: { sandboxRoot: "/var/www" } }` in its fuzz options

#### Scenario: Invalid detector name

- **WHEN** `npx vitiate ./test.ts -detectors=nonexistent` is executed
- **THEN** the CLI SHALL print an error message listing valid detector names
- **AND** the process SHALL exit with a non-zero exit code
