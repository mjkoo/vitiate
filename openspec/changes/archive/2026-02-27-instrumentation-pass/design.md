## Context

Vitiate's SWC WASM plugin (`vitiate-instrument`) is a stub that compiles to `wasm32-wasip1`
and performs an identity transform. The fuzzing engine is complete and reads coverage from a
shared `Uint8Array` buffer, but nothing writes to that buffer. This change implements the
two instrumentation passes — edge coverage counters and comparison tracing — that bridge
the gap between the engine and real JavaScript targets.

The plugin runs inside SWC's transform pipeline. It receives the parsed AST, mutates it to
insert instrumentation, and returns the modified AST. SWC handles serialization, source map
propagation, and WASM execution.

## Goals / Non-Goals

**Goals:**

- SWC plugin that inserts edge coverage counters (`__vitiate_cov[ID]++`) at every branch
  point in JavaScript/TypeScript source.
- SWC plugin that wraps comparison operators with `__vitiate_trace_cmp(left, right, id, op)`
  calls for value-profile feedback.
- Deterministic edge IDs derived from file path + source span, stable across rebuilds.
- Module-level preamble that caches global references for performance.
- Plugin configuration via SWC's plugin config JSON with sensible defaults.
- Napi `traceCmp` passthrough stub that correctly evaluates comparisons.
- Comprehensive fixture tests for every instrumented construct.

**Non-Goals:**

