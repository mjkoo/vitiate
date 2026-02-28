## MODIFIED Requirements

### Requirement: Plugin factory function

The system SHALL export a `vitiatePlugin(options?)` function that returns a Vite plugin object. The plugin SHALL have the name `"vitiate"` and set `enforce: "post"` so its transform hook runs after all other transforms (TypeScript, JSX, etc. are already compiled to JavaScript).

The `options` parameter SHALL accept:

- An optional `instrument` object with:
  - `include` (string[], default `["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"]`): Glob patterns for files to instrument.
  - `exclude` (string[], default `["**/node_modules/**"]`): Glob patterns for files to skip.

- An optional `fuzz` object with project-wide fuzzing defaults:
  - `maxLen` (number, optional): Maximum input length in bytes.
  - `timeoutMs` (number, optional): Per-execution timeout in milliseconds.
  - `maxTotalTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
  - `runs` (number, optional): Maximum number of fuzzing iterations.
  - `seed` (number, optional): RNG seed for reproducible fuzzing.
  - `cacheDir` (string, optional): Cache directory path, resolved relative to project root.

#### Scenario: Default plugin creation

- **WHEN** `vitiatePlugin()` is called with no arguments
- **THEN** a Vite plugin is returned with `name: "vitiate"` and `enforce: "post"`
- **AND** the plugin instruments all JS/TS files except those in `node_modules`
- **AND** no fuzz defaults are injected into the environment

#### Scenario: Plugin with fuzz defaults

- **WHEN** `vitiatePlugin({ fuzz: { maxLen: 4096, timeoutMs: 5000 } })` is called
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ_OPTIONS` to `{"maxLen":4096,"timeoutMs":5000}` if the env var is not already set
- **AND** fuzz tests that do not specify per-test options inherit these defaults

#### Scenario: Plugin with cacheDir

- **WHEN** `vitiatePlugin({ fuzz: { cacheDir: ".fuzz-cache" } })` is called
- **THEN** the plugin's `config()` hook sets `VITIATE_CACHE_DIR` to the absolute path of `.fuzz-cache` resolved relative to the Vite project root
- **AND** the env var is only set if `VITIATE_CACHE_DIR` is not already defined

#### Scenario: Explicit env vars take precedence

- **WHEN** `VITIATE_FUZZ_OPTIONS={"maxLen":1024}` is already set in the environment
- **AND** `vitiatePlugin({ fuzz: { maxLen: 4096 } })` is called
- **THEN** `VITIATE_FUZZ_OPTIONS` retains the value `{"maxLen":1024}`
- **AND** the plugin config is ignored for that env var

#### Scenario: Custom exclude overrides default

- **WHEN** `vitiatePlugin({ instrument: { exclude: [] } })` is called
- **THEN** the plugin instruments all files including those in `node_modules`

#### Scenario: Custom include narrows scope

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**/*.ts"] } })` is called
- **THEN** only files matching `src/**/*.ts` are instrumented

## ADDED Requirements

### Requirement: Project root communication

The plugin's `config()` hook SHALL resolve the Vite project root and set `VITIATE_PROJECT_ROOT` in `process.env` if it is not already set. The project root SHALL be obtained from the Vite config's `root` property (which defaults to `process.cwd()` when not explicitly configured).

This env var is consumed by the corpus management module to anchor the cache directory.

#### Scenario: Project root is set from Vite config

- **WHEN** the plugin's `config()` hook runs
- **AND** `VITIATE_PROJECT_ROOT` is not set in the environment
- **THEN** `VITIATE_PROJECT_ROOT` is set to the resolved absolute path of Vite's `root`

#### Scenario: Explicit project root takes precedence

- **WHEN** `VITIATE_PROJECT_ROOT=/custom/root` is already set in the environment
- **AND** the plugin's `config()` hook runs
- **THEN** `VITIATE_PROJECT_ROOT` retains `/custom/root`
