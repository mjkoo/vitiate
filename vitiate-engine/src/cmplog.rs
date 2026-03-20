//! # Thread-safety
//!
//! CmpLog state is thread-local. Only one [`Fuzzer`](crate::engine::Fuzzer) should
//! be active per thread at a time. Multiple concurrent Fuzzers on the same thread
//! share the write pointer, slot buffer, and entry accumulator, which leads to
//! incorrect behavior: interleaved `getNextInput`/`reportResult` calls mix
//! comparison entries between Fuzzers.
//!
//! CmpLog is enabled explicitly via [`enable()`] (called by `Fuzzer::new()`) and
//! disabled via [`disable()`] (called by `Fuzzer::shutdown()`). `Fuzzer::drop()`
//! does not touch CmpLog, so non-deterministic GC timing is irrelevant.

use std::cell::{RefCell, UnsafeCell};

use libafl::observers::cmp::{CmpValues, CmplogBytes};

/// Maximum number of comparison entries per iteration.
const MAX_ENTRIES: usize = 4096;

/// Size of each slot in the shared slot buffer, in bytes.
///
/// # Slot layout (80 bytes)
///
/// These offsets must stay in sync with `createCmplogWriteFunctions()` in
/// `vitiate-core/src/globals.ts`, which serializes slots from JS.
///
/// ```text
/// Offset  Size  Field
/// ------  ----  ----------------------------
///  0..4     4   cmpId      (u32 LE)
///  4        1   opId       (u8, 0-7)
///  5        1   leftType   (1 = f64, 2 = string)
///  6        1   rightType  (1 = f64, 2 = string)
///  7        1   leftLen    (u8, string only)
///  8..40   32   leftData   (f64 LE at 8..16, or UTF-8 bytes)
/// 40        1   rightLen   (u8, string only)
/// 41..73   32   rightData  (f64 LE at 41..49, or UTF-8 bytes)
/// 73..80    7   (padding)
/// ```
const SLOT_SIZE: usize = 80;

/// Total size of the shared slot buffer (256 KB).
///
/// Must match `SLOT_BUFFER_SIZE` in `vitiate-core/src/globals.ts`.
const SLOT_BUFFER_SIZE: usize = 256 * 1024;

/// Maximum number of slots in the slot buffer (3276 at 256 KB / 80 bytes).
///
/// Must match `MAX_SLOTS` in `vitiate-core/src/globals.ts`.
const MAX_SLOTS: usize = SLOT_BUFFER_SIZE / SLOT_SIZE;

/// Sentinel value for the write pointer indicating CmpLog is disabled.
/// Any value >= MAX_SLOTS causes the JS write function's overflow check
/// to return early, so 0xFFFFFFFF acts as a disabled flag for free.
const WRITE_PTR_DISABLED: u32 = 0xFFFF_FFFF;

/// Largest integer JavaScript can represent exactly (`2^53 - 1`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Comparison operator type derived from the numeric operator ID parameter in
/// `__vitiate_cmplog_write()`. Used to populate `AflppCmpLogHeader` attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmpLogOperator {
    Equal,
    NotEqual,
    Less,
    Greater,
}

impl CmpLogOperator {
    /// Map a numeric operator ID to a `CmpLogOperator`.
    ///
    /// The SWC plugin emits integer operator IDs at compile time (0-7).
    /// IDs 6 (`<=`) and 7 (`>=`) intentionally map to `Less` and `Greater`
    /// respectively - the "or equal" distinction is not needed for I2S
    /// mutations.
    ///
    /// The IDs must stay in sync with `comparison_op_id()` in
    /// `vitiate-swc-plugin/src/lib.rs`. If you change this mapping, update
    /// both locations.
    ///
    /// Returns `None` for unknown IDs, letting callers skip CmpLog recording
    /// gracefully.
    pub fn from_id(id: u32) -> Option<Self> {
        match id {
            0 | 2 => Some(Self::Equal),    // === | ==
            1 | 3 => Some(Self::NotEqual), // !== | !=
            4 | 6 => Some(Self::Less),     // < | <=
            5 | 7 => Some(Self::Greater),  // > | >=
            _ => None,
        }
    }
}

/// Enriched CmpLog entry: comparison values, site ID, and operator type.
pub type CmpLogEntry = (CmpValues, u32, CmpLogOperator);

