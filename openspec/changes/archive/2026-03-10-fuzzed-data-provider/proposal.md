## Why

Fuzz targets currently receive raw `Buffer` input and must manually slice and interpret bytes to produce structured values (numbers, strings, booleans, etc.). This is tedious, error-prone, and discourages writing fuzz tests for APIs that accept typed arguments rather than raw binary data. A `FuzzedDataProvider` (FDP) - the standard pattern established by LLVM's libFuzzer and adopted by every major fuzzing framework - solves this by providing a structured API that consumes bytes from the fuzzer-generated buffer to produce arbitrary typed values within caller-specified ranges.

## What Changes

- Add a new standalone package `@vitiate/fuzzed-data-provider` that provides a `FuzzedDataProvider` class
- The class wraps a `Uint8Array` and exposes methods to consume bytes as booleans, integers (number and bigint), floats/doubles (with range support), strings (with encoding and printable options), byte arrays, and element selection from arrays
- Uses the LLVM split-buffer consumption strategy: individual values consumed from the end (little-endian), arrays/strings consumed from the front (big-endian) - this gives the mutation engine better structure to work with
- Pure TypeScript, zero native dependencies - usable independently of `@vitiate/core` or `@vitiate/engine`
- API designed to be compatible with the LLVM FuzzedDataProvider semantics so users familiar with C++/Rust/Java FDP implementations find a consistent interface

## Capabilities

### New Capabilities

- `fuzzed-data-provider`: The FuzzedDataProvider class and its full typed consumption API (booleans, integers, bigints, floats, doubles, strings, byte arrays, element picking), including range-constrained variants, array consumption, and the split-buffer byte management strategy

### Modified Capabilities

_(none - this is a new standalone package with no changes to existing specs)_

## Impact

- **New package**: `@vitiate/fuzzed-data-provider` added to the pnpm workspace, built with `tsup`, published as a standalone npm package
- **Future consumers**: Integration packages (`@vitiate/zod`, etc.) will depend on it directly for their structured generation visitors. `@vitiate/core` will not re-export FDP - it is a standalone utility with independent versioning
- **No breaking changes**: Existing `fuzz(name, (data: Buffer) => ...)` API is unchanged; FDP is opt-in (`new FuzzedDataProvider(data)` inside the target)
- **Build system**: New workspace entry in `pnpm-workspace.yaml`; turbo tasks are global and auto-apply to the new package
