## Context

The Rust infrastructure for vitiate is complete: `vitiate-instrument` (SWC WASM plugin) inserts edge coverage counters and comparison tracing into JavaScript AST, and `vitiate-napi` exposes LibAFL's fuzzing engine (mutation, coverage feedback, CmpLog, corpus management) via napi-rs. The TypeScript `vitiate` package is currently a one-line scaffold. This design covers the integration layer that makes the Rust infrastructure usable through Vitest.

The existing Rust API surface (from `vitiate-napi/index.d.ts`):

- `createCoverageMap(size: number) → Buffer` - zero-copy Rust-backed buffer
- `Fuzzer` class - `constructor(coverageMap, config?)`, `addSeed()`, `getNextInput()`, `reportResult()`, `stats`
- `traceCmp(left, right, cmpId, op) → boolean` - comparison tracing with CmpLog recording
- `ExitKind` enum - Ok(0), Crash(1), Timeout(2)
- `IterationResult` enum - None(0), Interesting(1), Solution(2)

The SWC WASM plugin (`vitiate-instrument`) is consumed via `@swc/core.transform()` with a plugin configuration specifying the `.wasm` path and JSON config.

## Goals / Non-Goals

**Goals:**

- A Vitest plugin that transparently instruments user code through Vite's transform pipeline
- A `fuzz()` test registrar that works like a normal Vitest test in regression mode and drives the fuzzing engine in fuzz mode
- Corpus management following Go's `testdata/fuzz/` conventions
- A standalone CLI for OSS-Fuzz compatibility
- Configurable instrumentation scope (include/exclude patterns, with `node_modules` excluded by default but overridable)

**Non-Goals:**

- Crash input minimization (future change)
- Multi-worker parallel fuzzing within a single target
- `-merge` corpus minimization mode
- `-fork`/`-jobs` flags (accept but ignore for CLI compatibility)
- Source map propagation from SWC transform (the SWC plugin does not yet produce source maps)
- Structured fuzzing / typed data providers

## Decisions

### 1. Standalone `fuzz()` function following the `bench()` pattern

Vitest's `bench()` is a top-level test registrar - you import it and use it like `test()` but for benchmarks. We follow the same pattern with `fuzz()`:

```ts
import { fuzz } from "vitiate";

fuzz("my parser", (data) => {
  parse(data);
});
```

`fuzz()` is a thin wrapper around Vitest's `test()` that handles mode detection, corpus loading, and fuzz loop entry. It registers a test with Vitest's runner, so it appears in normal test output, supports `.skip`, `.only`, `.todo`, and integrates with Vitest's filtering.

This is the most natural API for Vitest users - it looks and feels like `test()` or `bench()`, lives at the top level of a test file, and doesn't require learning any new patterns.

**Alternative considered:** `test.extend()` fixture pattern - `test("name", ({ fuzz }) => { fuzz((data) => ...) })`. This creates awkward double nesting and doesn't match any existing Vitest convention.

**Alternative considered:** Extending Vitest's `TestAPI` type to add `test.fuzz()`. This would require declaration merging into Vitest's internal types, is fragile across versions, and Vitest provides no stable mechanism for it. A standalone export is simpler and more portable.

### 2. Plugin uses `enforce: 'post'` and Vite's `createFilter` for include/exclude

The SWC instrumentation plugin runs as a Vite `transform` hook with `enforce: 'post'`. This ensures it operates on already-transpiled JavaScript - TypeScript, JSX, and other transforms are resolved first.

File filtering uses Vite's `createFilter(include, exclude)` utility. The default configuration:

```ts
{
  instrument: {
    include: ["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"],
    exclude: ["**/node_modules/**"]
  }
}
```

Users can override `exclude` to `[]` to instrument dependencies, or narrow `include` to specific directories. This is the standard Vite pattern and users already understand it.

### 3. Mode detection via environment variable, not CLI flag extension

Vitest doesn't support custom CLI flags in its `vitest` command. Instead of forking or wrapping the CLI, fuzzing mode is activated via:

- `VITIATE_FUZZ=1` environment variable
- The standalone `npx vitiate` CLI (which sets this internally)

The `VITIATE_FUZZ` env var can optionally contain a regex pattern to filter which fuzz targets to run (e.g., `VITIATE_FUZZ=parser`).

**Alternative considered:** `--fuzz` flag via Vitest's CLI. Vitest doesn't support arbitrary custom flags passed through to plugins. We would need to fork the CLI or use `vitest --reporter vitiate --` which is clunky. The env var approach is standard in the ecosystem (c.f. `FORCE_COLOR`, `NODE_ENV`).

### 4. Runtime globals initialized via Vitest `globalSetup`

The coverage map and trace function must be available on `globalThis` before any instrumented code runs. We use Vitest's `globalSetup` mechanism, configured automatically by the plugin's `configureVitest` hook.

In regression mode:

