---
title: CI Fuzzing
description: Integrating Vitiate into your CI pipeline for regression testing and continuous fuzzing.
---

Fuzzing delivers the most value when it is integrated into your CI pipeline at two levels: fast feedback on every change and deep exploration on a schedule. This guide covers the primary approach using `vitiate` CLI subcommands. If your CI pipeline needs libFuzzer-compatible flags or integration with a fuzzing platform, see [Standalone CLI](/vitiate/guides/cli/).

## Branches and Pull Requests

Run **regression tests** on every branch push and PR. Regression mode replays the committed seed corpus and cached corpus without generating new inputs, so it is fast, deterministic, and catches regressions introduced by the change:

```bash
npx vitiate regression
```

For additional confidence, run a **short fuzzing session** (30 seconds to a few minutes) after regression tests pass. This catches shallow bugs introduced by the change before they reach the main branch:

```bash
npx vitiate fuzz --fuzz-time 300
```

`--fuzz-time` sets the fuzzing duration in seconds per target. Keep it short enough that PRs are not blocked waiting for the fuzzer. The goal is fast feedback, not exhaustive exploration. You can also use the `VITIATE_FUZZ_TIME` environment variable as an alternative:

```bash
VITIATE_FUZZ_TIME=300 npx vitiate fuzz
```

## Main and Release Branches

Run **long nightly fuzzing sessions** (minutes to hours) on main or release branches via a scheduled CI job. These sessions have time to exercise deep code paths and find bugs that short runs miss:

```bash
npx vitiate fuzz --fuzz-time 3600
```

After a nightly session, optionally [minimize and checkpoint the corpus](/vitiate/concepts/corpus/#checkpointing-fuzzer-progress) to feed coverage gains back into the regression suite so that every subsequent PR benefits from the fuzzer's discoveries.

## GitHub Actions Example

```yaml
name: Fuzz
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 2 * * *'  # nightly

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx vitiate regression

  fuzz:
    runs-on: ubuntu-latest
    needs: regression
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci

      # Cache the corpus across runs to build on previous coverage
      - uses: actions/cache@v4
        with:
          path: .vitiate/corpus
          key: fuzz-corpus-${{ hashFiles('test/**/*.fuzz.ts') }}-${{ github.run_number }}
          restore-keys: |
            fuzz-corpus-${{ hashFiles('test/**/*.fuzz.ts') }}-
            fuzz-corpus-

      # Short fuzz on PRs, long fuzz on nightly schedule
      - name: Fuzz (short)
        if: github.event_name == 'pull_request'
        run: npx vitiate fuzz --fuzz-time 300

      - name: Fuzz (nightly)
        if: github.event_name == 'schedule'
        run: npx vitiate fuzz --fuzz-time 3600

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: crash-artifacts
          path: .vitiate/testdata/**/crashes/crash-*
```

## Corpus Caching

The cache key strategy in the example above ensures each CI run builds on previous coverage:

- `run_number` in the key means each run saves a new cache entry rather than overwriting
- `restore-keys` falls back to the most recent cache for the same test files, then to any previous cache
- If fuzz test files change, the cache starts fresh (since coverage maps may be incompatible)

For background on corpus locations and what gets cached, see [Corpus Locations](/vitiate/concepts/corpus/#corpus-locations). For periodic cleanup of the cached corpus, see [Corpus Minimization](/vitiate/concepts/corpus/#corpus-minimization).

## Summary

| CI context | What to run | Why |
|---|---|---|
| Every push/PR | Regression tests (`npx vitiate regression`) | Fast, deterministic - catches regressions |
| Every push/PR | Short fuzz (5min) | Catches shallow bugs before merge |
| Nightly on main | Long fuzz (1h) | Deep exploration, finds subtle bugs |
| After nightly fuzz | Optimize + checkpoint | Feeds coverage gains back to regression suite |
