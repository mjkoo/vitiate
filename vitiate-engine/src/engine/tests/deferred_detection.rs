use super::helpers::SEED_EXEC_TIME;
use super::helpers::{
    TestFuzzerBuilder, make_cmplog_bytes, make_coverage_map, make_state_and_feedback,
};
use crate::cmplog;
use crate::engine::DEFAULT_SEEDS;
use crate::engine::cmplog_metadata::set_n_fuzz_entry_for_corpus_id;
use crate::engine::feature_detection::DEFERRED_DETECTION_THRESHOLD;
use crate::engine::feature_detection::FeatureDetection;
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::CorpusId;
use libafl::corpus::{Corpus, SchedulerTestcaseMetadata, Testcase};
use libafl::feedbacks::MapIndexesMetadata;
use libafl::inputs::BytesInput;
use libafl::observers::cmp::CmpValues;
use libafl::schedulers::Scheduler;
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_grimoire_majority_utf8_enables() {
    // Corpus with 8 UTF-8 and 2 non-UTF-8 inputs → enabled.
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, ..) = make_state_and_feedback(map_ptr, 256);

    for i in 0..8 {
        let tc = Testcase::new(BytesInput::new(format!("text_{i}").into_bytes()));
        state.corpus_mut().add(tc).unwrap();
    }
    for _ in 0..2 {
        let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80, 0x81]));
        state.corpus_mut().add(tc).unwrap();
    }

    assert!(FeatureDetection::scan_corpus(&state, 0).0);
}

#[test]
fn test_grimoire_majority_non_utf8_disables() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, ..) = make_state_and_feedback(map_ptr, 256);

    for _ in 0..3 {
        let tc = Testcase::new(BytesInput::new(b"text".to_vec()));
        state.corpus_mut().add(tc).unwrap();
    }
    for _ in 0..7 {
        let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80]));
        state.corpus_mut().add(tc).unwrap();
    }

    assert!(!FeatureDetection::scan_corpus(&state, 0).0);
}

#[test]
fn test_grimoire_equal_counts_disables() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, ..) = make_state_and_feedback(map_ptr, 256);

    for _ in 0..5 {
        let tc = Testcase::new(BytesInput::new(b"text".to_vec()));
        state.corpus_mut().add(tc).unwrap();
    }
    for _ in 0..5 {
        let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE]));
        state.corpus_mut().add(tc).unwrap();
    }

    assert!(
        !FeatureDetection::scan_corpus(&state, 0).0,
        "equal counts should disable (strictly greater-than required)"
    );
}

#[test]
fn test_deferred_detection_respects_explicit_false_override() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // grimoire: explicit false, unicode: auto-detect (None).
    // After deferred detection fires with UTF-8 corpus, grimoire must stay
    // false while unicode must be auto-enabled.
    cmplog::disable();
    cmplog::drain();
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    // Simulate: grimoire explicitly disabled, unicode left for auto-detect.
    fuzzer.features.grimoire_override = Some(false);
    fuzzer.features.grimoire_enabled = false;
    fuzzer.features.unicode_override = None;
    fuzzer.features.unicode_enabled = false;
    fuzzer.features.deferred_detection_count = Some(0);

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    let seed_id = CorpusId::from(0usize);
    for i in 0..DEFERRED_DETECTION_THRESHOLD {
        fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(i + 10) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(
            matches!(result, IterationResult::Interesting),
            "iteration {i} should be interesting"
        );
        fuzzer.calibrate_finish().unwrap();
    }

    assert!(
        !fuzzer.features.grimoire_enabled,
        "explicit grimoire: false must not be overridden by deferred detection"
    );
    assert!(
        fuzzer.features.unicode_enabled,
        "unicode (auto-detect) should be enabled after UTF-8 corpus detected"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "deferred count should be consumed"
    );
}

#[test]
fn test_deferred_detection_respects_explicit_false_unicode_override() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // unicode: explicit false, grimoire: auto-detect (None).
    // After deferred detection fires with UTF-8 corpus, unicode must stay
    // false while grimoire must be auto-enabled.
    cmplog::disable();
    cmplog::drain();
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    // Simulate: unicode explicitly disabled, grimoire left for auto-detect.
    fuzzer.features.unicode_override = Some(false);
    fuzzer.features.unicode_enabled = false;
    fuzzer.features.grimoire_override = None;
    fuzzer.features.grimoire_enabled = false;
    fuzzer.features.deferred_detection_count = Some(0);

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    let seed_id = CorpusId::from(0usize);
    for i in 0..DEFERRED_DETECTION_THRESHOLD {
        fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(i + 10) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(
            matches!(result, IterationResult::Interesting),
            "iteration {i} should be interesting"
        );
        fuzzer.calibrate_finish().unwrap();
    }

    assert!(
        !fuzzer.features.unicode_enabled,
        "explicit unicode: false must not be overridden by deferred detection"
    );
    assert!(
        fuzzer.features.grimoire_enabled,
        "grimoire (auto-detect) should be enabled after UTF-8 corpus detected"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "deferred count should be consumed"
    );
}

