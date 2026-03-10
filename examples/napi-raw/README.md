# napi-raw example

This example demonstrates the **low-level NAPI API** directly: manual SWC
instrumentation, coverage map allocation, and the @vitiate/engine fuzz loop.

This is **not** the typical user workflow. For the recommended approach using the
Vitest plugin and `fuzz()` API, see [`../url-parser/`](../url-parser/).

## Running

From the repository root (after building):

```bash
node examples/napi-raw/fuzzme.mjs
```
