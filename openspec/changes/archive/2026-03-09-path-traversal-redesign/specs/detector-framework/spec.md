## MODIFIED Requirements

### Requirement: Detector configuration schema

The system SHALL define per-detector configuration using Valibot schemas within the `FuzzOptions.detectors` key. Each detector field SHALL accept either a `boolean` or a detector-specific options object:

- `boolean`: `true` enables with defaults, `false` disables.
- Options object: Enables the detector with the provided configuration.
- Absent field: Uses the tier default (Tier 1 = enabled, Tier 2 = disabled).

The following detector fields SHALL be defined for Tier 1 detectors:

- `prototypePollution?: boolean`
- `commandInjection?: boolean`
- `pathTraversal?: boolean | { allowedPaths?: string[]; deniedPaths?: string[] }`

Tier 2 detector fields (`redos`, `ssrf`, `unsafeEval`) are NOT included in this change. They SHALL be added to the schema when their respective detectors are implemented. The schema SHALL accept and silently ignore unknown keys within the `detectors` object to allow forward-compatible configuration files.

#### Scenario: Valid boolean configuration

- **WHEN** `detectors: { prototypePollution: false }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the prototype pollution detector SHALL be disabled

#### Scenario: Valid options object with allowedPaths and deniedPaths

- **WHEN** `detectors: { pathTraversal: { allowedPaths: ["/var/www"], deniedPaths: ["/var/www/secrets"] } }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the path traversal detector SHALL be enabled with the specified policy

#### Scenario: Valid options object with partial config

- **WHEN** `detectors: { pathTraversal: { deniedPaths: ["/etc/passwd"] } }` is provided in `FuzzOptions`
- **THEN** the configuration SHALL validate successfully
- **AND** the path traversal detector SHALL use the default `allowedPaths: ["/"]` and the provided `deniedPaths`

#### Scenario: Valid options object implies enabled (replaces sandboxRoot scenario)

- **WHEN** `DetectorManager` is constructed with `{ pathTraversal: { allowedPaths: ["/var/www"] } }`
- **THEN** the path traversal detector SHALL be active with the specified `allowedPaths`
- **AND** the default `deniedPaths: ["/etc/passwd"]` SHALL apply

#### Scenario: Empty detectors object uses defaults

- **WHEN** `detectors: {}` is provided in `FuzzOptions`
- **THEN** all Tier 1 detectors SHALL be enabled with default options
- **AND** all Tier 2 detectors SHALL be disabled

## REMOVED Requirements

### Requirement: sandboxRoot option in DetectorManager scenario

The "Options object implies enabled" scenario previously used `{ pathTraversal: { sandboxRoot: "/var/www" } }` as its example. This scenario is replaced above with the equivalent `allowedPaths`/`deniedPaths` configuration.

**Reason**: `sandboxRoot` is removed from the config schema in this change.
