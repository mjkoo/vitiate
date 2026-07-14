---
title: Plugin Options
description: Complete reference for vitiatePlugin() configuration.
---

```ts
import { vitiatePlugin } from "@vitiate/core/plugin";
```

## vitiatePlugin(options?)

```ts
function vitiatePlugin(options?: VitiatePluginOptions): Plugin
```

Returns a Vite plugin that enables SWC instrumentation and the Vitiate fuzz runtime.

## VitiatePluginOptions

All fields are optional.

### instrument

Controls which files are instrumented with coverage counters and comparison tracing.

```ts
instrument?: {
  include?: string[];  // Glob patterns for files to instrument
  exclude?: string[];  // Glob patterns for files to skip
}
```

**Defaults:**
- `include`: all `.js`, `.ts`, `.jsx`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts` files
- `exclude`: `[]` (no user code excluded)

`**/node_modules/**` is always excluded internally regardless of the `exclude` value - use `packages` to instrument dependencies.

#### Include/exclude semantics

- `include` and `exclude` control instrumentation of **your own code only** - they do not affect dependencies. Use `packages` for that.
- `exclude` always takes precedence over `include`.
- `**/node_modules/**` is always excluded internally regardless of the `exclude` value.
- Default `exclude` is `[]` (no user code excluded).

### instrument.packages

```ts
instrument?: {
  packages?: string[];  // npm package names to instrument
}
```

Lists third-party npm packages whose code should be instrumented with coverage counters. The plugin automatically configures Vitest module inlining (`test.server.deps.inline`) and transform filter bypass for the listed packages.

Package matching uses `/node_modules/<packageName>/` as a substring match on the resolved module ID, handling standard, pnpm, and nested `node_modules` layouts. Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) are always excluded regardless of your configuration.

```ts
vitiatePlugin({
  instrument: {
    packages: ["some-library"],  // instrument a specific dependency
  },
});
```

**Performance considerations:**

- **Transform time**: Instrumenting dependencies increases startup time because each listed package's files pass through SWC during Vite's module transform.
- **Coverage map saturation**: Large dependency trees produce many coverage edges, which can exhaust slots in the coverage map. If the fuzzer stops finding new coverage despite exercising new code paths, increase `coverageMapSize`.
- **Feedback quality**: When the coverage map is saturated, hash collisions reduce the fuzzer's ability to distinguish interesting inputs. List only the specific packages you are investigating, or increase `coverageMapSize`.

**CommonJS packages:**

Listed packages whose resolved entry is **CommonJS** (a `main` with no ESM `module`/`exports`/`type: "module"`, e.g. `node-forge`, `jpeg-js`) cannot be instrumented on the normal externalization path: Vitest loads them with native Node and their internal `require("./sub")` calls never reach the transform. Vitiate handles these transparently - you still just list the package name. Each listed CommonJS entry (and each imported subpath, `pkg/sub`) is compiled with esbuild into a single instrumentable ESM bundle of the package's **own** sources, built once and cached on disk (under the Vite cache dir), and instrumented like first-party code. Default **and** named imports keep working. No configuration beyond `packages` is required.

If a listed package is unambiguously misconfigured, the run aborts at startup with an error naming the package and cause: not installed (fails to resolve), no usable entry, esbuild bundle failure (esbuild diagnostics attached), or a native-addon-only entry. A package that resolves and compiles but is never imported by the tests that ran produces a warning (this is legitimate for filtered runs), not an abort.

**Accepted limitations for instrumented CommonJS packages:**

- **Coverage granularity is package-level.** All of a bundled package's edges hash against its single bundle-entry id (per-subpath for subpath imports). Distinct source spans still produce distinct edges, so the fuzzing feedback signal is intact; only human-readable per-file attribution collapses to the package (or subpath) level. Source maps still map crash stack traces back to the original files.
- **Only the listed package's own sources are instrumented.** Its own npm dependencies, Node built-ins, dynamic `require(expr)` targets, and native `.node` addons stay external (resolved at runtime through a native `require` bridge) and are not instrumented - instrumentation stays strictly "the packages you listed".
- **Native require paths load a second, uninstrumented copy.** Any *native* require path to a listed package - a listed package requiring another listed package by bare specifier, an unlisted externalized dependency requiring a listed package, or a dynamic `require(expr)` - loads the real files through native `require`, uninstrumented and with module state separate from the bundle's (stateful singletons can diverge). Direct imports from your test code always get the instrumented bundle, so coverage from the entries you import is unaffected.
- **Mixed root + subpath imports duplicate intra-package state.** Importing both `pkg` and `pkg/sub` of the same package embeds a private copy of any shared internal modules in each bundle, so intra-package singleton state can duplicate.

### fuzz

Default `FuzzOptions` applied to all `fuzz()` calls. Per-test options override these.

```ts
fuzz?: FuzzOptions
```

See [fuzz() API Reference](/reference/fuzz-api/) for the complete `FuzzOptions` type.

### dataDir

Directory for Vitiate data (corpus, testdata), relative to the project root.

```ts
dataDir?: string  // default: ".vitiate"
```

The resolved absolute path is propagated to test worker processes via the internal [`VITIATE_DATA_DIR`](/reference/environment-variables/#internal) environment variable, so workers read and write artifacts under the same directory as the main process.

### coverageMapSize

Number of edge counter slots in the coverage map. Must be a power of two between 256 and 4,194,304.

```ts
coverageMapSize?: number  // default: 65536
```

Larger maps reduce hash collisions (where different edges map to the same slot) but use more memory. The default is suitable for most projects. Increase it for very large codebases.

The resolved value is propagated to test worker processes via the internal [`VITIATE_COVERAGE_MAP_SIZE`](/reference/environment-variables/#internal) environment variable, so the map a worker allocates matches the size the instrumentation was compiled against.

Vitiate prints a one-time warning at the start of a campaign if the number of instrumented edges is large relative to the map size (roughly 2% or more), since collisions then start to silently merge edges and coarsen coverage feedback. If you see this warning, raise `coverageMapSize` to the next power of two.

## Setup File

The plugin automatically adds `@vitiate/core/setup` to Vitest's `setupFiles` via its `config()` hook. This initializes the coverage map and comparison tracing globals at runtime. No manual configuration is needed.

## Full Example

```ts
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        include: ["src/**/*.ts"],
        exclude: ["**/*.test.ts"],
      },
      fuzz: {
        maxLen: 8192,
        timeoutMs: 5000,
      },
      dataDir: ".vitiate",
      coverageMapSize: 65536,
    }),
  ],
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["test/**/*.test.ts"] } },
      { extends: true, test: { name: "fuzz", include: ["test/**/*.fuzz.ts"] } },
    ],
  },
});
```
