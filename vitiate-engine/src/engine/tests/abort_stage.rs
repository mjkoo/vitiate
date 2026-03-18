use super::helpers::TestFuzzerBuilder;
use crate::cmplog;
use crate::types::ExitKind;
use libafl::corpus::Corpus;
use libafl::state::HasSolutions;

#[test]
fn test_abort_stage_records_crash_as_solution() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some(), "stage should start");

    let solutions_before = fuzzer.solution_count;
    let solutions_corpus_before = fuzzer.state.solutions().count();

    fuzzer.abort_stage(ExitKind::Crash).unwrap();

    assert_eq!(
        fuzzer.solution_count,
        solutions_before + 1,
        "solution_count should increment on crash abort"
    );
    assert_eq!(
        fuzzer.state.solutions().count(),
        solutions_corpus_before + 1,
        "solutions corpus should have the crash input"
    );
}

#[test]
fn test_abort_stage_records_timeout_as_solution() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some(), "stage should start");

    let solutions_before = fuzzer.solution_count;
    let solutions_corpus_before = fuzzer.state.solutions().count();

    fuzzer.abort_stage(ExitKind::Timeout).unwrap();

    assert_eq!(
        fuzzer.solution_count,
        solutions_before + 1,
        "solution_count should increment on timeout abort"
    );
    assert_eq!(
        fuzzer.state.solutions().count(),
        solutions_corpus_before + 1,
        "solutions corpus should have the timeout input"
    );
}

#[test]
fn test_abort_stage_ok_does_not_record_solution() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

    let first = fuzzer.begin_stage().unwrap();
    assert!(first.is_some(), "stage should start");

    let solutions_before = fuzzer.solution_count;

    fuzzer.abort_stage(ExitKind::Ok).unwrap();

    assert_eq!(
        fuzzer.solution_count, solutions_before,
        "solution_count should not change on Ok abort"
    );
}
