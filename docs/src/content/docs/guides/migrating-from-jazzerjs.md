---
title: Migrating from Jazzer.js
description: Step-by-step guide to migrate fuzz tests from Jazzer.js (Jest integration or standalone CLI) to Vitiate.
---

Vitiate is a coverage-guided fuzzer built as a native Vitest plugin. Fuzz tests run alongside unit tests in the same runner with no separate toolchain required. See the [Quickstart](/getting-started/quickstart/) for prerequisites and installation.

## Update Dependencies

Remove Jazzer.js packages and Jest dependencies (if they were only used for fuzzing):

```bash
npm uninstall @jazzer.js/core @jazzer.js/jest-runner jest ts-jest @types/jest
```

Install Vitiate:

```bash
npm install --save-dev vitiate
```

If your fuzz targets use `FuzzedDataProvider` for structured inputs, also install:

```bash
npm install --save-dev @vitiate/fuzzed-data-provider
```

Then clean up leftover configuration:

- Remove any `overrides` or `resolutions` blocks in `package.json` that were added for Jazzer.js
- Delete `jest.config.fuzz.js` (or whatever Jest config was used for fuzzing)
- Delete `fuzz/globals.d.ts` or similar type declaration files for `it.fuzz`
- Remove any custom npm scripts that wrap `jest --config jest.config.fuzz.js` or `npx jazzer`

## Configure Vitest

Create or update `vitest.config.ts` with the Vitiate plugin:

```ts
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["test/**/*.test.ts"] } },
      { extends: true, test: { name: "fuzz", include: ["test/**/*.fuzz.ts"] } },
    ],
  },
});
```

The `projects` split keeps unit and fuzz tests in separate Vitest projects so they can have different configurations. Adjust the `include` globs to match your directory structure.

See [Plugin Options](/reference/plugin-options/) for the full configuration reference.

## Convert Fuzz Tests

### Test structure

Jazzer.js uses Jest's `describe`/`it.fuzz` pattern. Vitiate uses a standalone `fuzz()` function:

**Jazzer.js:**

```ts
import "@jazzer.js/jest-runner";
import { parse } from "../src/parser.js";

describe("parser", () => {
  it.fuzz("does not crash", (data: Buffer) => {
    parse(data.toString());
  });
});
```

**Vitiate:**

```ts
import { fuzz } from "@vitiate/core";
import { parse } from "../src/parser.js";

fuzz("parser does not crash", (data: Buffer) => {
  parse(data.toString());
});
```

Key differences:
- No `describe` wrapper needed - `fuzz()` is a top-level call
- No `import "@jazzer.js/jest-runner"` - the plugin handles registration
- The test name is the first argument to `fuzz()` (combine the `describe` and `it.fuzz` names if needed)

### Error handling

In both Jazzer.js and Vitiate, a fuzz target signals a bug by throwing. The standard pattern is to catch expected errors and let unexpected ones propagate:

```ts
fuzz("parse rejects gracefully", (data: Buffer) => {
  try {
    parse(data.toString());
  } catch (error) {
    if (error instanceof ParseError) {
      return; // Expected - parser rejected invalid input
    }
    throw error; // Unexpected error - this is a bug
  }
});
```

Any assertion approach works: `throw`, Node's built-in `assert`, or third-party assertion libraries. Vitiate does not prescribe a specific assertion helper.

### Replacing Jest assertions

Vitest's `expect` is API-compatible with Jest's, so most assertion code works unchanged. Just update the import:

```ts
import { expect } from "vitest";
```

### Modifiers

| Jazzer.js | Vitiate |
|-----------|---------|
| `it.fuzz.skip(...)` | `fuzz.skip(...)` |
| `it.fuzz.only(...)` | `fuzz.only(...)` |
| - | `fuzz.todo("name")` |

See [fuzz() API](/reference/fuzz-api/) for the complete API reference.

## Migrate FuzzedDataProvider

The import path changes but the API is compatible - both follow the same LLVM FuzzedDataProvider design:

**Jazzer.js:**

```ts
import { FuzzedDataProvider } from "@jazzer.js/core";
```

**Vitiate:**

```ts
import { FuzzedDataProvider } from "@vitiate/fuzzed-data-provider";
```

See [FuzzedDataProvider Reference](/reference/fuzzed-data-provider/) for the full API.

## Map Bug Detectors

