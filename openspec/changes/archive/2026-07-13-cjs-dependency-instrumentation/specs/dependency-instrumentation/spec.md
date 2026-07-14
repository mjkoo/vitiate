## MODIFIED Requirements

### Requirement: Package instrumentation option

The `InstrumentOptions` interface SHALL accept an optional `packages` field (`string[]`) listing npm package names to instrument. The plugin's `config()` hook SHALL add a regex pattern for each listed package to the `test.server.deps.inline` array; because `config()` runs before any resolution or classification is possible, patterns are added for all listed packages unconditionally (load-bearing for ESM entries, harmless belt-and-suspenders for compiled CommonJS entries). Each listed package's resolved entry SHALL then be classified as CommonJS or ESM (see the resolved-entry classification requirement), and the plugin SHALL instrument it via the path appropriate to that classification:

1. **ESM entries** keep today's inline+transform path: the inline pattern routes the package through the Vite transform pipeline instead of externalizing it.
2. **CommonJS entries** are compiled to an instrumentable ESM bundle owned by the plugin's `resolveId`/`load` hooks (see the CommonJS dependency compilation requirement), because inlining alone cannot instrument multi-file CJS packages.

In both cases, in the `transform` hook, the plugin SHALL instrument modules belonging to listed packages regardless of the `include`/`exclude` filter. The `include`/`exclude` filter is not consulted for packages - they are a separate instrumentation domain.

Package matching SHALL use substring matching on the resolved module ID for the pattern `/node_modules/<packageName>/`. The match MUST be on a path segment boundary (the package name MUST be preceded by `/node_modules/` and followed by `/`) to prevent partial name matches (e.g., `flat` SHALL NOT match `flatted`).

This matching strategy SHALL handle all common Node.js package manager layouts:
- Standard: `node_modules/flatted/src/index.js`
- pnpm: `node_modules/.pnpm/flatted@3.4.1/node_modules/flatted/src/index.js`
- Nested: `node_modules/foo/node_modules/flatted/src/index.js`

When `packages` is not specified or is an empty array, no dependencies SHALL be inlined, compiled, or instrumented by the plugin, and the `test.server.deps.inline` configuration SHALL NOT be modified.

Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) SHALL remain unconditionally excluded from instrumentation even if listed in `packages`.

#### Scenario: Single package instrumented

- **WHEN** `vitiatePlugin({ instrument: { packages: ["flatted"] } })` is called
- **THEN** the plugin's `config()` hook returns `test.server.deps.inline` containing a pattern matching `flatted`
- **AND** modules with paths containing `/node_modules/flatted/` are instrumented with coverage counters and comparison tracing
- **AND** modules in other node_modules packages are NOT instrumented

#### Scenario: Multiple packages instrumented

- **WHEN** `vitiatePlugin({ instrument: { packages: ["flatted", "lodash"] } })` is called
- **THEN** the plugin's `config()` hook returns `test.server.deps.inline` containing patterns matching both `flatted` and `lodash`
- **AND** code from both packages is instrumented, each via the path its resolved entry classifies to (per-module for ESM entries, bundle-entry for CommonJS entries)
- **AND** code in other node_modules packages is NOT instrumented

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
- **THEN** no dependencies are inlined or compiled
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

#### Scenario: Listed package never imported by executed tests

- **WHEN** `packages: ["flatted"]` is configured and `flatted` resolves and (if CJS) compiles successfully
- **AND** no module from `flatted` is transformed during the run (e.g., a filtered run or a conditional import that never executes)
- **THEN** at `buildEnd`, the plugin SHALL emit a warning on stderr naming the package and stating that it was listed but never imported by the tests that ran
- **AND** the run SHALL NOT be aborted (this case can be legitimate)

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

The `vitiate:hooks` plugin SHALL process modules belonging to packages listed in `instrument.packages`, bypassing the exclude filter for those modules. This is necessary because `**/node_modules/**` is always in the internal exclude list, which would otherwise cause the hooks plugin to skip dependency modules. For a listed package's modules that contain ESM named imports of hooked built-in modules, the hooks plugin SHALL rewrite those imports, ensuring detector hooks intercept calls from instrumented dependencies. Compiled CommonJS bundles reach detector hooks through their runtime `require` bridge instead (see the detector-hooks-in-bundled-CommonJS requirement), so they need no import rewriting; the hooks plugin nonetheless still runs over the bundle and rewrites any real ESM imports of hooked builtins that esbuild emits for external ESM sources.

