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

### coverageMapSize

Number of edge counter slots in the coverage map. Must be a power of two between 256 and 4,194,304.

```ts
coverageMapSize?: number  // default: 65536
```

Larger maps reduce hash collisions (where different edges map to the same slot) but use more memory. The default is suitable for most projects. Increase it for very large codebases.

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
