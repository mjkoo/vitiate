## MODIFIED Requirements

### Requirement: Plugin factory function

The system SHALL export a `vitiatePlugin(options?)` function that returns an array of two Vite plugins (`Plugin[]`):

- **`vitiate:hooks`** (`enforce: "pre"`): Rewrites ESM named imports of hooked built-in modules (`child_process`, `fs`, `fs/promises`, `http2`) into default import + destructuring. This ensures imported values are read from the live module object at call time rather than from the frozen ESM namespace that Vitest externalizes at startup, enabling detector module hooks to intercept calls.
- **`vitiate:instrument`** (`enforce: "post"`): Runs SWC instrumentation (edge coverage counters, comparison tracing) after all other transforms (TypeScript, JSX, etc. are already compiled to JavaScript).

The `options` parameter SHALL accept:

- An optional `instrument` object with:
  - `include` (string[], default `["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"]`): Glob patterns for files to instrument. Only affects the user's own code (not dependencies).
  - `exclude` (string[], default `[]`): Glob patterns for files to skip. Only affects the user's own code (not dependencies). `**/node_modules/**` is always appended internally regardless of this value.
  - `packages` (string[], optional): npm package names to instrument. See the `dependency-instrumentation` capability.

- An optional `fuzz` object with project-wide fuzzing defaults:
  - `maxLen` (number, optional): Maximum input length in bytes.
  - `timeoutMs` (number, optional): Per-execution timeout in milliseconds.
  - `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
  - `fuzzExecs` (number, optional): Maximum number of fuzzing iterations.
  - `seed` (number, optional): RNG seed for reproducible fuzzing.

- `dataDir` (string, optional): Test data root directory path, resolved relative to project root. When set, the value SHALL be resolved relative to the Vite project root and stored as module-scoped state. When not set, the default is `.vitiate/` relative to the project root.

- `coverageMapSize` (number, optional, default 65536): Number of edge counter slots in the coverage map. Must be an integer in [256, 4194304]. Larger values reduce hash collisions for large applications. A warning is emitted if the value is not a power of two.

**`include`/`exclude` precedence:** The `include` and `exclude` options use the same precedence model as the path traversal detector's `allowedPaths`/`deniedPaths` - the negative list always wins:

1. If a file matches any `exclude` pattern, it is **not instrumented** (exclude wins, no override possible)
2. If a file matches any `include` pattern, it **is instrumented**
3. If no `include` patterns are specified, all non-excluded JS/TS files are instrumented
4. If `include` patterns are specified but a file doesn't match any, it is **not instrumented**

`include`/`exclude` SHALL only affect the user's own code. `**/node_modules/**` SHALL always be appended to the internal exclude list regardless of user-provided `exclude` patterns. Dependency instrumentation is exclusively controlled by the `packages` option (see `dependency-instrumentation` capability).

The `vitiate:hooks` plugin SHALL use the resolved exclude patterns (but NOT the include patterns) to determine whether a file should be processed. The hooks plugin SHALL also process modules belonging to packages listed in `instrument.packages`, bypassing the exclude filter for those modules. This ensures detector import rewriting works in instrumented dependencies. The hooks plugin SHALL process all non-excluded JS/TS files regardless of the include patterns - because detector import rewriting must work across all user code (including test files) even when instrumentation scope is narrowed via include. Virtual modules (IDs starting with `\0`) and non-JS/TS files SHALL still be skipped unconditionally.

Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) SHALL remain unconditionally excluded from both instrumentation and hook rewriting regardless of user configuration.

**Migration from `nodeModulesExcluded` heuristic:** The previous behavior where removing "node_modules" from exclude patterns triggered `inline: true` for all dependencies is removed. Use `instrument: { packages: ["package-name"] }` to instrument specific dependencies. The `include`/`exclude` options no longer affect dependency inlining.

#### Scenario: Default plugin creation

- **WHEN** `vitiatePlugin()` is called with no arguments
- **THEN** an array of two Vite plugins is returned: `vitiate:hooks` (`enforce: "pre"`) and `vitiate:instrument` (`enforce: "post"`)
- **AND** the instrument plugin instruments all JS/TS files except those in `node_modules`
- **AND** the hooks plugin skips files in `node_modules`
- **AND** no fuzz defaults are injected into the environment
- **AND** `test.server.deps.inline` is not modified

#### Scenario: Plugin with fuzz defaults

- **WHEN** `vitiatePlugin({ fuzz: { maxLen: 4096, timeoutMs: 5000 } })` is called
- **THEN** the plugin's `config()` hook sets `VITIATE_OPTIONS` to `{"maxLen":4096,"timeoutMs":5000}` if the env var is not already set
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

#### Scenario: Explicit VITIATE_OPTIONS env var takes precedence

- **WHEN** `VITIATE_OPTIONS={"maxLen":1024}` is already set in the environment
- **AND** `vitiatePlugin({ fuzz: { maxLen: 4096 } })` is called
- **THEN** `VITIATE_OPTIONS` retains the value `{"maxLen":1024}`
- **AND** the plugin config is ignored for that env var

#### Scenario: Custom exclude carves out user code

- **WHEN** `vitiatePlugin({ instrument: { exclude: ["src/generated/**"] } })` is called
- **THEN** files in `src/generated/` are NOT instrumented
- **AND** files in `node_modules` are NOT instrumented (always excluded internally)
- **AND** `server.deps.inline` is NOT modified

#### Scenario: Custom include narrows scope

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**/*.ts"] } })` is called
- **THEN** only files matching `src/**/*.ts` are instrumented
- **AND** files in `node_modules` are NOT instrumented (always excluded internally)

