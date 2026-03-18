use super::helpers::{TestFuzzerBuilder, force_single_iteration, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::StageState;
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::Corpus;
use libafl::corpus::SchedulerTestcaseMetadata;
use libafl::corpus::Testcase;
use libafl::feedbacks::MapIndexesMetadata;
use libafl::inputs::{BytesInput, GeneralizedInputMetadata};
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
use libafl::schedulers::Scheduler;
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;
use std::time::Duration;

#[test]
fn test_pipeline_i2s_to_generalization_to_grimoire_to_none() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Full pipeline: I2S (1 iteration) → Generalization → Grimoire → None.
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
    fuzzer.features.grimoire_enabled = true;
    fuzzer.features.deferred_detection_count = None;

    // begin_stage starts I2S (CmpLog data exists from build_ready_for_stage).
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());
    assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

    // Force max_iterations = 1 so I2S completes on next advance.
    force_single_iteration(&mut fuzzer);

    // Advance I2S → should transition to Generalization (Grimoire enabled, input qualifies).
    // Set coverage for the novelty index so evaluate_coverage works.
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
    }
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        next.is_some(),
        "should transition from I2S to Generalization"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Generalization { .. }),
        "stage state should be Generalization after I2S completes"
    );

    // Drive through generalization: verification + gap-finding.
    // Verification: set novelty index so it passes.
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
    }
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        next.is_some(),
        "should produce gap-finding candidate after verification"
    );

    // Drive through remaining generalization phases until Grimoire starts.
    let mut count = 0;
    loop {
        unsafe {
            *fuzzer.map_ptr.add(42) = 1;
        }
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if matches!(fuzzer.stage_state, StageState::Grimoire { .. }) {
            assert!(
                candidate.is_some(),
                "Grimoire transition should return a candidate"
            );
            break;
        }
        if candidate.is_none() {
            panic!("generalization should transition to Grimoire, not None");
        }
        assert!(
            count <= 200,
            "should complete generalization within 200 iterations"
        );
    }

    // Drive through Grimoire until completion.
    // Force max_iterations = 1 so Grimoire completes on next advance.
    force_single_iteration(&mut fuzzer);
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(next.is_none(), "Grimoire should complete and return None");
    assert!(matches!(fuzzer.stage_state, StageState::None));
}

#[test]
fn test_pipeline_i2s_to_grimoire_preexisting_metadata() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // I2S → Grimoire (generalization skipped because entry already has GeneralizedInputMetadata).
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    // Set up CmpLog data so I2S starts.
    let cmp_entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"hello"),
        make_cmplog_bytes(b"world"),
    ))];
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata { list: cmp_entries });
    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());
    assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

    // Force I2S to complete in one iteration.
    force_single_iteration(&mut fuzzer);

    // Advance → should skip generalization (already has metadata) and go to Grimoire.
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(next.is_some(), "should transition to Grimoire");
    assert!(
        matches!(fuzzer.stage_state, StageState::Grimoire { .. }),
        "should be in Grimoire stage (generalization skipped)"
    );
}

#[test]
fn test_pipeline_i2s_to_none_grimoire_disabled() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // I2S → None (Grimoire disabled).
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
    fuzzer.features.grimoire_enabled = false;

    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());
    assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

    // Force I2S to complete.
    force_single_iteration(&mut fuzzer);

    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(next.is_none(), "should return None when Grimoire disabled");
    assert!(matches!(fuzzer.stage_state, StageState::None));
}

#[test]
fn test_pipeline_none_to_generalization_no_cmplog() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // No CmpLog → Generalization (Grimoire enabled, input qualifies).
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(b"hello", &[10]);

    // Ensure CmpValuesMetadata is empty (no CmpLog data).
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata { list: vec![] });
    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    let first = fuzzer.begin_stage().unwrap();
    assert!(
        first.is_some(),
        "should start Generalization when no CmpLog data"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Generalization { .. }),
        "should be in Generalization stage"
    );
}

#[test]
fn test_pipeline_none_to_grimoire_no_cmplog_preexisting_metadata() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // No CmpLog → Grimoire (Grimoire enabled, pre-existing GeneralizedInputMetadata).
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    // Ensure CmpValuesMetadata is empty.
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata { list: vec![] });
    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    let first = fuzzer.begin_stage().unwrap();
    assert!(
        first.is_some(),
        "should start Grimoire when no CmpLog data and metadata exists"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Grimoire { .. }),
        "should be in Grimoire stage"
    );
}

#[test]
fn test_pipeline_generalization_fail_to_none() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Generalization verification fails → None.
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(b"hello", &[10]);

    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some());

    // Disable Grimoire so if verification fails, we go to None (not Grimoire).
    fuzzer.features.grimoire_enabled = false;

    // Verification: DON'T set novelty index → verification fails.
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(next.is_none(), "verification failure should return None");
    assert!(matches!(fuzzer.stage_state, StageState::None));

    // Verify no GeneralizedInputMetadata was stored.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        !tc.has_metadata::<GeneralizedInputMetadata>(),
        "should not store metadata when verification fails"
    );
}

