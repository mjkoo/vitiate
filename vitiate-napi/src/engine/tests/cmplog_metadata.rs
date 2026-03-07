use crate::cmplog::{CmpLogEntry, CmpLogOperator};
use crate::engine::cmplog_metadata::extract_tokens_from_cmplog;
use libafl::observers::cmp::{CmpValues, CmplogBytes};

fn make_cmplog_bytes(data: &[u8]) -> CmplogBytes {
    let len = data.len().min(32) as u8;
    let mut buf = [0u8; 32];
    buf[..len as usize].copy_from_slice(&data[..len as usize]);
    CmplogBytes::from_buf_and_len(buf, len)
}

#[test]
fn test_extract_tokens_from_mixed_cmpvalues() {
    let entries: Vec<CmpLogEntry> = vec![
        (
            CmpValues::Bytes((make_cmplog_bytes(b"http"), make_cmplog_bytes(b"javascript"))),
            0,
            CmpLogOperator::Equal,
        ),
        (CmpValues::U8((10, 20, false)), 0, CmpLogOperator::Equal),
        (
            CmpValues::Bytes((make_cmplog_bytes(b"ftp"), make_cmplog_bytes(b"ssh"))),
            0,
            CmpLogOperator::Equal,
        ),
        (
            CmpValues::U16((1000, 2000, false)),
            0,
            CmpLogOperator::Equal,
        ),
    ];

    let tokens = extract_tokens_from_cmplog(&entries);

    // Should extract both operands from each Bytes entry, skip numeric entries.
    assert!(tokens.contains(&b"http".to_vec()));
    assert!(tokens.contains(&b"javascript".to_vec()));
    assert!(tokens.contains(&b"ftp".to_vec()));
    assert!(tokens.contains(&b"ssh".to_vec()));
    assert_eq!(tokens.len(), 4);
}

#[test]
fn test_extract_tokens_filters_empty_null_and_0xff() {
    let entries: Vec<CmpLogEntry> = vec![
        // Empty left operand — should be skipped.
        (
            CmpValues::Bytes((make_cmplog_bytes(b""), make_cmplog_bytes(b"valid"))),
            0,
            CmpLogOperator::Equal,
        ),
        // All-null operands — both should be skipped.
        (
            CmpValues::Bytes((
                make_cmplog_bytes(&[0x00, 0x00, 0x00, 0x00]),
                make_cmplog_bytes(b"also_valid"),
            )),
            0,
            CmpLogOperator::Equal,
        ),
        // All-0xFF operand — should be skipped.
        (
            CmpValues::Bytes((
                make_cmplog_bytes(b"keep_this"),
                make_cmplog_bytes(&[0xFF, 0xFF]),
            )),
            0,
            CmpLogOperator::Equal,
        ),
        // Mixed-with-nulls — should be kept (not all-null).
        (
            CmpValues::Bytes((
                make_cmplog_bytes(&[0x00, 0x41, 0x00]),
                make_cmplog_bytes(b"another"),
            )),
            0,
            CmpLogOperator::Equal,
        ),
    ];

    let tokens = extract_tokens_from_cmplog(&entries);

    // Kept: "valid", "also_valid", "keep_this", [0x00, 0x41, 0x00], "another"
    assert!(tokens.contains(&b"valid".to_vec()));
    assert!(tokens.contains(&b"also_valid".to_vec()));
    assert!(tokens.contains(&b"keep_this".to_vec()));
    assert!(tokens.contains(&vec![0x00, 0x41, 0x00]));
    assert!(tokens.contains(&b"another".to_vec()));
    assert_eq!(tokens.len(), 5);

    // Filtered: empty, all-null, all-0xFF
    assert!(!tokens.contains(&vec![]));
    assert!(!tokens.contains(&vec![0x00, 0x00, 0x00, 0x00]));
    assert!(!tokens.contains(&vec![0xFF, 0xFF]));
}
