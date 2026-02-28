## Context

Vitiate is a coverage-guided JavaScript fuzzer built as a Vitest plugin. The project
currently has skeleton crates (`vitiate-engine`, `vitiate-napi`, `vitiate-instrument`)
with placeholder code and no LibAFL integration.

The fuzzing architecture requires JavaScript to drive the loop: JS gets a mutated input
from Rust, executes the target, and reports coverage back to Rust. This is the inverse of
LibAFL's normal model where Rust owns the loop and calls a harness function pointer.

LibAFL's core types are heavily generic (e.g., `StdFuzzer<CS, F, IC, IF, OF>`). A
concrete facade must select specific type parameters and present a simple, opaque API
through NAPI.

## Goals / Non-Goals

**Goals:**

- Working NAPI addon with `createCoverageMap()` and a `Fuzzer` class that TypeScript can
  call to run a coverage-guided fuzzing loop step-by-step.
- Coverage map as a zero-copy shared buffer between JS and Rust.
- Input mutation via LibAFL's havoc mutators.
- Coverage feedback evaluation via `MaxMapFeedback`.
- In-memory corpus that grows as interesting inputs are discovered.
- Crash detection via `CrashFeedback` (inputs causing the target to throw).
- Fuzzing statistics (execs, corpus size, edge count, execs/sec).
- Rust-side unit tests exercising the engine without Node.js.
- TypeScript integration test exercising the full loop.

**Non-Goals:**

- Disk corpus persistence (in-memory only for this change).
- Crash deduplication or input minimization.
- Comparison tracing (`traceCmp` / `traceCmpStr`).
- SWC instrumentation plugin (untouched).
- Vitest plugin or `test.fuzz()` API.
- Multi-worker parallelism.
- libFuzzer CLI flag parsing.
- Dictionary-based or grammar-aware mutations.

## Decisions

### 1. Collapse vitiate-engine into vitiate-napi

**Choice:** Delete `vitiate-engine` as a separate crate. All Rust fuzzing logic lives in
`vitiate-napi/src/` as internal modules.

**Alternatives considered:**

- _Keep separate crate (PRD design)_: Adds a crate boundary and dependency edge for a
  facade that is ~200 lines of code with exactly one consumer. The PRD's rationale
  ("testable without Node.js") is satisfied by `cargo test` within `vitiate-napi` -
  the `#[napi]` attribute doesn't prevent pure-Rust unit tests.
- _Put everything in a single file_: The engine has enough distinct concerns (coverage
  map management, LibAFL type wiring, NAPI bindings) that module separation aids
  readability.

**Rationale:** YAGNI. If a second consumer of the Rust API appears, extraction to a
separate crate is a mechanical refactor. Until then, fewer crates means simpler workspace
and faster builds.

### 2. Zero-copy coverage map via pointer stash

**Choice:** Store a raw pointer to the JS `Buffer`'s backing memory inside the `Fuzzer`
struct, obtained from `createCoverageMap()`. Hold a `napi::Ref<Buffer>` to prevent GC.
On each `reportResult()` call, construct a `MapObserver` view directly over this pointer,
evaluate feedback, then zero the buffer in place. No per-iteration copy.

**Alternatives considered:**

- _Copy per iteration_: Copy the 65KB map into an `OwnedMapObserver` each iteration.
  Safe (no `unsafe`) but introduces two memops per iteration (copy + zero). At 50K
  iter/sec this is ~3.2 GB/s - likely dwarfed by V8 execution time, but it's a
  pessimization with no architectural benefit. The copy buys nothing that the pointer
  stash doesn't already provide.
- _SharedArrayBuffer_: Cross-thread-safe shared memory. This is orthogonal to the
  copy-vs-pointer question - `SharedArrayBuffer` solves multi-worker memory sharing,
  not per-iteration overhead. Multi-worker support requires solving harder problems
  first (corpus synchronization, scheduler coordination, feedback state merging) that
  are independent of coverage map transport. `SharedArrayBuffer` can be adopted when
  multi-worker lands without affecting this decision.