#### Scenario: Hooked import in listed package is rewritten

- **WHEN** `packages: ["flatted"]` is configured
- **AND** a module in `flatted` contains `import { execSync } from "child_process"`
- **THEN** the hooks plugin rewrites the import to default import + destructuring

#### Scenario: Unlisted package not processed by hooks plugin

- **WHEN** `packages: ["flatted"]` is configured
- **AND** a module in `lodash` contains `import { execSync } from "child_process"`
- **THEN** the hooks plugin does NOT process the module (lodash is not listed, and node_modules is excluded)

## ADDED Requirements

### Requirement: Resolved-entry CommonJS/ESM classification

The plugin SHALL classify each listed package's *resolved entry file* - the file that will actually flow through the pipeline - as CommonJS or ESM, and SHALL NOT trust package metadata fields (`module`, `exports` import conditions) as classification inputs, because Vite's SSR resolution can select a CommonJS `main` even when a `module` field exists. Classification SHALL agree with what resolution actually produced.

Classification SHALL apply these rules to the resolved entry file, extension first - the `package.json` `type` field governs only `.js` files:
- A `.mjs` extension SHALL classify as ESM.
- A `.cjs` extension SHALL classify as CommonJS, even when the nearest `package.json` has `type: "module"`.
- A `.js` extension SHALL classify as ESM when the nearest `package.json` has `type: "module"`; otherwise it SHALL be parsed with `es-module-lexer`: presence of ESM `import`/`export` syntax SHALL classify as ESM, otherwise CommonJS.

Classification results SHALL be cached per resolved entry. ESM entries continue through the existing inline+transform path unchanged; CommonJS entries are compiled (see the CommonJS dependency compilation requirement).

#### Scenario: Pure-CommonJS main classified as CJS

- **WHEN** a listed package's resolved entry is a `.js` file with no ESM syntax and no `type: "module"` in the nearest `package.json`
- **THEN** the entry is classified as CommonJS
- **AND** it is routed through the compilation path

#### Scenario: ESM entry classified as ESM

- **WHEN** a listed package's resolved entry is an `.mjs` file, or a `.js` file under a `package.json` with `type: "module"`, or a `.js` file containing ESM `import`/`export` syntax
- **THEN** the entry is classified as ESM
- **AND** it continues through the existing inline+transform path unchanged

#### Scenario: .cjs entry under type module classified as CJS

- **WHEN** a listed package's resolved entry is a `.cjs` file and the nearest `package.json` declares `type: "module"`
- **THEN** the entry is classified as CommonJS (the extension takes precedence; the `type` field governs only `.js` files)
- **AND** it is routed through the compilation path

#### Scenario: Metadata module field does not override resolved CJS entry

- **WHEN** a listed package declares a `module` field but Vite's SSR resolution selects the CommonJS `main` entry
- **THEN** classification operates on the resolved CommonJS `main`, not the `module` metadata
- **AND** the package is classified as CommonJS and compiled (rather than left on the broken externalization path)

### Requirement: CommonJS dependency compilation

For a listed package whose resolved entry is classified as CommonJS, the plugin SHALL take ownership of the entry via `resolveId` and `load` hooks and serve an instrumentable ESM bundle of the package's own sources, so the package's code cannot be externalized past the SWC transform and its internal relative `require` calls cannot escape to native require.

- `resolveId(source, importer)` SHALL resolve the requested entry and return an owned, non-external id for it so that Vitest cannot externalize the module.
- `load(id)` SHALL return an esbuild bundle built from a generated synthetic ESM entry (see the export-shape clause below) with `bundle: true`, `format: "esm"`, `platform: "node"`, `packages: "external"`, external `*.node`, and an external source map, returned as `{ code, map }`. Because `packages: "external"` is set, only the package's own relative `require`s are inlined; bare-specifier imports (the package's npm dependencies and Node builtins) stay external.
- The compiled bundle SHALL include a `banner` that establishes a native `require` in module scope via `createRequire` called with the real package entry's file URL embedded literally at build time (not derived from `import.meta.url`), so external static and dynamic requires resolve with native Node semantics from the real entry path regardless of the id the bundle is served under.
- The bundle SHALL preserve the package's native import surface: its default export SHALL be the entry's `module.exports`, and it SHALL re-export the named exports Node's CJS-ESM interop would synthesize - enumerated with `cjs-module-lexer` on the real entry, following re-export chains through the package's relative files as Node does. Names that are not valid identifiers, and `default`, SHALL be skipped; a lexing failure SHALL fall back to default-only exports, matching Node's behavior for unlexable CommonJS.
- The existing enforce:"post" `transform` SHALL match the bundle entry id via package matching and SHALL SWC-instrument the bundle unchanged.

