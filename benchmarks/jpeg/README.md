# bench-jpeg

A standalone, vitiate-only coverage/throughput benchmark for **jpeg-js** - a
pure-CommonJS JPEG decoder (marker state machine, Huffman decode, IDCT, colour
convert). It exists to exercise vitiate's `instrument.packages` CJS-instrumentation
path on a dense binary target. No cloning or vendoring: it drives the local
`@vitiate/core` build via `workspace:*`.

## Prerequisites

- `pnpm build` at the repo root (produces `vitiate-core/dist` + the engine `.node`).
- `pnpm install` at the repo root.

## Usage

```bash
node ../run-lib.mjs                        # 30s (smoke)
node ../run-lib.mjs --duration 300 --runs 3
# or: pnpm --filter @vitiate/bench-jpeg run bench
```

Each run starts from the committed `seeds/` only (the evolved corpus is wiped
first, so runs are reproducible and `--runs` replicates are independent), fuzzes
for the budget, and reports `edges`, `features`, `execs/sec`, `corpus`, and
`crashes` (median across runs). The shared runner lives at
`benchmarks/run-lib.mjs`; `.vitiate/` (gitignored) holds per-run testdata/corpus.