pub(crate) struct CmpLogState {
    entries: Vec<CmpLogEntry>,
    /// Shared slot buffer for zero-NAPI comparison data transfer from JS.
    /// Heap-allocated for stable address; exposed to JS as a `Buffer`.
    /// Wrapped in `UnsafeCell` because JS holds a raw pointer to this memory
    /// and reads/writes it concurrently with Rust's `RefCell` borrows.
    slot_buffer: Box<UnsafeCell<[u8; SLOT_BUFFER_SIZE]>>,
    /// Shared write pointer (4 bytes, used as `Uint32Array(1)` by JS).
    /// Doubles as the enabled/disabled flag: 0 = enabled (start at slot 0),
    /// 0xFFFFFFFF = disabled.
    /// Wrapped in `UnsafeCell` for the same aliasing reason as `slot_buffer`.
    write_pointer: Box<UnsafeCell<[u8; 4]>>,
}

impl CmpLogState {
    fn new() -> Self {
        // Allocate the slot buffer on the heap via Vec to avoid a 256 KB stack
        // frame that Box::new(UnsafeCell::new([0u8; N])) would create.
        // SAFETY: UnsafeCell<[u8; N]> has the same layout as [u8; N]
        // (#[repr(transparent)]), so transmuting a zeroed boxed byte array into
        // a boxed UnsafeCell is valid.
        let slot_buffer: Box<UnsafeCell<[u8; SLOT_BUFFER_SIZE]>> = {
            let boxed: Box<[u8; SLOT_BUFFER_SIZE]> = vec![0u8; SLOT_BUFFER_SIZE]
                .into_boxed_slice()
                .try_into()
                .expect("vec length matches SLOT_BUFFER_SIZE");
            // SAFETY: UnsafeCell<T> is #[repr(transparent)] over T, so
            // Box<[u8; N]> and Box<UnsafeCell<[u8; N]>> have identical layout.
            unsafe {
                Box::from_raw(Box::into_raw(boxed) as *mut UnsafeCell<[u8; SLOT_BUFFER_SIZE]>)
            }
        };
        let write_pointer = Box::new(UnsafeCell::new(WRITE_PTR_DISABLED.to_le_bytes()));
        Self {
            entries: Vec::new(),
            slot_buffer,
            write_pointer,
        }
    }

    /// Return the raw pointer and byte length of the slot buffer, for creating
    /// an external NAPI buffer. The pointer remains valid for the process
    /// lifetime (heap-allocated in a thread-local).
    pub(crate) fn slot_buffer_raw(&self) -> (*mut u8, usize) {
        (
            self.slot_buffer.get() as *mut u8,
            std::mem::size_of_val(&*self.slot_buffer),
        )
    }

    /// Return the raw pointer and byte length of the write pointer, for
    /// creating an external NAPI buffer.
    pub(crate) fn write_pointer_raw(&self) -> (*mut u8, usize) {
        (
            self.write_pointer.get() as *mut u8,
            std::mem::size_of_val(&*self.write_pointer),
        )
    }

    /// Read the write pointer as a u32 (little-endian).
    ///
    /// # Safety contract
    /// Caller must ensure no JS code is concurrently writing to the write
    /// pointer. Satisfied because Node.js is single-threaded and all Rust
    /// entry points are synchronous NAPI calls.
    fn read_write_ptr(&self) -> u32 {
        // SAFETY: Single-threaded access; no JS code executes during NAPI calls.
        u32::from_le_bytes(unsafe { *self.write_pointer.get() })
    }

    /// Set the write pointer to a u32 value (little-endian).
    ///
    /// # Safety contract
    /// Same as [`read_write_ptr`] - no concurrent JS access.
    fn set_write_ptr(&mut self, value: u32) {
        // SAFETY: Single-threaded access; no JS code executes during NAPI calls.
        unsafe { *self.write_pointer.get() = value.to_le_bytes() };
    }
}

thread_local! {
    pub(crate) static CMPLOG_STATE: RefCell<CmpLogState> = RefCell::new(CmpLogState::new());
}

/// Enable CmpLog recording, clearing any stale entries from a prior session.
/// Sets the write pointer to 0 so JS begins writing from slot 0.
pub fn enable() {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.entries.clear();
        state.set_write_ptr(0);
    });
}

/// Disable CmpLog recording and clear accumulated entries.
/// Sets the write pointer to `0xFFFFFFFF` (disabled sentinel).
pub fn disable() {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.set_write_ptr(WRITE_PTR_DISABLED);
        state.entries.clear();
    });
}

/// Drop guard that calls [`disable()`] on drop, ensuring CmpLog cleanup
/// even if a test panics.
#[cfg(test)]
pub struct TestCleanupGuard;

#[cfg(test)]
impl Drop for TestCleanupGuard {
    fn drop(&mut self) {
        disable();
    }
}

