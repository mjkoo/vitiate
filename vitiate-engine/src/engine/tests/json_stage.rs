use napi::bindgen_prelude::*;

use super::helpers::TestFuzzerBuilder;
use crate::cmplog;
use crate::engine::StageState;
use crate::engine::feature_detection::DEFERRED_DETECTION_THRESHOLD;
use crate::types::{ExitKind, IterationResult};

/// JSON stage starts and produces mutations from a JSON seed with detector
/// tokens in the dictionary.
///
/// Determinism: the test verifies that `begin_stage()` enters the Json state
/// and that the first output differs from the original seed (proving the
/// mutator ran). Individual mutator correctness (e.g., `__proto__` replacement)
/// is covered by the unit tests in `json.rs::tests`.
#[test]
fn json_stage_produces_mutation() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256)
        .json_mutations(true)
        .grimoire(false)
        .unicode(false)
        .redqueen(false)
        .build();

    // Add __proto__ token to the dictionary.
    use libafl::HasMetadata;
    if !fuzzer.state.has_metadata::<libafl::mutators::Tokens>() {
        fuzzer
            .state
            .add_metadata(libafl::mutators::Tokens::default());
    }
    // PANIC: Tokens metadata is guaranteed to exist - inserted above if absent.
    let tokens = fuzzer
        .state
        .metadata_mut::<libafl::mutators::Tokens>()
        .unwrap();
    tokens.add_token(&b"__proto__".to_vec());

    let seed = br#"{"x":"1"}"#;

    // Add a JSON seed.
    fuzzer.add_seed(Buffer::from(seed.to_vec())).unwrap();

    let _input = fuzzer.get_next_input().unwrap();
    // SAFETY: index 42 is within 256-byte map bounds.
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    // Calibrate.
    for _ in 0..4 {
        unsafe {
            *fuzzer.map_ptr.add(42) = 1;
        }
        if !fuzzer.calibrate_run(50_000.0).unwrap() {
            break;
        }
    }
    fuzzer.calibrate_finish().unwrap();

    // Begin stage should start JSON (no I2S data, no Grimoire, no Unicode).
    let stage_input = fuzzer.begin_stage().unwrap();
    assert!(stage_input.is_some(), "JSON stage should begin");
    assert!(
        matches!(fuzzer.stage_state, StageState::Json { .. }),
        "should be in Json stage state"
    );

    // The first stage output is a mutation of the seed - verify it differs.
    let first_output = stage_input.unwrap();
    assert_ne!(
        first_output.as_ref(),
        seed,
        "JSON stage output should differ from the original seed"
    );
}

/// JSON auto-detection enables mutations for JSON-heavy corpus.
///
/// Seeds the corpus with distinct JSON entries (each hitting a unique edge)
/// so the corpus is unambiguously JSON-dominated when deferred detection
/// fires at DEFERRED_DETECTION_THRESHOLD interesting inputs.
#[test]
fn json_auto_detection_enables_for_json_corpus() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();

    // Don't explicitly configure JSON - let auto-detect fire.
    let mut fuzzer = TestFuzzerBuilder::new(256)
        .grimoire(false)
        .unicode(false)
        .redqueen(false)
        .build();
    // json_mutations should start disabled (pending auto-detect).
    assert!(!fuzzer.features.json_mutations_enabled);

    // Add enough JSON seeds to exceed DEFERRED_DETECTION_THRESHOLD.
    // Each seed hits a unique edge so it's interesting and gets added to corpus.
    let json_seeds: Vec<&[u8]> = vec![
        br#"{"a":"b"}"#,
        br#"{"c":"d"}"#,
        br#"{"e":"f"}"#,
        br#"{"g":"h"}"#,
        br#"{"i":"j"}"#,
        br#"[1,2,3]"#,
        br#"{"k":true}"#,
        br#"{"l":null}"#,
        br#"[{"m":"n"}]"#,
        br#"{"o":{"p":"q"}}"#,
        br#"{"r":[1]}"#,
    ];

    for (i, seed) in json_seeds.iter().enumerate() {
        fuzzer.add_seed(Buffer::from(seed.to_vec())).unwrap();

        let _input = fuzzer.get_next_input().unwrap();
        // SAFETY: each index i+1 is within 256-byte map bounds.
        unsafe {
            *fuzzer.map_ptr.add(i + 1) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(result, IterationResult::Interesting);
        for _ in 0..4 {
            unsafe {
                *fuzzer.map_ptr.add(i + 1) = 1;
            }
            if !fuzzer.calibrate_run(50_000.0).unwrap() {
                break;
            }
        }
        fuzzer.calibrate_finish().unwrap();
    }

    // After enough interesting JSON inputs, json_mutations should be enabled.
    assert!(
        fuzzer.features.json_mutations_enabled,
        "JSON mutations should be auto-enabled for JSON-heavy corpus"
    );
}

