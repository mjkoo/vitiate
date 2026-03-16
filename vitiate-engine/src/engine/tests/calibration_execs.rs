use super::helpers::{TestFuzzerBuilder, make_seed_testcase};
use crate::types::{ExitKind, IterationResult};
use libafl::corpus::Corpus;
use libafl::inputs::BytesInput;
use libafl::schedulers::Scheduler;
use libafl::state::HasCorpus;

#[test]
fn calibration_execs_starts_at_zero() {
    let fuzzer = TestFuzzerBuilder::new(256).build();
    assert_eq!(fuzzer.stats().calibration_execs, 0);
}

#[test]
fn calibrate_run_increments_calibration_execs() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add a seed so the scheduler has something to select.
    let seed_tc = make_seed_testcase(b"seed");
    let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
    fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

    // Simulate get_next_input + novel coverage -> Interesting.
    fuzzer.last_input = Some(BytesInput::new(b"test".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: index 10 is within 256-byte map bounds; no other observer is live.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    // Run 3 calibration iterations (report_result counted as iteration 1).
    for i in 0..3 {
        // SAFETY: index 10 is within 256-byte map bounds.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.calibrate_run(50_000.0).unwrap();
        assert_eq!(
            fuzzer.stats().calibration_execs,
            (i + 1) as i64,
            "calibration_execs should be {} after {} calibrate_run calls",
            i + 1,
            i + 1
        );
    }

    fuzzer.calibrate_finish().unwrap();
    // calibration_execs persists after finish.
    assert_eq!(fuzzer.stats().calibration_execs, 3);
}

#[test]
fn calibrate_run_does_not_increment_total_execs() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    let seed_tc = make_seed_testcase(b"seed");
    let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
    fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

    fuzzer.last_input = Some(BytesInput::new(b"test".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: index 10 is within bounds.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    let total_after_report = fuzzer.stats().total_execs;

    // Run calibration iterations.
    for _ in 0..3 {
        // SAFETY: index 10 is within bounds.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.calibrate_run(50_000.0).unwrap();
    }
    fuzzer.calibrate_finish().unwrap();

    assert_eq!(
        fuzzer.stats().total_execs,
        total_after_report,
        "total_execs should not change during calibration"
    );
}

#[test]
fn calibration_execs_accumulate_across_entries() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    let seed_tc = make_seed_testcase(b"seed");
    let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
    fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

    // First interesting input -> calibration.
    fuzzer.last_input = Some(BytesInput::new(b"input1".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: index 10 is within bounds.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();

    for _ in 0..3 {
        // SAFETY: index 10 is within bounds.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.calibrate_run(50_000.0).unwrap();
    }
    fuzzer.calibrate_finish().unwrap();
    assert_eq!(fuzzer.stats().calibration_execs, 3);

    // Second interesting input -> more calibration.
    fuzzer.last_input = Some(BytesInput::new(b"input2".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: index 20 is within bounds, novel coverage.
    unsafe {
        *fuzzer.map_ptr.add(20) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    for _ in 0..3 {
        // SAFETY: index 20 is within bounds.
        unsafe {
            *fuzzer.map_ptr.add(20) = 1;
        }
        let _ = fuzzer.calibrate_run(50_000.0).unwrap();
    }
    fuzzer.calibrate_finish().unwrap();

    assert_eq!(
        fuzzer.stats().calibration_execs,
        6,
        "calibration_execs should accumulate across multiple calibrated entries"
    );
}