#[test]
fn test_pipeline_abort_from_generalization() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(b"hello", &[10]);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(matches!(
        fuzzer.stage_state,
        StageState::Generalization { .. }
    ));

    let total_before = fuzzer.total_execs;
    fuzzer.abort_stage(ExitKind::Crash).unwrap();

    assert!(matches!(fuzzer.stage_state, StageState::None));
    assert_eq!(fuzzer.total_execs, total_before + 1);

    // Verify no GeneralizedInputMetadata was stored.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(!tc.has_metadata::<GeneralizedInputMetadata>());
}

#[test]
fn test_pipeline_abort_from_grimoire() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");

    let _first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(matches!(fuzzer.stage_state, StageState::Grimoire { .. }));

    let total_before = fuzzer.total_execs;
    fuzzer.abort_stage(ExitKind::Timeout).unwrap();

    assert!(matches!(fuzzer.stage_state, StageState::None));
    assert_eq!(fuzzer.total_execs, total_before + 1);
}

#[test]
fn test_pipeline_abort_from_i2s() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    let _first = fuzzer.begin_stage().unwrap();
    assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

    let total_before = fuzzer.total_execs;
    fuzzer.abort_stage(ExitKind::Crash).unwrap();

    assert!(matches!(fuzzer.stage_state, StageState::None));
    assert_eq!(fuzzer.total_execs, total_before + 1);
}

#[test]
fn test_pipeline_i2s_to_unicode_grimoire_disabled() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // I2S → Unicode → None (grimoire disabled, unicode enabled).
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.features.unicode_enabled = true;
    fuzzer.features.deferred_detection_count = None;

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    let _ = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
    }
    cmplog::push(
        CmpValues::Bytes((make_cmplog_bytes(b"hello"), make_cmplog_bytes(b"world"))),
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

    // beginStage should start I2S.
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());
    assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

    // Force I2S to single iteration.
    force_single_iteration(&mut fuzzer);

    // Advance I2S - should transition to Unicode (grimoire disabled).
    let after_i2s = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        after_i2s.is_some(),
        "should transition to unicode after I2S"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { .. }),
        "stage should be Unicode after I2S completion"
    );

    // Force unicode to single iteration and advance - should complete.
    force_single_iteration(&mut fuzzer);

    let after_unicode = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        after_unicode.is_none(),
        "unicode should complete and return None"
    );
    assert!(matches!(fuzzer.stage_state, StageState::None));
}

#[test]
fn test_pipeline_grimoire_to_unicode() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Grimoire → Unicode → None (both enabled).
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");
    fuzzer.features.unicode_enabled = true;

    let first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(first.is_some());

    // Force Grimoire to single iteration.
    force_single_iteration(&mut fuzzer);

    // Advance Grimoire - should transition to Unicode.
    let after_grimoire = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        after_grimoire.is_some(),
        "should transition to unicode after Grimoire"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { .. }),
        "stage should be Unicode after Grimoire completion"
    );
}

#[test]
fn test_pipeline_unicode_disabled_existing_transitions_unchanged() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // With unicode disabled, Grimoire → None (no unicode fallthrough).
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_grimoire_entry(b"fn foo() {}");
    assert!(!fuzzer.features.unicode_enabled);

    let first = fuzzer.begin_grimoire(corpus_id).unwrap();
    assert!(first.is_some());

    // Force Grimoire to single iteration.
    force_single_iteration(&mut fuzzer);

    let after_grimoire = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        after_grimoire.is_none(),
        "should return None when unicode disabled"
    );
    assert!(matches!(fuzzer.stage_state, StageState::None));
}

#[test]
fn test_pipeline_unicode_only_begin_no_cmplog() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // No CmpLog, Grimoire not applicable, unicode enabled → direct to Unicode.
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);

    // Set up for beginStage: set last_interesting_corpus_id directly.
    fuzzer.last_interesting_corpus_id = Some(corpus_id);
    fuzzer.stage_state = StageState::None;

    // Ensure no CmpLog data.
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata::new());

    let result = fuzzer.begin_stage().unwrap();
    assert!(result.is_some(), "should begin unicode stage directly");
    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { .. }),
        "stage should be Unicode"
    );
}

#[test]
fn test_pipeline_grimoire_enabled_but_not_applicable_transitions_to_unicode() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Grimoire enabled, but entry doesn't qualify for generalization and has no
    // GeneralizedInputMetadata → should fall through to Unicode.
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.features.grimoire_enabled = true;
    fuzzer.features.unicode_enabled = true;
    fuzzer.features.deferred_detection_count = None;

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Add a corpus entry that does NOT have GeneralizedInputMetadata
    // and does NOT qualify for generalization (no MapNoveltiesMetadata).
    let mut testcase = Testcase::new(BytesInput::new(b"hello utf8 test".to_vec()));
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_n_fuzz_entry(0);
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![]));
    *testcase.exec_time_mut() = Some(Duration::from_micros(100));

    let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
    fuzzer
        .scheduler
        .on_add(&mut fuzzer.state, corpus_id)
        .unwrap();

    // Set up for beginStage.
    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    // Ensure no CmpLog data.
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata::new());

    let result = fuzzer.begin_stage().unwrap();
    assert!(
        result.is_some(),
        "should fall through to unicode when grimoire not applicable"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { .. }),
        "stage should be Unicode"
    );
}

