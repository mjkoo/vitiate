---
title: Corpus and Regression Testing
description: How Vitiate manages test inputs across fuzzing and regression modes.
---

The corpus is the set of inputs that the fuzzer has found useful. Understanding how it works will help you get the most out of Vitiate.

## Corpus Locations

Vitiate loads inputs from three locations, checked in this order:

### Seed Corpus

```
testdata/fuzz/<sanitized-test-name>/
```

Files you create manually to give the fuzzer a starting point. Good seeds exercise different code paths in your target. Crash artifacts are also stored here (prefixed with `crash-` or `timeout-`).

The directory name is a sanitized form of the test name: an 8-character hash prefix followed by the name with special characters replaced by underscores (e.g., `8fcacc40-parse_url` for a test named `"parse-url"`). The easiest way to discover the directory path is to run the fuzzer briefly — it creates the directory automatically.

### Cached Corpus

```
.vitiate-corpus/<test-file>/<sanitized-test-name>/
```

Generated automatically during fuzzing. Each file is named by its SHA-256 hash for deduplication. This directory grows as the fuzzer discovers new coverage and can be deleted safely — the fuzzer will rebuild it. Consider adding `.vitiate-corpus/` to your `.gitignore`.

### Extra Directories

Passed as positional arguments on the CLI:

```bash
npx vitiate test/parser.fuzz.ts extra-corpus/ shared-corpus/
```

Useful for sharing corpora across team members or importing inputs from other fuzzers.

## Two Modes

### Fuzzing Mode

Activated by running `npx vitiate`. The fuzzer:

1. Loads all seed, cached, and extra corpus entries
2. Evaluates each seed to establish initial coverage
3. Mutates corpus entries to generate new inputs
4. Saves interesting new inputs to the cached corpus
5. Saves crash artifacts to the seed corpus directory

### Regression Mode

Activated by running `npm test` (or `vitest run`). Each fuzz test:

1. Loads all seed and cached corpus entries
2. Runs the target once per entry, in order
3. Fails the test if any entry throws an unexpected error

This means every crash artifact and every interesting input the fuzzer has ever found is replayed as a test case. Crash artifacts are permanent regression guards — if someone reintroduces the bug, the test fails.

## Crash Artifacts

When the fuzzer finds a crashing input, it:

1. Minimizes the input (removes bytes while preserving the crash)
2. Writes the minimized input to `testdata/fuzz/<sanitized-test-name>/crash-<sha256>`
3. Continues fuzzing for more crashes (configurable via `stopOnCrash`)

Commit crash artifacts to version control. They are small, deterministic, and serve as documentation of bugs that were found and fixed.

Timeout artifacts follow the same pattern: `testdata/fuzz/<sanitized-test-name>/timeout-<sha256>`.

## Corpus Minimization

Over time the cached corpus can grow large. Use merge mode to find the smallest subset that maintains the same coverage:

```bash
npx vitiate test/parser.fuzz.ts -merge 1 minimized/ .vitiate-corpus/test/parser.fuzz.ts/
```

This reads all inputs from the source directories, evaluates their coverage, and writes only the minimal set to `minimized/`.

## Tips

- **Commit seed corpus and crash artifacts.** They are small and valuable. Other developers get the fuzzer's accumulated knowledge when they clone the repository.
- **Do not commit the cached corpus.** It can be large and is regenerated automatically. Add `.vitiate-corpus/` to `.gitignore`.
- **Curate seeds.** A few well-chosen seeds (valid inputs, edge cases, minimal examples) are better than thousands of random files. The fuzzer can mutate from good seeds much more effectively.
- **Run the fuzzer for longer on CI.** Short local runs find easy bugs. Scheduled CI jobs running for minutes or hours find the deep ones.
