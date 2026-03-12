use napi::bindgen_prelude::*;

use super::helpers::TestFuzzerBuilder;
use crate::cmplog;
use crate::engine::DEFAULT_SEEDS;
use crate::types::{ExitKind, IterationResult};

/// Seeds added via `add_seed()` are returned verbatim in FIFO order
/// before the scheduler+mutation path is used.
#[test]
fn seeds_returned_verbatim_before_mutation() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(64).build();

    let seeds: Vec<Vec<u8>> = vec![
        b"first seed".to_vec(),
        b"second seed".to_vec(),
        b"third seed".to_vec(),
    ];

    for seed in &seeds {
        fuzzer.add_seed(Buffer::from(seed.clone())).unwrap();
    }

    for (i, expected) in seeds.iter().enumerate() {
        let output = fuzzer.get_next_input().unwrap();
        assert_eq!(
            output.as_ref(),
            expected.as_slice(),
            "seed {i} should be returned verbatim"
        );
    }
}

/// A seed returned verbatim integrates correctly with the coverage feedback
/// pipeline: novel coverage is reported as `Interesting`.
#[test]
fn seed_evaluation_integrates_with_report_result() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(64).build();

    fuzzer
        .add_seed(Buffer::from(b"coverage seed".to_vec()))
        .unwrap();

    let output = fuzzer.get_next_input().unwrap();
    assert_eq!(output.as_ref(), b"coverage seed");

    // Write novel coverage before reporting.
    // SAFETY: index 10 is within the 64-byte map; no other observer is live.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }

    let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(
        result,
        IterationResult::Interesting,
        "novel coverage from verbatim seed should be Interesting"
    );
}

/// When all auto-seeds are evaluated without producing any coverage,
/// the next `get_next_input()` returns an error instead of re-queuing.
#[test]
fn all_auto_seeds_without_coverage_returns_error() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(64).build();

    // Drain all auto-seeds without writing any coverage.
    for _ in 0..DEFAULT_SEEDS.len() {
        let _input = fuzzer.get_next_input().unwrap();
        let result = fuzzer.report_result(ExitKind::Ok, 1_000.0).unwrap();
        assert_eq!(
            result,
            IterationResult::None,
            "no coverage written, should be NotInteresting"
        );
    }

    // Next call should error - all auto-seeds exhausted with zero coverage.
    let result = fuzzer.get_next_input();
    assert!(result.is_err(), "expected error after all auto-seeds fail");
    let msg = result.err().unwrap().to_string();
    assert!(
        msg.contains("none produced coverage"),
        "expected 'none produced coverage' in error, got: {msg}"
    );
}

/// When user-provided seeds all fail to produce coverage, auto-seeds are
/// NOT tried - the error fires immediately.
#[test]
fn user_seeds_without_coverage_skips_auto_seeds_and_errors() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(64).build();

    fuzzer
        .add_seed(Buffer::from(b"user seed 1".to_vec()))
        .unwrap();
    fuzzer
        .add_seed(Buffer::from(b"user seed 2".to_vec()))
        .unwrap();

    // Drain both user seeds without writing coverage.
    for _ in 0..2 {
        let _input = fuzzer.get_next_input().unwrap();
        let result = fuzzer.report_result(ExitKind::Ok, 1_000.0).unwrap();
        assert_eq!(result, IterationResult::None);
    }

    // Next call should error - user seeds exhausted, auto-seeds skipped.
    let result = fuzzer.get_next_input();
    assert!(result.is_err(), "expected error after all user seeds fail");
    let msg = result.err().unwrap().to_string();
    assert!(
        msg.contains("none produced coverage"),
        "expected 'none produced coverage' in error, got: {msg}"
    );
}

/// When all seeds crash (solutions found) but none produce coverage,
/// the next `get_next_input()` returns a clear error instead of a
/// confusing "Scheduler failed" message from an empty corpus.
#[test]
fn all_seeds_crash_without_coverage_returns_clear_error() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(64).build();

    // Add user seeds that will all crash.
    fuzzer
        .add_seed(Buffer::from(b"crash seed 1".to_vec()))
        .unwrap();
    fuzzer
        .add_seed(Buffer::from(b"crash seed 2".to_vec()))
        .unwrap();

    // Drain user seeds with Crash exit (no coverage written).
    for _ in 0..2 {
        let _input = fuzzer.get_next_input().unwrap();
        let result = fuzzer.report_result(ExitKind::Crash, 1_000.0).unwrap();
        assert_eq!(result, IterationResult::Solution);
    }

    // User seeds crashed → auto-seeds are queued. Drain them with Crash too.
    for _ in 0..DEFAULT_SEEDS.len() {
        let _input = fuzzer.get_next_input().unwrap();
        let result = fuzzer.report_result(ExitKind::Crash, 1_000.0).unwrap();
        assert_eq!(result, IterationResult::Solution);
    }

    // Next call should error - all seeds crashed, corpus empty.
    let result = fuzzer.get_next_input();
    assert!(
        result.is_err(),
        "expected error after all seeds crash without coverage"
    );
    let msg = result.err().unwrap().to_string();
    assert!(
        msg.contains("corpus is empty"),
        "expected 'corpus is empty' in error, got: {msg}"
    );
}

/// When at least one seed produces novel coverage, the fuzzer transitions
/// to normal mutation-based fuzzing.
#[test]
fn seed_with_coverage_transitions_to_normal_fuzzing() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(64).build();

    fuzzer
        .add_seed(Buffer::from(b"no cov seed".to_vec()))
        .unwrap();
    fuzzer.add_seed(Buffer::from(b"cov seed".to_vec())).unwrap();

    // First seed: no coverage → NotInteresting.
    let _input = fuzzer.get_next_input().unwrap();
    let result = fuzzer.report_result(ExitKind::Ok, 1_000.0).unwrap();
    assert_eq!(result, IterationResult::None);

    // Second seed: write novel coverage → Interesting.
    let _input = fuzzer.get_next_input().unwrap();
    // SAFETY: index 5 is within the 64-byte map; no other observer is live.
    unsafe {
        *fuzzer.map_ptr.add(5) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 1_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    // Calibrate the interesting entry (required before scheduler can select it).
    loop {
        // SAFETY: index 5 is within the 64-byte map; no other observer is live.
        unsafe {
            *fuzzer.map_ptr.add(5) = 1;
        }
        if !fuzzer.calibrate_run(1_000.0).unwrap() {
            break;
        }
    }
    fuzzer.calibrate_finish().unwrap();

    // Next get_next_input should succeed - scheduler selects from corpus.
    let input = fuzzer.get_next_input();
    assert!(
        input.is_ok(),
        "should succeed with corpus entry available: {:?}",
        input.err()
    );
}