/// Check if CmpLog recording is currently enabled.
///
/// Enabled when the write pointer is a valid slot index (< MAX_SLOTS).
/// Disabled when write pointer is 0xFFFFFFFF.
#[cfg(test)]
pub fn is_enabled() -> bool {
    CMPLOG_STATE.with(|s| {
        let state = s.borrow();
        (state.read_write_ptr() as usize) < MAX_SLOTS
    })
}

/// Push an enriched comparison entry into the thread-local accumulator.
///
/// Silently drops entries at global capacity (4096). Does not check the
/// enabled state; in production, the JS write function guards against
/// writes when disabled, and `drain()` skips slot buffer processing when
/// the write pointer is the disabled sentinel.
///
/// Only used in tests; `drain()` inlines equivalent logic for bulk processing.
#[cfg(test)]
pub fn push(entry: CmpValues, site_id: u32, operator: CmpLogOperator) {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.entries.len() < MAX_ENTRIES {
            state.entries.push((entry, site_id, operator));
        }
    });
}

/// Deserialize a single slot from the slot buffer into an `ExtractedValue`.
///
/// Reads the type tag at the given offset and interprets the remaining bytes:
/// - Type 1 (f64): reads 8 bytes as little-endian f64
/// - Type 2 (string): reads `len` bytes as UTF-8 (max 32 bytes)
/// - Type 0 or other: Skip
fn deserialize_slot_operand(
    buffer: &[u8; SLOT_BUFFER_SIZE],
    type_offset: usize,
    len_offset: usize,
    data_offset: usize,
) -> ExtractedValue {
    match buffer[type_offset] {
        1 => {
            // f64 - read 8 bytes little-endian
            let bytes: [u8; 8] = buffer[data_offset..data_offset + 8]
                .try_into()
                .expect("8-byte slice from fixed-size buffer is always valid");
            ExtractedValue::Num(f64::from_le_bytes(bytes))
        }
        2 => {
            // string - read len bytes (max 32)
            let len = (buffer[len_offset] as usize).min(32);
            ExtractedValue::Str(buffer[data_offset..data_offset + len].to_vec())
        }
        _ => ExtractedValue::Skip,
    }
}

/// Drain the slot buffer and accumulated entries, returning all enriched entries.
///
/// Reads entries from the slot buffer (written by JS), deserializes them into
/// `ExtractedValue` pairs, calls `serialize_pair()` for each, then returns the
/// accumulated entries. Resets the write pointer to 0 and clears the entries
/// vector.
///
/// If the write pointer exceeds `MAX_SLOTS` (including the disabled sentinel
/// `0xFFFFFFFF`), returns any pre-accumulated entries without processing the
/// slot buffer or modifying the write pointer.
pub fn drain() -> Vec<CmpLogEntry> {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();

        let write_ptr = state.read_write_ptr() as usize;

        // Guard: disabled sentinel or corruption - return any pre-accumulated
        // entries without processing the slot buffer or modifying the write
        // pointer.
        if write_ptr > MAX_SLOTS {
            return std::mem::take(&mut state.entries);
        }

        // SAFETY: Single-threaded; JS does not execute during this synchronous
        // NAPI call. The UnsafeCell ensures the raw pointer JS holds is not
        // invalidated by this borrow.
        let slot_buffer = unsafe { &*state.slot_buffer.get() };

        // Process slot buffer entries 0..write_ptr
        for i in 0..write_ptr {
            let base = i * SLOT_SIZE;

            // Read cmpId (u32 LE at offset 0)
            let cmp_id = u32::from_le_bytes(
                slot_buffer[base..base + 4]
                    .try_into()
                    .expect("4-byte slice from fixed-size buffer is always valid"),
            );

            // Read operatorId (u8 at offset 4)
            let operator_id = slot_buffer[base + 4] as u32;
            let operator = match CmpLogOperator::from_id(operator_id) {
                Some(op) => op,
                None => continue, // Skip invalid operator IDs
            };

            // Deserialize left operand (type at offset 5, len at offset 7, data at offset 8)
            let left = deserialize_slot_operand(slot_buffer, base + 5, base + 7, base + 8);

            // Deserialize right operand (type at offset 6, len at offset 40, data at offset 41)
            let right = deserialize_slot_operand(slot_buffer, base + 6, base + 40, base + 41);

            if let Some(cmp_values) = serialize_pair(&left, &right) {
                for entry in cmp_values {
                    // Inline push logic to avoid re-borrowing the RefCell
                    if state.entries.len() < MAX_ENTRIES {
                        state.entries.push((entry, cmp_id, operator));
                    }
                }
            }
        }

        // Reset write pointer to 0 for next iteration
        state.set_write_ptr(0);
        std::mem::take(&mut state.entries)
    })
}

