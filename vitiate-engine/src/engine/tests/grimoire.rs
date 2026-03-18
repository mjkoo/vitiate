use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::{Fuzzer, StageState};
use crate::types::{ExitKind, FuzzerConfig};
use libafl::HasMetadata;
use libafl::corpus::{Corpus, Testcase};
use libafl::inputs::{BytesInput, GeneralizedInputMetadata};
use libafl::observers::cmp::CmpValues;
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;

// -----------------------------------------------------------------------
// Grimoire mutational stage tests
#[test]
fn test_grimoire_stage_begins_with_metadata() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(
        first.is_some(),
        "begin_grimoire should return Some when metadata exists"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Grimoire { .. }),
        "stage should be Grimoire"
    );

    cmplog::force_disable();
}

#[test]
fn test_grimoire_stage_skipped_without_metadata() {
    cmplog::force_disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).grimoire(true).build();
    fuzzer.features.deferred_detection_count = None;

    // Add a corpus entry WITHOUT GeneralizedInputMetadata.
    let testcase = Testcase::new(BytesInput::new(b"test".to_vec()));
    let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();

    let result = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "begin_grimoire should return None without metadata"
    );

    cmplog::force_disable();
}

#[test]
fn test_grimoire_stage_skipped_when_disabled() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");
    fuzzer.features.grimoire_enabled = false;

    let result = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "begin_grimoire should return None when Grimoire disabled"
    );

    cmplog::force_disable();
}

#[test]
fn test_grimoire_stage_completes_after_iterations() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(first.is_some());

    // Force max_iterations to 3 for deterministic testing.
    if let StageState::Grimoire {
        corpus_id,
        iteration,
        ..
    } = fuzzer.stage_state
    {
        fuzzer.stage_state = StageState::Grimoire {
            corpus_id,
            iteration,
            max_iterations: 3,
        };
    }

    // Advance through 3 iterations.
    let second = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(second.is_some(), "iteration 1 should produce next");

    let third = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(third.is_some(), "iteration 2 should produce next");

    let done = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(done.is_none(), "iteration 3 should complete the stage");
    assert!(matches!(fuzzer.stage_state, StageState::None));

    cmplog::force_disable();
}

#[test]
fn test_grimoire_execution_counting() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let total_before = fuzzer.total_execs;

    let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

    // Force max_iterations to 2.
    if let StageState::Grimoire {
        corpus_id,
        iteration,
        ..
    } = fuzzer.stage_state
    {
        fuzzer.stage_state = StageState::Grimoire {
            corpus_id,
            iteration,
            max_iterations: 2,
        };
    }

    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(fuzzer.total_execs, total_before + 1);

    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(fuzzer.total_execs, total_before + 2);

    cmplog::force_disable();
}

#[test]
fn test_grimoire_cmplog_drained() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

    // Push CmpLog entries simulating target execution.
    cmplog::push(
        CmpValues::Bytes((
            make_cmplog_bytes(b"grimoire_test"),
            make_cmplog_bytes(b"grimoire_data"),
        )),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // CmpLog should be drained.
    let drained = cmplog::drain();
    assert!(
        drained.is_empty(),
        "CmpLog should be drained during Grimoire stage"
    );

    cmplog::force_disable();
}

#[test]
fn test_grimoire_max_input_len_enforced() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");
    fuzzer.max_input_len = 5;

    let first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(first.is_some());

    // The output should be truncated to max_input_len.
    let bytes: Vec<u8> = first.unwrap().to_vec();
    assert!(
        bytes.len() <= 5,
        "output should be truncated to max_input_len"
    );

    cmplog::force_disable();
}

