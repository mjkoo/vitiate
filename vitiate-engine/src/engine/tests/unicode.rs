use std::time::Duration;

use super::helpers::{TestFuzzerBuilder, make_coverage_map, make_state_and_feedback};
use crate::cmplog;
use crate::engine::{Fuzzer, StageState, UnicodeInput};
use crate::types::{ExitKind, FuzzerConfig, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::{Corpus, SchedulerTestcaseMetadata, Testcase};
use libafl::feedbacks::{MapIndexesMetadata, MapNoveltiesMetadata};
use libafl::inputs::BytesInput;
use libafl::mutators::unicode::{
    UnicodeCategoryRandMutator, UnicodeCategoryTokenReplaceMutator, UnicodeSubcategoryRandMutator,
    UnicodeSubcategoryTokenReplaceMutator,
};
use libafl::mutators::{MutationResult, Mutator};
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
use libafl::schedulers::Scheduler;
use libafl::stages::UnicodeIdentificationMetadata;
use libafl::state::{HasCorpus, HasMaxSize};
use napi::bindgen_prelude::Buffer;

// -----------------------------------------------------------------------
// Unicode Identification Metadata Tests (Task 1.3)
// -----------------------------------------------------------------------

#[test]
fn test_unicode_metadata_fully_valid_utf8() {
    let meta = UnicodeIdentificationMetadata::new(b"hello world");
    assert_eq!(
        meta.ranges().len(),
        1,
        "fully valid UTF-8 should have one region"
    );
    assert_eq!(meta.ranges()[0].0, 0, "region should start at offset 0");
    // All ASCII chars are single-byte, so every position is a character boundary.
    let bitvec = &meta.ranges()[0].1;
    assert_eq!(bitvec.len(), 11);
    for i in 0..11 {
        assert!(bitvec[i], "byte {i} should be a character boundary");
    }
}

#[test]
fn test_unicode_metadata_embedded_invalid_bytes() {
    let mut input = b"abc".to_vec();
    input.extend_from_slice(&[0xFF, 0xFE]);
    input.extend_from_slice(b"def");
    let meta = UnicodeIdentificationMetadata::new(&input);
    assert!(
        meta.ranges().len() >= 2,
        "should have at least two regions for abc and def"
    );
}

#[test]
fn test_unicode_metadata_multi_byte_characters() {
    // Emoji "😀" is 4 bytes: F0 9F 98 80
    let input = "😀".as_bytes();
    let meta = UnicodeIdentificationMetadata::new(input);
    assert_eq!(meta.ranges().len(), 1);
    let bitvec = &meta.ranges()[0].1;
    assert_eq!(bitvec.len(), 4);
    // Only first byte is a character boundary.
    assert!(bitvec[0], "first byte should be a character boundary");
    assert!(!bitvec[1], "continuation byte should not be a boundary");
    assert!(!bitvec[2], "continuation byte should not be a boundary");
    assert!(!bitvec[3], "continuation byte should not be a boundary");
}

#[test]
fn test_unicode_metadata_empty_input() {
    let meta = UnicodeIdentificationMetadata::new(b"");
    assert!(
        meta.ranges().is_empty(),
        "empty input should have no regions"
    );
}

#[test]
fn test_unicode_metadata_entirely_non_utf8() {
    let input = vec![0xFF, 0xFE, 0xFD, 0xFC, 0xFB];
    let meta = UnicodeIdentificationMetadata::new(&input);
    assert!(
        meta.ranges().is_empty(),
        "entirely non-UTF-8 should have no regions"
    );
}

// -----------------------------------------------------------------------
// Unicode Mutator Tests (Task 2.6)
// -----------------------------------------------------------------------

#[test]
fn test_unicode_category_rand_mutator_produces_result() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 256);
    state.set_max_size(4096);

    let original = b"hello123".to_vec();
    let input = BytesInput::new(original.clone());
    let metadata = UnicodeIdentificationMetadata::new(&original);
    let mut unicode_input: UnicodeInput = (input, metadata);

    let mut mutator = UnicodeCategoryRandMutator;
    let result = mutator.mutate(&mut state, &mut unicode_input).unwrap();
    if result == MutationResult::Mutated {
        assert_ne!(
            unicode_input.0.as_ref() as &Vec<u8>,
            &original,
            "Mutated result should differ from original input"
        );
    }
}

#[test]
fn test_unicode_subcategory_rand_mutator_produces_result() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 256);
    state.set_max_size(4096);

    let original = b"HELLO".to_vec();
    let input = BytesInput::new(original.clone());
    let metadata = UnicodeIdentificationMetadata::new(&original);
    let mut unicode_input: UnicodeInput = (input, metadata);

    let mut mutator = UnicodeSubcategoryRandMutator;
    let result = mutator.mutate(&mut state, &mut unicode_input).unwrap();
    if result == MutationResult::Mutated {
        assert_ne!(
            unicode_input.0.as_ref() as &Vec<u8>,
            &original,
            "Mutated result should differ from original input"
        );
    }
}

