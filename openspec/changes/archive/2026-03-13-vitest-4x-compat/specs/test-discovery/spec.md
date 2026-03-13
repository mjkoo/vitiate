## MODIFIED Requirements

### Requirement: Test discovery via Vitest

The `init` subcommand SHALL use Vitest's Node API (`createVitest` from `vitest/node`) to discover fuzz test files. The system SHALL:

1. Create a Vitest instance using `createVitest('test', { include: ['**/*.fuzz.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'] })` without running tests.
2. Collect test specifications using Vitest's test collection API.
3. Walk the test module tree to extract test names from `fuzz()` calls.
4. Compute the relative test file path (relative to project root) for each test file.
5. Filter discovered test modules to only those whose file path matches the fuzz test suffix pattern (`.fuzz.ts`, `.fuzz.js`, `.fuzz.mjs`, etc.), discarding any test modules from other projects or include patterns that do not match the fuzz file convention.

Step 5 is necessary because when the consuming project defines `test.projects` in its vitest config, Vitest creates separate project instances for each entry. Each project applies its own `include` pattern, ignoring the inline `include` passed to `createVitest()`. The post-collection filter ensures only fuzz test files are processed regardless of the project's vitest configuration. The pattern covers all vitest-supported JS/TS extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`).

The vitiate plugin SHALL be loaded during discovery to ensure the same configuration (including `dataDir`) is available.

#### Scenario: Discover tests in nested directories

- **WHEN** `npx vitiate init` is executed
- **AND** the project contains `src/parsers/json.fuzz.ts` with `fuzz("parses JSON", ...)`
- **AND** the project contains `src/parsers/url.fuzz.ts` with `fuzz("parses URLs", ...)`
- **THEN** both tests SHALL be discovered with their relative file paths

#### Scenario: Multiple tests in one file

- **WHEN** `npx vitiate init` is executed
- **AND** `src/parser.fuzz.ts` contains `fuzz("parses JSON", ...)` and `fuzz("parses URLs", ...)`
- **THEN** both tests SHALL be discovered as separate entries with the same file path but different test names

#### Scenario: Tests inside describe blocks

- **WHEN** `npx vitiate init` is executed
- **AND** a fuzz test is inside a `describe()` block
- **THEN** the test name SHALL include the full suite hierarchy (matching Vitest's `getTaskFullName` format)

#### Scenario: Multi-project config with unit and fuzz projects

- **WHEN** `npx vitiate init` is executed
- **AND** the project's `vitest.config.ts` defines `test.projects` with a "unit" project (`src/**/*.test.ts`) and a "fuzz" project (`fuzz/**/*.fuzz.ts`)
- **THEN** only fuzz test files (matching `*.fuzz.*`) SHALL be discovered
- **AND** unit test files (ending in `.test.ts`) SHALL NOT be discovered
- **AND** no seed directories SHALL be created for unit tests

#### Scenario: Single-project config (no test.projects)

- **WHEN** `npx vitiate init` is executed
- **AND** the project's `vitest.config.ts` does not define `test.projects`
- **THEN** the inline `include` pattern SHALL be respected by Vitest
- **AND** only fuzz test files SHALL be discovered (same behavior as before)

#### Scenario: Project with non-standard fuzz project name

- **WHEN** `npx vitiate init` is executed
- **AND** the project defines `test.projects` with a project named "security-tests" that includes `**/*.fuzz.ts`
- **THEN** fuzz test files SHALL be discovered regardless of the project name
- **AND** filtering is based on file extension, not project name
