//! # Thread-safety
//!
//! CmpLog state is thread-local. Only one [`Fuzzer`](crate::engine::Fuzzer) should
//! be active per thread at a time. Multiple concurrent Fuzzers on the same thread
//! share the enable flag and entry buffer, which leads to incorrect behavior:
//! interleaved `getNextInput`/`reportResult` calls mix comparison entries between
//! Fuzzers.
//!
//! CmpLog is enabled explicitly via [`enable()`] (called by `Fuzzer::new()`) and
//! disabled via [`disable()`] (called by `Fuzzer::shutdown()`). `Fuzzer::drop()`
//! does not touch CmpLog, so non-deterministic GC timing is irrelevant.

use std::cell::RefCell;

use libafl::observers::cmp::{CmpValues, CmplogBytes};

/// Maximum number of comparison entries per iteration.
const MAX_ENTRIES: usize = 4096;

/// Maximum number of CmpLog entries recorded per comparison site per iteration.
///
/// Beyond this cap, entries for the same site are silently dropped. This limits
/// hot-loop comparisons (e.g., `i < length`) from flooding the accumulator while
/// preserving enough entries for REDQUEEN dual-trace and I2S mutations.
const MAX_ENTRIES_PER_SITE: u8 = 8;

/// Number of slots in the per-site count array. Must be a power of two so that
/// `cmp_id & (SITE_COUNT_SLOTS - 1)` is a valid index. Hash collisions cause
/// two sites to share a budget, which is acceptable because the cap is a
/// performance heuristic, not a correctness invariant.
const SITE_COUNT_SLOTS: usize = 512;
const _: () = assert!(SITE_COUNT_SLOTS.is_power_of_two());

/// Largest integer JavaScript can represent exactly (`2^53 - 1`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Comparison operator type derived from the numeric operator ID parameter in
/// `__vitiate_trace_cmp_record()`. Used to populate `AflppCmpLogHeader` attributes.
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

struct CmpLogState {
    enabled: bool,
    entries: Vec<CmpLogEntry>,
    /// Per-site entry counts indexed by `cmp_id & (SITE_COUNT_SLOTS - 1)`.
    /// Zeroed on drain/enable/disable.
    site_counts: [u8; SITE_COUNT_SLOTS],
}

thread_local! {
    static CMPLOG_STATE: RefCell<CmpLogState> = const { RefCell::new(CmpLogState { enabled: false, entries: Vec::new(), site_counts: [0u8; SITE_COUNT_SLOTS] }) };
}

/// Enable CmpLog recording, clearing any stale entries and per-site counts
/// from a prior session.
pub fn enable() {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.entries.clear();
        state.site_counts = [0u8; SITE_COUNT_SLOTS];
        state.enabled = true;
    });
}

/// Disable CmpLog recording and clear accumulated entries and per-site counts.
pub fn disable() {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.enabled = false;
        state.entries.clear();
        state.site_counts = [0u8; SITE_COUNT_SLOTS];
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
/// Only used in tests now that `trace_cmp_record` uses [`is_site_at_cap`]
/// for its early-exit check.
#[cfg(test)]
pub fn is_enabled() -> bool {
    CMPLOG_STATE.with(|s| s.borrow().enabled)
}

/// Check if a comparison site has reached its per-site entry cap.
///
/// Returns `true` (skip this site) when:
/// - CmpLog is disabled (no active Fuzzer)
/// - The global 4096-entry cap has been reached
/// - The per-site count for `cmp_id` has reached `MAX_ENTRIES_PER_SITE`
///
/// Designed to be called from `trace_cmp_record` *before* serialization, so
/// that NAPI extraction and ryu_js formatting are skipped entirely for capped
/// sites. Uses an immutable borrow - the count is incremented later in `push()`.
pub fn is_site_at_cap(cmp_id: u32) -> bool {
    CMPLOG_STATE.with(|s| {
        let state = s.borrow();
        if !state.enabled {
            return true;
        }
        if state.entries.len() >= MAX_ENTRIES {
            return true;
        }
        let slot = (cmp_id as usize) & (SITE_COUNT_SLOTS - 1);
        state.site_counts[slot] >= MAX_ENTRIES_PER_SITE
    })
}

/// Push an enriched comparison entry into the thread-local accumulator.
///
/// Silently drops entries when disabled, at global capacity (4096), or when the
/// per-site cap for `site_id` has been reached.
pub fn push(entry: CmpValues, site_id: u32, operator: CmpLogOperator) {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.enabled && state.entries.len() < MAX_ENTRIES {
            let slot = (site_id as usize) & (SITE_COUNT_SLOTS - 1);
            if state.site_counts[slot] >= MAX_ENTRIES_PER_SITE {
                return;
            }
            state.entries.push((entry, site_id, operator));
            state.site_counts[slot] = state.site_counts[slot].saturating_add(1);
        }
    });
}

