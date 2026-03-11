# Vitiate

Coverage-guided fuzzing for JavaScript and TypeScript, built as a Vitest plugin.

Vitiate uses [SWC](https://swc.rs/) for compile-time instrumentation and [LibAFL](https://github.com/AFLplusplus/LibAFL) for mutation-driven fuzzing.
Write fuzz tests alongside your unit tests in Vitest, or use the standalone CLI for libFuzzer-compatible workflows.

## Quickstart

Install the packages:

```bash
npm install --save-dev @vitiate/core @vitiate/engine @vitiate/swc-plugin
```

Configure Vitest (`vitest.config.ts`):

```ts
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    setupFiles: ["@vitiate/core/setup"],
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

Fuzz it:

```bash
npx vitiate test/parser.fuzz.ts
```

Crashes are saved to `testdata/fuzz/<test-name>/crash-<sha256>`.
Run your test suite normally and they are replayed as regression tests automatically.

## How It Works

1. **Build time:** The SWC plugin inserts edge coverage counters (`__vitiate_cov[id]++`) and comparison tracing calls into every JS/TS module.
2. **Runtime:** A shared coverage map (zero-copy between JS and Rust) tracks which edges are hit.
3. **Fuzz loop:** LibAFL reads the coverage map after each execution, evaluates feedback, updates the corpus, and generates the next input using havoc mutations, CmpLog-guided byte replacement, Grimoire structure-aware mutations, and Unicode-aware mutations.
4. **Crashes:** Inputs that cause uncaught exceptions are saved as crash artifacts and minimized automatically.

## Vitest Integration

### Regression Mode (default)

When you run `npm test` or `vitest run`, fuzz tests execute in regression mode.
Saved crash artifacts and corpus entries are replayed deterministically.
This means every crash you find becomes a permanent regression test with no extra work.

Corpus entries are loaded from three sources, in order:

- **Seed corpus:** `testdata/fuzz/<test-name>/` (files without a `crash-` or `timeout-` prefix)
- **Cached corpus:** `.vitiate-corpus/<test-file>/<test-name>/` (generated during fuzzing)
- **Extra directories:** passed via the CLI

If no corpus exists, a single empty buffer is used as the default input.

### Fuzzing Mode

The CLI launches Vitest under the hood with instrumentation enabled and the fuzz loop active:

```bash
npx vitiate test/parser.fuzz.ts
```

You can also target a specific test by name:

```bash
npx vitiate test/parser.fuzz.ts -test "parse does not crash"
```

Common options:

```
-max_len <N>            Maximum input length in bytes
-timeout <N>            Per-execution timeout in seconds (0 = disabled)
-runs <N>               Total fuzzing iterations (0 = unlimited)
-max_total_time <N>     Total fuzzing time limit in seconds
-seed <N>               RNG seed for reproducibility
-dict <path>            Path to a fuzzing dictionary file
```

### fuzz() API

The `fuzz()` function works like Vitest's `test()`:

```ts
fuzz(name: string, target: (data: Buffer) => void | Promise<void>, options?: FuzzOptions)
```

It supports `.skip`, `.only`, and `.todo` modifiers, just like `test()`.

Per-test options can override plugin defaults:

```ts
fuzz("my target", (data) => { /* ... */ }, {
  maxLen: 1024,
  timeoutMs: 5000,
  fuzzTimeMs: 60_000,
  seed: 42,
});
```

### Dictionaries

Place a dictionary file at `testdata/fuzz/<test-name>.dict` and it will be picked up automatically.
Dictionary files contain one token per line, used to seed mutations with domain-specific byte patterns.

## FuzzedDataProvider

For targets that need structured input rather than raw bytes, install the optional `@vitiate/fuzzed-data-provider` package:

```bash
npm install --save-dev @vitiate/fuzzed-data-provider
```

```ts
import { fuzz } from "@vitiate/core";
import { FuzzedDataProvider } from "@vitiate/fuzzed-data-provider";

fuzz("structured input", (data: Buffer) => {
  const fdp = new FuzzedDataProvider(data);
  const name = fdp.consumeString(100);
  const age = fdp.consumeIntegralInRange(0, 150);
  const tags = fdp.consumeStringArray(10, 50);

  createUser({ name, age, tags });
});
```

Available methods include:

- `consumeBoolean()`, `consumeIntegral(maxBytes)`, `consumeIntegralInRange(min, max)`
- `consumeNumber()`, `consumeNumberInRange(min, max)`, `consumeProbabilityFloat()`
- `consumeBytes(maxLength)`, `consumeRemainingAsBytes()`
- `consumeString(maxLength)`, `consumeRemainingAsString()`
- `consumeStringArray(maxArrayLength, maxStringLength)`
- `pickValue(array)`, `pickValues(array, count)`

## Detectors

Vitiate includes built-in vulnerability detectors that hook into Node.js APIs at runtime.
They work in both fuzzing and regression modes.

**Tier 1** (enabled by default):

| Detector | Description |
|---|---|
| `prototypePollution` | Snapshot-based detection of `Object.prototype` modifications |
| `commandInjection` | Hooks `child_process` to detect command injection |
| `pathTraversal` | Hooks `fs` to detect path traversal |
| `redos` | Detects regex denial-of-service (threshold: 100ms per call) |

**Tier 2** (disabled by default):

| Detector | Description |
|---|---|
| `ssrf` | Hooks `http`/`http2` to detect server-side request forgery |
| `unsafeEval` | Detects `eval()` of attacker-controlled strings |

Enable or configure detectors per-test:

```ts
fuzz("with detectors", target, {
  detectors: {
    prototypePollution: true,
    ssrf: true,
    pathTraversal: { deniedPaths: ["/etc/shadow"] },
  },
});
```

Or via the CLI:

```bash
npx vitiate test.fuzz.ts -detectors prototypePollution,ssrf,pathTraversal.deniedPaths=/etc/shadow
```

When detectors are specified on the CLI, all defaults are disabled and only the listed detectors are active.

## libFuzzer Compatibility (CLI)

The CLI accepts standard libFuzzer flags, making it a drop-in for workflows that expect a libFuzzer-compatible interface:

```bash
# Fuzz with a seed corpus directory
npx vitiate test.fuzz.ts corpus/

# Corpus minimization (merge mode)
npx vitiate test.fuzz.ts -merge 1 minimized_corpus/ corpus_a/ corpus_b/

# Set artifact output location
npx vitiate test.fuzz.ts -artifact_prefix ./crashes/
```

The CLI runs a supervisor process that manages crash recovery.
When the fuzzer hits a crash, the supervisor captures the input, writes the artifact, and respawns the child to continue fuzzing.

Additional libFuzzer-compatible flags:

```
-artifact_prefix <path>     Path prefix for crash artifacts
-merge <0|1>                Corpus minimization via set cover
-minimize_budget <N>        Max iterations for crash minimization (default: 10000)
-minimize_time_limit <N>    Time limit for crash minimization in seconds
```

## Plugin Options

The Vite plugin accepts configuration for instrumentation and fuzzing defaults:

```ts
vitiatePlugin({
  // Control which files are instrumented
  instrument: {
    include: ["src/**/*.ts"],
    exclude: ["**/node_modules/**", "**/*.test.ts"],
  },

  // Default fuzz options for all tests
  fuzz: {
    maxLen: 8192,
    timeoutMs: 5000,
  },

  // Corpus cache directory (relative to project root)
  cacheDir: ".vitiate-corpus",

  // Edge counter slots (default: 65536)
  coverageMapSize: 65536,
});
```

## Environment Variables

| Variable | Description |
|---|---|
| `VITIATE_FUZZ_TIME` | Total fuzzing time in seconds (overrides `fuzzTimeMs`) |
| `VITIATE_FUZZ_EXECS` | Max iterations (overrides `fuzzExecs`) |
| `VITIATE_DEBUG` | Set to `1` for debug output (mode, coverage map size) |

## Platform Support

Prebuilt native binaries are provided for:

- Linux: x86_64 (glibc, musl), aarch64 (glibc, musl), armv7 (gnueabihf)
- macOS: aarch64 (Apple Silicon)
- Windows: x86_64

Requires Node.js 18 or later, Vite 6+, and Vitest 3.1+.

## Packages

| Package | Description |
|---|---|
| `@vitiate/core` | Vite plugin, fuzz API, CLI, corpus management |
| `@vitiate/engine` | Native Node.js addon wrapping LibAFL (prebuilt binaries) |
| `@vitiate/swc-plugin` | SWC WASM plugin for coverage instrumentation |
| `@vitiate/fuzzed-data-provider` | Structured fuzzing helper (optional) |