/// JSON auto-detection disables mutations for text corpus.
#[test]
fn json_auto_detection_disables_for_text_corpus() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256)
        .grimoire(false)
        .unicode(false)
        .redqueen(false)
        .build();

    // Add a plain text seed (not JSON-like).
    fuzzer
        .add_seed(Buffer::from(b"hello world this is plain text".to_vec()))
        .unwrap();

    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(1) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);
    for _ in 0..4 {
        unsafe {
            *fuzzer.map_ptr.add(1) = 1;
        }
        if !fuzzer.calibrate_run(50_000.0).unwrap() {
            break;
        }
    }
    fuzzer.calibrate_finish().unwrap();

    for i in 2..=DEFERRED_DETECTION_THRESHOLD + 1 {
        let _input = fuzzer.get_next_input().unwrap();
        unsafe {
            *fuzzer.map_ptr.add(i) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        if result == IterationResult::Interesting {
            for _ in 0..4 {
                unsafe {
                    *fuzzer.map_ptr.add(i) = 1;
                }
                if !fuzzer.calibrate_run(50_000.0).unwrap() {
                    break;
                }
            }
            fuzzer.calibrate_finish().unwrap();
        }
    }

    assert!(
        fuzzer.features.deferred_detection_count.is_none(),
        "deferred detection should have fired"
    );
    assert!(
        !fuzzer.features.json_mutations_enabled,
        "JSON mutations should remain disabled for text corpus"
    );
}

/// Detector seeds are queued during seed composition and coexist with
/// default auto-seeds when no user seeds are present.
#[test]
fn detector_seeds_coexist_with_auto_seeds() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();

    use crate::engine::DEFAULT_SEEDS;

    let detector_seed_1: &[u8] = br#"{"__proto__":1}"#;
    let detector_seed_2: &[u8] = br#"["__proto__"]"#;

    let mut fuzzer = TestFuzzerBuilder::new(256)
        .detector_seeds(vec![
            Buffer::from(detector_seed_1.to_vec()),
            Buffer::from(detector_seed_2.to_vec()),
        ])
        .build();

    // No user seeds - detector seeds + default auto-seeds should be queued.
    // First inputs should be the 2 detector seeds, then DEFAULT_SEEDS.
    let first = fuzzer.get_next_input().unwrap();
    assert_eq!(first.as_ref(), detector_seed_1);

    let second = fuzzer.get_next_input().unwrap();
    assert_eq!(second.as_ref(), detector_seed_2);

    // Next should be the first default seed.
    let third = fuzzer.get_next_input().unwrap();
    assert_eq!(third.as_ref(), DEFAULT_SEEDS[0]);

    // Total seed count should be detector_seeds + DEFAULT_SEEDS.
    // (We already consumed 3, so verify the rest.)
    for (i, expected_seed) in DEFAULT_SEEDS.iter().enumerate().skip(1) {
        let input = fuzzer.get_next_input().unwrap();
        assert_eq!(input.as_ref(), *expected_seed, "default seed {i} mismatch");
        fuzzer.report_result(ExitKind::Ok, 1_000.0).unwrap();
    }
}

/// autoSeed=false omits detector seeds and default auto-seeds, starts with
/// single empty seed when no user corpus is present.
#[test]
fn auto_seed_false_starts_with_empty_seed() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).auto_seed(false).build();

    // No user seeds, auto_seed disabled - should get a single empty seed.
    let input = fuzzer.get_next_input().unwrap();
    assert_eq!(input.as_ref(), b"", "should start with empty seed");
}
