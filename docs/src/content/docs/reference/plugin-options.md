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
- `include`: all `.js`, `.ts`, `.jsx`, `.tsx` files
- `exclude`: `**/node_modules/**`

Instrument only the code you are fuzzing - excluding test files and dependencies improves performance and reduces noise in coverage feedback.

#### Instrumenting node_modules

By default, `**/node_modules/**` is in the `exclude` list, so dependencies are not instrumented. To fuzz into your dependencies (e.g., finding bugs in libraries you consume), remove the node_modules exclusion:

```ts
vitiatePlugin({
  instrument: {
    exclude: [],  // instrument everything, including node_modules
  },
});
```

When `exclude` does not contain a pattern mentioning `node_modules`, the plugin automatically configures Vitest to inline dependencies through the Vite transform pipeline (`server.deps.inline: true`). This is required for node_modules files to reach the instrumentation hooks.

Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) are always excluded regardless of your configuration.

**Performance considerations:**

- **Transform time**: Instrumenting node_modules significantly increases startup time because every dependency file passes through SWC during Vite's module transform.
- **Coverage map saturation**: Large dependency trees produce many coverage edges, which can exhaust slots in the coverage map. If the fuzzer stops finding new coverage despite exercising new code paths, increase `coverageMapSize`.
- **Feedback quality**: When the coverage map is saturated, hash collisions reduce the fuzzer's ability to distinguish interesting inputs. Narrow your `include` patterns to instrument only the specific packages you are investigating, or increase `coverageMapSize`.

### fuzz

Default `FuzzOptions` applied to all `fuzz()` calls. Per-test options override these.

```ts
fuzz?: FuzzOptions
```

See [fuzz() API Reference](/vitiate/reference/fuzz-api/) for the complete `FuzzOptions` type.

### cacheDir

Directory for the cached corpus, relative to the project root.

```ts
cacheDir?: string  // default: ".vitiate-corpus"
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
        exclude: ["**/node_modules/**", "**/*.test.ts"],
      },
      fuzz: {
        maxLen: 8192,
        timeoutMs: 5000,
      },
      cacheDir: ".vitiate-corpus",
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