A listed CommonJS package's own npm dependencies SHALL NOT be instrumented - they remain external to the bundle - so instrumentation stays strictly "the packages you listed". Coverage for an instrumented CommonJS dependency SHALL be attributed at bundle-entry (package or subpath) granularity; distinct source spans SHALL still produce distinct edge ids so the coverage-guided feedback signal is preserved, and the source map SHALL map crash stack traces back to the original source files.

ESM-classified packages SHALL return early from `resolveId`/`load` without interception.

#### Scenario: Multi-file CommonJS package instrumented end-to-end

- **WHEN** a listed pure-CommonJS multi-file package is imported by an executed test
- **THEN** `resolveId`/`load` serve an ESM bundle inlining the package's internal relative requires
- **AND** the bundle is SWC-instrumented, producing coverage edges that grow as inputs explore the package (not just wrapper-file edges)
- **AND** no module from the package escapes to native require

#### Scenario: Named import from a bundled CommonJS package works

- **WHEN** user code contains `import { parse } from "pkg"` for a listed CommonJS package whose `module.exports.parse` is a function
- **THEN** the import succeeds and binds the same value native Node interop would provide
- **AND** the run does NOT fail with a missing-export error

#### Scenario: Package own dependencies stay external

- **WHEN** a bundled CommonJS package requires one of its own npm dependencies by bare specifier
- **THEN** that dependency is left external to the bundle and resolves through the runtime `require` bridge at load time
- **AND** the dependency's code is NOT instrumented or attributed to the listed package

#### Scenario: External requires resolve via the runtime bridge

- **WHEN** a bundled CommonJS package calls `require("crypto")` or another Node builtin
- **THEN** the injected `createRequire` banner resolves it with native semantics from the real package entry path
- **AND** the require does not throw a "Dynamic require is not supported" error

### Requirement: Subpath import instrumentation

The plugin SHALL intercept and instrument subpath imports (`pkg/sub`) of a listed package in addition to its bare specifier. Each distinct resolved entry SHALL be classified and, if CommonJS, bundled independently, with the cache keyed per entry and edge ids hashing per entry id so entries never collide in the coverage map.

Because subpath entries cannot be enumerated at startup, each SHALL be classified and (if CommonJS) compiled lazily on its first resolve, using the same resolver and cache as root entries. A subpath bundle failure SHALL be raised as a hard error at that first import - with the same semantics as the bundle-failed cause of the startup-errors requirement - never a silent fallthrough to native require.

#### Scenario: Subpath entry of a listed CJS package instrumented

- **WHEN** `packages` lists a CommonJS package and an executed test imports `pkg/sub` of it
- **THEN** the subpath's resolved entry is classified and (if CommonJS) bundled independently
- **AND** coverage from the subpath entry is instrumented and attributed to that subpath entry id

#### Scenario: Subpath bundle failure is a hard error at first import

- **WHEN** a listed CommonJS package's subpath entry fails to compile with esbuild on its first resolve
- **THEN** a hard error naming the package and subpath, with esbuild diagnostics attached, is raised
- **AND** the module is NOT silently loaded uninstrumented through native require

### Requirement: Eager compilation and bundle cache

The plugin SHALL resolve and classify every listed package's root entry, and compile every CommonJS one, eagerly in an async `buildStart` that Vite awaits before any transform, so that misconfiguration failures surface at startup and `load` for a root entry reduces to a cache lookup. Subpath entries are the one lazy case (see the subpath import instrumentation requirement). Eager `buildStart` resolution and request-time `resolveId` resolution SHALL use the same resolver with identical options, so the entry classified eagerly is the entry served later. A `load` for a root entry absent from the cache SHALL be treated as an internal error, not a silent fallthrough to native require.

Compiled bundles SHALL be cached on disk under the Vite/vitiate cache directory, keyed by (package name, resolved version, resolved entry path, entry mtime, package.json mtime, toolchain fingerprint), where the toolchain fingerprint covers the esbuild version and the bundle recipe (build options, banner, synthetic-entry schema) so that upgrading esbuild or changing the recipe invalidates prior bundles. A cache hit reuses the bundle; any key change rebuilds it. Cache writes SHALL be atomic (write to a temporary file, then rename) so concurrent processes compiling the same package never observe a partial bundle. The cache SHALL be bypassed (always rebuild) when the resolved package directory lies outside `node_modules` (the workspace / `file:` / `link:` case, where version and mtime keys are unreliable). esbuild SHALL be imported lazily so configs without CommonJS packages never load it.

