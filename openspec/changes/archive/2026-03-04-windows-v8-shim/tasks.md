## 1. C++ Shim Cross-Platform Symbol Resolution

- [x] 1.1 Add `#ifdef _WIN32` branch to `vitiate_v8_init()` in `v8_shim.cc` that uses `GetProcAddress(GetModuleHandle(NULL), ...)` with MSVC x64 mangled names for the three V8 symbols (`GetCurrent`, `TerminateExecution`, `CancelTerminateExecution`)
- [x] 1.2 Add `GetProcAddress`-based NAPI symbol resolution in the `#ifdef _WIN32` branch (plain C names: `napi_get_global`, `napi_call_function`, etc.)
- [x] 1.3 Add `#include <windows.h>` (or `<libloaderapi.h>`) in the `_WIN32` branch, keep `<dlfcn.h>` in the `#else` branch

## 2. Build System and Rust Wrapper

- [x] 2.1 Remove the `CARGO_CFG_UNIX` gate in `build.rs` so `v8_shim.cc` compiles on all targets. Add MSVC-compatible compiler flag (`/std:c++14`) alongside the existing `-std=c++14`
- [x] 2.2 Remove `#[cfg(unix)]` / `#[cfg(not(unix))]` gates from `v8_shim.rs` - make all extern declarations and wrapper functions unconditional
- [x] 2.3 Remove the `v8_terminate_available()` function since the shim now compiles everywhere and availability is determined at runtime by `v8_init()`. Update the warning condition in `Watchdog::new()` from `!v8_ok && v8_shim::v8_terminate_available()` to `!v8_ok`

## 3. Dynamic Exit Timeout Multiplier

- [x] 3.1 Change `exit_multiplier` in `Watchdog::new()` from `if cfg!(unix) { 5 } else { 1 }` to `if v8_ok { 5 } else { 1 }`

## 4. Rust Fallback Path Bug Fix

- [x] 4.1 In the Rust fallback path in `watchdog.rs` `run_target()`, read `fired` into a local variable BEFORE calling `self.disarm()` (which resets `fired` to false via `swap`). When the saved value is true, call `v8_shim::v8_cancel_terminate()` before `disarm()` and before any NAPI calls. Use the saved value (not `self.shared.fired.load()`) for exit kind classification

## 5. Tests and Assertions

- [x] 5.1 Remove `it.skipIf(process.platform === "win32")` from the sync timeout test in `loop.test.ts`
- [x] 5.2 Update `smoke.mjs` V8 shim availability assertion: assert `true` on Windows (same as glibc Linux/macOS), keeping the musl-accepts-either logic
- [x] 5.3 Remove the `v8_terminate_available_matches_platform` unit test in `v8_shim.rs` (the function it tests is removed by task 2.3)
- [x] 5.4 Update comments in `v8_shim.cc`, `v8_shim.rs`, `lib.rs`, and `watchdog.rs` that reference Unix-only behavior or `cfg(unix)` constraints

## 6. Verification

- [x] 6.1 Run full test suite locally (`pnpm exec turbo run test`)
- [x] 6.2 Run lints and checks (`eslint`, `clippy`, `cargo fmt`, `prettier`, `cargo deny`)
- [x] 6.3 Verify Windows CI passes (sync timeout test runs, no "Channel closed" error)
