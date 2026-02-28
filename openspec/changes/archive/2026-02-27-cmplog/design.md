## Context

The vitiate fuzzer currently has two feedback channels: edge coverage counters (written by instrumented JS code into a shared `Uint8Array`) and comparison tracing calls (emitted by the SWC plugin as `__vitiate_trace_cmp(left, right, id, op)`). Edge coverage drives the mutation engine via `MaxMapFeedback`. Comparison tracing, however, is a passthrough - `traceCmp` evaluates the comparison correctly but discards the operand values. This means the fuzzer cannot learn from comparisons like `input === "admin"` and must discover magic bytes by random mutation alone.

LibAFL provides `I2SRandReplace`, an input-to-state replacement mutator that reads `CmpValuesMetadata` from the fuzzer state. When it finds bytes in the input matching one side of a recorded comparison, it replaces them with the other side. This is the standard mechanism for CmpLog-guided fuzzing in AFL++/LibAFL. The vitiate NAPI bridge already has a `traceCmp` function receiving both operands - we just need to record them and wire the metadata to the mutator.

The SWC instrumentation plugin (`vitiate-instrument`) already emits the right call shape and requires no changes for this work.

## Goals / Non-Goals

**Goals:**

- Record comparison operands from `traceCmp` calls in a format consumable by LibAFL's `I2SRandReplace` mutator.
- Add `I2SRandReplace` to the `Fuzzer`'s mutator stack alongside the existing havoc mutator.
- Populate `CmpValuesMetadata` on the fuzzer state each iteration so I2S mutations are informed by the current execution's comparisons.
- Maintain zero overhead in regression mode (when no fuzzer is active, `traceCmp` remains a pure passthrough).
- Keep the `traceCmp` NAPI function signature unchanged.

**Non-Goals:**

- Full AFL++-style `AFLppCmpLogMap` with fixed-size slots and the AFL++ CmpLog tracing stage. That machinery is designed for binary targets with compiler-inserted map writes. Our JS→NAPI bridge provides comparison operands directly - we can populate `CmpValuesMetadata` without the intermediate map.
- Redqueen-style colorization or input-to-state correspondence analysis. I2SRandReplace is the simpler, always-on strategy.
- Comparison operand deduplication or loop detection within a single execution. LibAFL's `CmpValuesMetadata::add_from` has loop detection, but since we populate the metadata directly (not via a CmpMap), we skip this for simplicity. If loop counters cause noise, this can be added later.
- Changes to the SWC instrumentation plugin or the TypeScript package.

## Decisions

### 1. Direct `CmpValuesMetadata` population vs. `CmpMap` + `StdCmpObserver`

**Decision:** Populate `CmpValuesMetadata` directly from a thread-local `Vec<CmpValues>`, bypassing the `CmpMap` trait and `StdCmpObserver`.

**Rationale:** LibAFL's `StdCmpObserver` expects a `CmpMap` - a fixed-size, indexed structure designed for compiler-inserted writes to shared memory. In vitiate, comparison operands arrive via NAPI function calls with the values already available as JS types. Building a `CmpMap` implementation would add an indexing layer and serialization/deserialization round-trip that serves no purpose. `I2SRandReplace` only reads `CmpValuesMetadata` from state metadata - it never touches the observer or map directly. Populating the metadata directly is simpler and avoids pulling in `CmpMap`-related trait bounds.

**Alternative considered:** Implement `CmpMap` backed by a `Vec<CmpValues>`, wrap it in `StdCmpObserver`, and add the observer to the observer tuple in `reportResult`. This would integrate with LibAFL's observer lifecycle more idiomatically but changes the observer tuple type (currently `tuple_list!(StdMapObserver)`) which ripples through feedback and state type aliases. The indirection adds complexity without benefit since we never use pre_exec/post_exec hooks on the observer.

### 2. Thread-local storage for comparison log

**Decision:** Use a `thread_local! { RefCell<Vec<CmpValues>> }` in the `cmplog` module. `traceCmp` appends to it. `Fuzzer::reportResult` drains it into `CmpValuesMetadata` on the state.

**Rationale:** `traceCmp` is a standalone NAPI export - it has no reference to a `Fuzzer` instance. The coverage map solved this by being a `Buffer` shared between JS and Rust via a raw pointer. For CmpLog, we need to accumulate structured data (typed comparison pairs), not write to a flat byte buffer. A thread-local Vec is the simplest mechanism:

- Node.js is single-threaded, so there are no concurrency concerns.
- No need for `unsafe` shared memory or global mutexes.
- The Fuzzer can drain the vec in `reportResult` without any synchronization.
- When no fuzzer is active (regression mode), `traceCmp` checks a thread-local "enabled" flag and skips recording entirely.

