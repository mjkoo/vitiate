## ADDED Requirements

### Requirement: Plugin factory function

The system SHALL export a `vitiatePlugin(options?)` function that returns an array of two Vite plugins (`Plugin[]`):

- **`vitiate:hooks`** (`enforce: "pre"`): Rewrites ESM named imports of hooked built-in modules (`child_process`, `fs`, `fs/promises`, `http2`) into default import + destructuring. This ensures imported values are read from the live module object at call time rather than from the frozen ESM namespace that Vitest externalizes at startup, enabling detector module hooks to intercept calls.
- **`vitiate:instrument`** (`enforce: "post"`): Runs SWC instrumentation (edge coverage counters, comparison tracing) after all other transforms (TypeScript, JSX, etc. are already compiled to JavaScript).

The `options` parameter SHALL accept:

- An optional `instrument` object with:
  - `include` (string[], default `["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"]`): Glob patterns for files to instrument.
  - `exclude` (string[], default `["**/node_modules/**"]`): Glob patterns for files to skip.

- An optional `fuzz` object with project-wide fuzzing defaults:
  - `maxLen` (number, optional): Maximum input length in bytes.
  - `timeoutMs` (number, optional): Per-execution timeout in milliseconds.
  - `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
  - `fuzzExecs` (number, optional): Maximum number of fuzzing iterations.
  - `seed` (number, optional): RNG seed for reproducible fuzzing.

- `dataDir` (string, optional): Test data root directory path, resolved relative to project root. When set, the value SHALL be resolved relative to the Vite project root and stored as the global test data root directory. When not set, the default is `.vitiate/` relative to the project root. This replaces the previous `cacheDir` option.

- `coverageMapSize` (number, optional, default 65536): Number of edge counter slots in the coverage map. Must be an integer in [256, 4194304]. Larger values reduce hash collisions for large applications. A warning is emitted if the value is not a power of two.

The `vitiate:hooks` plugin SHALL use the resolved exclude patterns (but NOT the include patterns) to determine whether a file should be processed. The hooks plugin SHALL NOT hardcode a node_modules exclusion independent of the configured exclude patterns. The hooks plugin SHALL process all JS/TS files not matched by the exclude patterns, regardless of the include patterns - because detector import rewriting must work across all user code (including test files) even when instrumentation scope is narrowed via include. Virtual modules (IDs starting with `\0`) and non-JS/TS files SHALL still be skipped unconditionally.

When the resolved `exclude` patterns do not contain any pattern with the substring `node_modules`, the plugin's `config()` hook SHALL return `server: { deps: { inline: true } }` to configure Vitest to inline all dependencies through the Vite transform pipeline. This ensures node_modules files reach the plugin's transform hooks when the user has opted in to instrumenting them.

When the resolved `exclude` patterns contain at least one pattern with the substring `node_modules` (the default), the plugin SHALL NOT modify `server.deps` configuration.

Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) SHALL remain unconditionally excluded from both instrumentation and hook rewriting regardless of user configuration.

#### Scenario: Default plugin creation

- **WHEN** `vitiatePlugin()` is called with no arguments
- **THEN** an array of two Vite plugins is returned: `vitiate:hooks` (`enforce: "pre"`) and `vitiate:instrument` (`enforce: "post"`)
- **AND** the instrument plugin instruments all JS/TS files except those in `node_modules`
- **AND** the hooks plugin skips files in `node_modules`
- **AND** no fuzz defaults are injected into the environment
- **AND** `server.deps` is not modified

#### Scenario: Plugin with fuzz defaults

- **WHEN** `vitiatePlugin({ fuzz: { maxLen: 4096, timeoutMs: 5000 } })` is called
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ_OPTIONS` to `{"maxLen":4096,"timeoutMs":5000}` if the env var is not already set
- **AND** fuzz tests that do not specify per-test options inherit these defaults

#### Scenario: Plugin with dataDir