```ts
globalThis.__vitiate_cov = new Uint8Array(65536);
globalThis.__vitiate_trace_cmp = (l, r, id, op) => {
  // Pure JS comparison - no napi dependency needed
  const ops = { "===": (a, b) => a === b /* ... */ };
  return ops[op](l, r);
};
```

In fuzzing mode:

```ts
import { createCoverageMap, traceCmp } from "vitiate-napi";
globalThis.__vitiate_cov = createCoverageMap(65536);
globalThis.__vitiate_trace_cmp = traceCmp;
```

The key invariant: the buffer identity is stable for the process lifetime. Instrumented modules cache `let __vitiate_cov = globalThis.__vitiate_cov` at module scope, so the reference must never change.

**Alternative considered:** Injecting setup via a virtual module resolved by the plugin. This adds complexity (virtual module resolution, import ordering) without benefit. `globalSetup` runs before any test file is loaded, guaranteeing the globals exist.

### 5. Corpus management as a stateless module

Corpus I/O is implemented as a simple module with pure functions - no class, no state:

- `loadCorpus(testDir, testName) → Buffer[]` - reads all files from `testdata/fuzz/{testName}/` relative to the test file directory
- `loadCachedCorpus(testName) → Buffer[]` - reads from the cache directory (`.vitiate-corpus/{testName}/`)
- `writeCorpusEntry(testName, data) → string` - writes an interesting input to the cache directory, returns the file path
- `writeCrashArtifact(testDir, testName, data) → string` - writes to `testdata/fuzz/{testName}/crash-{hash}`, returns the path

File names for cached entries use a content hash (SHA-256 hex, truncated to 16 chars). Crash artifacts use `crash-{hash}`. This prevents duplicates naturally.

The cache directory defaults to `.vitiate-corpus/` in the project root, overridable via `VITIATE_CACHE_DIR` env var.

### 6. Fuzz loop runs synchronously within the test, with periodic async yields

The fuzz loop is driven by the `fuzz()` function inside a single Vitest test. The loop:

```
1. Create Fuzzer with coverage map
2. Load seeds from corpus directories → addSeed() each
3. Loop:
   a. input = getNextInput()
   b. Fill coverage map to zero (done by reportResult on previous iteration)
   c. Try: await target(input)
   d. exitKind = Ok (or Crash if thrown, Timeout if exceeded deadline)
   e. result = reportResult(exitKind)
   f. If result === Solution: write crash artifact, collect error
   g. If result === Interesting: write to cached corpus
   h. Every 1000 iterations: yield to event loop (setImmediate), update reporter
   i. Check termination: time limit, max runs, or solution found
4. Report results
```

The periodic `setImmediate` yield prevents the event loop from starving, allows the reporter to update, and keeps the process responsive to signals.

### 7. Standalone CLI as thin `startVitest()` wrapper

The `npx vitiate` CLI:

1. Parses libFuzzer-style arguments (positional corpus dirs, `-max_len=N`, `-timeout=N`, `-runs=N`, `-seed=N`)
2. Sets `VITIATE_FUZZ=1` in the environment
3. Calls `startVitest('test', [testFile], { plugins: [vitiatePlugin(config)] })`

This reuses the entire Vite transform pipeline - no separate loader needed. The Vitest startup overhead (a few hundred ms) is negligible for long-running fuzz campaigns.

### 8. Progress reporter logs to stderr

The fuzzing progress reporter writes periodic status lines to stderr (not stdout), so it doesn't interfere with Vitest's normal output or piped output. It uses a simple interval timer:

```
fuzz: elapsed: 3s, execs: 125017 (41672/sec), corpus: 202 (11 new), edges: 1847
```

The reporter is configured automatically by the plugin when fuzzing mode is active.

## Risks / Trade-offs

**[SWC WASM plugin loading may be slow on first transform]** → The WASM plugin is loaded once per Vite transform pipeline invocation and cached. Subsequent transforms reuse the loaded plugin. Cold start adds ~200ms, which is negligible for fuzzing campaigns and acceptable for test suite runs.

**[Vitest internal APIs may change]** → We depend only on stable public APIs: `test()` for test registration, `startVitest()` for CLI, `configureVitest` for plugin lifecycle. The `fuzz()` export is our own function, so we control the API surface.

**[Event loop starvation during fuzz loop]** → Mitigated by periodic `setImmediate` yields every N iterations. The yield frequency is tunable but defaults to every 1000 iterations, which balances throughput (~50k+ execs/sec target) with responsiveness.

**[Large corpus directories may slow regression mode startup]** → Corpus entries are loaded eagerly. For very large corpora (10k+ entries), this could add noticeable delay. Acceptable for MVP; lazy loading is a future optimization.

**[No crash minimization]** → Crash artifacts may be larger than necessary. Users can manually minimize. Automatic minimization is planned as a follow-up change.

**[`node_modules` instrumentation increases transform time]** → When users opt in to instrumenting dependencies, every dependency module goes through SWC transform. This is the correct trade-off: users explicitly choose this, and the performance cost is paid during Vite's transform phase (cached after first run). The default excludes `node_modules` for fast startup.
