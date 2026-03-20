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

## Slow Startup When Instrumenting Dependencies

**Symptoms:** The fuzzer takes a long time to start because it instruments every file in listed dependency packages.

This happens when `instrument.packages` includes dependencies with large file counts. Each listed package's files pass through SWC instrumentation during Vite's module transform, which adds startup overhead proportional to the number of files.

**Fix:** List only the specific packages you are actively investigating:

```ts
vitiatePlugin({
  instrument: {
    packages: ["specific-lib"], // only instrument what you need
  },
});
```

Avoid listing large frameworks or utility libraries unless you specifically need coverage feedback from their internals. See [Plugin Options - packages](/reference/plugin-options/#instrumentpackages) for performance considerations.

## Fuzzer Not Finding Anything

**Symptoms:** The fuzzer runs for a long time but finds no crashes and coverage plateaus early.

**Possible fixes:**

1. **Add seed inputs.** Place representative inputs in `.vitiate/testdata/<hashdir>/seeds/`. Run `npx vitiate init` to create the directories. Seeds give the fuzzer a starting point closer to valid inputs.

2. **Add a dictionary.** Place a dictionary file in `.vitiate/testdata/<hashdir>/` with domain-specific tokens. See [Dictionaries and Seeds](/guides/dictionaries-and-seeds/) for syntax details.

3. **Check that coverage is increasing.** If edge count stays flat from the start, verify that the target code is actually being instrumented. Enable debug output with `VITIATE_DEBUG=1` to confirm.

4. **Use structured fuzzing.** If the target expects typed input rather than raw bytes, use [`FuzzedDataProvider`](/reference/fuzzed-data-provider/) to consume structured values from the fuzzer's byte stream.

## Corpus Growing Too Large

**Symptoms:** The cached corpus directory (`.vitiate/corpus/`) grows large over extended fuzzing sessions, slowing down regression test runs.

**Fix:** Run corpus minimization to reduce the corpus to a minimal set that preserves coverage:

```bash
npx vitiate optimize
```

See [Corpus and Regression Testing](/concepts/corpus/#corpus-minimization) for details.

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
