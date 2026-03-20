## Context

After the per-site cap optimization, the dominant cost is the NAPI boundary crossing itself: ~29% of wall time is spent in V8's C++ callback dispatch machinery for `trace_cmp_record`. Every instrumented comparison pays the full V8 callback entry/exit cost (`CallbackInfo::new`, `napi_get_cb_info`, `FunctionCallbackWrapper::Invoke`, `GetFunctionTemplateData`) to cross into Rust, even if the call returns immediately because the site is capped or CmpLog is disabled.

The coverage map already uses shared memory: `createCoverageMap()` returns a `Buffer` backed by Rust memory, and JS writes `__vitiate_cov[id]++` directly without any NAPI call. We apply the same principle to CmpLog: JS writes comparison data into Rust-owned shared memory, and Rust reads it in bulk during `drain()`.

## Goals / Non-Goals

**Goals:**
- Eliminate all per-comparison NAPI boundary crossings
- JS handles guard checks (per-site cap, buffer overflow) and operand serialization entirely in JS
- Rust reads and processes comparison data in bulk during `drain()`
- Produce the same `CmpValues` entries as the current path (semantic equivalence)

**Non-Goals:**
- Moving `CmpValues` construction to JS (Rust handles the `serialize_pair` / integer detection / `CmplogBytes` construction during bulk processing)
- Value-level deduplication (future optimization)
- Tuning slot buffer size to specific benchmarks (pick a reasonable default, expose as a constant)

## Decisions

### Decision 1: Fixed-slot buffer in Rust-owned shared memory

A contiguous byte array allocated by Rust, exposed to JS as a `Buffer`. JS writes comparison entries into fixed-size slots; Rust reads them in bulk during `drain()`.

**Layout:**

```
Slot buffer: [slot_0 | slot_1 | ... | slot_N-1]
Write pointer: Uint32Array(1) - JS increments, Rust reads and resets
```

Each slot is a fixed size (e.g., 80 bytes):

```
Offset  Size  Field
0       4     cmpId (u32 LE)
4       1     operatorId (u8)
5       1     leftType (0=skip, 1=f64, 2=string)
6       1     rightType
7       1     leftLen (string byte count, max 32; 0 for f64)
8       8     leftF64 (when leftType=1, LE)
8       32    leftStr (when leftType=2, UTF-8, zero-padded)
40      1     rightLen
41      8     rightF64 (when rightType=1, LE)
41      32    rightStr (when rightType=2, UTF-8, zero-padded)
Total:  73 bytes -> pad to 80 for alignment
```

The buffer holds `BUFFER_SIZE / SLOT_SIZE` entries. When the write pointer reaches capacity, additional entries are silently dropped (matching existing overflow behavior).

**Rationale:** Fixed slots avoid variable-length framing on both sides. The 80-byte slot wastes space for small entries (two u8 comparisons need ~15 bytes) but makes the JS writer branchless for offset calculation: `slot * 80`. V8's TurboFan JIT compiles `DataView.setFloat64` and `Uint8Array` writes to direct memory stores.

**Sizing:** At 80 bytes per slot, a 256KB buffer holds 3,276 slots. Each numeric comparison produces 2 `CmpValues` entries from 1 buffer slot (Rust does the expansion during bulk processing), so 3,276 slots can produce up to ~6,552 entries - well above the 4,096-entry global cap. This ensures the buffer never limits before the global cap does.

**Alternative considered:** Variable-length entries with length prefix. Rejected because the JS writer would need size calculation before writing, adding branching on the hot path.

**Alternative considered:** Separate typed arrays per field. Rejected because scattering one logical entry across arrays makes Rust-side iteration cache-unfriendly.

**Stale data invariant:** The slot buffer is not zeroed between iterations; only the write pointer is reset to 0. Stale data from previous iterations may exist in slots beyond the current write pointer, but Rust processes only slots `0..writePtr[0]`, all of which were freshly written by JS in the current iteration. Within a slot, Rust uses the type tag to decide which fields to read (e.g., `leftLen` is only read when `leftType == 2`), so uninitialized fields for other type cases are harmless. Partial writes from early returns (e.g., left operand is a number but right is a boolean) leave data in the slot, but the write pointer is only incremented after both operands are successfully written, so Rust never sees incomplete entries.

