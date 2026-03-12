---
title: Troubleshooting
description: Common issues and how to resolve them.
---

## Coverage Map Saturation

**Symptoms:** The fuzzer stops finding new edges despite the target having unexplored code paths. The status line shows edge count near the coverage map size.

**Fix:** Increase `coverageMapSize` in your plugin options:

```ts
vitiatePlugin({
  coverageMapSize: 131072, // default is 65536
});
```

Larger maps reduce hash collisions at the cost of more memory. Double the default is a good starting point for large codebases.

## Slow Startup When Instrumenting node_modules

**Symptoms:** The fuzzer takes a long time to start because it instruments every imported module, including large dependency trees from `node_modules`.

This only happens if you have removed `**/node_modules/**` from the `exclude` list (it is excluded by default). When `node_modules` is not excluded, the plugin also sets `server.deps.inline: true` so that dependencies flow through the Vite transform pipeline, which adds overhead for every imported package.

**Fix:** Narrow the `include` patterns to only the specific packages you need instrumented:

```ts
vitiatePlugin({
  instrument: {
    include: ["src/**/*.ts", "node_modules/my-library/**/*.js"],
    exclude: [], // node_modules removed from exclude to allow instrumentation
  },
});
```

Or, if you don't need to instrument any dependencies, restore the default exclude:

```ts
vitiatePlugin({
  instrument: {
    exclude: ["**/node_modules/**"],
  },
});
```

## Fuzzer Not Finding Anything

**Symptoms:** The fuzzer runs for a long time but finds no crashes and coverage plateaus early.

**Possible fixes:**

1. **Add seed inputs.** Place representative inputs in `.vitiate/testdata/<hashdir>/seeds/`. Run `npx vitiate init` to create the directories. Seeds give the fuzzer a starting point closer to valid inputs.

2. **Add a dictionary.** Place a dictionary file in `.vitiate/testdata/<hashdir>/` with domain-specific tokens. See [Dictionaries and Seeds](/vitiate/guides/dictionaries-and-seeds/) for syntax details.

3. **Check that coverage is increasing.** If edge count stays flat from the start, verify that the target code is actually being instrumented. Enable debug output with `VITIATE_DEBUG=1` to confirm.

4. **Use structured fuzzing.** If the target expects typed input rather than raw bytes, use [`FuzzedDataProvider`](/vitiate/reference/fuzzed-data-provider/) to consume structured values from the fuzzer's byte stream.

## Corpus Growing Too Large

**Symptoms:** The cached corpus directory (`.vitiate/corpus/`) grows large over extended fuzzing sessions, slowing down regression test runs.

**Fix:** Run corpus minimization to reduce the corpus to a minimal set that preserves coverage:

```bash
npx vitiate optimize
```

See [Corpus and Regression Testing](/vitiate/concepts/corpus/#corpus-minimization) for details.

## Debug Mode

Set `VITIATE_DEBUG=1` to enable verbose diagnostic output:

```bash
VITIATE_DEBUG=1 npx vitiate fuzz
```

This logs:
- The active mode (fuzz, regression, optimize)
- Coverage map size and address
- Which modules are being instrumented
- Internal engine state
