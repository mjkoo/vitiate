## Context

The watchdog timeout system has two tiers: V8 `TerminateExecution` (graceful, process survives) and `_exit` fallback (process dies). Today, the graceful tier is Unix-only because:

1. The C++ shim (`v8_shim.cc`) uses `dlsym` and is compiled only on Unix (`CARGO_CFG_UNIX` gate in `build.rs`).
2. The Rust FFI wrapper (`v8_shim.rs`) has `#[cfg(unix)]` on all extern declarations.
3. The `_exit` fallback multiplier is hardcoded: `5x` on Unix, `1x` on Windows.

Node.js on Windows exports V8 C++ symbols from `node.exe` and ships `node.lib` with those symbols. The `GetProcAddress(GetModuleHandle(NULL), ...)` API is the Windows equivalent of `dlsym(RTLD_DEFAULT, ...)`.

Additionally, the Rust fallback path (used when the C++ shim returns 0) has a latent bug with two interacting problems: (1) `disarm()` atomically resets `fired` to false via `swap(false, AcqRel)` before the classification code reads it, so timeouts are always misclassified as crashes, and (2) it does not call `CancelTerminateExecution()` before making NAPI calls after a timeout. Today this is harmless because the fallback is only reached when V8 termination is unavailable (the process dies via `_exit` before the code runs), but it is a correctness issue that should be fixed as defense-in-depth.

## Goals / Non-Goals

**Goals:**
- V8 `TerminateExecution` works on Windows (x64), enabling graceful timeout recovery without killing the process.
- The `_exit` fallback multiplier adapts to V8 availability rather than target OS.
- The Rust fallback path correctly handles V8 termination (defense-in-depth).
- Sync timeout test (`loop.test.ts`) runs on Windows.

**Non-Goals:**
- Windows x86 (32-bit) support. MSVC mangled names differ between x86 and x64; only x64 matters for Node.js.
- Eliminating the C++ shim in favor of a pure-Rust implementation. The shim's `vitiate_run_target` handles V8 termination at the NAPI C level with critical ordering guarantees; rewriting it in Rust gains nothing.
- Changing the watchdog thread architecture or timeout semantics.

## Decisions

### Decision 1: Use `GetProcAddress` for runtime symbol resolution (not `node.lib` linking)

**Choice:** Resolve V8 symbols at runtime via `GetProcAddress(GetModuleHandle(NULL), ...)` with MSVC-mangled names.

**Alternative considered:** Link against `node.lib` at build time (the standard approach for C++ addons).

**Rationale:** `GetProcAddress` mirrors the existing `dlsym` approach - graceful null return when symbols are missing, no build-time dependency on a version-specific `node.lib`, and no changes to the napi-rs build pipeline. The `node.lib` approach would require fetching the correct `node.lib` for the target Node.js version during build, complicating CI and local development.

### Decision 2: Platform-conditional symbol resolution in `v8_shim.cc` via preprocessor

**Choice:** Use `#ifdef _WIN32` / `#else` in `v8_shim.cc` to select between `GetProcAddress` (Windows) and `dlsym` (Unix) for symbol resolution. The rest of the shim (init, terminate, cancel, run_target) is platform-agnostic.

**Alternative considered:** Separate `v8_shim_win.cc` and `v8_shim_unix.cc` files.

**Rationale:** The only platform difference is the symbol resolution function and the mangled name strings. A single file with a preprocessor branch in `vitiate_v8_init()` is simpler than maintaining two files with 95% identical code.

### Decision 3: Dynamic `_exit` fallback multiplier based on V8 availability

**Choice:** Set `exit_timeout_multiplier` to `5` when `v8_init()` succeeds, `1` when it fails - regardless of target OS.

**Alternative considered:** Keep the `cfg!(unix)` check or use a separate Windows-specific multiplier.

**Rationale:** The multiplier exists to give V8 `TerminateExecution` time to propagate. When V8 termination is unavailable (symbols not found, static musl, etc.), the `_exit` fallback is the primary mechanism and should fire at 1x. When V8 termination is available (Unix glibc, musl dynamic, Windows), the 5x grace period applies equally. Tying the multiplier to V8 availability rather than OS makes the logic self-describing and correct for all platforms.

### Decision 4: Fix the Rust fallback `fired` ordering and `CancelTerminateExecution`

The Rust fallback path has two interacting bugs:

**Bug A: `disarm()` resets `fired` before classification reads it.** `disarm()` calls `fired.swap(false, AcqRel)` at line 301. The classification code at line 410 then reads `fired.load(Acquire)` - which is always `false`. Timeouts are silently misclassified as crashes.

**Bug B: No `CancelTerminateExecution` before NAPI calls.** The C++ shim calls `CancelTerminateExecution()` before building the result object. The Rust fallback doesn't, so NAPI calls between the exception and `disarm()` could fail if V8's termination flag is still set.

The root cause is that `disarm()` has two responsibilities with conflicting ordering needs:
- **Stop the timer** (clear deadline, signal condvar) - must happen ASAP to prevent `_exit` from racing while we build the result
- **Clean up V8 state** (cancel terminate, reset `fired`) - must happen AFTER `fired` is read for classification

