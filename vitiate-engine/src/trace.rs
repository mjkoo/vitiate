use napi::bindgen_prelude::*;
use napi_derive::napi;

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