#### Scenario: Exclude takes precedence over include

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**"], exclude: ["src/generated/**"] } })` is called
- **THEN** files in `src/` are instrumented EXCEPT files in `src/generated/`
- **AND** the exclude pattern wins for files matching both

#### Scenario: node_modules always excluded from include/exclude filter

- **WHEN** `vitiatePlugin({ instrument: { exclude: [] } })` is called
- **THEN** files in `node_modules` are still NOT instrumented via the include/exclude filter
- **AND** `server.deps.inline` is NOT modified
- **AND** dependency instrumentation requires the `packages` option

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
- **THEN** the hooks plugin returns `null` regardless of include/exclude configuration or packages list

### Requirement: Transform hook instruments code via SWC

The plugin's `transform(code, id)` hook SHALL call `@swc/core.transform()` with the `@vitiate/swc-plugin` WASM plugin for every module that passes the include/exclude filter OR belongs to a package listed in `instrument.packages`. The SWC transform SHALL insert edge coverage counters and comparison tracing calls into the JavaScript AST.

The WASM plugin path SHALL be resolved from the `@vitiate/swc-plugin` package's `main` field (the `.wasm` artifact).

#### Scenario: TypeScript file is instrumented

- **WHEN** a `.ts` file passes through the Vite pipeline and reaches the vitiate transform hook
- **THEN** the output JavaScript contains `__vitiate_cov[` counter increments at branch points
- **AND** the output JavaScript contains `__vitiate_cmplog_write(` calls replacing comparison operators

#### Scenario: node_modules file is skipped by default

- **WHEN** a file with path containing `node_modules` passes through the transform hooks with default options
- **THEN** the file is returned unchanged by both the hooks plugin and the instrument plugin

#### Scenario: Listed package file is instrumented

- **WHEN** `packages: ["flatted"]` is configured
- **AND** a file at `node_modules/flatted/src/index.js` passes through the transform hook
- **THEN** the instrument plugin instruments the file with coverage counters and comparison tracing

#### Scenario: Unlisted package file is not instrumented

- **WHEN** `packages: ["flatted"]` is configured
- **AND** a file at `node_modules/lodash/index.js` passes through the transform hook
- **THEN** the instrument plugin does NOT instrument the file

## REMOVED Requirements

### ~~Requirement: `nodeModulesExcluded` heuristic~~ (REMOVED)

> **Removed in change `dependency-fuzzing-ux`.**
> **Reason:** The heuristic (setting `server: { deps: { inline: true } }` when no exclude pattern contains the substring "node_modules") was confusing, all-or-nothing, and crashed on many real-world dependency sets. Replaced by the explicit `instrument.packages` option in the `dependency-instrumentation` capability.
> **Migration:** Use `instrument: { packages: ["package-name"] }` to instrument specific dependencies instead of removing "node_modules" from exclude patterns.

The following main-spec content is removed:

- The paragraph: "When the resolved `exclude` patterns do not contain any pattern with the substring `node_modules`, the plugin's `config()` hook SHALL return `server: { deps: { inline: true } }`..."
- The paragraph: "When the resolved `exclude` patterns contain at least one pattern with the substring `node_modules` (the default), the plugin SHALL NOT modify `server.deps` configuration."
- Scenario: "Custom exclude removes node_modules exclusion"
- Scenario: "Custom exclude with narrower node_modules pattern"

### ~~Requirement: Transform hook instruments node_modules when exclude overridden~~ (REMOVED)

> **Removed in change `dependency-fuzzing-ux`.**
> **Reason:** With `**/node_modules/**` always appended to the internal exclude list, the scenario where `exclude: []` causes node_modules to be instrumented via the include/exclude filter no longer applies. Dependency instrumentation is exclusively via `instrument.packages`.

The following main-spec content is removed:

- Scenario: "node_modules file is instrumented when exclude is overridden"

## ADDED Requirements

### Requirement: Config file capture and early globals initialization

The `vitiate:instrument` plugin SHALL add a `configResolved` hook that:

1. Captures the resolved config file path from `resolvedConfig.configFile`. This is a standard Vite property containing the resolved absolute path to the config file, or `false` if no config file was used. The captured path SHALL be stored as module-scoped state via `setConfigFile`/`getConfigFile` accessors exported from `config.ts`. This value is consumed by the supervisor's `spawnChild` callback to forward `--config` to child vitest processes.

2. Initializes `globalThis.__vitiate_cov` with the coverage map buffer. In regression mode, this SHALL be a plain `Uint8Array`. In fuzz mode (`VITIATE_FUZZ` env var set), this SHALL load the `@vitiate/engine` napi addon and call `createCoverageMap()` to get the Rust-backed buffer. If the napi addon fails to load in fuzz mode, the hook SHALL throw, failing the Vitest startup (fail-fast - a missing addon in fuzz mode is unrecoverable). This ensures the coverage map exists before any instrumented code (including inlined dependency modules) can execute.

3. Initializes `globalThis.__vitiate_cmplog_write` with a stable forwarding wrapper. The wrapper delegates to an internal implementation variable, initially set to a no-op. `setup.ts` later swaps the internal implementation to the real slot-buffer writer in fuzz mode. The wrapper function reference itself never changes, preserving identity for modules that cache it at module scope.

**Vite lifecycle guarantee:** Vite awaits `configResolved` hooks (including async hooks) to completion before proceeding to module resolution, transforms, or evaluation. This guarantees that the globals initialized in this hook are available before any instrumented code can execute, including inlined dependency modules. This ordering is the foundational assumption for the early-init approach.

#### Scenario: Config file path captured from resolved config

- **WHEN** the plugin's `configResolved` hook runs
- **AND** the resolved config has a `configFile` property set to `/project/vitest.config.ts`
- **THEN** the config file path is stored as `/project/vitest.config.ts`

#### Scenario: No config file used

- **WHEN** the plugin's `configResolved` hook runs
- **AND** the resolved config has `configFile` set to `false`
- **THEN** the config file path is stored as `undefined` (no path to forward)

#### Scenario: Coverage map initialized before module transforms

- **WHEN** the plugin's `configResolved` hook completes
- **THEN** `globalThis.__vitiate_cov` is a valid writable buffer
- **AND** any subsequently transformed and evaluated module can safely write to `__vitiate_cov[id]`

#### Scenario: Fuzz mode creates Rust-backed buffer early

- **WHEN** the plugin's `configResolved` hook runs with `VITIATE_FUZZ=1`
- **THEN** `globalThis.__vitiate_cov` is the Rust-backed `Buffer` from `createCoverageMap()`
- **AND** the same buffer is used by the fuzz loop for zero-copy feedback (no replacement needed)

#### Scenario: Napi addon load failure in fuzz mode

- **WHEN** the plugin's `configResolved` hook runs with `VITIATE_FUZZ=1`
- **AND** the `@vitiate/engine` napi addon fails to load (e.g., missing prebuilt binary)
- **THEN** the hook throws an error
- **AND** the Vitest startup fails immediately (fail-fast)

#### Scenario: Trace function wrapper preserves identity

- **WHEN** the plugin's `configResolved` hook sets `globalThis.__vitiate_cmplog_write`
- **AND** a module caches the function reference at module scope during early evaluation
- **AND** `setup.ts` later swaps the internal implementation
- **THEN** the cached function reference still delegates to the new implementation