#### Scenario: Bundle cache hit reuses compiled output

- **WHEN** a CommonJS package was compiled on a prior load and its (name, version, entry path, entry mtime, package.json mtime, toolchain fingerprint) key is unchanged
- **THEN** the cached bundle is reused without recompiling

#### Scenario: Bundle cache miss rebuilds

- **WHEN** the resolved entry mtime or package.json mtime changes for a listed CommonJS package
- **THEN** the cache key changes and the bundle is recompiled

#### Scenario: Toolchain change invalidates cache

- **WHEN** the esbuild version or the bundle recipe (build options, banner, synthetic-entry schema) changes between runs
- **THEN** the toolchain fingerprint changes and cached bundles are recompiled

#### Scenario: Outside node_modules bypasses cache

- **WHEN** a listed CommonJS package resolves to a directory outside `node_modules` (workspace, `file:`, or `link:` dependency)
- **THEN** the on-disk cache is bypassed and the bundle is rebuilt on every load

### Requirement: Startup errors for misconfigured packages

Unambiguous package misconfigurations SHALL be raised as hard errors thrown during eager `buildStart`, aborting the run with a nonzero exit before any fuzzing starts. The error SHALL be thrown from whichever process evaluates the plugin's `buildStart` first (supervisor parent, fuzz child, or worker); the first failing process aborts the run, so the user receives an actionable failure in every case. Each error message SHALL name the offending package and its cause. The escalated causes are:

- **Not installed** - the listed package's entry fails to resolve. This applies to ESM-listed packages too, since classification resolves every listed package.
- **No usable entry** - the package resolves but exposes no entry file to instrument.
- **Bundle failed** - esbuild fails to compile the CommonJS entry; esbuild diagnostics SHALL be attached to the error. For subpath entries, which are compiled lazily, this cause SHALL be raised with the same hard-error semantics at first resolve (see the subpath import instrumentation requirement).
- **Native-only entry** - the resolved entry is a native addon and cannot be instrumented.

The previously silent "listed package produced no coverage" outcome SHALL NOT occur for these causes. The fuzz-loop "all seeds evaluated but none produced coverage" path SHALL additionally name the listed package(s) so the user is pointed at the cause rather than a generic instrumentation message. The one remaining warning (resolved and compiled but never imported by the executed tests) is covered by the Package instrumentation option requirement.

#### Scenario: Not-installed package aborts at startup

- **WHEN** `packages: ["nonexistent"]` is configured and the package cannot be resolved
- **THEN** `buildStart` throws a hard error naming `nonexistent` and stating it is not installed / failed to resolve
- **AND** the run aborts with a nonzero exit before any fuzzing starts

#### Scenario: Bundle failure aborts at startup with diagnostics

- **WHEN** a listed CommonJS package's root entry fails to compile with esbuild
- **THEN** `buildStart` throws a hard error naming the package with the esbuild diagnostics attached
- **AND** the run aborts before any fuzzing starts

#### Scenario: Native-only entry aborts at startup

- **WHEN** a listed package's resolved entry is a native addon that cannot be instrumented
- **THEN** `buildStart` throws a hard error naming the package and its native-only cause

#### Scenario: No-coverage fuzz message names listed packages

- **WHEN** the fuzz loop evaluates all seeds but none produce coverage
- **AND** `instrument.packages` lists one or more packages
- **THEN** the resulting message names the listed package(s) as a likely cause

### Requirement: Detector hooks in bundled CommonJS dependencies

Detector hooks SHALL intercept hooked-builtin calls made from inside an instrumented (bundled) CommonJS dependency. Because the compiled bundle accesses external builtins through its native `require` bridge, `require("child_process")` and similar calls SHALL return the CJS module object on which detector hooks are installed, with no import rewriting required. Hook installation timing SHALL be safe: the setup file installs hooks before any test file imports the bundle, so even load-time destructuring (e.g., `const { execSync } = require("child_process")`) captures the hooked function.

#### Scenario: Detector fires on hooked builtin called from a bundled CJS dependency

- **WHEN** a bundled CommonJS dependency calls a hooked builtin (e.g., `child_process.execSync`) with attacker-controlled input
- **THEN** the corresponding detector intercepts the call
- **AND** the detector reports the finding as if the call had originated from instrumented first-party code
