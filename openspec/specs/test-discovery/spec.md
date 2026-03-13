# Test Discovery

## Purpose

Defines the `init` subcommand's test discovery and directory scaffolding behavior, using Vitest's Node API to find fuzz tests and create their test data directory structure.

## Requirements

### Requirement: init subcommand

The `vitiate init` subcommand SHALL discover all fuzz tests in the project and create their test data directory structure. It SHALL be idempotent - safe to run multiple times, creating only directories that don't already exist.

#### Scenario: Basic init invocation

- **WHEN** `npx vitiate init` is executed in a project with `*.fuzz.ts` files
- **THEN** the system SHALL discover all fuzz tests
- **AND** create seed directories for each test
- **AND** print a summary of discovered tests and their paths

#### Scenario: Idempotent re-run

- **WHEN** `npx vitiate init` is executed and seed directories already exist
- **THEN** existing directories SHALL not be modified
- **AND** new tests (not previously discovered) SHALL have directories created
- **AND** the summary SHALL include all tests (existing and new)

#### Scenario: No fuzz tests found

- **WHEN** `npx vitiate init` is executed in a project with no `*.fuzz.ts` files
- **THEN** a message SHALL be printed indicating no fuzz tests were found
- **AND** the process SHALL exit with code 0

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

### Requirement: Directory scaffolding

For each discovered fuzz test, the `init` subcommand SHALL create the seed directory at `<root>/testdata/<hashdir>/seeds/` where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)`.

The `crashes/`, `timeouts/`, and `corpus/` directories SHALL NOT be created by `init` - they are created on demand by the fuzzer when artifacts are written.

#### Scenario: Seed directory created

- **WHEN** `init` discovers test `"parses JSON"` in `src/parser.fuzz.ts`
- **THEN** `.vitiate/testdata/<hashdir>/seeds/` SHALL be created
- **AND** `.vitiate/testdata/<hashdir>/crashes/` SHALL NOT be created
- **AND** `.vitiate/corpus/<hashdir>/` SHALL NOT be created

### Requirement: Gitignore management

The `init` subcommand SHALL ensure that `.vitiate/corpus/` is listed in the project's `.gitignore` file. If `.gitignore` does not exist, it SHALL be created. If `.gitignore` exists but does not contain a line matching `.vitiate/corpus/`, the line SHALL be appended.

The `testdata/` subtree SHALL NOT be gitignored (it contains committed test data).

#### Scenario: Gitignore entry added

- **WHEN** `npx vitiate init` is executed
- **AND** `.gitignore` does not contain `.vitiate/corpus/`
- **THEN** `.vitiate/corpus/` SHALL be appended to `.gitignore`

#### Scenario: Gitignore entry already present

- **WHEN** `npx vitiate init` is executed
- **AND** `.gitignore` already contains `.vitiate/corpus/`
- **THEN** `.gitignore` SHALL not be modified

#### Scenario: No gitignore file

- **WHEN** `npx vitiate init` is executed
- **AND** no `.gitignore` file exists at the project root
- **THEN** a `.gitignore` file SHALL be created containing `.vitiate/corpus/`

### Requirement: Manifest output

The `init` subcommand SHALL print a summary table to stdout listing each discovered fuzz test with:

- The relative test file path
- The test name
- The computed hash directory name
- The full path to the seed directory

#### Scenario: Manifest output format

- **WHEN** `npx vitiate init` discovers two tests
- **THEN** a table SHALL be printed showing the test file, test name, hash, and seed path for each test
