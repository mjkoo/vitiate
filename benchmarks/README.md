# Benchmarks

Re-runnable vitiate vs jazzer.js effectiveness benchmark on the five
xword-parser fuzz targets (ipuz, puz, jpz, xd, parse). Replaces the one-off
`VITIATE_REPORT.md` methodology with a pinned, repeatable setup.

## Prerequisites

- Local clones (not on GitHub; ask mjkoo):
  - `~/Projects/xword-parser` - harness source with the `jazzer-benchmark` and
    `vitiate-migration` branches
  - `~/Projects/xword-parser-jazzer` - working tree with uncommitted oracle
    improvements to the jazzer harness files (overlaid at setup)
  - `~/Projects/xword-parser-testdata` - seed corpus (`testdata/` is
    gitignored in the harness repos)

  Paths are configurable in `bench.config.json`.
- A built vitiate workspace: `pnpm build` at the repo root (the setup script
  packs the local build into tarballs, including the native engine binary).

## Usage

```bash
node setup.mjs                 # clone + overlay + redirect deps + install
node run-bench.mjs             # smoke mode: 30s x 1 run (sanity check)
node run-bench.mjs --mode full # 300s x 2 runs (the real protocol, ~2h)
```

Rerun `setup.mjs` after any vitiate rebuild - it re-packs the tarballs and
reinstalls the vitiate checkout so runs always measure the current build.
Setup verifies the installed `@vitiate/core` matches the local `dist/` by
content hash; if pnpm ever serves a stale cached tarball, delete
`vendor/xword-vitiate/node_modules` and rerun setup.

Reports land in `results/<stamp>-<mode>.md` (tables) and `.json` (raw
aggregate); per-run JSONL and console logs in `results/raw/`.

## How it works

- `setup.mjs` packs the workspace packages (`@vitiate/core`, `@vitiate/engine`
  plus its platform package with the locally built `.node`,
  `@vitiate/swc-plugin`, `@vitiate/fuzzed-data-provider`, `vitiate`) into
  `vendor/tarballs/`, clones the two harness branches at the SHAs pinned in
  `bench.config.json` into `vendor/xword-{jazzer,vitiate}/`, overlays the
  uncommitted jazzer harness improvements, copies in the seed testdata, and
  points the vitiate checkout at the tarballs via `pnpm.overrides`.
- `run-bench.mjs` invokes each checkout's own `scripts/fuzz-benchmark.js`
  (which emit JSONL event streams; the vitiate one reads final stats from
  `VITIATE_RESULTS_FILE`, immune to the vitest fork-pool flush race) and
  merges the streams into a comparison report.

## Reading the results

- **exec/s**: median across periodic status samples, averaged over runs.
  Vitiate's rate includes calibration executions (honest stats as of C6).
- **Coverage**: vitiate `edges` (source-level branch decision points) and
  jazzer `cov` (V8 basic-block coverage) have different granularities and are
  NOT directly comparable; both `ft` columns are feature counts in each
  tool's own terms. Track each tool against its own baseline over time.
- **INVALID runs**: the runner flags runs that died early, produced no
  metrics, or exited with unexpected codes, and exits nonzero. A known
  failure mode to watch for: `Scheduler on_replace failed: Key not found`
  (MinimizerScheduler, hit 4/5 harnesses in the original 2026-03 benchmark).
  The vendored scripts capture the fuzz child's stderr internally, so on an
  INVALID run rerun the target manually inside the checkout to see the error:

  ```bash
  cd vendor/xword-vitiate
  VITIATE_FUZZ=1 VITIATE_FUZZ_TIME=30 pnpm exec vitest run fuzz/puz.fuzz.ts
  ```

## Fairness notes

- Both sides seed from the same `testdata/` tree and use `max_len` 8192
  (vitiate via `vitest.config.ts` `fuzz.maxLen`, jazzer via `-max_len=8192`
  in the overlaid `scripts/fuzz-benchmark.js`).
- Both sides use equivalent strengthened validation oracles
  (`validateParseError` / `validateIpuzParsed` / `validateCell` /
  `validateUnified`) in their fuzz entries.
- Instrumentation scope: vitiate instruments `src/**/*.ts` in the harness
  checkout; jazzer instruments `dist/`. Whether dependencies (e.g.
  `fast-xml-parser`) are instrumented differs by tool config and materially
  changes coverage numbers - recorded in the report metadata, keep fixed
  across runs you compare.