**Alternative considered:** Add a `setCmpLogBuffer` NAPI export that the TypeScript layer calls to pass a shared buffer (like the coverage map). This would mirror the coverage map pattern but requires defining a binary serialization format for heterogeneous CmpValues entries, adds a buffer management API to the TS layer, and means the TS package needs changes - violating our goal of keeping this change Rust-only.

### 3. JS value → CmpValues serialization

**Decision:** Serialize comparison operands as `CmpValues::Bytes` using UTF-8 string representation, with a numeric fast path.

Serialization rules:

- **String values:** UTF-8 bytes, truncated to 32 bytes (`CmplogBytes` max). This handles the common case: `input.toString() === "admin"`.
- **Number values (integers in u8/u16/u32 range):** Use `CmpValues::U8`/`U16`/`U32` with both operands as the integer type. AND ALSO emit a `CmpValues::Bytes` entry with the number's decimal string representation. This dual recording covers both binary reads (`data.readUInt32BE()`) and string reads (`parseInt(data.toString())`).
- **Number values (other):** String representation as bytes.
- **BigInt, boolean, null, undefined, object:** Skip - these don't produce useful byte patterns for I2S replacement.

**Rationale:** JavaScript fuzzer inputs are `Buffer` (raw bytes). User code typically converts them to strings (`data.toString()`) or reads numeric values. The I2S mutator looks for operand bytes in the input buffer and replaces them with the other operand. String representation is the most common pattern. The numeric fast path with integer CmpValues covers binary protocol parsers that do `buf.readUInt32BE()`.

`CmplogBytes` has a 32-byte limit. This is adequate for most magic values (API keys, method names, short tokens). Longer comparisons are truncated - the first 32 bytes still provide useful signal.

The `v1_is_const` field is set to `false` for all entries since we cannot statically determine which operand originates from input vs. a constant. This means `I2SRandReplace` tries replacement in both directions, which is the safe default.

### 4. Mutator stack: I2SRandReplace alongside havoc

**Decision:** Combine `I2SRandReplace` with the existing `HavocScheduledMutator` using a `StdMOptMutator` or by adding I2S as an extra mutation in the havoc cycle, so that both havoc mutations and I2S replacements are applied during mutation.

Concretely: after havoc mutation, apply `I2SRandReplace` as a post-havoc step with some probability. This avoids replacing the havoc mutator (which provides breadth) while adding targeted I2S mutations (which provide depth on comparisons).

**Alternative considered:** Replace `HavocScheduledMutator` with a `StdScheduledMutator` that includes both havoc mutations and `I2SRandReplace` in its mutation list. This is cleaner but changes the mutator type significantly and requires careful tuning of mutation weights. The simpler approach of running I2S as a secondary pass keeps the existing havoc behavior untouched.

### 5. Enabling/disabling CmpLog recording

**Decision:** Use a thread-local boolean flag (`CMPLOG_ENABLED`) that the `Fuzzer` sets to `true` at construction and `false` on drop. `traceCmp` checks this flag before recording.

**Rationale:** In regression mode, no `Fuzzer` exists, so the flag defaults to `false` and `traceCmp` remains a pure passthrough with minimal overhead (one thread-local boolean check). This avoids the need for a separate NAPI export to enable/disable recording.

## Risks / Trade-offs

**[Risk] Thread-local accumulation may use significant memory for comparison-heavy code.** → Mitigation: Cap the thread-local Vec at a reasonable size (e.g., 4096 entries per iteration). Once full, silently drop new entries. This bounds memory and avoids pathological cases where a tight loop with comparisons produces millions of entries.

**[Risk] Serializing JS values to bytes has overhead on every comparison.** → Mitigation: The NAPI call itself already dominates (crossing the JS→Rust boundary). Value serialization within Rust adds marginal cost. The thread-local boolean check for disabled mode is essentially free.

**[Risk] `CmplogBytes` 32-byte limit truncates long strings.** → Mitigation: Acceptable for MVP. Most magic values are short. For longer comparisons, the first 32 bytes still provide partial signal that helps the mutator make progress. A future enhancement could emit multiple overlapping 32-byte windows.

**[Risk] `I2SRandReplace` may not fire if operand bytes don't appear in the input.** → This is expected behavior - I2S is opportunistic. It supplements havoc mutations rather than replacing them. When operand bytes aren't found in the input, I2S returns `MutationResult::Skipped` and havoc continues normally.

**[Risk] Type alias changes in engine.rs affect the Fuzzer struct definition.** → The mutator type changes from `HavocScheduledMutator<HavocMutationsType>` to include I2S. This is an internal change with no NAPI API impact. The only visible change is that mutations become more targeted.
