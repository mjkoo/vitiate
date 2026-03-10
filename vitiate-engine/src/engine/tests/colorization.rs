#![allow(clippy::single_range_in_vec_init)]

use std::ops::Range;

use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::engine::StageState;
use crate::engine::colorization::{coverage_hash, merge_ranges, type_replace};
use libafl::HasMetadata;
use libafl::corpus::Corpus;
use libafl::observers::cmp::{AflppCmpValuesMetadata, CmpValues};
use libafl::stages::colorization::TaintMetadata;
use libafl::state::HasCorpus;
use libafl_bolts::rands::StdRand;

#[test]
fn test_type_replace_null_byte() {
    let input = [0x00];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], 0x01);
}

#[test]
fn test_type_replace_one_byte() {
    let input = [0x01];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], 0x00);
}

#[test]
fn test_type_replace_ff_byte() {
    let input = [0xff];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], 0x00);
}

#[test]
fn test_type_replace_digit_zero_one_swap() {
    let input = [b'0', b'1'];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], b'1');
    assert_eq!(output[1], b'0');
}

#[test]
fn test_type_replace_digit_stays_digit() {
    let input = [b'5'];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert!(output[0].is_ascii_digit());
    assert_ne!(output[0], b'5');
}

#[test]
fn test_type_replace_hex_uppercase_stays_hex() {
    let input = [b'A'];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert!((b'A'..=b'F').contains(&output[0]));
    assert_ne!(output[0], b'A');
}

#[test]
fn test_type_replace_hex_lowercase_stays_hex() {
    let input = [b'a'];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert!((b'a'..=b'f').contains(&output[0]));
    assert_ne!(output[0], b'a');
}

#[test]
fn test_type_replace_whitespace_swaps() {
    let input = [0x20, 0x09, 0x0d, 0x0a];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], 0x09); // space → tab
    assert_eq!(output[1], 0x20); // tab → space
    assert_eq!(output[2], 0x0a); // CR → LF
    assert_eq!(output[3], 0x0d); // LF → CR
}

#[test]
fn test_type_replace_plus_slash_swap() {
    let input = [b'+', b'/'];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], b'/');
    assert_eq!(output[1], b'+');
}

#[test]
fn test_type_replace_xor_fallback() {
    let input = [0x80];
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], 0x80 ^ 0x7f);
}

#[test]
fn test_type_replace_low_byte_xor() {
    let input = [0x05]; // < 0x20, not a special case
    let output = type_replace(&input, &mut StdRand::with_seed(42));
    assert_eq!(output[0], 0x05 ^ 0x1f);
}

#[test]
fn test_type_replace_every_byte_differs() {
    let mut rand = StdRand::with_seed(42);
    for byte_val in 0u8..=255 {
        let input = [byte_val];
        let output = type_replace(&input, &mut rand);
        assert_ne!(
            output[0], byte_val,
            "type_replace failed to change byte 0x{byte_val:02x}"
        );
    }
}

#[test]
fn test_coverage_hash_same_pattern() {
    let mut map1 = vec![0u8; 100];
    let mut map2 = vec![0u8; 100];
    map1[5] = 1;
    map1[10] = 3;
    map2[5] = 7; // Different hit count
    map2[10] = 42; // Different hit count
    assert_eq!(coverage_hash(&map1), coverage_hash(&map2));
}

#[test]
fn test_coverage_hash_different_patterns() {
    let mut map1 = vec![0u8; 100];
    let mut map2 = vec![0u8; 100];
    map1[5] = 1;
    map2[10] = 1;
    assert_ne!(coverage_hash(&map1), coverage_hash(&map2));
}

#[test]
fn test_coverage_hash_empty_maps() {
    let map = vec![0u8; 100];
    let hash = coverage_hash(&map);
    assert_eq!(hash, coverage_hash(&map));
}

#[test]
fn test_merge_ranges_adjacent() {
    let ranges = vec![5..10, 10..15];
    let merged = merge_ranges(ranges);
    assert_eq!(merged, vec![5..15]);
}

#[test]
fn test_merge_ranges_overlapping() {
    let ranges = vec![5..12, 10..15];
    let merged = merge_ranges(ranges);
    assert_eq!(merged, vec![5..15]);
}

#[test]
fn test_merge_ranges_non_adjacent() {
    let ranges = vec![5..10, 15..20];
    let merged = merge_ranges(ranges);
    assert_eq!(merged, vec![5..10, 15..20]);
}

#[test]
fn test_merge_ranges_empty() {
    let ranges: Vec<Range<usize>> = vec![];
    let merged = merge_ranges(ranges);
    assert!(merged.is_empty());
}

#[test]
fn test_merge_ranges_single() {
    let ranges = vec![5..10];
    let merged = merge_ranges(ranges);
    assert_eq!(merged, vec![5..10]);
}

#[test]
fn test_merge_ranges_unsorted() {
    let ranges = vec![15..20, 5..10, 10..15];
    let merged = merge_ranges(ranges);
    assert_eq!(merged, vec![5..20]);
}

// --- REDQUEEN tests ---