- **WHEN** `vitiatePlugin({ dataDir: ".fuzzing" })` is called
- **THEN** the plugin's `config()` hook stores the absolute path of `.fuzzing` resolved relative to the Vite project root as module-scoped state
- **AND** the corpus management module uses this value as the test data root

#### Scenario: Plugin without dataDir uses default

- **WHEN** `vitiatePlugin()` is called without `dataDir`
- **THEN** the test data root defaults to `.vitiate/` relative to the project root

#### Scenario: cacheDir option no longer recognized

- **WHEN** `vitiatePlugin({ cacheDir: ".fuzz-cache" })` is called
- **THEN** the `cacheDir` option SHALL be ignored or produce a warning (it is no longer a valid option)

#### Scenario: Explicit VITIATE_FUZZ_OPTIONS env var takes precedence

- **WHEN** `VITIATE_FUZZ_OPTIONS={"maxLen":1024}` is already set in the environment
- **AND** `vitiatePlugin({ fuzz: { maxLen: 4096 } })` is called
- **THEN** `VITIATE_FUZZ_OPTIONS` retains the value `{"maxLen":1024}`
- **AND** the plugin config is ignored for that env var

#### Scenario: Custom exclude removes node_modules exclusion

- **WHEN** `vitiatePlugin({ instrument: { exclude: [] } })` is called
- **THEN** the instrument plugin instruments all files including those in `node_modules`
- **AND** the hooks plugin processes files in `node_modules` (rewriting hooked imports)
- **AND** the plugin's `config()` hook returns `server: { deps: { inline: true } }`

#### Scenario: Custom exclude with narrower node_modules pattern

- **WHEN** `vitiatePlugin({ instrument: { exclude: ["**/node_modules/lodash/**"] } })` is called
- **THEN** only files in `node_modules/lodash` are excluded from instrumentation
- **AND** the hooks plugin processes files outside `node_modules/lodash`
- **AND** `server.deps` is NOT modified (the heuristic detects `node_modules` in the exclude pattern substring)

#### Scenario: Custom include narrows scope

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**/*.ts"] } })` is called
- **THEN** only files matching `src/**/*.ts` are instrumented

#### Scenario: Narrowed include does not affect hooks plugin

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**/*.ts"] } })` is called
- **AND** a test file at `tests/parser.test.ts` imports `{ execSync } from "child_process"`
- **THEN** the hooks plugin rewrites the import in `tests/parser.test.ts` (detectors work)
- **AND** the instrument plugin does NOT instrument `tests/parser.test.ts` (not in include scope)

#### Scenario: Vitiate packages always excluded

- **WHEN** `vitiatePlugin({ instrument: { exclude: [] } })` is called
- **THEN** files in `@vitiate/core`, `@vitiate/engine`, and `@vitiate/swc-plugin` package directories are NOT instrumented
- **AND** the hooks plugin does NOT rewrite imports in vitiate package files

#### Scenario: Hooks plugin skips virtual modules regardless of config

- **WHEN** a virtual module (ID starting with `\0`) passes through the hooks plugin transform
- **THEN** the hooks plugin returns `null` regardless of include/exclude configuration

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

The plugin's `transform(code, id)` hook SHALL call `@swc/core.transform()` with the `@vitiate/swc-plugin` WASM plugin for every module that passes the include/exclude filter. The SWC transform SHALL insert edge coverage counters and comparison tracing calls into the JavaScript AST.

The WASM plugin path SHALL be resolved from the `@vitiate/swc-plugin` package's `main` field (the `.wasm` artifact).

#### Scenario: TypeScript file is instrumented

- **WHEN** a `.ts` file passes through the Vite pipeline and reaches the vitiate transform hook
- **THEN** the output JavaScript contains `__vitiate_cov[` counter increments at branch points
- **AND** the output JavaScript contains `__vitiate_trace_cmp(` calls replacing comparison operators

#### Scenario: node_modules file is skipped by default

