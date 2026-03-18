use libafl::HasMetadata;
use libafl::mutators::Tokens;
use napi::bindgen_prelude::Buffer;
use std::io::Write;

use crate::cmplog;
use crate::engine::Fuzzer;
use crate::types::FuzzerConfig;

fn make_config_with_dict(dict_path: &str) -> FuzzerConfig {
    FuzzerConfig {
        max_input_len: None,
        seed: Some(42),
        grimoire: None,
        unicode: None,
        redqueen: None,
        dictionary_path: Some(dict_path.to_string()),
        detector_tokens: None,
    }
}

#[test]
fn valid_dictionary_loads_tokens_into_state() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let dir = tempfile::tempdir().unwrap();
    let dict_path = dir.path().join("test.dict");
    let mut file = std::fs::File::create(&dict_path).unwrap();
    writeln!(file, "# comment").unwrap();
    writeln!(file, "keyword_true=\"true\"").unwrap();
    writeln!(file, "keyword_false=\"false\"").unwrap();
    writeln!(file, "\"hello\"").unwrap();
    drop(file);

    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = make_config_with_dict(dict_path.to_str().unwrap());
    let fuzzer = Fuzzer::new(coverage_map, Some(config), None, None).unwrap();

    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
    assert!(
        token_list.contains(&b"true".as_slice()),
        "should contain 'true'"
    );
    assert!(
        token_list.contains(&b"false".as_slice()),
        "should contain 'false'"
    );
    assert!(
        token_list.contains(&b"hello".as_slice()),
        "should contain 'hello'"
    );
    assert_eq!(token_list.len(), 3);
}

#[test]
fn nonexistent_dictionary_returns_error() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = make_config_with_dict("/nonexistent/path/to/dict.dict");
    let result = Fuzzer::new(coverage_map, Some(config), None, None);

    let err = result
        .err()
        .expect("should return an error for nonexistent dictionary");
    let err_msg = err.to_string();
    assert!(
        err_msg.contains("/nonexistent/path/to/dict.dict"),
        "error should include file path, got: {err_msg}"
    );
}

#[test]
fn malformed_dictionary_returns_error() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let dir = tempfile::tempdir().unwrap();
    let dict_path = dir.path().join("bad.dict");
    std::fs::write(&dict_path, "not a valid line\n").unwrap();

    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = make_config_with_dict(dict_path.to_str().unwrap());
    let result = Fuzzer::new(coverage_map, Some(config), None, None);

    let err = result
        .err()
        .expect("should return an error for malformed dictionary");
    let err_msg = err.to_string();
    assert!(
        err_msg.contains(dict_path.to_str().unwrap()),
        "error should include file path, got: {err_msg}"
    );
}

#[test]
fn empty_dictionary_succeeds_with_no_tokens() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let dir = tempfile::tempdir().unwrap();
    let dict_path = dir.path().join("empty.dict");
    std::fs::write(&dict_path, "# only a comment\n\n").unwrap();

    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = make_config_with_dict(dict_path.to_str().unwrap());
    let fuzzer = Fuzzer::new(coverage_map, Some(config), None, None).unwrap();

    let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
    assert_eq!(
        tokens.tokens().len(),
        0,
        "empty dictionary should produce zero tokens"
    );
}

#[test]
fn no_dictionary_path_does_not_add_tokens_metadata() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let coverage_map: Buffer = vec![0u8; 256].into();
    let config = FuzzerConfig {
        max_input_len: None,
        seed: Some(42),
        grimoire: None,
        unicode: None,
        redqueen: None,
        dictionary_path: None,
        detector_tokens: None,
    };
    let fuzzer = Fuzzer::new(coverage_map, Some(config), None, None).unwrap();

    assert!(
        !fuzzer.state.has_metadata::<Tokens>(),
        "Tokens metadata should not be present when no dictionary is provided"
    );
}