#[test]
fn test_begin_redqueen_skips_without_taint_metadata() {
    let mut fuzzer = TestFuzzerBuilder::new(64).build_ready_for_stage();

    // Add a corpus entry.
    let input = libafl::inputs::BytesInput::new(vec![1, 2, 3, 4]);
    let mut testcase = libafl::corpus::Testcase::new(input);
    testcase.set_exec_time(std::time::Duration::from_millis(1));
    let corpus_id = fuzzer
        .state
        .corpus_mut()
        .add(testcase)
        .expect("add testcase");

    // Add AflppCmpValuesMetadata with some data but NO TaintMetadata.
    let mut cmp_meta = AflppCmpValuesMetadata::new();
    cmp_meta.orig_cmpvals.insert(
        0,
        vec![CmpValues::Bytes((
            make_cmplog_bytes(&[1; 4]),
            make_cmplog_bytes(&[2; 4]),
        ))],
    );
    fuzzer.state.metadata_map_mut().insert(cmp_meta);

    // begin_redqueen should skip (no TaintMetadata) and return None.
    let result = fuzzer.begin_redqueen(corpus_id).expect("no error");
    assert!(result.is_none(), "should skip without TaintMetadata");
    assert!(
        matches!(fuzzer.stage_state, StageState::None),
        "stage should be None"
    );
}

#[test]
fn test_begin_redqueen_skips_without_cmp_metadata() {
    let mut fuzzer = TestFuzzerBuilder::new(64).build_ready_for_stage();

    // Add a corpus entry.
    let input = libafl::inputs::BytesInput::new(vec![1, 2, 3, 4]);
    let mut testcase = libafl::corpus::Testcase::new(input);
    testcase.set_exec_time(std::time::Duration::from_millis(1));
    let corpus_id = fuzzer
        .state
        .corpus_mut()
        .add(testcase)
        .expect("add testcase");

    // Add TaintMetadata but no AflppCmpValuesMetadata.
    let taint = TaintMetadata::new(vec![1, 2, 3, 4], vec![0..4]);
    fuzzer.state.metadata_map_mut().insert(taint);

    // begin_redqueen should skip (no AflppCmpValuesMetadata) and return None.
    let result = fuzzer.begin_redqueen(corpus_id).expect("no error");
    assert!(result.is_none(), "should skip without CmpValuesMetadata");
}

#[test]
fn test_begin_redqueen_skips_with_empty_orig_cmpvals() {
    let mut fuzzer = TestFuzzerBuilder::new(64).build_ready_for_stage();

    // Add a corpus entry.
    let input = libafl::inputs::BytesInput::new(vec![1, 2, 3, 4]);
    let mut testcase = libafl::corpus::Testcase::new(input);
    testcase.set_exec_time(std::time::Duration::from_millis(1));
    let corpus_id = fuzzer
        .state
        .corpus_mut()
        .add(testcase)
        .expect("add testcase");

    // Add empty AflppCmpValuesMetadata and TaintMetadata.
    let cmp_meta = AflppCmpValuesMetadata::new();
    fuzzer.state.metadata_map_mut().insert(cmp_meta);
    let taint = TaintMetadata::new(vec![1, 2, 3, 4], vec![0..4]);
    fuzzer.state.metadata_map_mut().insert(taint);

    // begin_redqueen should skip (empty orig_cmpvals) and return None.
    let result = fuzzer.begin_redqueen(corpus_id).expect("no error");
    assert!(result.is_none(), "should skip with empty orig_cmpvals");
}

#[test]
fn test_begin_redqueen_sets_corpus_id() {
    use libafl::corpus::HasCurrentCorpusId;

    let mut fuzzer = TestFuzzerBuilder::new(64).build_ready_for_stage();

    // Add a corpus entry with data that can produce comparison matches.
    let input = libafl::inputs::BytesInput::new(vec![0x41, 0x42, 0x43, 0x44]);
    let mut testcase = libafl::corpus::Testcase::new(input);
    testcase.set_exec_time(std::time::Duration::from_millis(1));
    let corpus_id = fuzzer
        .state
        .corpus_mut()
        .add(testcase)
        .expect("add testcase");

    // Add both metadata types.
    let mut cmp_meta = AflppCmpValuesMetadata::new();
    cmp_meta.orig_cmpvals.insert(
        0,
        vec![CmpValues::Bytes((
            make_cmplog_bytes(&[0x41; 4]),
            make_cmplog_bytes(&[0x42; 4]),
        ))],
    );
    fuzzer.state.metadata_map_mut().insert(cmp_meta);
    let taint = TaintMetadata::new(vec![0x41, 0x42, 0x43, 0x44], vec![0..4]);
    fuzzer.state.metadata_map_mut().insert(taint);

    // Call begin_redqueen — multi_mutate may return empty candidates for this
    // simple input, but the corpus ID should be set.
    let _result = fuzzer.begin_redqueen(corpus_id);

    // The corpus ID should have been set on the state.
    let current_id = fuzzer
        .state
        .current_corpus_id()
        .expect("should not error")
        .expect("corpus_id should be Some");
    assert_eq!(
        current_id, corpus_id,
        "corpus_id on state should match the one we set"
    );
}

// NOTE: A full integration test exercising the complete pipeline
// (begin_colorization → advance_colorization → dual trace →
// begin_redqueen → advance_redqueen) is intentionally absent here.
// The setup requires a fully wired Fuzzer with coverage map, CmpLog
// observer, and multi-step async iteration — complexity that belongs
// in the end-to-end fuzz-pipeline.test.ts rather than unit tests.
