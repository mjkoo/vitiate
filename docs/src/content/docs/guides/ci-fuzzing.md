---
title: CI Fuzzing and libFuzzer Compatibility
description: Running Vitiate in CI and using its libFuzzer-compatible CLI interface.
---

Vitiate's CLI accepts libFuzzer-compatible flags, making it usable with fuzzing infrastructure that expects a libFuzzer-style interface.

## libFuzzer-Compatible Interface

The CLI maps libFuzzer conventions to Vitiate:

```bash
# Standard libFuzzer invocation pattern
npx vitiate test/parser.fuzz.ts corpus/ -max_len 1024 -max_total_time 300

# Corpus minimization (merge mode)
npx vitiate test/parser.fuzz.ts -merge 1 minimized/ corpus_a/ corpus_b/

# Artifact output location
npx vitiate test/parser.fuzz.ts -artifact_prefix ./crashes/
```

Positional arguments after the test file are treated as corpus directories, matching libFuzzer behavior.

## CI Fuzzing

### Environment Variables

Use environment variables to configure fuzzing in CI without modifying test files:

```bash
# Run for 5 minutes
VITIATE_FUZZ_TIME=300 npx vitiate test/parser.fuzz.ts

# Run for exactly 100,000 iterations
VITIATE_FUZZ_EXECS=100000 npx vitiate test/parser.fuzz.ts
```

### GitHub Actions Example

```yaml
name: Fuzz
on:
  schedule:
    - cron: '0 2 * * *'  # nightly
  workflow_dispatch:

jobs:
  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx vitiate test/parser.fuzz.ts -max_total_time 600
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: crash-artifacts
          path: testdata/fuzz/**/crash-*
```

### Corpus Caching

Persist the corpus across CI runs to build on previous coverage:

```yaml
      - uses: actions/cache@v4
        with:
          path: .vitiate-corpus
          key: fuzz-corpus-${{ hashFiles('test/**/*.fuzz.ts') }}-${{ github.run_number }}
          restore-keys: |
            fuzz-corpus-${{ hashFiles('test/**/*.fuzz.ts') }}-
            fuzz-corpus-
```

## Corpus Minimization

Over time, the corpus grows. Periodically minimize it:

```bash
# Merge multiple corpus directories into a minimized set
npx vitiate test/parser.fuzz.ts -merge 1 minimized-corpus/ .vitiate-corpus/ extra-corpus/

# Replace the old corpus with the minimized one
rm -rf .vitiate-corpus/
mv minimized-corpus/ .vitiate-corpus/
```

The merge operation evaluates every input's coverage contribution and keeps only the smallest set that maintains the same total coverage.

## Supported Flags

| Flag | libFuzzer Equivalent | Notes |
|------|---------------------|-------|
| `-max_len` | `-max_len` | Maximum input length |
| `-timeout` | `-timeout` | Per-execution timeout (seconds) |
| `-runs` | `-runs` | Total iterations |
| `-max_total_time` | `-max_total_time` | Total time limit (seconds) |
| `-seed` | `-seed` | RNG seed |
| `-dict` | `-dict` | Dictionary file |
| `-merge` | `-merge` | Corpus minimization |
| `-artifact_prefix` | `-artifact_prefix` | Crash artifact location |
| `-fork` | `-fork` | Parsed for compatibility, ignored (always 1) |
| `-jobs` | `-jobs` | Parsed for compatibility, ignored (always 1) |