**Rationale:** The `napi::Ref<Buffer>` prevents GC of the backing `ArrayBuffer`,
keeping the raw pointer valid for the lifetime of the `Fuzzer`. The `unsafe` surface is
small and well-contained: one `std::slice::from_raw_parts_mut` to create the observer
view. This is a standard NAPI pattern used by native image processing, crypto, and
buffer manipulation libraries. Avoiding the copy eliminates unnecessary overhead without
meaningful complexity cost.

### 3. Use libafl + libafl_bolts, not libafl_libfuzzer

**Choice:** Depend on `libafl` (core framework) and `libafl_bolts` (utilities) only.

**Alternatives considered:**

- _Wrap libafl_libfuzzer_: That crate is a cargo-fuzz drop-in exposing `LLVMFuzzerRunDriver`
  (C ABI). Its build system compiles a separate static archive and uses `llvm-objcopy` to
  rename every Rust symbol. This machinery exists for Rust-to-Rust linking scenarios that
  don't apply to a NAPI addon.
- _Use libafl_sugar (high-level API)_: Designed for Python bindings via PyO3. Would need
  adaptation for NAPI and still doesn't support externally-driven loops.

**Rationale:** We need LibAFL's composable primitives (mutators, schedulers, feedbacks,
corpus) assembled into a step-by-step API. The core `libafl` crate provides exactly this.
Higher-level wrappers assume Rust owns the loop.

### 4. ProbabilitySamplingScheduler, not QueueScheduler or PowerQueueScheduler

**Choice:** Use `ProbabilitySamplingScheduler` (probabilistic corpus entry selection).

**Alternatives considered:**

- _QueueScheduler_: Simple round-robin. Deterministic and zero-config, but treats all
  corpus entries equally regardless of their coverage contribution. No prioritization.
- _PowerQueueScheduler (AFLFast power schedules)_: Adaptive scheduling weighted by
  coverage and execution time. The best long-term choice, but requires `CalibrationStage`
  (re-executes each new corpus entry multiple times to measure stability and timing) and
  `StdPowerMutationalStage` (replaces `StdMutationalStage`). These stages assume they own
  the execution loop - calibration needs to invoke the target internally, which conflicts
  with our externally-driven architecture where JS calls `getNextInput()`/`reportResult()`.
  Integrating calibration requires either asking JS to re-run the target during
  `reportResult()` (changes the API contract) or running a shadow executor on the Rust
  side (requires duplicating the JS target semantics). This is a meaningful design problem
  that warrants its own change.
- _WeightedScheduler (AFL++-style)_: Same calibration requirement as PowerQueueScheduler.
  Builds an alias table for probabilistic selection weighted by `TestcaseScore`. Better
  than PowerQueue in theory but same integration challenge.
- _Entropic (libFuzzer-style)_: Not available in LibAFL. Entropic (Böhme et al., FSE 2020) was implemented directly in libFuzzer and never ported to the AFL family.
- _RandScheduler_: Pure random selection. No calibration needed but no prioritization
  either - strictly worse than probability sampling.

**Rationale:** `ProbabilitySamplingScheduler` provides non-deterministic scheduling with
per-entry probability metadata, without requiring calibration stages. It's a meaningful
improvement over round-robin (avoids getting stuck cycling through unproductive entries)
while staying compatible with our externally-driven loop. `PowerQueueScheduler` with
calibration integration is the right long-term target and should be designed as a
follow-up change once the basic loop is proven.

### 5. Auto-seed with diverse default corpus

**Choice:** If no seeds are added before the first `getNextInput()`, automatically add a
small set of diverse default inputs to the corpus:

```
""                    (empty - zero-length edge case)
"\n"                  (minimal valid ASCII, libFuzzer's default)
"0"                   (numeric boundary value)
"\x00\x00\x00\x00"   (binary/null-byte handling)
"{}"                  (empty JSON object)
"test"                (short printable ASCII string)
```

