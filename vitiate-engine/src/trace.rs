use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::cmplog::{CmpLogOperator, ExtractedValue};

/// Return a 256 KB Buffer backed by the CmpLog slot buffer's Rust-owned memory.
///
/// Called once during `initGlobals()`. JS creates `Uint8Array` and `DataView`
/// views over this buffer and writes comparison operands into fixed-size slots.
/// Rust reads the slots during `drain()`.
///
/// The backing memory lives in thread-local `CmpLogState` (effectively `'static`).
/// The Buffer has no release callback because Rust owns the memory.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn cmplog_get_slot_buffer(env: Env) -> Result<Buffer> {
    crate::cmplog::CMPLOG_STATE.with(|s| {
        let state = s.borrow();
        let (ptr, len) = state.slot_buffer_raw();

        let mut buffer_value: napi::sys::napi_value = std::ptr::null_mut();
        // SAFETY: slot_buffer is a Box<UnsafeCell<[u8; SLOT_BUFFER_SIZE]>> in a
        // thread_local RefCell. The memory is valid for the process lifetime.
        // The pointer is derived via UnsafeCell::get(), which yields a raw
        // pointer that remains valid regardless of subsequent RefCell borrows.
        // No finalizer is attached because Rust owns the memory.
        let status = unsafe {
            napi::sys::napi_create_external_buffer(
                env.raw(),
                len,
                ptr as *mut std::ffi::c_void,
                None,
                std::ptr::null_mut(),
                &mut buffer_value,
            )
        };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_create_external_buffer failed for slot buffer",
            ));
        }
        // SAFETY: buffer_value is a valid napi_value of type Buffer, just
        // created by napi_create_external_buffer above.
        unsafe { Buffer::from_napi_value(env.raw(), buffer_value) }
    })
}

/// The CmpLog slot size in bytes (80).
///
/// For boundary tests; not part of the fuzzing API. Asserted equal to
/// `SLOT_SIZE` in `vitiate-core/src/globals.ts` by the cross-language
/// boundary test.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn cmplog_slot_size() -> u32 {
    crate::cmplog::SLOT_SIZE as u32
}

/// The write-pointer sentinel value that disables CmpLog (0xFFFFFFFF).
///
/// For boundary tests; not part of the fuzzing API. Asserted equal to
/// `WRITE_PTR_DISABLED` in `vitiate-core/src/globals.ts` by the
/// cross-language boundary test.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn cmplog_write_ptr_disabled() -> u32 {
    crate::cmplog::WRITE_PTR_DISABLED
}

/// One decoded CmpLog slot, as returned by `cmplogDrainTestEntries()`.
///
/// For boundary tests; not part of the fuzzing API. Values are
/// string-encoded to avoid f64/u64 precision loss across the NAPI boundary.
#[napi(object)]
pub struct CmplogTestEntry {
    /// The comparison-site ID from slot offset 0.
    pub cmp_id: u32,
    /// Operator decoded from the slot's op ID.
    #[napi(ts_type = "'equal' | 'not_equal' | 'less' | 'greater'")]
    pub operator: String,
    /// Left operand kind.
    #[napi(ts_type = "'num' | 'str' | 'skip'")]
    pub left_kind: String,
    /// Left operand: JS `Number.toString()` form for numbers, lossy UTF-8
    /// for strings, empty for skip.
    pub left: String,
    /// Right operand kind.
    #[napi(ts_type = "'num' | 'str' | 'skip'")]
    pub right_kind: String,
    /// Right operand, encoded like `left`.
    pub right: String,
}

fn operator_label(op: CmpLogOperator) -> &'static str {
    match op {
        CmpLogOperator::Equal => "equal",
        CmpLogOperator::NotEqual => "not_equal",
        CmpLogOperator::Less => "less",
        CmpLogOperator::Greater => "greater",
    }
}

fn encode_extracted(value: &ExtractedValue) -> (&'static str, String) {
    match value {
        ExtractedValue::Num(n) => ("num", crate::cmplog::format_f64(*n)),
        ExtractedValue::Str(bytes) => ("str", String::from_utf8_lossy(bytes).into_owned()),
        ExtractedValue::Skip => ("skip", String::new()),
    }
}

/// Drain the CmpLog slot buffer at slot granularity, one entry per slot.
///
/// For boundary tests; not part of the fuzzing API. Decodes each slot with
/// the same deserialization path as the production `drain()` and resets the
/// write pointer, but reports pre-`serialize_pair` operands so a JS write can
/// be asserted value-for-value. See `cmplog-boundary.test.ts` in vitiate-core.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn cmplog_drain_test_entries() -> Vec<CmplogTestEntry> {
    crate::cmplog::drain_test_entries()
        .into_iter()
        .map(|slot| {
            let (left_kind, left) = encode_extracted(&slot.left);
            let (right_kind, right) = encode_extracted(&slot.right);
            CmplogTestEntry {
                cmp_id: slot.cmp_id,
                operator: operator_label(slot.operator).to_string(),
                left_kind: left_kind.to_string(),
                left,
                right_kind: right_kind.to_string(),
                right,
            }
        })
        .collect()
}

/// Return a 4-byte Buffer backed by the CmpLog write pointer's Rust-owned memory.
///
/// Called once during `initGlobals()`. JS creates a `Uint32Array(1)` view over
/// this buffer. The write pointer serves dual purposes: tracking the next write
/// slot AND signaling enabled/disabled state (0xFFFFFFFF = disabled).
///
/// The backing memory lives in thread-local `CmpLogState` (effectively `'static`).
/// The Buffer has no release callback because Rust owns the memory.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn cmplog_get_write_pointer(env: Env) -> Result<Buffer> {
    crate::cmplog::CMPLOG_STATE.with(|s| {
        let state = s.borrow();
        let (ptr, len) = state.write_pointer_raw();

        let mut buffer_value: napi::sys::napi_value = std::ptr::null_mut();
        // SAFETY: write_pointer is a Box<UnsafeCell<[u8; 4]>> in a thread_local
        // RefCell. The memory is valid for the process lifetime. The pointer is
        // derived via UnsafeCell::get(), which yields a raw pointer that remains
        // valid regardless of subsequent RefCell borrows. No finalizer.
        let status = unsafe {
            napi::sys::napi_create_external_buffer(
                env.raw(),
                len,
                ptr as *mut std::ffi::c_void,
                None,
                std::ptr::null_mut(),
                &mut buffer_value,
            )
        };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_create_external_buffer failed for write pointer",
            ));
        }
        // SAFETY: buffer_value is a valid napi_value of type Buffer, just
        // created by napi_create_external_buffer above.
        unsafe { Buffer::from_napi_value(env.raw(), buffer_value) }
    })
}