### Decision 2: Write pointer as the enabled/disabled signal

The shared write pointer (`Uint32Array(1)`) doubles as the enabled/disabled flag. No separate enabled state is needed.

- **Disabled:** Rust sets `writePtr[0] = 0xFFFFFFFF`. The JS write function's existing check `if (slot >= MAX_SLOTS) return;` catches this, since `0xFFFFFFFF >= MAX_SLOTS` is always true. Zero additional cost - the overflow check was already there.
- **Enabled:** Rust sets `writePtr[0] = 0`. JS starts writing from slot 0.
- **Drain:** Rust reads entries `0..writePtr[0]`, then resets `writePtr[0] = 0`.

This eliminates:
- A separate enabled flag (no JS variable, no shared byte, no `Buffer`)
- Function reference swapping at enable/disable boundaries
- The stale cached reference problem entirely

The write function is set once during `initGlobals()` and never changes. Modules cache the reference in their preamble at load time. Enable/disable operates purely through the write pointer value in shared memory.

In regression mode (no fuzzer), `__vitiate_cmplog_write` is a no-op `(_l, _r, _c, _o) => {}` because no slot buffer is allocated and no fuzzer will ever set the write pointer. There is no function swap at runtime - the no-op is the only function that ever exists in regression mode.

**Rationale:** One check, one code path, zero additional state. The write pointer already existed and was already checked on every call. Making it pull double duty as the enabled flag is free.

### Decision 3: Per-site counts are JS-local

The per-site count array is a `Uint8Array(512)` allocated in JS. JS increments it after writing each slot buffer entry. JS resets it to all zeros between iterations.

Rust does not read the site counts. The per-site cap enforcement is entirely JS-side. Rust's `push()` still enforces the global 4,096-entry cap during bulk processing, but per-site capping happens before entries even reach the slot buffer.

**Lifecycle sync:** The fuzz loop resets counts at the top of each iteration, before running the target, by calling `globalThis.__vitiate_cmplog_reset_counts()`. This function is set by `initGlobals()` alongside the write function - it closes over the same `counts` array and calls `counts.fill(0)`. In regression mode, it is a no-op. This is equivalent to resetting at drain time in steady state (the two points are adjacent in the loop), but is more robust: if a previous fuzzing session ended abnormally (exception before drain), stale counts are cleared before the next iteration rather than persisting into it. Unlike the current Rust implementation where `enable()` explicitly resets `site_counts`, the JS-local counts rely on the iteration boundary for reset. This is sufficient because `Uint8Array` is zero-initialized on allocation (covering the first session) and the fuzz loop always resets before use (covering subsequent sessions).

**Count granularity change:** Per-site counts now track comparisons (slot buffer entries), not `CmpValues` entries. A numeric comparison that produces two `CmpValues` during Rust bulk processing (one integer variant, one Bytes variant) counts as one against the per-site budget. This effectively doubles the per-site budget for numeric comparisons (8 comparisons producing up to 16 `CmpValues`, vs the previous behavior where each `CmpValues` counted separately). This is acceptable because the cap's purpose is to limit hot sites, and counting comparisons is more intuitive than counting their serialized representations.

**Rationale:** The site counts are only read and written by JS. Making them JS-local means they're a plain `Uint8Array` - no shared memory, no `Box` indirection, no pointer lifetime concerns.

### Decision 4: SWC plugin emits calls to `__vitiate_cmplog_write`

The SWC plugin emits a function call to a cached write function. The plugin's preamble and IIFE pattern are updated:

```js
// Preamble (emitted once per module):
var __vitiate_cov = globalThis.__vitiate_cov;
var __vitiate_cmplog_write = globalThis.__vitiate_cmplog_write;
```

The comparison IIFE becomes:

```js
((l, r) => (__vitiate_cmplog_write(l, r, CMP_ID, OP_ID), l === r))(a, b)
```

The `__vitiate_cmplog_write` function is defined once in `globals.ts` during `initGlobals()`. In fuzzing mode, it writes to the slot buffer. In regression mode, it is a no-op. A companion `__vitiate_cmplog_reset_counts` function is also set, closing over the same `counts` array, for the fuzz loop to call at iteration boundaries.

