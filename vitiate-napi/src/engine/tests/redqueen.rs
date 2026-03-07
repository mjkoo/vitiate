use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::feature_detection::DEFERRED_DETECTION_THRESHOLD;
use crate::engine::{Fuzzer, StageState};
use crate::types::{ExitKind, FuzzerConfig, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::Corpus;
use libafl::corpus::CorpusId;
use libafl::corpus::Testcase;
use libafl::inputs::BytesInput;
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_begin_stage_starts_colorization_when_redqueen_enabled() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
    fuzzer.features.redqueen_enabled = true;

    let result = fuzzer.begin_stage().unwrap();
    assert!(result.is_some(), "should start colorization");
    assert!(
        matches!(fuzzer.stage_state, StageState::Colorization { .. }),
        "stage should be Colorization, got {:?}",
        std::mem::discriminant(&fuzzer.stage_state)
    );
    assert!(
        fuzzer.redqueen_ran_for_entry,
        "redqueen_ran_for_entry should be true"
    );

    cmplog::disable();
}

#[test]
fn test_begin_stage_falls_to_i2s_when_redqueen_disabled() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
    fuzzer.features.redqueen_enabled = false;

    let result = fuzzer.begin_stage().unwrap();
    assert!(result.is_some(), "should start I2S");
    assert!(
        matches!(fuzzer.stage_state, StageState::I2S { .. }),
        "stage should be I2S"
    );
    assert!(
        !fuzzer.redqueen_ran_for_entry,
        "redqueen_ran_for_entry should be false"
    );

    cmplog::disable();
}

#[test]
fn test_begin_stage_falls_to_i2s_when_input_too_large() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
    fuzzer.features.redqueen_enabled = true;

    // Replace the corpus entry with one larger than MAX_COLORIZATION_LEN.
    let large_input = BytesInput::new(vec![
        0x42;
        crate::engine::colorization::MAX_COLORIZATION_LEN + 1
    ]);
    let mut testcase = Testcase::new(large_input);
    testcase.set_exec_time(std::time::Duration::from_millis(1));
    let new_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
    fuzzer.last_interesting_corpus_id = Some(new_id);

    // Add CmpValuesMetadata so I2S can start.
    let mut cmp_meta = CmpValuesMetadata::new();
    cmp_meta.list.push(CmpValues::Bytes((
        make_cmplog_bytes(b"test"),
        make_cmplog_bytes(b"best"),
    )));
    fuzzer.state.metadata_map_mut().insert(cmp_meta);

    let result = fuzzer.begin_stage().unwrap();
    assert!(result.is_some(), "should start I2S");
    assert!(
        matches!(fuzzer.stage_state, StageState::I2S { .. }),
        "stage should be I2S, not Colorization"
    );
    assert!(
        !fuzzer.redqueen_ran_for_entry,
        "redqueen_ran_for_entry should be false for oversized input"
    );

    cmplog::disable();
}

#[test]
fn test_redqueen_ran_for_entry_reset_on_begin_stage() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    // Manually set the flag to true.
    fuzzer.redqueen_ran_for_entry = true;

    let _result = fuzzer.begin_stage().unwrap();
    // Flag should be reset to false at the start of begin_stage.
    // (It would only be re-set to true if REDQUEEN is enabled and
    // colorization starts, but we left redqueen_enabled = false.)
    assert!(
        !fuzzer.redqueen_ran_for_entry,
        "redqueen_ran_for_entry should be reset"
    );

    cmplog::disable();
}

#[test]
fn test_redqueen_explicit_enable() {
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: None,
            unicode: None,
            redqueen: Some(true),
        }),
    )
    .unwrap();
    assert!(
        fuzzer.features.redqueen_enabled,
        "explicit true should enable"
    );
}

#[test]
fn test_redqueen_explicit_disable() {
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: None,
            unicode: None,
            redqueen: Some(false),
        }),
    )
    .unwrap();
    assert!(
        !fuzzer.features.redqueen_enabled,
        "explicit false should disable"
    );
}

#[test]
fn test_redqueen_auto_detect_empty_corpus_defaults_false() {
    let coverage_map: Buffer = vec![0u8; 256].into();
    let fuzzer = Fuzzer::new(
        coverage_map,
        Some(FuzzerConfig {
            max_input_len: None,
            seed: None,
            grimoire: None,
            unicode: None,
            redqueen: None,
        }),
    )
    .unwrap();
    assert!(
        !fuzzer.features.redqueen_enabled,
        "auto-detect with empty corpus should default to false"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_some(),
        "should have deferred detection"
    );
}

#[test]
fn test_redqueen_deferred_detection_binary_corpus_enables() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.features.redqueen_override = None;
    fuzzer.features.redqueen_enabled = false;
    fuzzer.features.deferred_detection_count = Some(0);

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
    let seed_id = CorpusId::from(0usize);

    for i in 0..DEFERRED_DETECTION_THRESHOLD {
        fuzzer.last_input = Some(BytesInput::new(vec![0x80, 0x90, 0xA0, i as u8]));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(i + 10) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(matches!(result, IterationResult::Interesting));
        fuzzer.calibrate_finish().unwrap();
    }

    assert!(
        fuzzer.features.redqueen_enabled,
        "REDQUEEN should be enabled for binary corpus"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "detection should be resolved"
    );

    cmplog::disable();
}

#[test]
fn test_redqueen_deferred_detection_utf8_corpus_disables() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.features.redqueen_override = None;
    fuzzer.features.redqueen_enabled = false;
    fuzzer.features.deferred_detection_count = Some(0);

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
    let seed_id = CorpusId::from(0usize);

    for i in 0..DEFERRED_DETECTION_THRESHOLD {
        fuzzer.last_input = Some(BytesInput::new(format!("hello{i}").into_bytes()));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(i + 10) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(matches!(result, IterationResult::Interesting));
        fuzzer.calibrate_finish().unwrap();
    }

    assert!(
        !fuzzer.features.redqueen_enabled,
        "REDQUEEN should be disabled for UTF-8 corpus"
    );
    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "detection should be resolved"
    );

    cmplog::disable();
}

#[test]
fn test_redqueen_complementary_to_grimoire_unicode() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.features.grimoire_override = None;
    fuzzer.features.unicode_override = None;
    fuzzer.features.redqueen_override = None;
    fuzzer.features.grimoire_enabled = false;
    fuzzer.features.unicode_enabled = false;
    fuzzer.features.redqueen_enabled = false;
    fuzzer.features.deferred_detection_count = Some(0);

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
    let seed_id = CorpusId::from(0usize);

    for i in 0..DEFERRED_DETECTION_THRESHOLD {
        fuzzer.last_input = Some(BytesInput::new(vec![0xFF, 0xFE, 0xFD, i as u8]));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(i + 10) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(matches!(result, IterationResult::Interesting));
        fuzzer.calibrate_finish().unwrap();
    }

    // Binary corpus: REDQUEEN on, Grimoire/Unicode off.
    assert!(
        fuzzer.features.redqueen_enabled,
        "binary corpus → REDQUEEN enabled"
    );
    assert!(
        !fuzzer.features.grimoire_enabled,
        "binary corpus → Grimoire disabled"
    );
    assert!(
        !fuzzer.features.unicode_enabled,
        "binary corpus → Unicode disabled"
    );

    cmplog::disable();
}