**Choice:** Save `fired` before `disarm()`, cancel V8 termination when saved value is true, then classify using the saved value:

```rust
let call_status = napi_call_function(...);

// Read fired BEFORE disarm() resets it. Must happen first because
// disarm() atomically swaps fired to false.
let timed_out = self.shared.fired.load(Ordering::Acquire);

// If V8 termination fired, cancel it before any NAPI calls.
// disarm() will call cancel again - idempotent, harmless.
if timed_out {
    v8_shim::v8_cancel_terminate();
}

// Stop the watchdog timer to prevent _exit from firing while
// we build the result object.
self.disarm();

// ... classify using timed_out, not self.shared.fired.load()
```

This mirrors the C++ shim's ordering: read `fired` → cancel → build result → `disarm()`.

**Rationale:** The bug is latent today because the Rust fallback is only reached when V8 termination is unavailable (the watchdog calls `_exit` and the process dies before this code runs). After this change, the C++ shim handles all platforms when symbols are available. The Rust fallback remains reachable only when symbols can't be resolved (static Node builds, cargo test), where V8 termination is still unavailable. Nevertheless, defense-in-depth demands that both paths handle V8 termination correctly - especially since `vitiate_run_target` returning 0 (shim not initialized) and `v8_init` returning 1 (symbols resolved) are independent conditions in principle, even though in practice they are correlated.

### Decision 5: MSVC-mangled names hardcoded for x64 only

**Choice:** Hardcode the three MSVC x64 mangled names as string literals in the `#ifdef _WIN32` branch:

| Method | MSVC x64 mangled name |
|--------|-----------------------|
| `GetCurrent` | `?GetCurrent@Isolate@v8@@SAPEAV12@XZ` |
| `TerminateExecution` | `?TerminateExecution@Isolate@v8@@QEAAXXZ` |
| `CancelTerminateExecution` | `?CancelTerminateExecution@Isolate@v8@@QEAAXXZ` |

**Rationale:** These names have been stable since V8 6.x / Node 10 (8+ years). x86 mangling differs but is irrelevant - Node.js on Windows is overwhelmingly x64. If V8 ever changes these signatures, `GetProcAddress` returns null and the watchdog degrades gracefully to `_exit`-only mode.

### Decision 6: MSVC x64 calling convention is compatible with function pointer casts

On MSVC x64, all calling conventions (`__cdecl`, `__thiscall`, `__stdcall`, `__fastcall`) collapse to a single convention. `this` is passed in `rcx`, identical to passing a pointer as the first explicit argument. Casting `GetProcAddress` results to `void (*)(v8::Isolate*)` for non-static member functions is ABI-correct on x64. No special thiscall wrapper is needed.

### Decision 7: `vitiate_run_target` compiles on MSVC without changes

The `vitiate_run_target` function is the critical codepath for sync timeout recovery - it calls the target via NAPI, intercepts V8 termination exceptions, calls `CancelTerminateExecution`, and builds the result object. Unlike `vitiate_v8_init`, it contains no platform-specific code: it uses only function pointers (resolved at init time), standard C++ atomics (`std::memory_order_acquire`), and NAPI opaque types. It compiles as-is on MSVC.

The existing spec did not mention `vitiate_run_target` (only the three init/terminate/cancel functions). The delta spec for this change adds it to close the gap, since the function is essential for the timeout recovery path on all platforms.

### Decision 8: Rust fallback path remains necessary for symbol resolution failures

After this change, the C++ shim compiles on all platforms and `run_target_ffi` unconditionally calls `vitiate_run_target`. However, the Rust fallback path is still reachable: if `vitiate_v8_init()` failed (symbols not resolved), `vitiate_run_target` returns 0 (because `fn_napi_call_function == nullptr`) and `run_target_ffi` returns `None`. The shim also returns 0 on runtime NAPI failures (`napi_get_global`, `napi_create_object`), though these are rare edge cases that the Rust fallback handles gracefully.

This happens on:
- Static Node.js builds where V8/NAPI symbols are not in the dynamic symbol table
- `cargo test` binaries (no Node.js host process)
- Hypothetical embedded environments without standard symbol exports

The fallback path must remain correct and tested. The `_exit`-only mode is the appropriate behavior when symbols can't be resolved - the process dies on timeout, and the supervisor respawns.

## Risks / Trade-offs

- **MSVC mangling fragility** → Mitigated: `GetProcAddress` returns null on mismatch, falling back to `_exit`-only mode. These symbols have been stable for 8+ years.
- **Untested on ARM64 Windows** → Accepted: ARM64 Windows is rare for Node.js development. The mangled names may differ. If ARM64 becomes relevant, we can add the mangled names later (same graceful fallback).
- **NAPI symbol resolution on Windows** → The C++ shim resolves NAPI symbols via `dlsym` on Unix to avoid link-time dependencies (for `cargo test`). On Windows, `GetProcAddress` serves the same purpose. The existing NAPI symbol resolution in the shim needs the same `GetProcAddress` treatment.
- **Static Node.js builds** → Symbol resolution fails gracefully (returns null), watchdog degrades to `_exit`-only mode. This is the same behavior as today on Windows. We have not encountered a static build in CI (Alpine uses dynamic), but the fallback path is exercised by the existing Windows and cargo test codepaths.