#[test]
fn test_unicode_category_token_replace_skipped_when_no_tokens() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 256);
    state.set_max_size(4096);
    // No Tokens metadata added - mutator should skip.

    let input = BytesInput::new(b"hello".to_vec());
    let metadata = UnicodeIdentificationMetadata::new(b"hello");
    let mut unicode_input: UnicodeInput = (input, metadata);

    let mut mutator = UnicodeCategoryTokenReplaceMutator;
    let result = mutator.mutate(&mut state, &mut unicode_input).unwrap();
    assert_eq!(
        result,
        MutationResult::Skipped,
        "should skip when no tokens available"
    );
}

#[test]
fn test_unicode_subcategory_token_replace_skipped_when_no_tokens() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 256);
    state.set_max_size(4096);

    let input = BytesInput::new(b"hello".to_vec());
    let metadata = UnicodeIdentificationMetadata::new(b"hello");
    let mut unicode_input: UnicodeInput = (input, metadata);

    let mut mutator = UnicodeSubcategoryTokenReplaceMutator;
    let result = mutator.mutate(&mut state, &mut unicode_input).unwrap();
    assert_eq!(
        result,
        MutationResult::Skipped,
        "should skip when no tokens available"
    );
}

#[test]
fn test_unicode_mutator_skipped_on_empty_input() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 256);
    state.set_max_size(4096);

    let input = BytesInput::new(vec![]);
    let metadata = UnicodeIdentificationMetadata::new(b"");
    let mut unicode_input: UnicodeInput = (input, metadata);

    let mut mutator = UnicodeCategoryRandMutator;
    let result = mutator.mutate(&mut state, &mut unicode_input).unwrap();
    assert_eq!(
        result,
        MutationResult::Skipped,
        "should skip on empty input"
    );
}

#[test]
fn test_unicode_mutator_skipped_on_no_utf8_region() {
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 256);
    state.set_max_size(4096);

    let raw = vec![0xFF, 0xFE, 0xFD];
    let input = BytesInput::new(raw.clone());
    let metadata = UnicodeIdentificationMetadata::new(&raw);
    let mut unicode_input: UnicodeInput = (input, metadata);

    let mut mutator = UnicodeCategoryRandMutator;
    let result = mutator.mutate(&mut state, &mut unicode_input).unwrap();
    assert_eq!(
        result,
        MutationResult::Skipped,
        "should skip when no UTF-8 region"
    );
}

// -----------------------------------------------------------------------
// Unicode Configuration Tests (Task 3.5)
// -----------------------------------------------------------------------

#[test]
fn test_unicode_explicit_enable_through_constructor() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: None,
            unicode: Some(true),
            redqueen: None,
            dictionary_path: None,
            detector_tokens: None,
        }),
        None,
        None,
    )
    .unwrap();
    assert!(
        fuzzer.features.unicode_enabled,
        "unicode should be enabled when config.unicode = Some(true)"
    );
}

#[test]
fn test_unicode_explicit_disable_through_constructor() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: None,
            unicode: Some(false),
            redqueen: None,
            dictionary_path: None,
            detector_tokens: None,
        }),
        None,
        None,
    )
    .unwrap();
    assert!(
        !fuzzer.features.unicode_enabled,
        "unicode should be disabled when config.unicode = Some(false)"
    );
}

#[test]
fn test_unicode_and_grimoire_independent_explicit_control() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Grimoire disabled, unicode enabled.
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: Some(false),
            unicode: Some(true),
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
        "grimoire should be disabled"
    );
    assert!(fuzzer.features.unicode_enabled, "unicode should be enabled");
    // Deferred detection is still needed for REDQUEEN (redqueen: None).
    assert!(
        fuzzer.features.deferred_detection_count.is_some(),
        "deferred detection needed for REDQUEEN auto-detect"
    );
}

