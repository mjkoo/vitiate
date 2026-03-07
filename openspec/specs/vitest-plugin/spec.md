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
  - `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
  - `runs` (number, optional): Maximum number of fuzzing iterations.
  - `seed` (number, optional): RNG seed for reproducible fuzzing.

- `cacheDir` (string, optional): Cache directory path, resolved relative to project root.

- `coverageMapSize` (number, optional, default 65536): Number of edge counter slots in the coverage map. Must be an integer in [256, 4194304]. Larger values reduce hash collisions for large applications. A warning is emitted if the value is not a power of two.

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

- **WHEN** `vitiatePlugin({ cacheDir: ".fuzz-cache" })` is called
- **THEN** the plugin's `config()` hook stores the absolute path of `.fuzz-cache` resolved relative to the Vite project root as module-scoped state
- **AND** the corpus management module uses this value for cache directory resolution

#### Scenario: Explicit VITIATE_FUZZ_OPTIONS env var takes precedence

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

### Requirement: VITIATE_FUZZ_TIME environment variable

The system SHALL support a `VITIATE_FUZZ_TIME` environment variable as a convenience shorthand for setting the fuzz campaign duration. The value SHALL be interpreted as a non-negative integer number of seconds.

When `VITIATE_FUZZ_TIME` is set:
- The value SHALL be validated as a non-negative integer. Invalid values (negative, non-integer, non-numeric, Infinity) SHALL produce a warning on stderr and be ignored.
- The value SHALL be converted from seconds to milliseconds and applied as `fuzzTimeMs`.
- `VITIATE_FUZZ_TIME` SHALL take precedence over `VITIATE_FUZZ_OPTIONS.fuzzTimeMs`. An invalid `VITIATE_FUZZ_TIME` SHALL NOT clobber a valid `VITIATE_FUZZ_OPTIONS.fuzzTimeMs`.

Precedence (highest wins): `VITIATE_FUZZ_TIME` > `VITIATE_FUZZ_OPTIONS.fuzzTimeMs` > per-test `fuzzTimeMs` option.

#### Scenario: Simple duration override

- **WHEN** `VITIATE_FUZZ_TIME=30` is set in the environment
- **THEN** each fuzz test runs for up to 30 seconds (30000ms)
- **AND** this is equivalent to `VITIATE_FUZZ_OPTIONS={"fuzzTimeMs":30000}`

#### Scenario: VITIATE_FUZZ_TIME overrides VITIATE_FUZZ_OPTIONS

- **WHEN** `VITIATE_FUZZ_TIME=10` and `VITIATE_FUZZ_OPTIONS={"fuzzTimeMs":60000}` are both set
- **THEN** `fuzzTimeMs` is 10000 (VITIATE_FUZZ_TIME wins)

#### Scenario: Invalid VITIATE_FUZZ_TIME is ignored

- **WHEN** `VITIATE_FUZZ_TIME=abc` is set
- **THEN** a warning is written to stderr
- **AND** the value is ignored (does not affect fuzzTimeMs)

### Requirement: Project root communication

The plugin's `config()` hook SHALL resolve the Vite project root and store it as module-scoped state via `setProjectRoot()`. The project root SHALL be obtained from the Vite config's `root` property (which defaults to `process.cwd()` when not explicitly configured).

This value is consumed by the corpus management module to anchor the cache directory. No environment variable is needed because the plugin and corpus module run in the same process.

#### Scenario: Project root is set from Vite config

- **WHEN** the plugin's `config()` hook runs
- **THEN** the project root is set to the resolved absolute path of Vite's `root`

#### Scenario: Project root defaults to cwd

- **WHEN** the plugin's `config()` hook runs
- **AND** Vite's `root` is not configured
- **THEN** the project root is set to `process.cwd()`

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

### ~~Requirement: Fuzz mode activation via --fuzz CLI flag~~ (REMOVED)

> **Removed in change `projects-fuzz-activation`.**
> **Reason**: Vitest's `cac` CLI parser rejects unknown flags before the plugin's `config()` hook runs, making `parseFuzzFlag()` dead code. The Vitest maintainers have explicitly declined to support plugin-extensible CLI flags. `VITIATE_FUZZ=1` is the sole activation mechanism.
> **Migration**: Use `VITIATE_FUZZ=1 vitest run` instead of `vitest --fuzz`. Use Vitest's `-t` flag instead of `--fuzz=<pattern>`.
