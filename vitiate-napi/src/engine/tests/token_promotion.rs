use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::token_tracker::{MAX_TOKEN_CANDIDATES, TOKEN_PROMOTION_THRESHOLD};
use crate::types::ExitKind;
use libafl::HasMetadata;
use libafl::mutators::Tokens;
use libafl::observers::cmp::CmpValues;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_report_result_populates_tokens_from_cmplog() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add a seed so the fuzzer has something to work with.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Push the same CmpLog entries TOKEN_PROMOTION_THRESHOLD times so
    // the tokens get promoted into the dictionary.
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((make_cmplog_bytes(b"http"), make_cmplog_bytes(b"javascript"))),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        cmplog::push(
            CmpValues::U16((1000, 2000, false)),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    // Verify Tokens metadata was populated from the Bytes entry.
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(
        token_list.contains(&b"http".as_slice()),
        "should contain 'http'"
    );
    assert!(
        token_list.contains(&b"javascript".as_slice()),
        "should contain 'javascript'"
    );

    cmplog::disable();
}

#[test]
fn test_tokens_accumulate_across_report_result_calls() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Push two different comparisons TOKEN_PROMOTION_THRESHOLD times each
    // so both pairs get promoted.
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((make_cmplog_bytes(b"http"), make_cmplog_bytes(b"javascript"))),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        cmplog::push(
            CmpValues::Bytes((make_cmplog_bytes(b"ftp"), make_cmplog_bytes(b"ssh"))),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    // All four tokens should be present (accumulated, not replaced).
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(token_list.contains(&b"http".as_slice()));
    assert!(token_list.contains(&b"javascript".as_slice()));
    assert!(token_list.contains(&b"ftp".as_slice()));
    assert!(token_list.contains(&b"ssh".as_slice()));
    assert_eq!(token_list.len(), 4);

    cmplog::disable();
}

#[test]
fn test_token_candidates_capped_at_max() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Push MAX_TOKEN_CANDIDATES + 100 unique single-observation tokens.
    // Each token is observed only once, so none are promoted.
    for i in 0..(MAX_TOKEN_CANDIDATES + 100) {
        let _input = fuzzer.get_next_input().unwrap();
        let token_bytes = format!("tok_{i:06}");
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(token_bytes.as_bytes()),
                make_cmplog_bytes(b"other"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    assert!(
        fuzzer.token_tracker.candidates.len() <= MAX_TOKEN_CANDIDATES,
        "token_candidates should be capped at {MAX_TOKEN_CANDIDATES}, got {}",
        fuzzer.token_tracker.candidates.len(),
    );

    cmplog::disable();
}

#[test]
fn test_promoted_tokens_not_reinserted_into_candidates() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Push a token TOKEN_PROMOTION_THRESHOLD observations to promote it.
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(b"promote_me"),
                make_cmplog_bytes(b"other_side"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    // The promoted token should be in the dictionary.
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    assert!(
        tokens
            .tokens()
            .iter()
            .any(|t| t.as_slice() == b"promote_me"),
        "promoted token should be in the dictionary"
    );

    // The promoted token should be removed from candidates and tracked in promoted_tokens.
    assert!(
        !fuzzer
            .token_tracker
            .candidates
            .contains_key(b"promote_me".as_slice()),
        "promoted token should be removed from token_candidates"
    );
    assert!(
        fuzzer
            .token_tracker
            .promoted
            .contains(b"promote_me".as_slice()),
        "promoted token should be tracked in promoted_tokens"
    );

    let dict_len_before = fuzzer.state.metadata::<Tokens>().unwrap().tokens().len();

    // Push the same CmpLog entry again — the token must NOT re-enter candidates.
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(b"promote_me"),
                make_cmplog_bytes(b"other_side"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    // Token must not re-enter candidates.
    assert!(
        !fuzzer
            .token_tracker
            .candidates
            .contains_key(b"promote_me".as_slice()),
        "promoted token should not re-enter token_candidates"
    );

    // Token must still be in the promoted set.
    assert!(
        fuzzer
            .token_tracker
            .promoted
            .contains(b"promote_me".as_slice()),
        "promoted token should remain in promoted_tokens"
    );

    // Dictionary should not have grown (no duplicate promotion).
    let dict_len_after = fuzzer.state.metadata::<Tokens>().unwrap().tokens().len();
    assert_eq!(
        dict_len_before, dict_len_after,
        "dictionary should not grow from re-observed promoted tokens"
    );

    cmplog::disable();
}
