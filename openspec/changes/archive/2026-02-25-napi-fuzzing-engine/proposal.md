## Why

Vitiate's core value proposition — coverage-guided JavaScript fuzzing — requires a Rust
engine that mutates inputs, evaluates coverage feedback, and manages a corpus of
interesting test cases. Nothing else in the system (SWC instrumentation, Vitest plugin,
CLI) can function without this engine. It is the first component that must exist.

The engine must expose a step-by-step API to JavaScript via NAPI because JavaScript drives
the fuzzing loop: it calls into Rust for the next mutated input, executes the JS target,
then reports coverage results back to Rust. This is architecturally different from how
LibAFL normally operates (Rust owns the loop), requiring a facade over LibAFL's
composable primitives.

## What Changes

- **Remove `vitiate-engine` crate.** The separate pure-Rust crate adds an unnecessary
  abstraction layer. The facade over LibAFL is small and lives directly in `vitiate-napi`
  as internal Rust modules, testable with `cargo test` without Node.js.
- **Add LibAFL dependencies** (`libafl`, `libafl_bolts`) to the workspace, providing
  mutation, scheduling, feedback, and corpus management primitives.
- **Implement the fuzzing engine** inside `vitiate-napi` as internal Rust modules:
  coverage map allocation, corpus management, mutation via LibAFL's havoc mutators,
  coverage feedback evaluation via `MaxMapFeedback`, and statistics tracking.
- **Expose NAPI bindings** for the engine: `createCoverageMap()`, a `Fuzzer` class with
  `addSeed()`, `getNextInput()`, `reportResult()`, and `stats`.
- **Update TypeScript types** via napi-rs auto-generation (`index.d.ts`).
- **Add integration test** exercising the full create → seed → mutate → report loop
  from TypeScript.

## Capabilities

### New Capabilities

- `coverage-map`: Rust-allocated coverage map exposed as zero-copy Node.js Buffer for
  JS instrumentation to write to and Rust feedback to read from.
- `fuzzing-engine`: Core fuzzing lifecycle — corpus management, input mutation, coverage
  feedback evaluation, crash detection — exposed as a NAPI class with a step-by-step API
  that JavaScript drives.

### Modified Capabilities

_None — no existing specs._

## Impact

- **Crates:** `vitiate-engine` deleted; `vitiate-napi` gains internal modules and LibAFL
  dependencies. Workspace `Cargo.toml` updated.
- **Dependencies:** `libafl` and `libafl_bolts` added to workspace. `cargo-deny` config
  may need license exceptions for transitive deps.
- **npm packages:** `vitiate-napi` package gains new TypeScript type exports. `vitiate`
  root package unaffected (still re-exports from `vitiate-napi`).
- **Build:** Compile time increases due to LibAFL dependency tree. No new build targets
  or toolchain requirements.
