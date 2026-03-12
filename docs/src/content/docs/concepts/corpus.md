---
title: Corpus and Regression Testing
description: How Vitiate manages test inputs across fuzzing and regression modes.
---

The corpus is the set of inputs that the fuzzer has found useful. Understanding how it works will help you get the most out of Vitiate.

## Corpus Locations

Vitiate loads inputs from two locations:

### Seed Corpus

```
testdata/fuzz/<sanitized-test-name>/
```

Files you create manually to give the fuzzer a starting point. Good seeds exercise different code paths in your target. Crash artifacts are also stored here (prefixed with `crash-` or `timeout-`).

The directory name is a sanitized form of the test name: an 8-character hash prefix followed by the name with special characters replaced by underscores (e.g., `8fcacc40-parse_url` for a test named `"parse-url"`). The easiest way to discover the directory path is to run the fuzzer briefly - it creates the directory automatically and prints the path in crash output. You can also list existing directories with `ls testdata/fuzz/` (see the [Tutorial](/vitiate/getting-started/tutorial/#step-3-add-seed-inputs) for a walkthrough).

### Cached Corpus

```
.vitiate-corpus/<test-file>/<sanitized-test-name>/
```

Generated automatically during fuzzing. Each file is named by its SHA-256 hash for deduplication. This directory grows as the fuzzer discovers new coverage and can be deleted safely - the fuzzer will rebuild it. Add `.vitiate-corpus/` to your `.gitignore`.

## Two Modes

Vitiate's `fuzz()` function behaves differently depending on the environment. The same test file serves both modes with no code changes.

### Fuzzing Mode

Activated by setting the `VITIATE_FUZZ` environment variable:

```bash
VITIATE_FUZZ=1 npx vitest run test/parser.fuzz.ts
```

In fuzzing mode, each `fuzz()` call becomes a supervisor that spawns a child Vitest process and enters the fuzz loop. The fuzzer:

1. Loads all seed and cached corpus entries
2. Evaluates each seed to establish initial coverage
3. Mutates corpus entries to generate new inputs
4. Saves interesting new inputs to the cached corpus
5. Saves crash artifacts to the seed corpus directory

If a crash is found, the test fails with the crash details and artifact path.

### Regression Mode

Activated by running your tests normally (the default when `VITIATE_FUZZ` is not set):

```bash
npx vitest run
```

Each `fuzz()` call:

1. Loads all seed and cached corpus entries
2. Runs the target once per entry, in order
3. Fails the test if any entry throws an unexpected error

This means every crash artifact and every interesting input the fuzzer has ever found is replayed as a test case. Crash artifacts are permanent regression guards - if someone reintroduces the bug, the test fails.

## Crash Artifacts

When the fuzzer finds a crashing input, it:

1. Minimizes the input (removes bytes while preserving the crash)
2. Writes the minimized input to `testdata/fuzz/<sanitized-test-name>/crash-<sha256>`
3. Continues fuzzing for more crashes (configurable via `stopOnCrash`)

Commit crash artifacts to version control. They are small, deterministic, and serve as documentation of bugs that were found and fixed.

Timeout artifacts follow the same pattern: `testdata/fuzz/<sanitized-test-name>/timeout-<sha256>`.

## Corpus Minimization

Over time the cached corpus grows as the fuzzer discovers new coverage. Many of these entries become redundant - later inputs may cover the same edges as earlier ones. Minimization finds the smallest subset that maintains the same total coverage.

Run optimize mode to minimize the cached corpus in place:

```bash
VITIATE_OPTIMIZE=1 npx vitest run
```

Optimize mode works as follows for each `fuzz()` test:

1. **Replays seed corpus** entries (`testdata/fuzz/<name>/`) to establish a baseline of pre-covered edges
2. **Replays cached corpus** entries (`.vitiate-corpus/<test-file>/<name>/`) and records the edges each one covers
3. **Runs set cover** over cached entries only, treating seed edges as already covered - cached entries that are fully redundant with seeds or other survivors are eliminated
4. **Deletes non-surviving cached entries** in place from `.vitiate-corpus/`

Seed corpus entries are never deleted - they serve as the coverage baseline. Only cached entries are subject to minimization.

Minimize periodically, especially after long fuzzing sessions. A smaller corpus means faster regression test runs and faster seed evaluation at the start of the next fuzzing session.

For libFuzzer-compatible corpus minimization across arbitrary directories, see the [standalone CLI's merge mode](/vitiate/guides/cli/#corpus-minimization-merge-mode).

### Checkpointing Fuzzer Progress

After a long fuzzing session, you can checkpoint the fuzzer's progress by promoting surviving cached entries to the seed corpus. This makes the coverage gains permanent - they survive even if `.vitiate-corpus/` is deleted or the project is cloned fresh.

```bash
# 1. Optimize to keep only the minimal covering set
VITIATE_OPTIMIZE=1 npx vitest run

# 2. Copy surviving cached entries to the seed corpus
cp .vitiate-corpus/<test-file>/<sanitized-test-name>/* \
   testdata/fuzz/<sanitized-test-name>/

# 3. Commit the new seeds
git add testdata/fuzz/
git commit -m "chore: checkpoint fuzzer corpus"
```

After checkpointing, you can safely delete `.vitiate-corpus/` and start the next fuzzing session from the enriched seed corpus.

## Tips

- **Commit seed corpus and crash artifacts.** They are small and valuable. Other developers get the fuzzer's accumulated knowledge when they clone the repository.
- **Do not commit the cached corpus.** It can be large and is regenerated automatically. Add `.vitiate-corpus/` to `.gitignore`.
- **Checkpoint after long sessions.** Run `VITIATE_OPTIMIZE=1 npx vitest run`, then copy surviving cached entries to the seed corpus and commit them. This preserves coverage gains permanently.
- **Integrate fuzzing into CI.** Run regression tests on every PR and long fuzzing sessions nightly on main. See [CI Fuzzing](/vitiate/guides/ci-fuzzing/) for setup details.
