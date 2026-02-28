## ADDED Requirements

### Requirement: Plugin factory function

The system SHALL export a `vitiatePlugin(options?)` function that returns a Vite plugin object. The plugin SHALL have the name `"vitiate"` and set `enforce: "post"` so its transform hook runs after all other transforms (TypeScript, JSX, etc. are already compiled to JavaScript).

The `options` parameter SHALL accept an optional `instrument` object with:

- `include` (string[], default `["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"]`): Glob patterns for files to instrument.
- `exclude` (string[], default `["**/node_modules/**"]`): Glob patterns for files to skip.

#### Scenario: Default plugin creation

- **WHEN** `vitiatePlugin()` is called with no arguments
- **THEN** a Vite plugin is returned with `name: "vitiate"` and `enforce: "post"`
- **AND** the plugin instruments all JS/TS files except those in `node_modules`

#### Scenario: Custom exclude overrides default

- **WHEN** `vitiatePlugin({ instrument: { exclude: [] } })` is called
- **THEN** the plugin instruments all files including those in `node_modules`

#### Scenario: Custom include narrows scope

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**/*.ts"] } })` is called
- **THEN** only files matching `src/**/*.ts` are instrumented

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

### Requirement: configureVitest lifecycle hook

The plugin SHALL implement the `configureVitest(context)` hook to integrate with Vitest's lifecycle. This hook SHALL configure the runtime setup file as a `setupFiles` entry so that global coverage map and trace function are initialized before any test code executes.

#### Scenario: Setup file is registered

- **WHEN** the vitiate plugin is loaded by Vitest
- **THEN** the plugin's `configureVitest` hook adds the vitiate runtime setup module to Vitest's `setupFiles` configuration
