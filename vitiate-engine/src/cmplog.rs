//! # Thread-safety
//!
//! CmpLog state is thread-local. Only one [`Fuzzer`](crate::engine::Fuzzer) should
//! be active per thread at a time. Multiple concurrent Fuzzers on the same thread
//! share the enable flag and entry buffer, which leads to incorrect behavior:
//! the first Fuzzer dropped disables recording for the survivor, and interleaved
//! `getNextInput`/`reportResult` calls mix comparison entries between Fuzzers.

use std::cell::RefCell;

use libafl::observers::cmp::{CmpValues, CmplogBytes};

/// Maximum number of comparison entries per iteration.
const MAX_ENTRIES: usize = 4096;

/// Comparison operator type derived from the `op` string parameter in
/// `__vitiate_trace_cmp()`. Used to populate `AflppCmpLogHeader` attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmpLogOperator {
    Equal,
    NotEqual,
    Less,
    Greater,
}

impl CmpLogOperator {
    /// Parse a JavaScript comparison operator string into a `CmpLogOperator`.
    ///
    /// Returns `None` for unknown operators. The SWC plugin only emits known
    /// operators, but `trace_cmp` is a public NAPI function that can be called
    /// with arbitrary strings from JS - returning `None` lets callers skip
    /// CmpLog recording gracefully while the operator match in `trace_cmp`
    /// returns the appropriate JS error.
    pub fn from_op(op: &str) -> Option<Self> {
        match op {
            "===" | "==" => Some(Self::Equal),
            "!==" | "!=" => Some(Self::NotEqual),
            "<" | "<=" => Some(Self::Less),
            ">" | ">=" => Some(Self::Greater),
            _ => None,
        }
    }
}

/// Largest integer JavaScript can represent exactly (`2^53 - 1`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Enriched CmpLog entry: comparison values, site ID, and operator type.
pub type CmpLogEntry = (CmpValues, u32, CmpLogOperator);

struct CmpLogState {
    enabled: bool,
    entries: Vec<CmpLogEntry>,
}

thread_local! {
    static CMPLOG_STATE: RefCell<CmpLogState> = const { RefCell::new(CmpLogState { enabled: false, entries: Vec::new() }) };
}

/// Enable CmpLog recording. Called when a Fuzzer is constructed.
///
/// Assumes at most one Fuzzer is active per thread. See module docs.
pub fn enable() {
    CMPLOG_STATE.with(|s| s.borrow_mut().enabled = true);
}

/// Disable CmpLog recording and discard any leftover entries.
///
/// Called when a Fuzzer is dropped. Draining prevents stale entries from
/// leaking into a subsequently created Fuzzer.
/// Assumes at most one Fuzzer is active per thread. See module docs.
pub fn disable() {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.enabled = false;
        state.entries.clear();
    });
}

/// Check if CmpLog recording is currently enabled.
pub fn is_enabled() -> bool {
    CMPLOG_STATE.with(|s| s.borrow().enabled)
}

/// Push an enriched comparison entry into the thread-local accumulator.
///
/// Silently drops entries when disabled or at capacity (4096).
pub fn push(entry: CmpValues, site_id: u32, operator: CmpLogOperator) {
    CMPLOG_STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.enabled && state.entries.len() < MAX_ENTRIES {
            state.entries.push((entry, site_id, operator));
        }
    });
}

/// Drain all accumulated enriched entries and return them.
///
/// The accumulator is empty after this call.
pub fn drain() -> Vec<CmpLogEntry> {
    CMPLOG_STATE.with(|s| std::mem::take(&mut s.borrow_mut().entries))
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

    /// Reset cmplog state between tests.
    fn reset() {
        disable();
    }

    // === Accumulator tests ===

    #[test]
    fn test_disabled_by_default() {
        reset();
        assert!(!is_enabled());
    }

    #[test]
    fn test_enable_disable_lifecycle() {
        reset();
        enable();
        assert!(is_enabled());
        disable();
        assert!(!is_enabled());
    }

    #[test]
    fn test_push_when_enabled() {
        reset();
        enable();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        let entries = drain();
        assert_eq!(entries.len(), 1);
        disable();
    }

    #[test]
    fn test_push_when_disabled() {
        reset();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        let entries = drain();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_capacity_limit() {
        reset();
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
        disable();
    }

    #[test]
    fn test_drain_returns_and_clears() {
        reset();
        enable();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        push(CmpValues::U8((3, 4, false)), 1, CmpLogOperator::Less);
        let entries = drain();
        assert_eq!(entries.len(), 2);
        let entries2 = drain();
        assert!(entries2.is_empty());
        disable();
    }

    #[test]
    fn test_enriched_entry_preserves_site_id_and_operator() {
        reset();
        enable();
        push(CmpValues::U8((10, 20, false)), 42, CmpLogOperator::Less);
        let entries = drain();
        assert_eq!(entries.len(), 1);
        let (values, site_id, operator) = &entries[0];
        assert_eq!(*site_id, 42);
        assert_eq!(*operator, CmpLogOperator::Less);
        assert_eq!(*values, CmpValues::U8((10, 20, false)));
        disable();
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
    fn test_disable_drains_stale_entries() {
        reset();
        enable();
        push(CmpValues::U8((1, 2, false)), 0, CmpLogOperator::Equal);
        // disable() should drain stale entries
        disable();
        // New session should not see entries from the prior one
        enable();
        let entries = drain();
        assert!(entries.is_empty(), "disable() must drain stale entries");
        disable();
    }

    // === CmpLogOperator tests ===

    #[test]
    fn test_operator_from_strict_equal() {
        assert_eq!(CmpLogOperator::from_op("==="), Some(CmpLogOperator::Equal));
    }

    #[test]
    fn test_operator_from_loose_equal() {
        assert_eq!(CmpLogOperator::from_op("=="), Some(CmpLogOperator::Equal));
    }

    #[test]
    fn test_operator_from_strict_not_equal() {
        assert_eq!(
            CmpLogOperator::from_op("!=="),
            Some(CmpLogOperator::NotEqual)
        );
    }

    #[test]
    fn test_operator_from_loose_not_equal() {
        assert_eq!(
            CmpLogOperator::from_op("!="),
            Some(CmpLogOperator::NotEqual)
        );
    }

    #[test]
    fn test_operator_from_less_than() {
        assert_eq!(CmpLogOperator::from_op("<"), Some(CmpLogOperator::Less));
    }

    #[test]
    fn test_operator_from_less_than_or_equal() {
        assert_eq!(CmpLogOperator::from_op("<="), Some(CmpLogOperator::Less));
    }

    #[test]
    fn test_operator_from_greater_than() {
        assert_eq!(CmpLogOperator::from_op(">"), Some(CmpLogOperator::Greater));
    }

    #[test]
    fn test_operator_from_greater_than_or_equal() {
        assert_eq!(CmpLogOperator::from_op(">="), Some(CmpLogOperator::Greater));
    }

    #[test]
    fn test_operator_from_unknown_returns_none() {
        assert_eq!(CmpLogOperator::from_op("??"), None);
        assert_eq!(CmpLogOperator::from_op("???"), None);
        assert_eq!(CmpLogOperator::from_op(""), None);
    }
}
