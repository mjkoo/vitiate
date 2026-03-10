use super::helpers::{TestFuzzerBuilder, force_single_iteration, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::StageState;
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::Corpus;
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
use libafl::state::{HasCorpus, HasExecutions};
use napi::bindgen_prelude::Buffer;

#[test]
fn test_begin_stage_returns_null_during_active_stage() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    // First beginStage should return Some (stage starts).
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some(), "beginStage should return Some initially");
    assert!(
        matches!(fuzzer.stage_state, StageState::I2S { .. }),
        "stage should be I2S"
    );

    // Second beginStage during active stage should return None.
    let second = fuzzer.begin_stage().unwrap();
    assert!(
        second.is_none(),
        "beginStage should return None during active stage"
    );

    // Active stage should not be disrupted.
    assert!(
        matches!(fuzzer.stage_state, StageState::I2S { .. }),
        "stage should still be I2S"
    );

    cmplog::disable();
}

#[test]
fn test_advance_stage_returns_null_with_no_active_stage() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // advanceStage with no active stage should return None.
    let total_before = fuzzer.total_execs;
    let result = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        result.is_none(),
        "advanceStage should return None without active stage"
    );
    // Verify no side effects (total_execs unchanged).
    assert_eq!(fuzzer.total_execs, total_before);

    cmplog::disable();
}

#[test]
fn test_single_iteration_stage_completes_immediately() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add a seed.
    fuzzer
        .add_seed(Buffer::from(b"seed_data".to_vec()))
        .unwrap();

    // Simulate getNextInput.
    let _ = fuzzer.get_next_input().unwrap();

    // Write novel coverage.
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
    }

    // Push CmpLog data.
    cmplog::push(
        CmpValues::Bytes((make_cmplog_bytes(b"test"), make_cmplog_bytes(b"data"))),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    // Calibrate.
    for _ in 0..3 {
        unsafe {
            *fuzzer.map_ptr.add(42) = 1;
        }
        let needs_more = fuzzer.calibrate_run(50_000.0).unwrap();
        if !needs_more {
            break;
        }
    }
    fuzzer.calibrate_finish().unwrap();

    // Force max_iterations = 1 by setting a specific seed on the RNG.
    // We can't easily control the RNG to get exactly 1, so instead we'll
    // manually set the stage state after beginStage.
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());

    // Override max_iterations to 1 to test single-iteration behavior.
    force_single_iteration(&mut fuzzer);

    // First advanceStage should return None (stage complete after one iteration).
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        next.is_none(),
        "advanceStage should return None for single-iteration stage"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::None),
        "stage should be None after completion"
    );

    cmplog::disable();
}

#[test]
fn test_cmplog_drained_and_discarded_during_stage() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    // Record original CmpValuesMetadata.
    let original_cmp_count = fuzzer
        .state
        .metadata_map()
        .get::<CmpValuesMetadata>()
        .map(|m| m.list.len())
        .unwrap_or(0);
    assert!(
        original_cmp_count > 0,
        "should have CmpLog data from report_result"
    );

    // Begin stage.
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());

    // Simulate a stage execution that produces CmpLog entries.
    cmplog::push(
        CmpValues::Bytes((
            make_cmplog_bytes(b"stage_operand_1"),
            make_cmplog_bytes(b"stage_operand_2"),
        )),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    // advanceStage should drain and discard these CmpLog entries.
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // Verify CmpValuesMetadata was NOT overwritten by stage CmpLog data.
    let cmp_meta = fuzzer
        .state
        .metadata_map()
        .get::<CmpValuesMetadata>()
        .expect("CmpValuesMetadata should exist");
    assert_eq!(
        cmp_meta.list.len(),
        original_cmp_count,
        "CmpValuesMetadata should not be overwritten by stage CmpLog data"
    );

    // Verify token promotion did not occur for stage CmpLog entries.
    assert!(
        !fuzzer
            .token_tracker
            .candidates
            .contains_key(b"stage_operand_1".as_slice()),
        "stage CmpLog operands should not enter token_candidates"
    );

    cmplog::disable();
}

#[test]
fn test_non_cumulative_mutations() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    // Get the original corpus entry bytes for comparison.
    let stage_corpus_id = fuzzer.last_interesting_corpus_id.unwrap();
    let original_bytes: Vec<u8> = fuzzer
        .state
        .corpus()
        .cloned_input_for_id(stage_corpus_id)
        .unwrap()
        .into();

    // Begin stage.
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());

    // Get the corpus_id from the stage state.
    let i2s_corpus_id = match fuzzer.stage_state {
        StageState::I2S { corpus_id, .. } => corpus_id,
        _ => panic!("expected I2S stage"),
    };

    // Advance through multiple iterations and verify each starts from the
    // original corpus entry (not the previous mutation).
    for _ in 0..3 {
        // The next mutation should be based on the original entry.
        // We can verify this indirectly: the corpus entry bytes should
        // remain unchanged throughout the stage.
        let current_bytes: Vec<u8> = fuzzer
            .state
            .corpus()
            .cloned_input_for_id(i2s_corpus_id)
            .unwrap()
            .into();
        assert_eq!(
            current_bytes, original_bytes,
            "corpus entry should not be modified by stage mutations"
        );

        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        if next.is_none() {
            break;
        }
    }

    cmplog::disable();
}

#[test]
fn test_abort_stage_noop_with_no_active_stage() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    let total_execs_before = fuzzer.total_execs;
    let state_execs_before = *fuzzer.state.executions();

    // abortStage with no active stage should be a no-op.
    fuzzer.abort_stage(ExitKind::Crash).unwrap();

    assert_eq!(
        fuzzer.total_execs, total_execs_before,
        "total_execs should not change on no-op abort"
    );
    assert_eq!(
        *fuzzer.state.executions(),
        state_execs_before,
        "state.executions should not change on no-op abort"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::None),
        "stage should remain None"
    );

    cmplog::disable();
}