#[test]
fn test_grimoire_empty_corpus_defers_detection() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let fuzzer = TestFuzzerBuilder::new(256).build();

    // Empty corpus with no override → deferred.
    assert!(!fuzzer.features.grimoire_enabled);
    assert_eq!(fuzzer.features.deferred_detection_count, Some(0));
}

#[test]
fn test_grimoire_deferred_triggers_after_10_interesting() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Generate DEFERRED_DETECTION_THRESHOLD interesting inputs with controlled UTF-8 content.
    // We bypass get_next_input to avoid havoc producing non-UTF-8 bytes.
    let seed_id = CorpusId::from(0usize);
    for i in 0..DEFERRED_DETECTION_THRESHOLD {
        fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(i + 10) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(
            matches!(result, IterationResult::Interesting),
            "iteration {i} should be interesting"
        );
        fuzzer.calibrate_finish().unwrap();
    }

    // After DEFERRED_DETECTION_THRESHOLD interesting UTF-8 inputs, Grimoire should be enabled.
    assert!(
        fuzzer.features.grimoire_enabled,
        "should be enabled after DEFERRED_DETECTION_THRESHOLD UTF-8 inputs"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "deferred count should be consumed"
    );
}

#[test]
fn test_grimoire_deferred_ignores_stage_found_entries() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // One interesting input via main loop → deferred count = 1.
    // Push CmpLog data so begin_stage has I2S entries to work with.
    let seed_id = CorpusId::from(0usize);
    fuzzer.last_input = Some(BytesInput::new(b"utf8_main".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    unsafe {
        *fuzzer.map_ptr.add(50) = 1;
    }
    cmplog::push(
        CmpValues::Bytes((make_cmplog_bytes(b"hello"), make_cmplog_bytes(b"world"))),
        0,
        cmplog::CmpLogOperator::Equal,
    );
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));
    assert_eq!(fuzzer.features.deferred_detection_count, Some(1));

    // Calibrate to completion.
    loop {
        unsafe {
            *fuzzer.map_ptr.add(50) = 1;
        }
        if !fuzzer.calibrate_run(50_000.0).unwrap() {
            break;
        }
    }
    fuzzer.calibrate_finish().unwrap();

    // Begin I2S stage (CmpLog data was drained into state by report_result).
    let stage_buf = fuzzer.begin_stage().unwrap();
    assert!(stage_buf.is_some(), "stage should start");

    // Novel coverage during stage advance.
    unsafe {
        *fuzzer.map_ptr.add(80) = 1;
    }
    let _advance = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // Deferred count must still be 1 - stage-found entries don't count.
    assert_eq!(
        fuzzer.features.deferred_detection_count,
        Some(1),
        "stage-found entries should not increment deferred count"
    );
}

#[test]
fn test_scan_corpus_skip_all_returns_false() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, ..) = make_state_and_feedback(map_ptr, 256);
    for _ in 0..3 {
        state
            .corpus_mut()
            .add(Testcase::new(BytesInput::new(b"text".to_vec())))
            .unwrap();
    }
    // skip_count == count: no entries to scan.
    assert!(
        !FeatureDetection::scan_corpus(&state, 3).0,
        "skipping all entries should return false"
    );
    // skip_count > count: still no entries to scan.
    assert!(
        !FeatureDetection::scan_corpus(&state, 100).0,
        "skipping beyond corpus size should return false"
    );
}

#[test]
fn test_deferred_detection_excludes_auto_seeds() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // When deferred detection fires, scan_corpus should skip the
    // auto-seeds (all valid UTF-8) so only user-found inputs influence the vote.
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    for seed in DEFAULT_SEEDS {
        let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));
        testcase.set_exec_time(SEED_EXEC_TIME);
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
        testcase.add_metadata(sched_meta);
        testcase.add_metadata(MapIndexesMetadata::new(vec![]));
        let id = fuzzer.state.corpus_mut().add(testcase).unwrap();
        fuzzer.scheduler.on_add(&mut fuzzer.state, id).unwrap();
        set_n_fuzz_entry_for_corpus_id(&fuzzer.state, id).unwrap();
    }
    fuzzer.features.auto_seed_count = DEFAULT_SEEDS.len();

    // Add only non-UTF-8 interesting inputs.
    for i in 0u8..4 {
        let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80, i]));
        fuzzer.state.corpus_mut().add(tc).unwrap();
    }

    // Without skipping: UTF-8 seeds outnumber non-UTF-8 user inputs -> enabled (wrong).
    assert!(
        FeatureDetection::scan_corpus(&fuzzer.state, 0).0,
        "without skipping, default seeds cause false positive"
    );

    // With skipping: 0 UTF-8 user vs 4 non-UTF-8 -> disabled (correct).
    assert!(
        !FeatureDetection::scan_corpus(&fuzzer.state, fuzzer.features.auto_seed_count).0,
        "with skipping, only user inputs are counted"
    );
}