**Alternatives considered:**

- _Single empty input_: Functional, but Herrera et al. (ISSTA 2021, 33 CPU-years of
  fuzzing across multiple fuzzers) found that a single empty seed is the worst-performing
  strategy - higher exec/s but significantly fewer bugs and less coverage than even a
  small diverse set. libFuzzer itself uses `\n`, not empty.
- _Single non-empty input_: Better than empty, but still leaves the mutator to discover
  all structural tokens (braces, brackets, quotes) through random byte mutation, which is
  statistically unlikely.
- _Large default corpus_: Diminishing returns. The research shows diversity matters more
  than size for initial seeds. Six small seeds cover the key input classes (empty, ASCII,
  numeric, binary, structured) with negligible overhead.

**Rationale:** LibAFL's scheduler panics on `next()` with an empty corpus. Rather than
requiring callers to always call `addSeed()` first (error-prone), the engine handles the
empty case gracefully. The diverse seed set gives the mutator structural tokens (JSON
braces, null bytes, printable ASCII) as starting material, dramatically accelerating
discovery of parsing and validation code paths in JS targets. Users should still call
`addSeed()` with representative examples for targets expecting specific input formats.

### 6. Module structure

```
vitiate-napi/src/
├── lib.rs          # #[napi] exports only
├── engine.rs       # Fuzzer struct wrapping LibAFL components
├── coverage.rs     # Coverage map allocation and observer bridge
└── types.rs        # FuzzerConfig, IterationResult, ExitKind, FuzzerStats
```

**Rationale:** Separates NAPI boundary (`lib.rs`) from engine logic (`engine.rs`) from
type definitions (`types.rs`). Each module has a single responsibility. The NAPI functions
in `lib.rs` are thin wrappers that delegate to `engine.rs`.

## Risks / Trade-offs

- **LibAFL dependency weight** → Monitor compile times after adding deps. Use
  `default-features = false` aggressively. May need `cargo-deny` license exceptions for
  LibAFL's transitive dependencies.

- **LibAFL type system complexity** → The deeply nested generics may make concrete type
  signatures unwieldy. Mitigate with type aliases. If trait bounds become unmanageable,
  consider `Box<dyn Trait>` for specific components (at minor runtime cost).

- **Observer without executor** → We bypass LibAFL's executor pipeline entirely (JS runs
  the target). `MaxMapFeedback::is_interesting()` reads from the observer via the
  `MapObserver` trait and doesn't care how the map was populated. Verified by reading
  the feedback implementation - it only calls `observer.get()` and compares against
  stored maxima.

- **Coverage map zeroing ownership** → Rust zeros the JS Buffer in place via the stashed
  pointer at the end of `reportResult()`. Between calls the map is clean. If JS code runs
  between `reportResult()` returning and the next `getNextInput()` call (e.g., logging
  that touches instrumented code), those stray writes will be included in the next
  iteration's coverage. This is acceptable - it matches libFuzzer's behavior with
  persistent mode harnesses.

- **Pointer stash safety** → The `napi::Ref<Buffer>` prevents GC but the raw pointer
  is still `unsafe` to dereference. Invariants: (1) the `Ref` must outlive all pointer
  uses (enforced by holding both in the same struct), (2) JS must not reallocate or
  detach the `ArrayBuffer` while the `Fuzzer` is alive. Node.js `Buffer` objects use
  non-detachable backing stores by default, so (2) holds unless the user explicitly
  calls `ArrayBuffer.transfer()` on the underlying buffer, which would be a misuse of
  the API.

- **Default corpus assumptions** → The default seed set includes JSON-like tokens (`{}`)
  which biases early exploration toward structured-input code paths. This is a good
  default for JS targets (which overwhelmingly process strings/JSON), but targets
  expecting purely binary protocols won't benefit from the JSON seeds. The cost is
  negligible - a few extra corpus entries that the scheduler will deprioritize if they
  don't produce interesting coverage.
