// V8 shim and NAPI target runner for vitiate watchdog timeout enforcement.
//
// Uses dlsym to locate V8 and NAPI symbols at runtime from the Node.js host
// binary, avoiding link-time dependencies. The symbols resolve when loaded by
// Node.js; in test binaries without V8/NAPI, they're not found and the shim
// functions return 0 (failure), falling back gracefully.
//
// NAPI symbols are also resolved via dlsym (rather than linked directly) so
// that the object file has no external symbol references. This keeps
// `cargo test` working — the .node shared library resolves undefined symbols
// from the Node.js host, but cargo test binaries can't.
//
// Only compiled on Unix targets (Linux, macOS) where V8 C++ symbols are
// visible to dlopen'd shared libraries.
//
// Platform limitation: dlsym(RTLD_DEFAULT, ...) requires V8 symbols to be
// exported from the host binary's dynamic symbol table. On musl-based or
// statically-linked Node.js builds, symbols may not be visible. In that case,
// vitiate_v8_init() returns 0 and the watchdog falls back to _exit-only mode
// with no diagnostic beyond the stderr warning in Watchdog::new.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <dlfcn.h>

// --- Forward declarations ---

// V8
namespace v8 {
class Isolate;
} // namespace v8

// NAPI opaque types (stable ABI, no header needed)
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef enum {
    vitiate_napi_ok,
    vitiate_napi_invalid_arg,
    vitiate_napi_object_expected,
    vitiate_napi_string_expected,
    vitiate_napi_name_expected,
    vitiate_napi_function_expected,
    vitiate_napi_number_expected,
    vitiate_napi_boolean_expected,
    vitiate_napi_array_expected,
    vitiate_napi_generic_failure,
    vitiate_napi_pending_exception,
    vitiate_napi_cancelled,
    vitiate_napi_escape_called_twice,
    vitiate_napi_handle_scope_mismatch,
    vitiate_napi_callback_scope_mismatch,
    vitiate_napi_queue_full,
    vitiate_napi_closing,
    vitiate_napi_bigint_expected,
    vitiate_napi_date_expected,
    vitiate_napi_arraybuffer_expected,
    vitiate_napi_detachable_arraybuffer_expected,
    vitiate_napi_would_deadlock,
} vitiate_napi_status;

// Result struct returned to Rust
struct VitiateRunTargetResult {
    int32_t exit_kind; // 0=Ok, 1=Crash, 2=Timeout
    napi_value value;  // The result object { exitKind, error?, result? }
};

// --- ABI safety assertions ---

static_assert(sizeof(std::atomic<bool>) == 1,
              "std::atomic<bool> must be 1 byte to match Rust AtomicBool");

// --- V8 function pointers (resolved via dlsym) ---

// Publication flag: guards all static function pointers and cached_isolate.
// Written with memory_order_release at the end of vitiate_v8_init(); read with
// memory_order_acquire at the top of vitiate_v8_terminate(). The acquire
// synchronizes-with the release, making all prior non-atomic writes visible
// to the watchdog thread.
static std::atomic<bool> init_published{false};

static v8::Isolate* cached_isolate = nullptr;

using GetCurrentFn = v8::Isolate* (*)();
using MemberFn = void (*)(v8::Isolate*);

static GetCurrentFn fn_get_current = nullptr;
static MemberFn fn_terminate = nullptr;
static MemberFn fn_cancel_terminate = nullptr;

// --- NAPI function pointers (resolved via dlsym) ---

using NapiGetGlobalFn = vitiate_napi_status (*)(napi_env, napi_value*);
using NapiCallFunctionFn = vitiate_napi_status (*)(napi_env, napi_value, napi_value, size_t, const napi_value*, napi_value*);
using NapiCreateObjectFn = vitiate_napi_status (*)(napi_env, napi_value*);
using NapiCreateStringUtf8Fn = vitiate_napi_status (*)(napi_env, const char*, size_t, napi_value*);
using NapiCreateUint32Fn = vitiate_napi_status (*)(napi_env, uint32_t, napi_value*);
using NapiSetPropertyFn = vitiate_napi_status (*)(napi_env, napi_value, napi_value, napi_value);
using NapiGetAndClearLastExceptionFn = vitiate_napi_status (*)(napi_env, napi_value*);
using NapiCreateErrorFn = vitiate_napi_status (*)(napi_env, napi_value, napi_value, napi_value*);

static NapiGetGlobalFn fn_napi_get_global = nullptr;
static NapiCallFunctionFn fn_napi_call_function = nullptr;
static NapiCreateObjectFn fn_napi_create_object = nullptr;
static NapiCreateStringUtf8Fn fn_napi_create_string_utf8 = nullptr;
static NapiCreateUint32Fn fn_napi_create_uint32 = nullptr;
static NapiSetPropertyFn fn_napi_set_property = nullptr;
static NapiGetAndClearLastExceptionFn fn_napi_get_and_clear_last_exception = nullptr;
static NapiCreateErrorFn fn_napi_create_error = nullptr;

