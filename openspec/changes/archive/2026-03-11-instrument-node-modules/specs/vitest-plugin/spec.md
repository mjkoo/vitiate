## MODIFIED Requirements

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

- `cacheDir` (string, optional): Cache directory path, resolved relative to project root.

- `coverageMapSize` (number, optional, default 65536): Number of edge counter slots in the coverage map. Must be an integer in [256, 4194304]. Larger values reduce hash collisions for large applications. A warning is emitted if the value is not a power of two.

The `vitiate:hooks` plugin SHALL use the resolved exclude patterns (but NOT the include patterns) to determine whether a file should be processed. The hooks plugin SHALL NOT hardcode a node_modules exclusion independent of the configured exclude patterns. The hooks plugin SHALL process all JS/TS files not matched by the exclude patterns, regardless of the include patterns — because detector import rewriting must work across all user code (including test files) even when instrumentation scope is narrowed via include. Virtual modules (IDs starting with `\0`) and non-JS/TS files SHALL still be skipped unconditionally.

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

#### Scenario: Plugin with cacheDir

- **WHEN** `vitiatePlugin({ cacheDir: ".fuzz-cache" })` is called
- **THEN** the plugin's `config()` hook stores the absolute path of `.fuzz-cache` resolved relative to the Vite project root as module-scoped state
- **AND** the corpus management module uses this value for cache directory resolution

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