/// Create a `CmplogBytes` from a byte slice, truncating to 32 bytes.
fn to_cmplog_bytes(data: &[u8]) -> CmplogBytes {
    let len = data.len().min(32) as u8;
    let mut buf = [0u8; 32];
    buf[..len as usize].copy_from_slice(&data[..len as usize]);
    CmplogBytes::from_buf_and_len(buf, len)
}

/// Extracted JS value kind for serialization (testable without NAPI).
#[derive(Debug)]
pub enum ExtractedValue {
    Str(Vec<u8>),
    Num(f64),
    Skip,
}

/// Serialize a pair of extracted JS values to CmpValues entries.
///
/// Returns None if either value should be skipped (null, undefined, boolean, object).
pub fn serialize_pair(left: &ExtractedValue, right: &ExtractedValue) -> Option<Vec<CmpValues>> {
    match (left, right) {
        (ExtractedValue::Str(l), ExtractedValue::Str(r)) => Some(vec![CmpValues::Bytes((
            to_cmplog_bytes(l),
            to_cmplog_bytes(r),
        ))]),
        (ExtractedValue::Num(l), ExtractedValue::Num(r)) => Some(serialize_number_pair(*l, *r)),
        (ExtractedValue::Str(s), ExtractedValue::Num(n)) => {
            let n_str = format_f64(*n);
            Some(vec![CmpValues::Bytes((
                to_cmplog_bytes(s),
                to_cmplog_bytes(n_str.as_bytes()),
            ))])
        }
        (ExtractedValue::Num(n), ExtractedValue::Str(s)) => {
            let n_str = format_f64(*n);
            Some(vec![CmpValues::Bytes((
                to_cmplog_bytes(n_str.as_bytes()),
                to_cmplog_bytes(s),
            ))])
        }
        _ => None,
    }
}

/// Format an f64 identically to JavaScript's `Number.toString()`.
///
/// Uses `ryu_js` which implements the full ECMAScript `Number::toString`
/// algorithm, including exponential notation thresholds, negative zero,
/// NaN, and ±Infinity.
fn format_f64(v: f64) -> String {
    let mut buf = ryu_js::Buffer::new();
    buf.format(v).to_string()
}

/// Serialize a pair of numbers to CmpValues entries.
///
/// Non-negative integers fitting in u8/u16/u32/u64 emit the integer variant and a Bytes entry.
/// Non-integers (and negative numbers) emit only a Bytes entry with their string representation.
fn serialize_number_pair(l: f64, r: f64) -> Vec<CmpValues> {
    let mut result = Vec::new();

    if let (Some(li), Some(ri)) = (as_nonneg_int(l), as_nonneg_int(r)) {
        let max_val = li.max(ri);
        if max_val <= u8::MAX as u64 {
            result.push(CmpValues::U8((li as u8, ri as u8, false)));
        } else if max_val <= u16::MAX as u64 {
            result.push(CmpValues::U16((li as u16, ri as u16, false)));
        } else if max_val <= u32::MAX as u64 {
            result.push(CmpValues::U32((li as u32, ri as u32, false)));
        } else {
            result.push(CmpValues::U64((li, ri, false)));
        }
    }

    // Always emit a Bytes entry with the string representation.
    let l_str = format_f64(l);
    let r_str = format_f64(r);
    result.push(CmpValues::Bytes((
        to_cmplog_bytes(l_str.as_bytes()),
        to_cmplog_bytes(r_str.as_bytes()),
    )));

    result
}