```js
// Fuzzing mode (set once during initGlobals, never swapped):
globalThis.__vitiate_cmplog_reset_counts = () => counts.fill(0);

const write = (left, right, cmpId, opId) => {
  const slot = wptr[0];
  if (slot >= MAX_SLOTS) return;  // covers buffer-full AND disabled
  const si = cmpId & 511;
  if (counts[si] >= 8) return;

  const off = slot * SLOT_SIZE;
  view.setUint32(off, cmpId, true);
  buf[off + 4] = opId;

  const lt = typeof left;
  if (lt === 'number') {
    buf[off + 5] = 1;
    view.setFloat64(off + 8, left, true);
  } else if (lt === 'string') {
    buf[off + 5] = 2;
    const n = encoder.encodeInto(left, buf.subarray(off + 8, off + 40)).written;
    buf[off + 7] = n;
  } else {
    return; // skip unsupported types
  }

  const rt = typeof right;
  if (rt === 'number') {
    buf[off + 6] = 1;
    view.setFloat64(off + 41, right, true);
  } else if (rt === 'string') {
    buf[off + 6] = 2;
    const n = encoder.encodeInto(right, buf.subarray(off + 41, off + 73)).written;
    buf[off + 40] = n;
  } else {
    return; // skip unsupported types
  }

  wptr[0] = slot + 1;
  counts[si]++;
};
```

**Rationale:** A single function call is the minimal overhead at the call site. The IIFE structure is preserved because it guarantees operands are evaluated exactly once. The function body is pure JS with no NAPI crossing. The `typeof` checks and `DataView` writes are among the fastest operations in V8's JIT.

**Why not fully inline the guard + write?** Inlining the entire write logic at every comparison site would bloat code size significantly (~30 lines per comparison). A function call to a cached local reference is one indirect jump - negligible compared to the NAPI crossing it replaces.

### Decision 5: Only the slot buffer and write pointer are shared memory

Two NAPI exports, called once during `initGlobals()`:

- `cmplogGetSlotBuffer() -> Buffer` (256KB) - slot buffer backing memory
- `cmplogGetWritePointer() -> Buffer` (4 bytes, used as `Uint32Array`)

These are the only shared-memory surfaces. Rust allocates the memory (`Box<[u8; N]>` for stable heap address), JS gets `Buffer` views.

Everything else is JS-local:
- Per-site counts: `Uint8Array(512)`
- `TextEncoder` instance
- `DataView` over the slot buffer (derived from the `Buffer`)
- Constants (`MAX_SLOTS`, `SLOT_SIZE`, etc.)

**Rationale:** Minimize the shared-memory surface. Only data that both JS and Rust need to read/write crosses the boundary. The slot buffer is written by JS and read by Rust. The write pointer is incremented by JS and read/reset by Rust.

### Decision 6: Rust bulk processing in drain()

`drain()` gains a slot buffer processing step:

1. Read write pointer to get entry count N. If N > MAX_SLOTS, return any pre-accumulated entries without processing the slot buffer or modifying the write pointer. This guards against the disabled sentinel (`0xFFFFFFFF`) and any corruption - `drain()` is called from 40+ sites including stages that drain-and-discard, and must be safe regardless of CmpLog state.
2. For entries 0..N:
   - Read `cmpId`, `operatorId` from slot
   - Map `operatorId` to `CmpLogOperator` (skip invalid IDs)
   - Read `leftType`/`rightType` and deserialize to `ExtractedValue`:
     - Type 1 (f64): read 8 bytes as `f64` LE -> `ExtractedValue::Num`
     - Type 2 (string): read `len` bytes as UTF-8 -> `ExtractedValue::Str`
     - Type 0 (skip): `ExtractedValue::Skip`
   - Call existing `serialize_pair(&left, &right)` to get `Vec<CmpValues>`
   - Append each `CmpValues` to the entries accumulator (inline, not via `push()`, because `drain()` already holds the `RefCell` borrow)
3. Reset write pointer to 0

**Rationale:** Reusing `serialize_pair()` means the slot buffer produces identical `CmpValues` as the NAPI path did. The integer detection (`as_nonneg_int`), size binning (`U8/U16/U32/U64`), and `CmplogBytes` construction all happen in Rust exactly as before. Downstream consumers (I2S, REDQUEEN, token extraction) see no change.

