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

Instrument only the code you are fuzzing — excluding test files and dependencies improves performance and reduces noise in coverage feedback.

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
