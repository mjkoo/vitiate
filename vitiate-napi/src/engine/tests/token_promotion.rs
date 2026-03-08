use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::token_tracker::{
    MAX_DICTIONARY_SIZE, MAX_TOKEN_CANDIDATES, TOKEN_PROMOTION_THRESHOLD,
};
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

#[test]
fn user_provided_tokens_present_in_state_with_cmplog_promotion() {
    cmplog::disable();
    cmplog::drain();

    // Create a fuzzer with a user-provided dictionary.
    let dir = tempfile::tempdir().unwrap();
    let dict_path = dir.path().join("test.dict");
    std::fs::write(&dict_path, "\"user_token_a\"\n\"user_token_b\"\n").unwrap();

    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = crate::types::FuzzerConfig {
        max_input_len: None,
        seed: Some(42),
        grimoire: None,
        unicode: None,
        redqueen: None,
        dictionary_path: Some(dict_path.to_str().unwrap().to_string()),
        detector_tokens: None,
    };
    let mut fuzzer = crate::engine::Fuzzer::new(coverage_map, Some(config)).unwrap();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // User tokens should already be present.
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(token_list.contains(&b"user_token_a".as_slice()));
    assert!(token_list.contains(&b"user_token_b".as_slice()));

    // Now promote a CmpLog token.
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(b"cmplog_tok"),
                make_cmplog_bytes(b"other"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    // User tokens and at least one CmpLog token should be present.
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(token_list.contains(&b"user_token_a".as_slice()));
    assert!(token_list.contains(&b"user_token_b".as_slice()));
    assert!(token_list.contains(&b"cmplog_tok".as_slice()));

    cmplog::disable();
}

#[test]
fn user_tokens_do_not_count_toward_cmplog_cap() {
    cmplog::disable();
    cmplog::drain();

    // Create a dictionary with MAX_DICTIONARY_SIZE + 100 user tokens.
    let dir = tempfile::tempdir().unwrap();
    let dict_path = dir.path().join("big.dict");
    let mut dict_content = String::new();
    for i in 0..(MAX_DICTIONARY_SIZE + 100) {
        dict_content.push_str(&format!("\"user_{i:06}\"\n"));
    }
    std::fs::write(&dict_path, &dict_content).unwrap();

    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = crate::types::FuzzerConfig {
        max_input_len: None,
        seed: Some(42),
        grimoire: None,
        unicode: None,
        redqueen: None,
        dictionary_path: Some(dict_path.to_str().unwrap().to_string()),
        detector_tokens: None,
    };
    let mut fuzzer = crate::engine::Fuzzer::new(coverage_map, Some(config)).unwrap();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // User tokens exceed MAX_DICTIONARY_SIZE — they should all be present.
    let user_token_count = fuzzer.state.metadata::<Tokens>().unwrap().tokens().len();
    assert_eq!(user_token_count, MAX_DICTIONARY_SIZE + 100);

    // CmpLog promotion should still work (promoted set is empty).
    assert_eq!(fuzzer.token_tracker.promoted.len(), 0);
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(b"cmplog_new"),
                make_cmplog_bytes(b"other_new"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    // The CmpLog token should have been promoted despite user tokens exceeding cap.
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(
        token_list.contains(&b"cmplog_new".as_slice()),
        "CmpLog token should be promoted even when user tokens exceed MAX_DICTIONARY_SIZE"
    );

    cmplog::disable();
}

#[test]
fn detector_tokens_inserted_and_exempt_from_cap() {
    cmplog::disable();
    cmplog::drain();

    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = crate::types::FuzzerConfig {
        max_input_len: None,
        seed: Some(42),
        grimoire: None,
        unicode: None,
        redqueen: None,
        dictionary_path: None,
        detector_tokens: Some(vec![
            Buffer::from(b"__proto__".to_vec()),
            Buffer::from(b"constructor".to_vec()),
            Buffer::from(b"../".to_vec()),
        ]),
    };
    let mut fuzzer = crate::engine::Fuzzer::new(coverage_map, Some(config)).unwrap();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Detector tokens should be in Tokens metadata.
    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(token_list.contains(&b"__proto__".as_slice()));
    assert!(token_list.contains(&b"constructor".as_slice()));
    assert!(token_list.contains(&b"../".as_slice()));

    // Detector tokens should be pre-promoted (won't be re-discovered by CmpLog).
    assert!(
        fuzzer
            .token_tracker
            .promoted
            .contains(b"__proto__".as_slice())
    );
    assert!(
        fuzzer
            .token_tracker
            .promoted
            .contains(b"constructor".as_slice())
    );
    assert!(fuzzer.token_tracker.promoted.contains(b"../".as_slice()));
    assert_eq!(fuzzer.token_tracker.pre_seeded_count, 3);

    // CmpLog promotion should still work — detector tokens don't count toward cap.
    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(b"cmplog_val"),
                make_cmplog_bytes(b"other_val"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(
        token_list.contains(&b"cmplog_val".as_slice()),
        "CmpLog token should be promoted despite detector tokens in promoted set"
    );

    cmplog::disable();
}

#[test]
fn duplicate_detector_tokens_do_not_cause_underflow() {
    cmplog::disable();
    cmplog::drain();

    // Pass duplicate detector tokens — HashSet deduplicates but pre_seeded_count
    // would be the Vec length. With saturating_sub this must not panic or
    // permanently disable CmpLog promotion.
    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = crate::types::FuzzerConfig {
        max_input_len: None,
        seed: Some(42),
        grimoire: None,
        unicode: None,
        redqueen: None,
        dictionary_path: None,
        detector_tokens: Some(vec![
            Buffer::from(b"../".to_vec()),
            Buffer::from(b"../".to_vec()),
            Buffer::from(b"../".to_vec()),
        ]),
    };
    let mut fuzzer = crate::engine::Fuzzer::new(coverage_map, Some(config)).unwrap();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // promoted has 1 entry (deduplicated), pre_seeded_count is 3.
    // saturating_sub(3) from 1 = 0, so CmpLog promotion should still work.
    assert_eq!(fuzzer.token_tracker.promoted.len(), 1);
    assert_eq!(fuzzer.token_tracker.pre_seeded_count, 3);

    for _ in 0..TOKEN_PROMOTION_THRESHOLD {
        let _input = fuzzer.get_next_input().unwrap();
        cmplog::push(
            CmpValues::Bytes((make_cmplog_bytes(b"after_dup"), make_cmplog_bytes(b"other"))),
            0,
            cmplog::CmpLogOperator::Equal,
        );
        fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    }

    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(
        token_list.contains(&b"after_dup".as_slice()),
        "CmpLog promotion should work even with duplicate detector tokens"
    );

    cmplog::disable();
}