/// If the f64 is a non-negative integer within JS safe integer range, return it as u64.
fn as_nonneg_int(v: f64) -> Option<u64> {
    if v >= 0.0 && v.fract() == 0.0 && v <= MAX_SAFE_INTEGER {
        Some(v as u64)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libafl_bolts::{AsSlice, HasLen};

    /// Reset cmplog state and return a cleanup guard that calls [`disable()`]
    /// on drop, ensuring isolation even if the test panics.
    fn reset() -> TestCleanupGuard {
        disable();
        TestCleanupGuard
    }

    // === Accumulator tests ===

    #[test]
    fn test_disabled_by_default() {
        let _cleanup = reset();
        assert!(!is_enabled());
    }

    #[test]
    fn test_enable_disable_lifecycle() {
        let _cleanup = reset();
        enable();
        assert!(is_enabled());
        disable();
        assert!(!is_enabled());
    }

    #[test]
    fn test_push_when_enabled() {
        let _cleanup = reset();
        enable();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        let entries = drain();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_push_always_accepts_below_global_cap() {
        let _cleanup = reset();
        // push() no longer checks enabled state - disabled guard is in JS
        // write function and drain(). push() only enforces global cap.
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        let entries = drain();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_capacity_limit() {
        let _cleanup = reset();
        enable();
        for i in 0..MAX_ENTRIES + 100 {
            push(
                CmpValues::U8((0, 0, false)),
                i as u32,
                CmpLogOperator::Equal,
            );
        }
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn test_drain_returns_and_clears() {
        let _cleanup = reset();
        enable();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        push(CmpValues::U8((3, 4, false)), 1, CmpLogOperator::Less);
        let entries = drain();
        assert_eq!(entries.len(), 2);
        let entries2 = drain();
        assert!(entries2.is_empty());
    }

    #[test]
    fn test_enriched_entry_preserves_site_id_and_operator() {
        let _cleanup = reset();
        enable();
        push(CmpValues::U8((10, 20, false)), 42, CmpLogOperator::Less);
        let entries = drain();
        assert_eq!(entries.len(), 1);
        let (values, site_id, operator) = &entries[0];
        assert_eq!(*site_id, 42);
        assert_eq!(*operator, CmpLogOperator::Less);
        assert_eq!(*values, CmpValues::U8((10, 20, false)));
    }

    // === Serialization tests (Task 2.2) ===

    #[test]
    fn test_serialize_string_pair() {
        let left = ExtractedValue::Str(b"hello".to_vec());
        let right = ExtractedValue::Str(b"world".to_vec());
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 1);
        match &result[0] {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"hello");
                assert_eq!(r.as_slice(), b"world");
            }
            _ => panic!("Expected CmpValues::Bytes"),
        }
    }

    #[test]
    fn test_serialize_long_string_truncation() {
        let long = vec![b'a'; 50];
        let left = ExtractedValue::Str(long);
        let right = ExtractedValue::Str(b"short".to_vec());
        let result = serialize_pair(&left, &right).unwrap();
        match &result[0] {
            CmpValues::Bytes((l, _)) => {
                assert_eq!(l.len(), 32);
            }
            _ => panic!("Expected CmpValues::Bytes"),
        }
    }

    #[test]
    fn test_serialize_small_integer_u8() {
        let left = ExtractedValue::Num(42.0);
        let right = ExtractedValue::Num(100.0);
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], CmpValues::U8((42, 100, false)));
        match &result[1] {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"42");
                assert_eq!(r.as_slice(), b"100");
            }
            _ => panic!("Expected CmpValues::Bytes"),
        }
    }

    #[test]
    fn test_serialize_medium_integer_u16() {
        let left = ExtractedValue::Num(1000.0);
        let right = ExtractedValue::Num(2000.0);
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], CmpValues::U16((1000, 2000, false)));
    }

    #[test]
    fn test_serialize_large_integer_u32() {
        let left = ExtractedValue::Num(100_000.0);
        let right = ExtractedValue::Num(200_000.0);
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], CmpValues::U32((100_000, 200_000, false)));
    }

    #[test]
    fn test_serialize_float_bytes_only() {
        let left = ExtractedValue::Num(3.125);
        let right = ExtractedValue::Num(2.75);
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 1);
        assert!(
            matches!(&result[0], CmpValues::Bytes(_)),
            "Float pair should produce only CmpValues::Bytes, got {:?}",
            result[0]
        );
    }

    #[test]
    fn test_serialize_mixed_string_number() {
        let left = ExtractedValue::Str(b"42".to_vec());
        let right = ExtractedValue::Num(42.0);
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 1);
        match &result[0] {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"42");
                assert_eq!(r.as_slice(), b"42");
            }
            _ => panic!("Expected CmpValues::Bytes"),
        }
    }

    #[test]
    fn test_serialize_skip_types() {
        let skip = ExtractedValue::Skip;
        let str_val = ExtractedValue::Str(b"test".to_vec());
        let num_val = ExtractedValue::Num(42.0);

        assert!(serialize_pair(&skip, &str_val).is_none());
        assert!(serialize_pair(&num_val, &skip).is_none());
        assert!(serialize_pair(&skip, &skip).is_none());
    }

    #[test]
    fn test_serialize_u64_integer() {
        let left = ExtractedValue::Num(5_000_000_000.0);
        let right = ExtractedValue::Num(6_000_000_000.0);
        let result = serialize_pair(&left, &right).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0],
            CmpValues::U64((5_000_000_000, 6_000_000_000, false))
        );
        match &result[1] {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"5000000000");
                assert_eq!(r.as_slice(), b"6000000000");
            }
            _ => panic!("Expected CmpValues::Bytes"),
        }
    }

    #[test]
    fn test_serialize_u32_max_boundary() {
        // u32::MAX should produce U32
        let result = serialize_pair(
            &ExtractedValue::Num(u32::MAX as f64),
            &ExtractedValue::Num(1.0),
        )
        .unwrap();
        assert_eq!(result[0], CmpValues::U32((u32::MAX, 1, false)));

        // u32::MAX + 1 should produce U64
        let result = serialize_pair(
            &ExtractedValue::Num(u32::MAX as f64 + 1.0),
            &ExtractedValue::Num(1.0),
        )
        .unwrap();
        assert_eq!(
            result[0],
            CmpValues::U64((u64::from(u32::MAX) + 1, 1, false))
        );
    }

    #[test]
    fn test_format_f64_matches_js() {
        // Large integers use exponential notation
        assert_eq!(format_f64(1e21), "1e+21");
        assert_eq!(format_f64(1.5e21), "1.5e+21");
        // Small fractions use exponential notation
        assert_eq!(format_f64(1e-7), "1e-7");
        assert_eq!(format_f64(5e-7), "5e-7");
        // Special values
        assert_eq!(format_f64(f64::INFINITY), "Infinity");
        assert_eq!(format_f64(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(format_f64(f64::NAN), "NaN");
        // Negative zero becomes "0"
        assert_eq!(format_f64(-0.0), "0");
    }

    #[test]
    fn test_enable_clears_stale_entries() {
        let _cleanup = reset();
        enable();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        // Re-enable should clear stale entries from the prior session
        enable();
        let entries = drain();
        assert!(entries.is_empty(), "enable() must clear stale entries");
    }

    #[test]
    fn test_double_enable_then_disable() {
        let _cleanup = reset();
        enable();
        assert!(is_enabled());
        enable(); // second enable clears entries, stays enabled
        assert!(is_enabled());
        disable(); // single disable is sufficient
        assert!(!is_enabled());
    }

    // === Global cap tests (per-site capping is now JS-side) ===

    #[test]
    fn test_push_global_cap_enforced() {
        let _cleanup = reset();
        enable();
        // push() now only enforces the global 4096-entry cap
        for i in 0..(MAX_ENTRIES as u32 + 10) {
            push(CmpValues::U8((0, 0, false)), i, CmpLogOperator::Equal);
        }
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn test_push_same_site_no_per_site_cap() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        // Per-site capping is now JS-side, so push() accepts all entries
        // for the same site up to the global cap.
        for i in 0..20u8 {
            push(CmpValues::U8((i, 0, false)), site_id, CmpLogOperator::Equal);
        }
        let entries = drain();
        assert_eq!(entries.len(), 20);
    }

    // === CmpLogOperator tests ===

    #[test]
    fn test_operator_from_id_strict_equal() {
        assert_eq!(CmpLogOperator::from_id(0), Some(CmpLogOperator::Equal));
    }

    #[test]
    fn test_operator_from_id_loose_equal() {
        assert_eq!(CmpLogOperator::from_id(2), Some(CmpLogOperator::Equal));
    }

    #[test]
    fn test_operator_from_id_strict_not_equal() {
        assert_eq!(CmpLogOperator::from_id(1), Some(CmpLogOperator::NotEqual));
    }

    #[test]
    fn test_operator_from_id_loose_not_equal() {
        assert_eq!(CmpLogOperator::from_id(3), Some(CmpLogOperator::NotEqual));
    }

    #[test]
    fn test_operator_from_id_less_than() {
        assert_eq!(CmpLogOperator::from_id(4), Some(CmpLogOperator::Less));
    }

    #[test]
    fn test_operator_from_id_less_than_or_equal() {
        assert_eq!(CmpLogOperator::from_id(6), Some(CmpLogOperator::Less));
    }

    #[test]
    fn test_operator_from_id_greater_than() {
        assert_eq!(CmpLogOperator::from_id(5), Some(CmpLogOperator::Greater));
    }

    #[test]
    fn test_operator_from_id_greater_than_or_equal() {
        assert_eq!(CmpLogOperator::from_id(7), Some(CmpLogOperator::Greater));
    }

    #[test]
    fn test_operator_from_id_unknown_returns_none() {
        assert_eq!(CmpLogOperator::from_id(8), None);
        assert_eq!(CmpLogOperator::from_id(99), None);
        assert_eq!(CmpLogOperator::from_id(u32::MAX), None);
    }

    // === Slot buffer deserialization tests ===

    /// Write a numeric comparison entry into the slot buffer at slot index `slot`.
    fn write_numeric_slot(
        buffer: &mut [u8; SLOT_BUFFER_SIZE],
        slot: usize,
        cmp_id: u32,
        operator_id: u8,
        left: f64,
        right: f64,
    ) {
        let base = slot * SLOT_SIZE;
        buffer[base..base + 4].copy_from_slice(&cmp_id.to_le_bytes());
        buffer[base + 4] = operator_id;
        buffer[base + 5] = 1; // leftType = f64
        buffer[base + 6] = 1; // rightType = f64
        buffer[base + 8..base + 16].copy_from_slice(&left.to_le_bytes());
        buffer[base + 41..base + 49].copy_from_slice(&right.to_le_bytes());
    }

    /// Write a string comparison entry into the slot buffer at slot index `slot`.
    fn write_string_slot(
        buffer: &mut [u8; SLOT_BUFFER_SIZE],
        slot: usize,
        cmp_id: u32,
        operator_id: u8,
        left: &[u8],
        right: &[u8],
    ) {
        let base = slot * SLOT_SIZE;
        buffer[base..base + 4].copy_from_slice(&cmp_id.to_le_bytes());
        buffer[base + 4] = operator_id;
        buffer[base + 5] = 2; // leftType = string
        buffer[base + 6] = 2; // rightType = string
        let left_len = left.len().min(32);
        let right_len = right.len().min(32);
        buffer[base + 7] = left_len as u8;
        buffer[base + 8..base + 8 + left_len].copy_from_slice(&left[..left_len]);
        buffer[base + 40] = right_len as u8;
        buffer[base + 41..base + 41 + right_len].copy_from_slice(&right[..right_len]);
    }

    #[test]
    fn test_deserialize_numeric_slot() {
        let mut buffer = [0u8; SLOT_BUFFER_SIZE];
        write_numeric_slot(&mut buffer, 0, 5, 0, 42.0, 100.0);
        let left = deserialize_slot_operand(&buffer, 5, 7, 8);
        let right = deserialize_slot_operand(&buffer, 6, 40, 41);
        match left {
            ExtractedValue::Num(v) => assert_eq!(v, 42.0),
            _ => panic!("Expected Num, got {:?}", left),
        }
        match right {
            ExtractedValue::Num(v) => assert_eq!(v, 100.0),
            _ => panic!("Expected Num, got {:?}", right),
        }
    }

    #[test]
    fn test_deserialize_string_slot() {
        let mut buffer = [0u8; SLOT_BUFFER_SIZE];
        write_string_slot(&mut buffer, 0, 10, 0, b"hello", b"world");
        let left = deserialize_slot_operand(&buffer, 5, 7, 8);
        let right = deserialize_slot_operand(&buffer, 6, 40, 41);
        match left {
            ExtractedValue::Str(v) => assert_eq!(v, b"hello"),
            _ => panic!("Expected Str, got {:?}", left),
        }
        match right {
            ExtractedValue::Str(v) => assert_eq!(v, b"world"),
            _ => panic!("Expected Str, got {:?}", right),
        }
    }

    #[test]
    fn test_deserialize_skip_type() {
        let buffer = [0u8; SLOT_BUFFER_SIZE]; // all zeros = type 0 = skip
        let result = deserialize_slot_operand(&buffer, 5, 7, 8);
        assert!(matches!(result, ExtractedValue::Skip));
    }

    #[test]
    fn test_deserialize_invalid_operator_id_skipped_in_drain() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_numeric_slot(buf, 0, 5, 99, 42.0, 100.0);
            state.set_write_ptr(1);
        });
        let entries = drain();
        assert!(entries.is_empty(), "Invalid operator ID should be skipped");
    }

    #[test]
    fn test_drain_empty_buffer() {
        let _cleanup = reset();
        enable();
        // write pointer = 0 (from enable), no entries written
        let entries = drain();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_drain_when_disabled_returns_empty() {
        let _cleanup = reset();
        // Disabled by default (write pointer = 0xFFFFFFFF)
        CMPLOG_STATE.with(|s| {
            let state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            // Write something into slot 0 (stale data)
            write_numeric_slot(buf, 0, 5, 0, 42.0, 100.0);
        });
        let entries = drain();
        assert!(entries.is_empty());
        // Write pointer should NOT be modified (remains 0xFFFFFFFF)
        CMPLOG_STATE.with(|s| {
            let state = s.borrow();
            assert_eq!(state.read_write_ptr(), WRITE_PTR_DISABLED);
        });
    }

    #[test]
    fn test_drain_numeric_comparison() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_numeric_slot(buf, 0, 5, 0, 42.0, 100.0);
            state.set_write_ptr(1);
        });
        let entries = drain();
        // Numeric comparison produces 2 entries: U8 + Bytes
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, CmpValues::U8((42, 100, false)));
        assert_eq!(entries[0].1, 5); // cmp_id
        assert_eq!(entries[0].2, CmpLogOperator::Equal); // operator
        match &entries[1].0 {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"42");
                assert_eq!(r.as_slice(), b"100");
            }
            _ => panic!("Expected Bytes"),
        }
    }

    #[test]
    fn test_drain_string_comparison() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_string_slot(buf, 0, 10, 0, b"hello", b"world");
            state.set_write_ptr(1);
        });
        let entries = drain();
        assert_eq!(entries.len(), 1);
        match &entries[0].0 {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"hello");
                assert_eq!(r.as_slice(), b"world");
            }
            _ => panic!("Expected Bytes"),
        }
        assert_eq!(entries[0].1, 10);
    }

    #[test]
    fn test_drain_mixed_type_comparison() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            // Mixed: left = string "42", right = number 42.0
            let base = 0;
            buf[base..base + 4].copy_from_slice(&10u32.to_le_bytes());
            buf[base + 4] = 0; // operator === (Equal)
            buf[base + 5] = 2; // leftType = string
            buf[base + 6] = 1; // rightType = f64
            buf[base + 7] = 2; // leftLen = 2
            buf[base + 8..base + 10].copy_from_slice(b"42");
            buf[base + 41..base + 49].copy_from_slice(&42.0f64.to_le_bytes());
            state.set_write_ptr(1);
        });
        let entries = drain();
        assert_eq!(entries.len(), 1);
        match &entries[0].0 {
            CmpValues::Bytes((l, r)) => {
                assert_eq!(l.as_slice(), b"42");
                assert_eq!(r.as_slice(), b"42");
            }
            _ => panic!("Expected Bytes"),
        }
    }

    #[test]
    fn test_drain_multiple_slots() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_string_slot(buf, 0, 1, 0, b"hello", b"world");
            write_numeric_slot(buf, 1, 2, 4, 3.0, 5.0);
            state.set_write_ptr(2);
        });
        let entries = drain();
        // String: 1 entry (Bytes), Numeric: 2 entries (U8 + Bytes)
        assert_eq!(entries.len(), 3);
        // First entry from string comparison
        assert_eq!(entries[0].1, 1);
        // Second and third from numeric comparison
        assert_eq!(entries[1].1, 2);
        assert_eq!(entries[1].2, CmpLogOperator::Less);
    }

    #[test]
    fn test_drain_resets_write_pointer() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_numeric_slot(buf, 0, 5, 0, 1.0, 2.0);
            state.set_write_ptr(1);
        });
        drain();
        CMPLOG_STATE.with(|s| {
            let state = s.borrow();
            assert_eq!(state.read_write_ptr(), 0);
        });
    }

    #[test]
    fn test_drain_full_buffer() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            // Fill all slots with string comparisons (1 CmpValues each)
            for i in 0..MAX_SLOTS {
                write_string_slot(buf, i, i as u32, 0, b"a", b"b");
            }
            state.set_write_ptr(MAX_SLOTS as u32);
        });
        let entries = drain();
        // MAX_SLOTS string comparisons, but capped at MAX_ENTRIES (4096)
        assert_eq!(entries.len(), MAX_SLOTS.min(MAX_ENTRIES));
    }

    #[test]
    fn test_drain_u64_integer_from_slot() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_numeric_slot(buf, 0, 5, 0, 5_000_000_000.0, 6_000_000_000.0);
            state.set_write_ptr(1);
        });
        let entries = drain();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].0,
            CmpValues::U64((5_000_000_000, 6_000_000_000, false))
        );
    }

    #[test]
    fn test_drain_float_from_slot() {
        let _cleanup = reset();
        enable();
        CMPLOG_STATE.with(|s| {
            let mut state = s.borrow_mut();
            // SAFETY: Test-only; single-threaded, no concurrent JS access.
            let buf = unsafe { &mut *state.slot_buffer.get() };
            write_numeric_slot(buf, 0, 5, 0, 3.125, 2.75);
            state.set_write_ptr(1);
        });
        let entries = drain();
        // Float pair: only Bytes entry (no integer variant)
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0].0, CmpValues::Bytes(_)));
    }
}