/// Drain all accumulated enriched entries and return them.
///
/// The accumulator and per-site counts are reset after this call.
pub fn drain() -> Vec<CmpLogEntry> {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.site_counts = [0u8; SITE_COUNT_SLOTS];
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

/// Extract a JS value's type and data using raw NAPI calls.
pub fn extract_js_value(env: napi::sys::napi_env, value: napi::sys::napi_value) -> ExtractedValue {
    let mut value_type = napi::sys::ValueType::napi_undefined;
    // SAFETY: env and value are valid NAPI handles obtained from the current
    // callback scope (trace_cmp). napi_typeof reads the value type without
    // side effects.
    let status = unsafe { napi::sys::napi_typeof(env, value, &mut value_type) };
    if status != napi::sys::Status::napi_ok {
        return ExtractedValue::Skip;
    }

    match value_type {
        // SAFETY: get_string_utf8 requires a valid napi string value, which
        // we've confirmed via napi_typeof above.
        napi::sys::ValueType::napi_string => match unsafe { get_string_utf8(env, value) } {
            Some(bytes) => ExtractedValue::Str(bytes),
            None => ExtractedValue::Skip,
        },
        napi::sys::ValueType::napi_number => {
            let mut result: f64 = 0.0;
            // SAFETY: env/value are valid; napi_get_value_double reads a
            // number without side effects.
            let status = unsafe { napi::sys::napi_get_value_double(env, value, &mut result) };
            if status == napi::sys::Status::napi_ok {
                ExtractedValue::Num(result)
            } else {
                ExtractedValue::Skip
            }
        }
        _ => ExtractedValue::Skip,
    }
}

/// Get UTF-8 string bytes from a NAPI string value.
unsafe fn get_string_utf8(
    env: napi::sys::napi_env,
    value: napi::sys::napi_value,
) -> Option<Vec<u8>> {
    let mut len: usize = 0;
    let status = unsafe {
        napi::sys::napi_get_value_string_utf8(env, value, std::ptr::null_mut(), 0, &mut len)
    };
    if status != napi::sys::Status::napi_ok {
        return None;
    }

    let mut buf = vec![0u8; len + 1];
    let mut written: usize = 0;
    let status = unsafe {
        napi::sys::napi_get_value_string_utf8(
            env,
            value,
            buf.as_mut_ptr().cast(),
            buf.len(),
            &mut written,
        )
    };
    if status != napi::sys::Status::napi_ok {
        return None;
    }

    buf.truncate(written);
    Some(buf)
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

/// Serialize JS comparison operands to CmpValues entries.
///
/// Extracts values from raw NAPI handles and produces CmpValues entries.
pub fn serialize_to_cmp_values(
    env: napi::sys::napi_env,
    left: napi::sys::napi_value,
    right: napi::sys::napi_value,
) -> Option<Vec<CmpValues>> {
    let left_val = extract_js_value(env, left);
    let right_val = extract_js_value(env, right);
    serialize_pair(&left_val, &right_val)
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
    fn test_push_when_disabled() {
        let _cleanup = reset();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        let entries = drain();
        assert!(entries.is_empty());
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

    // === Per-site cap tests ===

    #[test]
    fn test_per_site_entries_within_cap_are_recorded() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        for i in 0..5 {
            push(CmpValues::U8((i, 0, false)), site_id, CmpLogOperator::Equal);
        }
        let entries = drain();
        assert_eq!(entries.len(), 5);
    }

    #[test]
    fn test_per_site_entries_beyond_cap_are_dropped() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        for i in 0..(MAX_ENTRIES_PER_SITE + 4) {
            push(CmpValues::U8((i, 0, false)), site_id, CmpLogOperator::Equal);
        }
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES_PER_SITE as usize);
    }

    #[test]
    fn test_per_site_different_sites_have_independent_budgets() {
        let _cleanup = reset();
        enable();
        // Site 1 and site 2 do not collide (1 & 511 = 1, 2 & 511 = 2)
        let site_a = 1;
        let site_b = 2;
        // Fill site A to cap
        for i in 0..MAX_ENTRIES_PER_SITE {
            push(CmpValues::U8((i, 0, false)), site_a, CmpLogOperator::Equal);
        }
        // Site B should still accept entries
        push(CmpValues::U8((99, 0, false)), site_b, CmpLogOperator::Equal);
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES_PER_SITE as usize + 1);
        // Last entry should be from site B
        assert_eq!(entries.last().unwrap().1, site_b);
    }

    #[test]
    fn test_per_site_colliding_sites_share_budget() {
        let _cleanup = reset();
        enable();
        // Sites 1 and 513 collide: 1 & 511 == 513 & 511 == 1
        let site_a = 1;
        let site_b = 513;
        assert_eq!(
            site_a & (SITE_COUNT_SLOTS as u32 - 1),
            site_b & (SITE_COUNT_SLOTS as u32 - 1),
        );
        // Push 5 entries for site A, then 3 for site B (total 8 = cap)
        for i in 0..5u8 {
            push(CmpValues::U8((i, 0, false)), site_a, CmpLogOperator::Equal);
        }
        for i in 0..3u8 {
            push(CmpValues::U8((i, 0, false)), site_b, CmpLogOperator::Equal);
        }
        assert_eq!(drain().len(), MAX_ENTRIES_PER_SITE as usize);
        // One more push to either site should be dropped
        enable();
        for i in 0..5u8 {
            push(CmpValues::U8((i, 0, false)), site_a, CmpLogOperator::Equal);
        }
        for i in 0..5u8 {
            push(CmpValues::U8((i, 0, false)), site_b, CmpLogOperator::Equal);
        }
        // Combined: 10 attempted, 8 recorded (shared budget)
        assert_eq!(drain().len(), MAX_ENTRIES_PER_SITE as usize);
    }

    #[test]
    fn test_per_site_global_cap_still_applies() {
        let _cleanup = reset();
        enable();
        // Use many different site IDs so per-site caps are not hit
        // Each site gets 1 entry, fill to global cap
        for i in 0..(MAX_ENTRIES as u32 + 10) {
            // Use site IDs that won't collide heavily: multiply by a large
            // prime to spread across the 512 slots
            push(
                CmpValues::U8((0, 0, false)),
                i.wrapping_mul(7919),
                CmpLogOperator::Equal,
            );
        }
        let entries = drain();
        // 7919 mod 512 = 239, gcd(239,512) = 1, so i*7919 mod 512 cycles
        // through all 512 slots. The first 4096 pushes distribute 8 entries
        // per slot (4096/512), hitting both the global and per-site caps
        // simultaneously. The remaining 10 pushes are all dropped.
        assert_eq!(entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn test_per_site_drain_resets_counts() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        // Fill site to cap
        for _ in 0..MAX_ENTRIES_PER_SITE {
            push(CmpValues::U8((1, 0, false)), site_id, CmpLogOperator::Equal);
        }
        assert_eq!(drain().len(), MAX_ENTRIES_PER_SITE as usize);
        // After drain, counts should be reset - new entry should be accepted
        push(CmpValues::U8((2, 0, false)), site_id, CmpLogOperator::Equal);
        let entries = drain();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_per_site_enable_resets_counts() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        // Fill site to cap
        for _ in 0..MAX_ENTRIES_PER_SITE {
            push(CmpValues::U8((1, 0, false)), site_id, CmpLogOperator::Equal);
        }
        // Re-enable should reset counts
        enable();
        push(CmpValues::U8((2, 0, false)), site_id, CmpLogOperator::Equal);
        let entries = drain();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn test_is_site_at_cap_returns_true_when_disabled() {
        let _cleanup = reset();
        // Disabled by default after reset
        assert!(is_site_at_cap(42));
    }

    #[test]
    fn test_is_site_at_cap_returns_true_when_site_at_cap() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        for _ in 0..MAX_ENTRIES_PER_SITE {
            push(CmpValues::U8((1, 0, false)), site_id, CmpLogOperator::Equal);
        }
        assert!(is_site_at_cap(site_id));
    }

    #[test]
    fn test_is_site_at_cap_returns_false_when_room() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        push(CmpValues::U8((1, 0, false)), site_id, CmpLogOperator::Equal);
        assert!(!is_site_at_cap(site_id));
    }

    #[test]
    fn test_is_site_at_cap_returns_true_when_fully_saturated() {
        let _cleanup = reset();
        enable();
        // Fill to global cap using sequential site IDs (0..4095). With 512
        // slots and MAX_ENTRIES_PER_SITE=8, every slot gets exactly 8 entries
        // (4096/512=8), so both the global cap and all per-site caps are
        // reached simultaneously. The global-cap-only path (entries.len() >=
        // MAX_ENTRIES) cannot be tested in isolation because 512*8=4096.
        for i in 0..MAX_ENTRIES as u32 {
            push(CmpValues::U8((0, 0, false)), i, CmpLogOperator::Equal);
        }
        assert!(is_site_at_cap(9999));
    }

    #[test]
    fn test_per_site_multi_entry_counts_both_entries() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        // Simulate numeric comparisons producing 2 entries each (integer + bytes).
        // Push 4 pairs = 8 entries total, hitting the per-site cap.
        for i in 0..4u8 {
            push(CmpValues::U8((i, 0, false)), site_id, CmpLogOperator::Equal);
            push(
                CmpValues::Bytes((to_cmplog_bytes(&[i]), to_cmplog_bytes(&[0]))),
                site_id,
                CmpLogOperator::Equal,
            );
        }
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES_PER_SITE as usize);

        // 5th pair should be fully dropped
        enable();
        for i in 0..5u8 {
            push(CmpValues::U8((i, 0, false)), site_id, CmpLogOperator::Equal);
            push(
                CmpValues::Bytes((to_cmplog_bytes(&[i]), to_cmplog_bytes(&[0]))),
                site_id,
                CmpLogOperator::Equal,
            );
        }
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES_PER_SITE as usize);
    }

    #[test]
    fn test_per_site_partial_multi_entry_drop_at_cap_boundary() {
        let _cleanup = reset();
        enable();
        let site_id = 42;
        // Push 7 entries for the site (1 slot remaining under cap of 8)
        for i in 0..7u8 {
            push(CmpValues::U8((i, 0, false)), site_id, CmpLogOperator::Equal);
        }
        // Push 2 more entries for the same site (simulating a numeric pair)
        // First should succeed (count becomes 8), second should be dropped
        push(CmpValues::U8((7, 0, false)), site_id, CmpLogOperator::Equal);
        push(
            CmpValues::Bytes((to_cmplog_bytes(b"7"), to_cmplog_bytes(b"0"))),
            site_id,
            CmpLogOperator::Equal,
        );
        let entries = drain();
        assert_eq!(entries.len(), MAX_ENTRIES_PER_SITE as usize);
        // Last recorded entry should be the U8 (8th entry), not the Bytes
        assert!(matches!(entries.last().unwrap().0, CmpValues::U8(_)));
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
}
