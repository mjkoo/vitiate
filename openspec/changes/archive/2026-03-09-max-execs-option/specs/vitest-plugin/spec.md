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
  - `fuzzTimeMs` (number, optional): Total fuzzing time limit in milliseconds.
  - `fuzzExecs` (number, optional): Maximum number of fuzzing iterations.
  - `seed` (number, optional): RNG seed for reproducible fuzzing.

- `cacheDir` (string, optional): Cache directory path, resolved relative to project root.

- `coverageMapSize` (number, optional, default 65536): Number of edge counter slots in the coverage map. Must be an integer in [256, 4194304]. Larger values reduce hash collisions for large applications. A warning is emitted if the value is not a power of two.

#### Scenario: Default plugin creation

- **WHEN** `vitiatePlugin()` is called with no arguments
- **THEN** a Vite plugin is returned with `name: "vitiate"` and `enforce: "post"`
- **AND** the plugin instruments all JS/TS files except those in `node_modules`
- **AND** no fuzz defaults are injected into the environment