#[test]
fn test_deferred_detection_resolves_both_features() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Both grimoire and unicode start disabled with deferred detection.
    assert!(!fuzzer.features.grimoire_enabled);
    assert!(!fuzzer.features.unicode_enabled);
    assert_eq!(fuzzer.features.deferred_detection_count, Some(0));

    // Add UTF-8 seeds so auto-seed skip count is bypassed and the corpus
    // contains enough UTF-8 entries for the scan to succeed.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Add 12 known UTF-8 corpus entries directly (bypassing havoc mutation
    // which may produce non-UTF-8 output). This simulates 10+ interesting
    // inputs that are valid UTF-8.
    for i in 0u16..12 {
        let content = format!("interesting_input_{i}");
        let mut testcase = Testcase::new(BytesInput::new(content.into_bytes()));
        testcase.add_metadata(MapNoveltiesMetadata::new(vec![50 + i as usize]));
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_n_fuzz_entry(0);
        testcase.add_metadata(sched_meta);
        testcase.add_metadata(MapIndexesMetadata::new(vec![50 + i as usize]));
        *testcase.exec_time_mut() = Some(Duration::from_micros(100));
        let id = fuzzer.state.corpus_mut().add(testcase).unwrap();
        fuzzer.scheduler.on_add(&mut fuzzer.state, id).unwrap();
    }

    // Simulate 10 main-loop interesting inputs to trigger deferred threshold.
    // (The deferred count tracks report_result Interesting calls, not corpus additions.)
    for i in 0u8..10 {
        let _ = fuzzer.get_next_input().unwrap();
        unsafe {
            *fuzzer.map_ptr.add(70 + i as usize) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(result, IterationResult::Interesting);
        // Calibrate.
        for _ in 0..3 {
            unsafe {
                *fuzzer.map_ptr.add(70 + i as usize) = 1;
            }
            let needs_more = fuzzer.calibrate_run(50_000.0).unwrap();
            if !needs_more {
                break;
            }
        }
        fuzzer.calibrate_finish().unwrap();
    }

    // After 10 interesting inputs, deferred detection should resolve.
    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "deferred detection should be resolved"
    );
    // The corpus has majority UTF-8 entries (seeds + manually added entries),
    // so both should be enabled.
    assert!(
        fuzzer.features.grimoire_enabled,
        "grimoire should be enabled after deferred detection"
    );
    assert!(
        fuzzer.features.unicode_enabled,
        "unicode should be enabled after deferred detection"
    );
}

#[test]
fn test_shared_deferred_threshold_with_one_feature_explicit() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Grimoire explicitly enabled, unicode auto-detect.
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
        "grimoire explicitly enabled"
    );
    assert!(
        !fuzzer.features.unicode_enabled,
        "unicode starts disabled (pending deferred)"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_some(),
        "deferred detection should be active for unicode"
    );
}

// -----------------------------------------------------------------------
// Unicode Stage Tests (Tasks 4.6)
// -----------------------------------------------------------------------

#[test]
fn test_begin_unicode_returns_some_for_utf8_entry() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    let result = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(
        result.is_some(),
        "begin_unicode should return Some for UTF-8 entry"
    );
    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { .. }),
        "stage should be Unicode"
    );
}

#[test]
fn test_begin_unicode_returns_none_when_disabled() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    fuzzer.features.unicode_enabled = false;
    let result = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "begin_unicode should return None when disabled"
    );
}

#[test]
fn test_begin_unicode_returns_none_for_non_utf8_entry() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let non_utf8 = vec![0xFF, 0xFE, 0xFD, 0xFC, 0xFB];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(&non_utf8, &[10]);
    let result = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "begin_unicode should return None for non-UTF-8 entry"
    );
}

#[test]
fn test_unicode_stage_iteration_counting() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    let first = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(first.is_some());

    // Force max_iterations to 3.
    if let StageState::Unicode {
        corpus_id,
        iteration,
        metadata,
        ..
    } = std::mem::replace(&mut fuzzer.stage_state, StageState::None)
    {
        fuzzer.stage_state = StageState::Unicode {
            corpus_id,
            iteration,
            max_iterations: 3,
            metadata,
        };
    }

    // Advance through 3 iterations.
    let second = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(second.is_some(), "iteration 1 should produce next");

    let third = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(third.is_some(), "iteration 2 should produce next");

    let done = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(done.is_none(), "iteration 3 should complete the stage");
    assert!(
        matches!(fuzzer.stage_state, StageState::None),
        "stage should transition to None"
    );
}

#[test]
fn test_unicode_stage_non_cumulative_mutations() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let input = b"hello world test";
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(input, &[10]);
    let first = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(first.is_some());

    // Force to 2 iterations.
    if let StageState::Unicode {
        corpus_id,
        iteration,
        metadata,
        ..
    } = std::mem::replace(&mut fuzzer.stage_state, StageState::None)
    {
        fuzzer.stage_state = StageState::Unicode {
            corpus_id,
            iteration,
            max_iterations: 2,
            metadata,
        };
    }

    // Advance - the original corpus entry should be preserved (non-cumulative).
    let second = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(second.is_some());

    // Verify original corpus entry is not modified.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap();
    let tc_ref = tc.borrow();
    let original_input = tc_ref.input().as_ref().unwrap();
    let original_bytes: &[u8] = original_input.as_ref();
    assert_eq!(
        original_bytes, input,
        "original corpus entry should be unchanged"
    );
}