The colorization dual-trace works naturally: the colorized target execution hits the same instrumented comparison sites, which write to the slot buffer via `__vitiate_cmplog_write`. When the colorization stage drains the accumulator, it gets entries from the slot buffer. No special path needed.

### Decision 7: The NAPI traceCmpRecord function is removed

Since all comparison tracing goes through the slot buffer (including colorization), the NAPI `traceCmpRecord` function in `trace.rs` is no longer needed. It is removed or gated behind `#[cfg(test)]`.

**Rationale:** One path is cleaner than two. The slot buffer handles all cases. Test code that needs to inject comparison entries can call `globalThis.__vitiate_cmplog_write(...)` or write to the slot buffer directly.

## Risks / Trade-offs

**[JS serialization fidelity]** JS-side serialization must produce semantically equivalent input to what Rust's `extract_js_value` produced. Strings must be UTF-8 truncated to 32 bytes. Numbers must be raw f64. **Mitigation:** Rust's `serialize_pair()` is unchanged and applies the same `as_nonneg_int` / `serialize_number_pair` / `to_cmplog_bytes` logic to the deserialized values. Integration tests verify output equivalence between old and new paths. **Note:** `TextEncoder.encodeInto()` will not split a multi-byte UTF-8 character at the 32-byte boundary (it writes fewer bytes instead), while the old Rust path's `to_cmplog_bytes` truncates at the raw byte boundary and can split a character. This means the JS path may produce 1-3 fewer bytes for strings with multi-byte characters straddling the 32-byte boundary. The difference is negligible in practice (ASCII dominates fuzzing targets) and is arguably better behavior (no trailing invalid UTF-8). This is an accepted minor deviation from exact byte-level equivalence.

**[String encoding performance]** `TextEncoder.encodeInto()` converts UTF-16 to UTF-8. For ASCII-only strings (common in fuzzing targets), this is overhead - a byte-by-byte `charCodeAt` loop writing directly to the buffer would be faster for pure ASCII. Additionally, `TypedArray.subarray()` (used to create the destination view for `encodeInto`) allocates a new view object on each call, adding GC pressure on hot string comparison paths. **Mitigation:** Start with `TextEncoder.encodeInto()` and `subarray()` for correctness and simplicity. If profiling shows string encoding or subarray allocation as a bottleneck, add an ASCII fast-path (`charCodeAt < 128` loop with `TextEncoder` fallback) and/or cache subarray views. These are self-contained optimizations within the write function.

**[Slot buffer overflow]** If a target produces more slot buffer entries than slots before `drain()`, excess entries are silently dropped. **Mitigation:** At 256KB / 80 bytes per slot = 3,276 slots. Each slot maps to 1-2 `CmpValues`. The global cap is 4,096 entries, and per-site capping limits practical volume well below this. The slot buffer should never be the limiting factor.

**[Pointer lifetime and safety]** The `Buffer` views hold raw pointers to Rust-owned memory. **Mitigation:** `CmpLogState` is `thread_local` (effectively `'static`). The `Buffer` objects are captured in the write function closure on `globalThis` (also `'static`). The NAPI `Buffer` is created with a release callback that is a no-op (Rust owns the memory).

**[Slot buffer stack allocation]** The design specifies `Box<[u8; SLOT_BUFFER_SIZE]>` for 256KB. A naive `Box::new([0u8; 262144])` would allocate 256KB on the stack before moving to the heap (depending on optimizer behavior). **Mitigation:** Use `vec![0u8; SLOT_BUFFER_SIZE].into_boxed_slice()` or `Box::new_zeroed()` to allocate directly on the heap and avoid potential stack overflow.

**[Removing traceCmpRecord breaks test helpers]** Tests in `loop.test.ts` call `globalThis.__vitiate_trace_cmp_record(...)` directly to inject comparison data. **Mitigation:** Tests should call `globalThis.__vitiate_cmplog_write(...)` instead. This is a mechanical update.

**[Memory visibility between JS and Rust]** V8's JIT could theoretically cache shared memory reads in registers across calls. **Mitigation:** The write function is called from a fresh IIFE per comparison. V8 does not hoist loads of external `ArrayBuffer` backing stores across function call boundaries. The `Buffer` backing store is external to V8's heap, so V8's optimizer treats it as potentially aliased and re-reads each time.