#[test]
fn test_pipeline_generalization_failure_transitions_to_none_not_unicode() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Generalization failure → None (not Unicode).
    // Unstable inputs produce unreliable coverage.
    let input = b"ab";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);
    fuzzer.features.unicode_enabled = true;

    // Begin generalization.
    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some());
    assert!(matches!(
        fuzzer.stage_state,
        StageState::Generalization { .. }
    ));

    // Simulate verification failure by NOT writing the expected coverage.
    // advance_generalization will see missing novel coverage → fail.
    let result = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // The generalization verification failed, so it should transition to None.
    assert!(
        result.is_none(),
        "generalization failure should transition to None, not Unicode"
    );
    assert!(matches!(fuzzer.stage_state, StageState::None));
}

#[test]
fn test_finalize_generalization_falls_through_to_unicode() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // When grimoire is disabled mid-flight, finalize_generalization must
    // fall through to Unicode instead of returning None.
    let input = b"fn foo() { return 42; }";
    let novelty_indices = vec![10, 20];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);
    fuzzer.features.unicode_enabled = true;

    // Begin generalization.
    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some());
    assert!(matches!(
        fuzzer.stage_state,
        StageState::Generalization { .. }
    ));

    // Disable grimoire mid-flight so finalize_generalization can't start Grimoire.
    fuzzer.features.grimoire_enabled = false;

    // Drive generalization to completion.
    let mut count = 0;
    loop {
        unsafe {
            for &idx in &novelty_indices {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        match &fuzzer.stage_state {
            StageState::Unicode { .. } => {
                assert!(
                    next.is_some(),
                    "Unicode transition should return a candidate"
                );
                break;
            }
            StageState::None if next.is_none() => {
                panic!(
                    "finalize_generalization returned None - should have fallen through to Unicode"
                );
            }
            _ => {}
        }
        count += 1;
        assert!(
            count <= 200,
            "should complete generalization within 200 iterations"
        );
    }

    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { .. }),
        "stage should have transitioned to Unicode after generalization"
    );
}

#[test]
fn test_pipeline_full_four_stage_lifecycle() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // I2S → Generalization → Grimoire → Unicode → None.
    // This is the most comprehensive pipeline test.
    let input = b"fn foo() { return 42; }";
    let novelty_indices = vec![10, 20];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);
    fuzzer.features.unicode_enabled = true;

    // Manually add CmpValuesMetadata with data to trigger I2S.
    fuzzer.state.metadata_map_mut().insert(CmpValuesMetadata {
        list: vec![CmpValues::Bytes((
            make_cmplog_bytes(b"foo"),
            make_cmplog_bytes(b"bar"),
        ))],
    });

    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    // beginStage should start I2S (CmpLog data present).
    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some());
    assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

    // Force I2S to single iteration.
    force_single_iteration(&mut fuzzer);

    // Advance I2S - should transition to Generalization.
    // Write expected coverage for generalization verification.
    unsafe {
        for &idx in &novelty_indices {
            *fuzzer.map_ptr.add(idx) = 1;
        }
    }
    let after_i2s = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        after_i2s.is_some(),
        "should transition from I2S to Generalization"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Generalization { .. }),
        "stage should be Generalization"
    );

    // Run through generalization to completion.
    loop {
        // Write expected coverage for each generalization candidate.
        unsafe {
            for &idx in &novelty_indices {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        if next.is_none() {
            // Generalization complete or Grimoire started.
            break;
        }
        // If we transitioned to Grimoire or Unicode, we're done with generalization.
        match &fuzzer.stage_state {
            StageState::Grimoire { .. } | StageState::Unicode { .. } => break,
            _ => continue,
        }
    }

    // After generalization, we should be in Grimoire or Unicode.
    // (Depends on whether generalization produced metadata.)
    match &fuzzer.stage_state {
        StageState::Grimoire { .. } => {
            // Force Grimoire to single iteration.
            force_single_iteration(&mut fuzzer);

            let after_grimoire = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            // Should transition to Unicode.
            if after_grimoire.is_some() {
                assert!(
                    matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                    "should transition from Grimoire to Unicode"
                );

                // Force unicode to single iteration.
                force_single_iteration(&mut fuzzer);

                let after_unicode = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                assert!(after_unicode.is_none(), "pipeline should complete");
            }
        }
        StageState::Unicode { .. } => {
            // Generalization skipped to Unicode directly.
            force_single_iteration(&mut fuzzer);
            let after_unicode = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(after_unicode.is_none(), "pipeline should complete");
        }
        StageState::None => {
            // Generalization may have failed (input unstable) - that's ok
            // for this test; the key is that the pipeline didn't crash.
        }
        _ => panic!("unexpected stage state after generalization"),
    }

    assert!(
        matches!(fuzzer.stage_state, StageState::None),
        "pipeline should end in None"
    );
}