#[test]
fn test_unicode_stage_cmplog_drained() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    let first = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(first.is_some());

    // Force to 2 iterations.
    if let StageState::Unicode {
        corpus_id,
        iteration,
        metadata,
        ..
    } = std::mem::replace(&mut fuzzer.stage_state, StageState::None)
    {
        fuzzer.stage_state = StageState::Unicode {
            corpus_id,
            iteration,
            max_iterations: 2,
            metadata,
        };
    }

    // Push some CmpLog entries before advancing.
    cmplog::push(
        CmpValues::U8((1, 2, false)),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // CmpLog should be drained.
    let drained = cmplog::drain();
    assert!(
        drained.is_empty(),
        "CmpLog should be empty after unicode advance"
    );
}

#[test]
fn test_unicode_stage_abort_transitions_to_none() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    let first = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(first.is_some());

    let execs_before = fuzzer.total_execs;
    fuzzer.abort_stage(ExitKind::Crash).unwrap();

    assert!(
        matches!(fuzzer.stage_state, StageState::None),
        "stage should be None after abort"
    );
    assert_eq!(
        fuzzer.total_execs,
        execs_before + 1,
        "abort should increment total_execs"
    );
}

#[test]
fn test_unicode_stage_max_input_length_enforcement() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let input = b"hello world";
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(input, &[10]);
    fuzzer.max_input_len = 5; // Restrict to 5 bytes.
    let result = fuzzer.begin_unicode(corpus_id).unwrap();
    if let Some(buf) = result {
        assert!(
            buf.len() <= 5,
            "output should be truncated to max_input_len"
        );
    }
}

#[test]
fn test_unicode_stage_metadata_stashed_in_stage_state() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    let _ = fuzzer.begin_unicode(corpus_id).unwrap();

    // Verify metadata is stashed in the stage state.
    assert!(
        matches!(fuzzer.stage_state, StageState::Unicode { ref metadata, .. } if !metadata.ranges().is_empty()),
        "unicode metadata should be stashed in stage state"
    );
}

// -----------------------------------------------------------------------
// Unicode Auto-Detection Integration Tests (Task 6.1-6.2)
// -----------------------------------------------------------------------

#[test]
fn test_unicode_stage_skipped_when_no_valid_utf8_regions() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Entry with no valid UTF-8 → begin_unicode returns None.
    let non_utf8 = vec![0xFF, 0xFE, 0xFD, 0xFC, 0xFB];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(&non_utf8, &[10]);

    // Set up for beginStage.
    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    // Ensure no CmpLog data.
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata::new());

    let result = fuzzer.begin_stage().unwrap();
    assert!(
        result.is_none(),
        "should return None when no valid UTF-8 regions"
    );
    assert!(matches!(fuzzer.stage_state, StageState::None));
}

#[test]
fn test_unicode_enabled_drives_stage_transitions() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // When unicode is enabled, pipeline transitions should reach Unicode stage.
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"test input", &[10]);

    // Simulate beginStage with no CmpLog and no grimoire.
    fuzzer.last_interesting_corpus_id = Some(corpus_id);
    fuzzer
        .state
        .metadata_map_mut()
        .insert(CmpValuesMetadata::new());

    let result = fuzzer.begin_stage().unwrap();
    assert!(result.is_some(), "unicode stage should start");
    assert!(matches!(fuzzer.stage_state, StageState::Unicode { .. }));

    // When unicode is disabled, same entry should not start stage.
    if let StageState::Unicode { .. } = fuzzer.stage_state {
        fuzzer.stage_state = StageState::None;
    }
    fuzzer.features.unicode_enabled = false;
    fuzzer.last_interesting_corpus_id = Some(corpus_id);

    let result2 = fuzzer.begin_stage().unwrap();
    assert!(
        result2.is_none(),
        "should return None when unicode disabled"
    );
}

#[test]
fn test_unicode_stage_exec_counter_increments() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .unicode(true)
        .build_with_corpus_entry(b"hello world", &[10]);
    let first = fuzzer.begin_unicode(corpus_id).unwrap();
    assert!(first.is_some());

    // Force to 2 iterations.
    if let StageState::Unicode {
        corpus_id,
        iteration,
        metadata,
        ..
    } = std::mem::replace(&mut fuzzer.stage_state, StageState::None)
    {
        fuzzer.stage_state = StageState::Unicode {
            corpus_id,
            iteration,
            max_iterations: 2,
            metadata,
        };
    }

    let execs_before = fuzzer.total_execs;
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(
        fuzzer.total_execs,
        execs_before + 1,
        "advance should increment total_execs"
    );

    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(
        fuzzer.total_execs,
        execs_before + 2,
        "second advance should increment total_execs"
    );
}