#[test]
fn test_grimoire_non_cumulative_mutations() {
    let input = b"fn foo() {}";
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(input);

    let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

    // Force max_iterations to 5.
    if let StageState::Grimoire {
        corpus_id,
        iteration,
        ..
    } = fuzzer.stage_state
    {
        fuzzer.stage_state = StageState::Grimoire {
            corpus_id,
            iteration,
            max_iterations: 5,
        };
    }

    // Advance through iterations. The corpus entry's metadata should
    // remain unchanged (each iteration clones independently).
    for _ in 0..4 {
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        if next.is_none() {
            break;
        }
        // Verify the corpus entry's metadata is still the original.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
        let original_bytes = meta.generalized_to_bytes();
        assert_eq!(
            original_bytes,
            input.to_vec(),
            "corpus entry metadata should not be modified by mutations"
        );
    }

    cmplog::force_disable();
}

#[test]
fn test_grimoire_abort_transitions_to_none() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let _first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(matches!(fuzzer.stage_state, StageState::Grimoire { .. }));

    let total_before = fuzzer.total_execs;
    fuzzer.abort_stage(ExitKind::Crash).unwrap();

    assert!(matches!(fuzzer.stage_state, StageState::None));
    assert_eq!(
        fuzzer.total_execs,
        total_before + 1,
        "abort should increment total_execs by 1"
    );

    cmplog::force_disable();
}

// -----------------------------------------------------------------------
// Grimoire override through constructor test (#5)
// -----------------------------------------------------------------------

#[test]
fn test_grimoire_override_through_constructor() {
    // When FuzzerConfig.grimoire = Some(true), grimoire_enabled should be true
    // and deferred_detection_count should be None (already resolved).
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: Some(true),
            unicode: None,
            redqueen: None,
            dictionary_path: None,
            detector_tokens: None,
        }),
        None,
        None,
    )
    .unwrap();
    assert!(
        fuzzer.features.grimoire_enabled,
        "grimoire_enabled should be true when config.grimoire = Some(true)"
    );
    // unicode needs auto-detect, so deferred count is still Some.
    assert!(
        fuzzer.features.deferred_detection_count.is_some(),
        "deferred_detection_count should be Some when unicode needs auto-detect"
    );
}

#[test]
fn test_grimoire_override_disabled_through_constructor() {
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: Some(false),
            unicode: None,
            redqueen: None,
            dictionary_path: None,
            detector_tokens: None,
        }),
        None,
        None,
    )
    .unwrap();
    assert!(
        !fuzzer.features.grimoire_enabled,
        "grimoire_enabled should be false when config.grimoire = Some(false)"
    );
    // unicode needs auto-detect, so deferred count is still Some.
    assert!(
        fuzzer.features.deferred_detection_count.is_some(),
        "deferred_detection_count should be Some when unicode needs auto-detect"
    );
}

// -----------------------------------------------------------------------
// Grimoire spec 5.1 tests (#8)
// -----------------------------------------------------------------------

#[test]
fn test_grimoire_iteration_advances_regardless_of_mutation_result() {
    // Verify that the iteration counter advances on each advance_stage call,
    // regardless of whether the underlying Grimoire mutator returns Mutated
    // or Skipped.
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(first.is_some(), "grimoire should start");

    // The first Grimoire candidate was already generated by begin_grimoire.
    // Advance the stage - regardless of whether the mutator skips or not,
    // the iteration should progress.
    let iteration_before = match fuzzer.stage_state {
        StageState::Grimoire { iteration, .. } => iteration,
        _ => panic!("should be in Grimoire state"),
    };

    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    // The stage may return None if max_iterations was 1, or Some if there are
    // more iterations. Either way, the iteration counter should have advanced.
    match fuzzer.stage_state {
        StageState::Grimoire { iteration, .. } => {
            assert_eq!(
                iteration,
                iteration_before + 1,
                "iteration should advance even if mutation was skipped"
            );
        }
        StageState::None => {
            // Stage completed (max_iterations was 1) - that's fine, iteration
            // counter was consumed. Verify next is None.
            assert!(next.is_none(), "stage should be done");
        }
        _ => panic!("unexpected stage state"),
    }

    cmplog::force_disable();
}