// --- Static helpers ---

static vitiate_napi_status set_prop_u32(napi_env env, napi_value obj, const char* key, uint32_t val) {
    napi_value key_val = nullptr;
    vitiate_napi_status s = fn_napi_create_string_utf8(env, key, strlen(key), &key_val);
    if (s != vitiate_napi_ok) return s;
    napi_value num_val = nullptr;
    s = fn_napi_create_uint32(env, val, &num_val);
    if (s != vitiate_napi_ok) return s;
    return fn_napi_set_property(env, obj, key_val, num_val);
}

static vitiate_napi_status set_prop_value(napi_env env, napi_value obj, const char* key, napi_value val) {
    napi_value key_val = nullptr;
    vitiate_napi_status s = fn_napi_create_string_utf8(env, key, strlen(key), &key_val);
    if (s != vitiate_napi_ok) return s;
    return fn_napi_set_property(env, obj, key_val, val);
}

extern "C" {

// Cache the current V8 isolate pointer and resolve V8 + NAPI symbol addresses.
// Must be called from the main thread during initialization.
// Returns 1 on success, 0 if any symbols are unavailable.
int vitiate_v8_init() {
    // Itanium ABI mangled names for v8::Isolate methods.
    // These have been stable since V8 6.x / Node 10.
    fn_get_current = reinterpret_cast<GetCurrentFn>(
        dlsym(RTLD_DEFAULT, "_ZN2v87Isolate10GetCurrentEv"));
    fn_terminate = reinterpret_cast<MemberFn>(
        dlsym(RTLD_DEFAULT, "_ZN2v87Isolate18TerminateExecutionEv"));
    fn_cancel_terminate = reinterpret_cast<MemberFn>(
        dlsym(RTLD_DEFAULT, "_ZN2v87Isolate24CancelTerminateExecutionEv"));

    if (!fn_get_current || !fn_terminate || !fn_cancel_terminate) {
        fn_get_current = nullptr;
        fn_terminate = nullptr;
        fn_cancel_terminate = nullptr;
        cached_isolate = nullptr;
        return 0;
    }

    cached_isolate = fn_get_current();
    if (cached_isolate == nullptr) {
        return 0;
    }

    // Resolve NAPI symbols (plain C names, no mangling)
    fn_napi_get_global = reinterpret_cast<NapiGetGlobalFn>(
        dlsym(RTLD_DEFAULT, "napi_get_global"));
    fn_napi_call_function = reinterpret_cast<NapiCallFunctionFn>(
        dlsym(RTLD_DEFAULT, "napi_call_function"));
    fn_napi_create_object = reinterpret_cast<NapiCreateObjectFn>(
        dlsym(RTLD_DEFAULT, "napi_create_object"));
    fn_napi_create_string_utf8 = reinterpret_cast<NapiCreateStringUtf8Fn>(
        dlsym(RTLD_DEFAULT, "napi_create_string_utf8"));
    fn_napi_create_uint32 = reinterpret_cast<NapiCreateUint32Fn>(
        dlsym(RTLD_DEFAULT, "napi_create_uint32"));
    fn_napi_set_property = reinterpret_cast<NapiSetPropertyFn>(
        dlsym(RTLD_DEFAULT, "napi_set_property"));
    fn_napi_get_and_clear_last_exception = reinterpret_cast<NapiGetAndClearLastExceptionFn>(
        dlsym(RTLD_DEFAULT, "napi_get_and_clear_last_exception"));
    fn_napi_create_error = reinterpret_cast<NapiCreateErrorFn>(
        dlsym(RTLD_DEFAULT, "napi_create_error"));

    if (!fn_napi_get_global || !fn_napi_call_function ||
        !fn_napi_create_object || !fn_napi_create_string_utf8 ||
        !fn_napi_create_uint32 || !fn_napi_set_property ||
        !fn_napi_get_and_clear_last_exception || !fn_napi_create_error) {
        // Clear everything — all or nothing
        fn_get_current = nullptr;
        fn_terminate = nullptr;
        fn_cancel_terminate = nullptr;
        cached_isolate = nullptr;
        fn_napi_get_global = nullptr;
        fn_napi_call_function = nullptr;
        fn_napi_create_object = nullptr;
        fn_napi_create_string_utf8 = nullptr;
        fn_napi_create_uint32 = nullptr;
        fn_napi_set_property = nullptr;
        fn_napi_get_and_clear_last_exception = nullptr;
        fn_napi_create_error = nullptr;
        return 0;
    }

    init_published.store(true, std::memory_order_release);
    return 1;
}

// Call TerminateExecution on the cached isolate. Thread-safe—designed to be
// called from the watchdog thread. Returns 1 on success, 0 if no isolate.
int vitiate_v8_terminate() {
    if (!init_published.load(std::memory_order_acquire)) {
        return 0;
    }
    if (cached_isolate == nullptr || fn_terminate == nullptr) {
        return 0;
    }
    fn_terminate(cached_isolate);
    return 1;
}

// Call CancelTerminateExecution on the cached isolate. Called from the main
// thread during disarm() to clear a pending termination flag. Returns 1 on
// success, 0 if no isolate.
int vitiate_v8_cancel_terminate() {
    if (cached_isolate == nullptr || fn_cancel_terminate == nullptr) {
        return 0;
    }
    fn_cancel_terminate(cached_isolate);
    return 1;
}

// Run the fuzz target function and handle V8 termination at the NAPI C level.
//
// - env: NAPI environment
// - target: JS function to call
// - input: Buffer argument to pass to the target
// - fired: pointer to Rust's WatchdogShared.fired AtomicBool
// - out: result struct filled on success
//
// Returns 1 on success (out is filled), 0 if shim is not initialized.
int vitiate_run_target(
    napi_env env,
    napi_value target,
    napi_value input,
    const std::atomic<bool>* fired,
    VitiateRunTargetResult* out
) {
    // If NAPI symbols weren't resolved, signal caller to use fallback
    if (fn_napi_call_function == nullptr) {
        return 0;
    }

    // Get global for `this`
    napi_value global = nullptr;
    if (fn_napi_get_global(env, &global) != vitiate_napi_ok) {
        return 0; // Fall through to Rust fallback
    }

    // Call the target function
    napi_value result_value = nullptr;
    vitiate_napi_status status = fn_napi_call_function(
        env, global, target, 1, &input, &result_value);

    // Build the result object
    napi_value obj = nullptr;
    if (fn_napi_create_object(env, &obj) != vitiate_napi_ok) {
        return 0; // Fall through to Rust fallback
    }

    if (status == vitiate_napi_ok) {
        // Successful call
        if (set_prop_u32(env, obj, "exitKind", 0) != vitiate_napi_ok) {
            return 0;
        }
        // result is best-effort — non-critical if it fails
        set_prop_value(env, obj, "result", result_value);
        out->exit_kind = 0;
        out->value = obj;
        return 1;
    }

    if (status == vitiate_napi_pending_exception) {
        if (fired->load(std::memory_order_acquire)) {
            // Timeout — cancel V8 termination so JS can resume.
            // This cancel is for local NAPI safety: without it, subsequent NAPI
            // calls (create_error, set_property, etc.) would fail with the
            // termination exception still pending. The Rust disarm() performs a
            // second cancel as the architectural guarantee for the next iteration.
            if (cached_isolate != nullptr && fn_cancel_terminate != nullptr) {
                fn_cancel_terminate(cached_isolate);
            }

            // Clear the pending exception
            napi_value exception = nullptr;
            vitiate_napi_status exc_status =
                fn_napi_get_and_clear_last_exception(env, &exception);

            if (set_prop_u32(env, obj, "exitKind", 2) != vitiate_napi_ok) {
                return 0;
            }
            out->exit_kind = 2;

            // Create a regular timeout Error for JS — best-effort; the exitKind
            // is already set so the caller can distinguish timeout without it.
            napi_value msg = nullptr;
            const char* err_msg = "fuzz target timed out";
            vitiate_napi_status msg_status =
                fn_napi_create_string_utf8(env, err_msg, strlen(err_msg), &msg);

            if (exc_status == vitiate_napi_ok && msg_status == vitiate_napi_ok) {
                napi_value error = nullptr;
                vitiate_napi_status err_status =
                    fn_napi_create_error(env, nullptr, msg, &error);
                if (err_status == vitiate_napi_ok) {
                    set_prop_value(env, obj, "error", error);
                }
            }

            out->value = obj;
            return 1;
        } else {
            // Regular crash — get the exception
            napi_value exception = nullptr;
            vitiate_napi_status exc_status =
                fn_napi_get_and_clear_last_exception(env, &exception);

            if (set_prop_u32(env, obj, "exitKind", 1) != vitiate_napi_ok) {
                return 0;
            }
            // error is best-effort
            if (exc_status == vitiate_napi_ok) {
                set_prop_value(env, obj, "error", exception);
            }
            out->exit_kind = 1;
            out->value = obj;
            return 1;
        }
    }

    // Unexpected NAPI error — return as crash with null error
    if (set_prop_u32(env, obj, "exitKind", 1) != vitiate_napi_ok) {
        return 0;
    }
    out->exit_kind = 1;
    out->value = obj;
    return 1;
}

} // extern "C"
