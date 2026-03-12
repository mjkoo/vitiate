# Vitiate

Coverage-guided fuzzing for JavaScript and TypeScript, built as a Vitest plugin.

Vitiate uses [SWC](https://swc.rs/) for compile-time instrumentation and [LibAFL](https://github.com/AFLplusplus/LibAFL) for mutation-driven fuzzing.
Write fuzz tests alongside your unit tests in Vitest, or use the standalone CLI for libFuzzer-compatible workflows.

**[Documentation](https://mjkoo.github.io/vitiate/)**

## Quickstart

Install the package:

```bash
npm install --save-dev vitiate
```

This installs the Vitest plugin, the standalone CLI, and all required dependencies.
If you only need the Vitest plugin and not the CLI, you can install `@vitiate/core` instead.

Configure Vitest (`vitest.config.ts`):

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

Write a fuzz test (`test/parser.fuzz.ts`):

```ts
import { fuzz } from "@vitiate/core";
import { parse, ParseError } from "../src/parser.js";

fuzz("parse does not crash", (data: Buffer) => {
  try {
    parse(data.toString("utf-8"));
  } catch (error) {
    if (!(error instanceof ParseError)) {
      throw error; // re-throw unexpected errors
    }
  }
});
```

Run the fuzzer:

```bash
npx vitiate test/parser.fuzz.ts
```

Or via Vitest directly:

```bash
VITIATE_FUZZ=1 npx vitest run test/parser.fuzz.ts
```

Crashes are saved to `testdata/fuzz/<name>/crash-<sha256>` (relative to the test file's directory, where `<name>` is a sanitized form of the test name like `a1b2c3d4-parse_does_not_crash`).
Run your test suite normally and they are replayed as regression tests automatically.

## How It Works

1. **Transform time:** Vite's plugin hooks run every JS/TS module through the SWC plugin as it is imported, inserting edge coverage counters and comparison tracing calls. No separate build step required.
2. **Runtime:** A shared coverage map (zero-copy between JS and Rust) tracks which edges are hit.
3. **Fuzz loop:** LibAFL reads the coverage map after each execution, evaluates feedback, updates the corpus, and generates the next input using havoc mutations, CmpLog-guided byte replacement, Grimoire structure-aware mutations, and Unicode-aware mutations.
4. **Crashes:** Inputs that cause uncaught exceptions are saved as crash artifacts and minimized automatically.

## Platform Support

Prebuilt native binaries are provided for:

- Linux: x86_64 (glibc, musl), aarch64 (glibc, musl), armv7 (gnueabihf)
- macOS: aarch64 (Apple Silicon)
- Windows: x86_64

Requires Node.js 18 or later, Vite 6+, and Vitest 3.1+.

## Packages

| Package | Description |
|---|---|
| `vitiate` | Wrapper package with the `vitiate` CLI binary |
| `@vitiate/core` | Vite plugin, fuzz API, corpus management |
| `@vitiate/engine` | Native Node.js addon wrapping LibAFL (prebuilt binaries) |
| `@vitiate/swc-plugin` | SWC WASM plugin for coverage instrumentation |
| `@vitiate/fuzzed-data-provider` | Structured fuzzing helper (optional) |
