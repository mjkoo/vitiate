## ADDED Requirements

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

### Requirement: Transform hook instruments code via SWC

The plugin's `transform(code, id)` hook SHALL call `@swc/core.transform()` with the `vitiate-instrument` WASM plugin for every module that passes the include/exclude filter. The SWC transform SHALL insert edge coverage counters and comparison tracing calls into the JavaScript AST.

The WASM plugin path SHALL be resolved from the `vitiate-instrument` package's `main` field (the `.wasm` artifact).

#### Scenario: TypeScript file is instrumented

- **WHEN** a `.ts` file passes through the Vite pipeline and reaches the vitiate transform hook
- **THEN** the output JavaScript contains `__vitiate_cov[` counter increments at branch points
- **AND** the output JavaScript contains `__vitiate_trace_cmp(` calls replacing comparison operators

#### Scenario: node_modules file is skipped by default

- **WHEN** a file with path containing `node_modules` passes through the transform hook with default options
- **THEN** the file is returned unchanged (no instrumentation applied)

#### Scenario: node_modules file is instrumented when exclude is overridden

- **WHEN** a file with path containing `node_modules` passes through the transform hook with `exclude: []`
- **THEN** the file is instrumented with coverage counters and comparison tracing

### Requirement: Setup file registration

The plugin SHALL register the runtime setup file via the `config()` hook by returning `{ test: { setupFiles: [setupPath] } }`. Vite deep-merges `config()` return values into the resolved config before Vitest processes them, ensuring the setup file is registered before any test code executes.

The `configureVitest` hook SHALL NOT be used for setup file registration because it fires after Vitest's project config is resolved and frozen — `setupFiles` cannot be modified at that point.

#### Scenario: Setup file is registered via config hook

- **WHEN** the vitiate plugin is loaded by Vitest
- **THEN** the plugin's `config()` hook returns a config object containing the vitiate runtime setup module in `test.setupFiles`
- **AND** the setup file is present in the resolved Vitest config before any tests execute

### Requirement: Fuzz mode activation via --fuzz CLI flag

The plugin's `config()` hook SHALL scan `process.argv` for a `--fuzz` argument and activate fuzzing mode if the `VITIATE_FUZZ` environment variable is not already set. This provides a CLI convenience so users can write `vitest --fuzz` instead of `VITIATE_FUZZ=1 vitest`.

The scan SHALL recognize two forms:

- `--fuzz` (bare flag): sets `VITIATE_FUZZ` to `"1"` (all fuzz tests run).
- `--fuzz=<pattern>` (with value): sets `VITIATE_FUZZ` to `"1"` and sets `VITIATE_FUZZ_PATTERN` to `<pattern>` (only fuzz tests matching the pattern run).

The form `--fuzz <pattern>` (space-separated) SHALL NOT be supported because it is ambiguous with Vitest's positional file arguments.

If `VITIATE_FUZZ` is already set in the environment, the `--fuzz` flag SHALL be ignored (explicit env vars take precedence). If `VITIATE_FUZZ_PATTERN` is already set in the environment, the pattern from `--fuzz=<pattern>` SHALL be ignored.

The `parseFuzzFlag(argv)` helper SHALL return a structured value: `{ pattern?: string }` when a `--fuzz` flag is found, or `undefined` when no flag is present. The optional `pattern` field SHALL be present only when `--fuzz=<pattern>` is used with a non-empty value.

#### Scenario: Bare --fuzz flag activates fuzzing

- **WHEN** `vitest --fuzz` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ` to `"1"`
- **AND** `VITIATE_FUZZ_PATTERN` is not set
- **AND** all fuzz tests run in fuzzing mode

#### Scenario: --fuzz with pattern sets both env vars

- **WHEN** `vitest --fuzz=mypattern` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **AND** `VITIATE_FUZZ_PATTERN` is not set in the environment
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ` to `"1"`
- **AND** the plugin's `config()` hook sets `VITIATE_FUZZ_PATTERN` to `"mypattern"`
- **AND** only fuzz tests whose name matches `mypattern` run in fuzzing mode

#### Scenario: Explicit VITIATE_FUZZ env var takes precedence over --fuzz

- **WHEN** `VITIATE_FUZZ=1 vitest --fuzz=mypattern` is executed
- **THEN** `VITIATE_FUZZ` retains the value `"1"`
- **AND** the `--fuzz` flag is ignored for the activation env var

#### Scenario: Explicit VITIATE_FUZZ_PATTERN env var takes precedence

- **WHEN** `VITIATE_FUZZ_PATTERN=existing vitest --fuzz=override` is executed
- **THEN** `VITIATE_FUZZ_PATTERN` retains the value `"existing"`

#### Scenario: No --fuzz flag and no env var

- **WHEN** `vitest` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **AND** `--fuzz` is not present in `process.argv`
- **THEN** `VITIATE_FUZZ` is not set
- **AND** `VITIATE_FUZZ_PATTERN` is not set
- **AND** fuzz tests run in regression mode (replaying corpus only)

#### Scenario: --fuzz after -- sentinel is ignored

- **WHEN** `vitest -- --fuzz` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** `VITIATE_FUZZ` is not set
- **AND** `VITIATE_FUZZ_PATTERN` is not set
- **AND** fuzz tests run in regression mode
