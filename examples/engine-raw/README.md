# engine-raw example

A **documentation example** showing the low-level `@vitiate/engine` API directly:
manual SWC instrumentation, coverage map allocation, and the fuzz loop.

This is **not** intended for direct use. The recommended workflow uses the Vitest
plugin and `fuzz()` API - see [`../url-parser/`](../url-parser/).

## Running

From the repository root (after building):

```bash
node examples/engine-raw/fuzzme.mjs
```
