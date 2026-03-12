use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::cmplog;
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId};
use libafl::feedbacks::MapNoveltiesMetadata;
use libafl::observers::cmp::CmpValues;
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_novelty_indices_recorded_for_interesting_input() {
    // When an input triggers new coverage, MapNoveltiesMetadata should be
    // stored on the testcase containing exactly the newly-maximized indices.
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    let _input = fuzzer.get_next_input().unwrap();

    // Write novel coverage at indices 42 and 100.
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
        *fuzzer.map_ptr.add(100) = 3;
    }

    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    let corpus_id = fuzzer
        .calibration
        .corpus_id
        .expect("should have calibration corpus_id");
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    let novelties = tc
        .metadata::<MapNoveltiesMetadata>()
        .expect("interesting input should have MapNoveltiesMetadata");
    let mut indices = novelties.list.clone();
    indices.sort();
    assert_eq!(
        indices,
        vec![42, 100],
        "novelty metadata should contain exactly the newly-maximized indices"
    );
}

#[test]
fn test_novelty_only_newly_maximized_not_all_covered() {
    // When input covers indices that already have equal-or-higher history values,
    // only the truly-novel (newly maximized) indices should be in MapNoveltiesMetadata.
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // First iteration: establish coverage at indices 10 and 20.
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
        *fuzzer.map_ptr.add(20) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));
    fuzzer.calibrate_finish().unwrap();

    // Second iteration: cover indices 10, 20 (same), plus new index 30.
    // Also: index 20 now has value 5 (higher than history's 1) → novel.
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 1; // same as history, NOT novel
        *fuzzer.map_ptr.add(20) = 5; // higher than history (1), IS novel
        *fuzzer.map_ptr.add(30) = 1; // new index, IS novel
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    let corpus_id = fuzzer
        .calibration
        .corpus_id
        .expect("should have calibration corpus_id");
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    let novelties = tc
        .metadata::<MapNoveltiesMetadata>()
        .expect("should have MapNoveltiesMetadata");
    let mut indices = novelties.list.clone();
    indices.sort();
    // Index 10 is NOT novel (same as history), indices 20 and 30 ARE novel.
    assert_eq!(
        indices,
        vec![20, 30],
        "only newly-maximized indices should be in novelties, not all covered"
    );
}

#[test]
fn test_novelty_metadata_stored_during_stage_execution() {
    // When a stage execution (e.g., I2S) triggers new coverage and the input
    // is added to the corpus, it should also have MapNoveltiesMetadata.
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Trigger an interesting input so we can start a stage.
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    cmplog::push(
        CmpValues::Bytes((make_cmplog_bytes(b"seed"), make_cmplog_bytes(b"test"))),
        0,
        cmplog::CmpLogOperator::Equal,
    );
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));
    fuzzer.calibrate_finish().unwrap();

    // Begin stage.
    let stage_input = fuzzer.begin_stage().unwrap();
    assert!(stage_input.is_some(), "stage should start");

    // Write novel coverage at a new index during stage execution.
    unsafe {
        *fuzzer.map_ptr.add(50) = 1;
    }

    let corpus_count_before = fuzzer.state.corpus().count();
    let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // The stage execution should have found new coverage and added a corpus entry.
    let corpus_count_after = fuzzer.state.corpus().count();
    assert!(
        corpus_count_after > corpus_count_before,
        "stage should have added a new corpus entry"
    );

    // Find the new entry (the last one added).
    let new_id = CorpusId::from(corpus_count_after - 1);
    let tc = fuzzer.state.corpus().get(new_id).unwrap().borrow();
    assert!(
        tc.metadata::<MapNoveltiesMetadata>().is_ok(),
        "stage-found corpus entry should have MapNoveltiesMetadata"
    );

    cmplog::disable();
}

#[test]
fn test_no_novelty_metadata_for_non_interesting_input() {
    // Non-interesting inputs are not added to corpus, so no metadata stored.
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    let _input = fuzzer.get_next_input().unwrap();
    // No novel coverage written to the map.
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::None));
    // Corpus should be empty - seeds are not in corpus until they produce
    // novel coverage, and this input had none.
    assert_eq!(
        fuzzer.state.corpus().count(),
        0,
        "no corpus entry should be added for non-interesting input"
    );
}