- Source map correctness validation (SWC handles propagation automatically).
- TypeScript runtime initialization of `globalThis.__vitiate_cov` / `__vitiate_trace_cmp`
  (that's the Vitest plugin change).
- Full CmpLog/value-profile integration in LibAFL (adding `CmpObserver`,
  `AFLppCmplogTracingStage`, modifying the engine's observer and feedback tuples).
- Configurable include/exclude patterns for which files to instrument (that's handled at
  the Vite plugin level, not the SWC plugin level).
- Multi-file integration testing (running instrumented code with the engine end-to-end).

## Decisions

### 1. Wrapping u8 counters, not saturating

**Choice:** Use bare `__vitiate_cov[ID]++` with `Uint8Array`'s native wrapping behavior.
When a slot reaches 255, the next increment wraps to 0.

**Alternatives considered:**

- _Saturating counters (`+= (val < 255)`)_: Prevents wrap-around but adds a comparison and
  conditional on every branch edge in the hot loop. For targets with tight inner loops (e.g.,
  parsers iterating over input bytes), this comparison executes millions of times per second.
- _Masked counters (`(val + 1) & 255`)_: Redundant — `Uint8Array` already wraps at 256.
  The mask is a no-op that makes the generated code larger and harder to read for no benefit.

**Rationale:** Wrapping is the AFL/libFuzzer convention. Both use wrapping u8 counters and
have for decades. LibAFL's `MaxMapFeedback` tracks the historical maximum value per slot, so
a counter that wraps from 255->0 doesn't lose information — the max was already recorded as
255 on a prior iteration. The bare `++` generates the smallest, fastest instrumentation code.

### 2. Edge IDs from file path + source span hash

**Choice:** Each edge ID is `hash(file_path, span.lo, span.hi) % coverage_map_size`.

**What is a source span?** SWC represents every AST node's location as a `Span` — a pair of
byte offsets `(lo, hi)` into the original source text. `lo` is the byte offset where the
node starts, `hi` is where it ends. For example, in `if (x > 0) { ... }`, the `IfStmt`
node's span covers from the `i` in `if` to the closing `}`. The consequent block has its own
distinct span nested within.

**Why this produces stable, correct IDs:**

- _Deterministic:_ Spans come from the parsed source text. Same file -> same AST -> same
  byte offsets, regardless of compilation order or incremental builds.
- _Unique per-edge within a file:_ Distinct branch points occupy different character ranges,
  so their `(lo, hi)` pairs differ. Hash collisions are possible but acceptable — AFL itself
  assigns random 16-bit edge IDs and tolerates collisions at similar rates.
- _Unique across files:_ The file path component prevents cross-file collisions.
- _Corpus stable:_ A corpus entry that triggered new coverage remains valid across rebuilds.
  The same edges map to the same IDs, so replaying hits the same coverage slots. Critical for
  persistent corpus directories.

**Alternatives considered:**

- _Sequential counters (global mutable state in the visitor)_: Simpler but non-deterministic
  across compilations. If two files are compiled in a different order, IDs shift. Corpus
  entries become invalid after any build change.
- _Random IDs_: AFL's original approach. Non-deterministic by design. Works in AFL because
  the corpus is rebuilt from scratch each run. Doesn't work for persistent corpora.
- _File-path-only hash_: Would assign the same ID to every edge in a file. Useless.

**Hash function:** FNV-1a or a simple multiply-xorshift. Runs at compile time (inside the
SWC plugin), not at runtime. Only needs to be deterministic and well-distributed.

### 3. Module-level preamble caching globals

**Choice:** Insert `var __vitiate_cov = globalThis.__vitiate_cov;` at the top of every
instrumented module. Instrumented code references the local `__vitiate_cov` variable, not
`globalThis.__vitiate_cov` directly.

**Alternatives considered:**

- _Direct global access on every hit (`globalThis.__vitiate_cov[ID]++`)_: V8 must look up
  `globalThis`, then do a property lookup for `__vitiate_cov`, on every branch. This is
  measurably slower than a local variable reference — V8 can't inline or cache a
  `globalThis` property access as effectively as a module-scoped `var`.
- _Import from a module (`import { cov } from 'vitiate/runtime'`)_: Would require the
  instrumentation to inject import statements, which interact with module resolution,
  circular dependencies, and Vite's transform pipeline in complex ways. A `globalThis`
  read at module init is simpler and works regardless of module system.

**Rationale:** The local variable is read on every branch edge — it must be fast. A single
`globalThis` lookup at module load time is negligible. The buffer identity never changes
(the engine zeroes it in-place), so the cached reference is always valid.

### 4. `traceCmp` as napi passthrough stub (not full CmpLog)

**Choice:** Add `traceCmp(left, right, cmpId, op)` to `vitiate-napi` as a function that
evaluates the comparison and returns the boolean result, without feeding operands to LibAFL.

**Alternatives considered:**

- _Full CmpLog integration now_: Requires adding a `CmpObserver` to the engine's observer
  tuple, which changes the LibAFL state type, feedback tuple, and observer type aliases in
  `engine.rs`. That's a meaningful refactor with its own design decisions (CmpLog map size,
  observer placement, interaction with `MaxMapFeedback`). Coupling it to the instrumentation
  pass creates a change that's too large to review confidently.
- _Defer `traceCmp` entirely (instrumentation emits calls, runtime throws)_: Would mean
  instrumented code can't run until CmpLog is fully implemented. Blocks end-to-end testing
  of the instrumentation pass.
- _Implement `traceCmp` in pure JavaScript_: Avoids napi overhead for the passthrough case.
  But the function signature must be stable, and the napi function is where CmpLog feedback
  will eventually be wired in. Starting with a napi stub means the upgrade path doesn't
  change the call site.

**Rationale:** The stubs let the instrumentation pass ship end-to-end: SWC plugin emits
calls, runtime delegates to napi, napi returns correct results. CmpLog feedback replaces the
stub internals later without changing the napi signature or instrumented code.

### 5. Comparison tracing evaluates the operator in Rust via napi

**Choice:** The `op` parameter is a string (`"==="`, `"<"`, etc.) and the napi function
dispatches on it to perform the comparison using napi's value comparison APIs.

**Alternatives considered:**

- _Emit the comparison inline and only report operands_: e.g.,
  `(__vitiate_report_cmp(a, b, id), a === b)`. This avoids the overhead of a napi call for
  the comparison itself but requires two expressions in the comma operator — the report call
  (side-effect only) and the original comparison. The reporting call still crosses the napi
  boundary. Net result: same number of napi calls, more complex generated code.
- _Numeric op enum instead of string_: Avoids string comparison in the hot loop. But napi
  string passing is already optimized (UTF-8 view, no copy for short strings), and the op
  dispatch is a simple match on 8 values. The string is more debuggable and the performance
  difference is negligible compared to the napi call overhead itself.

**Rationale:** A single function call with a string operator keeps the generated code simple
and the API surface small. When CmpLog integration lands, the function body changes but the
signature stays the same.

## Risks / Trade-offs

- **SWC plugin API stability** -> `swc_core` 57.x is pinned. SWC's WASM plugin API has
  broken across major versions before. The pin isolates us, but upgrading `@swc/core` in
  the TypeScript package will require matching the Rust `swc_core` version.

- **Edge ID collisions** -> With 65536 slots and potentially thousands of edges per file,
  collisions are inevitable for large codebases. This is the same tradeoff AFL makes and is
  well-studied — collision rates below ~5% have negligible impact on fuzzing effectiveness.
  The coverage map size is configurable if a project needs a larger ID space.

- **`traceCmp` overhead** -> Every comparison in instrumented code crosses the napi boundary.
  For code with many comparisons in tight loops, this could be a measurable performance hit.
  Mitigation: the `traceCmp` config toggle lets users disable comparison tracing if
  performance is critical. When CmpLog integration lands, the napi call will at least do
  useful work (recording operands) rather than being pure overhead.

- **Generated code size** -> Instrumentation adds ~30 bytes per branch point and ~60 bytes
  per comparison. For large modules, this increases code size and may affect V8's inlining
  heuristics. This is inherent to instrumentation-based fuzzing and matches the tradeoff
  AFL/libFuzzer make with LLVM instrumentation passes.