- **WHEN** a file with path containing `node_modules` passes through the transform hooks with default options
- **THEN** the file is returned unchanged by both the hooks plugin and the instrument plugin

#### Scenario: node_modules file is instrumented when exclude is overridden

- **WHEN** a file with path containing `node_modules` passes through the transform hooks with `exclude: []`
- **THEN** the hooks plugin rewrites hooked imports in the file
- **AND** the instrument plugin instruments the file with coverage counters and comparison tracing

### Requirement: Setup file registration

The plugin SHALL register the runtime setup file via the `config()` hook by returning `{ test: { setupFiles: [setupPath] } }`. Vite deep-merges `config()` return values into the resolved config before Vitest processes them, ensuring the setup file is registered before any test code executes.

The `configureVitest` hook SHALL NOT be used for setup file registration because it fires after Vitest's project config is resolved and frozen - `setupFiles` cannot be modified at that point.

#### Scenario: Setup file is registered via config hook

- **WHEN** the vitiate plugin is loaded by Vitest
- **THEN** the plugin's `config()` hook returns a config object containing the vitiate runtime setup module in `test.setupFiles`
- **AND** the setup file is present in the resolved Vitest config before any tests execute

### ~~Requirement: Fuzz mode activation via --fuzz CLI flag~~ (REMOVED)

> **Removed in change `projects-fuzz-activation`.**
> **Reason**: Vitest's `cac` CLI parser rejects unknown flags before the plugin's `config()` hook runs, making `parseFuzzFlag()` dead code. The Vitest maintainers have explicitly declined to support plugin-extensible CLI flags. `VITIATE_FUZZ=1` is the sole activation mechanism.
> **Migration**: Use `VITIATE_FUZZ=1 vitest run` instead of `vitest --fuzz`. Use Vitest's `-t` flag instead of `--fuzz=<pattern>`.

### Requirement: Hook import bail-out optimization

The `rewriteHookedImports` function SHALL perform a quick bail-out check before parsing: if the source code does not reference any hooked module in an import-like context, the function SHALL return `null` without invoking `es-module-lexer`.

The bail-out check for each hooked module SHALL use patterns that match how the module appears in import or require statements, not bare substring matching. For `child_process`, `fs/promises`, and `http2`, `code.includes(mod)` is sufficiently specific because these strings are unlikely to appear as substrings of unrelated identifiers. For `fs`, the check SHALL use patterns that avoid matching unrelated occurrences of the substring "fs" (e.g., in identifiers like `offset`, function names, or comments). Suitable patterns include checking for `'"fs"'`, `"'fs'"`, `':fs"'`, or `"':fs'"`.

The bail-out is a performance optimization only - false positives (proceeding to parse when no hooked imports exist) are acceptable, but false negatives (skipping a file that does contain hooked imports) are not.

#### Scenario: File without hooked module imports skips parsing

- **WHEN** `rewriteHookedImports` is called with source code that does not contain any hooked module import
- **THEN** the function SHALL return `null` without calling `es-module-lexer`

#### Scenario: File with fs import proceeds to parsing

- **WHEN** `rewriteHookedImports` is called with source code containing `import { readFile } from "fs"`
- **THEN** the bail-out check SHALL detect the hooked module reference
- **AND** the function SHALL proceed to parse and potentially rewrite imports

#### Scenario: File containing "fs" in identifier does not trigger parsing

- **WHEN** `rewriteHookedImports` is called with source code containing `const offset = 42` but no `fs` module import
- **THEN** the bail-out check SHALL NOT treat `offset` as a reference to the `fs` module
- **AND** the function SHALL return `null` (assuming no other hooked module is referenced)

#### Scenario: File with fs/promises import proceeds to parsing

- **WHEN** `rewriteHookedImports` is called with source code containing `import { readFile } from "fs/promises"`
- **THEN** the bail-out check SHALL detect the hooked module reference
- **AND** the function SHALL proceed to parse and potentially rewrite imports