Jazzer.js uses kebab-case names; Vitiate uses camelCase. Vitiate also adds detectors that Jazzer.js does not have.

| Jazzer.js name | Vitiate name | Tier | Default |
|----------------|--------------|------|---------|
| `command-injection` | `commandInjection` | 1 | On |
| `path-traversal` | `pathTraversal` | 1 | On |
| `prototype-pollution` | `prototypePollution` | 1 | On |
| - | `redos` | 2 | Off |
| - | `ssrf` | 2 | Off |
| - | `unsafeEval` | 2 | Off |

Tier 1 detectors are enabled by default. Tier 2 detectors must be explicitly enabled because they hook sensitive APIs and may produce false positives.

If your Jazzer.js config disabled specific detectors, translate the names to camelCase in your Vitiate configuration. See [Vulnerability Detectors](/guides/detectors/) for usage and [Detectors Reference](/reference/detectors/) for the full configuration API.

## Migrate Corpus and Crash Artifacts

### Initialize the directory structure

Run `npx vitiate init` to create seed directories for all discovered fuzz tests:

```bash
npx vitiate init
```

This creates `.vitiate/testdata/<hashdir>/seeds/` directories based on your fuzz test names.

### Copy existing artifacts

If you have crash regressions or seed inputs from Jazzer.js, copy them into the new structure:

```bash
# Copy crash regressions
cp old-crashes/* .vitiate/testdata/<hashdir>/crashes/

# Copy seed inputs
cp old-seeds/* .vitiate/testdata/<hashdir>/seeds/
```

The `<hashdir>` is a hash-based directory name shown by `npx vitiate init`. Each test gets its own directory. Timeout artifacts go in the sibling `timeouts/` directory.

### Update .gitignore

```gitignore
# Vitiate cached corpus (regenerated by the fuzzer)
.vitiate/corpus/

# SWC WASM plugin compilation cache (created by Vitiate's instrumentation)
.swc/
```

The `.swc/` directory contains platform-specific compiled WASM plugin artifacts that SWC creates during instrumentation. It is safe to delete and will be recreated on the next run. Jazzer.js does not create this directory since it uses a different instrumentation approach.

Commit `.vitiate/testdata/` to version control - it contains your crash regressions and seed inputs.

### Clean up old artifacts

Remove Jazzer.js corpus directories once migration is verified:

- `.cifuzz-corpus/` (Jazzer.js default corpus directory)
- Any custom corpus or crash directories from your old Jest config
- Old `jest.config.fuzz.js` references in CI scripts

See [Corpus and Regression Testing](/concepts/corpus/) for details on how Vitiate manages inputs.

## Update Package Scripts

| Old (Jazzer.js) | New (Vitiate) |
|-----------------|---------------|
| `jest --config jest.config.fuzz.js` | `npx vitiate regression` |
| `npx jazzer target.fuzz.ts` | `npx vitiate fuzz` |
| `npx jazzer -m=regression target.fuzz.ts` | `npx vitiate regression` |
| `npx jazzer target.fuzz.ts -- -max_total_time=300` | `npx vitiate fuzz --fuzz-time 300` |

See [CLI Flags](/reference/cli-flags/) for the complete command reference.

## Update CI

### Regression tests (every PR)

**Before:**

```yaml
- run: npx jest --config jest.config.fuzz.js
```

**After:**

```yaml
- run: npx vitiate regression
```

### Nightly fuzzing

**Before:**

```yaml
- run: npx jazzer target.fuzz.ts -- -max_total_time=3600
```

**After:**

```yaml
- run: npx vitiate fuzz --fuzz-time 3600
```

Update crash artifact paths in any CI steps that upload or archive them - Vitiate stores crashes under `.vitiate/testdata/<hashdir>/crashes/` instead of Jazzer.js's flat output directory.

See [CI Fuzzing](/guides/ci-fuzzing/) for complete GitHub Actions examples including corpus caching and crash artifact upload.

## Verify the Migration

1. **Install dependencies:** `npm ci` completes without errors
2. **Unit tests pass:** `npx vitest run` (regression mode runs fuzz tests against any existing corpus)
3. **Regression tests pass:** `npx vitiate regression` replays all committed crash artifacts and seeds
4. **Smoke fuzz:** `npx vitiate fuzz --fuzz-time 30` runs for 30 seconds without errors
