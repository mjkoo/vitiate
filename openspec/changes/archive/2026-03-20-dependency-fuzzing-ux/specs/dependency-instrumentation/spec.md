## ADDED Requirements

### Requirement: Package instrumentation option

The `InstrumentOptions` interface SHALL accept an optional `packages` field (`string[]`) listing npm package names to instrument. When `packages` is specified, the plugin SHALL automatically:

1. Add a regex pattern for each listed package to the `test.server.deps.inline` array returned from the plugin's `config()` hook. This causes vitest to route the package through the Vite transform pipeline instead of externalizing it.
2. In the `transform` hook, instrument modules belonging to listed packages regardless of the `include`/`exclude` filter. The `include`/`exclude` filter is not consulted for packages - they are a separate instrumentation domain.

Package matching SHALL use substring matching on the resolved module ID for the pattern `/node_modules/<packageName>/`. The match MUST be on a path segment boundary (the package name MUST be preceded by `/node_modules/` and followed by `/`) to prevent partial name matches (e.g., `flat` SHALL NOT match `flatted`).

This matching strategy SHALL handle all common Node.js package manager layouts:
- Standard: `node_modules/flatted/src/index.js`
- pnpm: `node_modules/.pnpm/flatted@3.4.1/node_modules/flatted/src/index.js`
- Nested: `node_modules/foo/node_modules/flatted/src/index.js`

When `packages` is not specified or is an empty array, no dependencies SHALL be inlined or instrumented by the plugin, and the `test.server.deps.inline` configuration SHALL NOT be modified.

Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) SHALL remain unconditionally excluded from instrumentation even if listed in `packages`.

#### Scenario: Single package instrumented

- **WHEN** `vitiatePlugin({ instrument: { packages: ["flatted"] } })` is called
- **THEN** the plugin's `config()` hook returns `test.server.deps.inline` containing a pattern matching `flatted`
- **AND** modules with paths containing `/node_modules/flatted/` are instrumented with coverage counters and comparison tracing
- **AND** modules in other node_modules packages are NOT instrumented

#### Scenario: Multiple packages instrumented

- **WHEN** `vitiatePlugin({ instrument: { packages: ["flatted", "lodash"] } })` is called
- **THEN** the plugin's `config()` hook returns `test.server.deps.inline` containing patterns matching both `flatted` and `lodash`
- **AND** modules in both packages are instrumented
- **AND** modules in other node_modules packages are NOT instrumented

#### Scenario: pnpm nested layout matched

- **WHEN** `packages: ["flatted"]` is configured
- **AND** the resolved module path is `node_modules/.pnpm/flatted@3.4.1/node_modules/flatted/src/index.js`
- **THEN** the module is matched and instrumented

#### Scenario: Partial package name does not match

- **WHEN** `packages: ["flat"]` is configured
- **AND** a module path contains `/node_modules/flatted/src/index.js`
- **THEN** the module is NOT matched (path segment boundary prevents `flat` matching `flatted`)

#### Scenario: Empty packages list

- **WHEN** `vitiatePlugin({ instrument: { packages: [] } })` is called
- **THEN** no dependencies are inlined
- **AND** no dependencies are instrumented
- **AND** `test.server.deps.inline` is NOT modified

#### Scenario: Packages does not affect include/exclude

- **WHEN** `vitiatePlugin({ instrument: { include: ["src/**"], packages: ["flatted"] } })` is called
- **THEN** only files matching `src/**` are instrumented from the user's own code
- **AND** flatted modules are instrumented regardless of the `include` pattern
- **AND** the two instrumentation domains are independent

#### Scenario: Scoped package instrumented

- **WHEN** `packages: ["@scope/pkg"]` is configured
- **AND** a module path contains `/node_modules/@scope/pkg/src/index.js`
- **THEN** the module is matched and instrumented

#### Scenario: Nonexistent package listed

- **WHEN** `packages: ["nonexistent"]` is configured
- **AND** no module path contains `/node_modules/nonexistent/`
- **THEN** no modules are instrumented for that package
- **AND** at `buildEnd`, the plugin SHALL emit a warning on stderr indicating that the package was listed but no modules from it were transformed, to help catch typos and missing installations

#### Scenario: Packages inline entries merge with user-provided inline config

- **WHEN** `packages: ["flatted"]` is configured
- **AND** the user's vitest config includes `test.server.deps.inline: [/some-regex/]`
- **THEN** the resolved `test.server.deps.inline` contains both the user's pattern and the plugin's flatted pattern
- **AND** Vite's `mergeConfig` concatenates the arrays (plugin entries appended to user entries)

#### Scenario: Packages instrumentation independent of exclude patterns

- **WHEN** `vitiatePlugin({ instrument: { exclude: ["**/flatted/**"], packages: ["flatted"] } })` is called
- **THEN** flatted modules are instrumented (packages bypass the include/exclude filter)
- **AND** the `exclude` pattern has no effect on the packages instrumentation domain

#### Scenario: Vitiate packages rejected from packages list

- **WHEN** `packages: ["@vitiate/core"]` is configured
- **THEN** `@vitiate/core` modules are NOT instrumented (vitiate's own packages are unconditionally excluded)

### Requirement: Hooks plugin processes listed packages

The `vitiate:hooks` plugin SHALL process modules belonging to packages listed in `instrument.packages`, bypassing the exclude filter for those modules. This is necessary because `**/node_modules/**` is always in the internal exclude list, which would otherwise cause the hooks plugin to skip dependency modules. For listed packages, the hooks plugin SHALL rewrite ESM named imports of hooked built-in modules, ensuring detector hooks intercept calls from instrumented dependencies.

#### Scenario: Hooked import in listed package is rewritten

- **WHEN** `packages: ["flatted"]` is configured
- **AND** a module in `flatted` contains `import { execSync } from "child_process"`
- **THEN** the hooks plugin rewrites the import to default import + destructuring

#### Scenario: Unlisted package not processed by hooks plugin

- **WHEN** `packages: ["flatted"]` is configured
- **AND** a module in `lodash` contains `import { execSync } from "child_process"`
- **THEN** the hooks plugin does NOT process the module (lodash is not listed, and node_modules is excluded)
