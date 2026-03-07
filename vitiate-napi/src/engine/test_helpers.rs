use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, Testcase};
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::{
    CrashFeedback, Feedback, MapIndexesMetadata, MapNoveltiesMetadata, MaxMapFeedback,
    StateInitializer, TimeoutFeedback,
};
use libafl::inputs::BytesInput;
use libafl::mutators::token_mutations::AflppRedQueen;
use libafl::mutators::{HavocScheduledMutator, havoc_mutations, tokens_mutations};
use libafl::observers::StdMapObserver;
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata, CmplogBytes};
use libafl::observers::map::CanTrack;
use libafl::schedulers::minimizer::TopRatedsMetadata;
use libafl::schedulers::powersched::{PowerSchedule, SchedulerMetadata};
use libafl::schedulers::{MinimizerScheduler, ProbabilitySamplingScheduler, Scheduler};
use libafl::state::{HasCorpus, HasMaxSize};
use libafl_bolts::rands::StdRand;
use libafl_bolts::tuples::{Merge, tuple_list};
use napi::bindgen_prelude::*;

use super::{
    CrashObjective, DEFAULT_MAX_INPUT_LEN, EDGES_OBSERVER_NAME, Fuzzer, FuzzerFeedback,
    FuzzerScheduler, FuzzerState, GRIMOIRE_MAX_STACK_POW, I2SSpliceReplace, SEED_EXEC_TIME,
    StageState, TimeoutObjective, UNICODE_MAX_STACK_POW,
};
use crate::cmplog;
use crate::types::{ExitKind, IterationResult};

// # Safety patterns used throughout this module
//
// Most test helpers construct a `StdMapObserver::from_mut_ptr` from a raw
// pointer into a `Vec<u8>` or napi `Buffer`. This is sound because:
//
// 1. The backing allocation (`Vec` / `Buffer`) is kept alive for the entire
//    lifetime of the `Fuzzer` or the test scope — the observer never outlives
//    the allocation it points into.
// 2. Only one `StdMapObserver` over the same pointer is live at any time.
//    Temporary observers (used to seed feedback history) are dropped inside
//    the block before the function returns.
// 3. `ptr::write_bytes` calls zero the coverage map between phases; the
//    pointer and length originate from the same `Vec` / `Buffer`, so the
//    write stays in bounds.
//
// The model for per-site SAFETY comments is `make_scheduler` (below).

use libafl::corpus::SchedulerTestcaseMetadata;
use libafl::mutators::grimoire::{
    GrimoireExtensionMutator, GrimoireRandomDeleteMutator, GrimoireRecursiveReplacementMutator,
    GrimoireStringReplacementMutator,
};
use libafl::mutators::unicode::{
    UnicodeCategoryRandMutator, UnicodeCategoryTokenReplaceMutator, UnicodeSubcategoryRandMutator,
    UnicodeSubcategoryTokenReplaceMutator,
};
use libafl::state::StdState;

pub(crate) fn make_coverage_map(size: usize) -> (*mut u8, Vec<u8>) {
    let mut map = vec![0u8; size];
    let ptr = map.as_mut_ptr();
    (ptr, map)
}

pub(crate) fn make_state_and_feedback(
    map_ptr: *mut u8,
    map_len: usize,
) -> (FuzzerState, FuzzerFeedback, CrashObjective) {
    // SAFETY: map_ptr/map_len come from caller's Vec; observer is dropped before returning.
    let observer = unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };
    let mut feedback = MaxMapFeedback::new(&observer);
    let mut objective = CrashFeedback::new();

    let mut state = StdState::new(
        StdRand::with_seed(42),
        InMemoryCorpus::<BytesInput>::new(),
        InMemoryCorpus::new(),
        &mut feedback,
        &mut objective,
    )
    .unwrap();

    // Initialize SchedulerMetadata (required by CorpusPowerTestcaseScore).
    state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));
    // Initialize TopRatedsMetadata (required by MinimizerScheduler).
    state.add_metadata(TopRatedsMetadata::new());

    drop(observer);
    (state, feedback, objective)
}

/// Create a MinimizerScheduler wrapping ProbabilitySamplingScheduler for tests.
///
/// # Safety
/// Creates a temporary `StdMapObserver` from `map_ptr`. The observer is consumed
/// by `track_indices()` and the tracking wrapper is dropped before returning,
/// so no observer aliases persist. Callers must ensure no other live observer
/// holds `map_ptr` at call time.
pub(crate) fn make_scheduler(map_ptr: *mut u8, map_len: usize) -> FuzzerScheduler {
    let observer = unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };
    let tracking = observer.track_indices();
    let scheduler = MinimizerScheduler::new(&tracking, ProbabilitySamplingScheduler::new());
    drop(tracking);
    scheduler
}

/// Create a seed testcase with scheduler metadata (required by CorpusPowerTestcaseScore)
/// and empty MapIndexesMetadata (required by MinimizerScheduler::update_score).
pub(crate) fn make_seed_testcase(data: &[u8]) -> Testcase<BytesInput> {
    let mut tc = Testcase::new(BytesInput::new(data.to_vec()));
    tc.set_exec_time(SEED_EXEC_TIME);
    let mut meta = SchedulerTestcaseMetadata::new(0);
    meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
    tc.add_metadata(meta);
    tc.add_metadata(MapIndexesMetadata::new(vec![]));
    tc
}

/// Build a full Fuzzer for integration-style tests using raw pointer/map.
pub(crate) fn make_fuzzer(
    map_ptr: *mut u8,
    map_len: usize,
) -> (
    FuzzerState,
    FuzzerFeedback,
    FuzzerScheduler,
    CrashObjective,
    TimeoutObjective,
) {
    // SAFETY: map_ptr/map_len come from caller's Vec; observer consumed by track_indices below.
    let observer = unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };
    let mut feedback = MaxMapFeedback::new(&observer);
    let mut crash_objective = CrashFeedback::new();

    let mut state = StdState::new(
        StdRand::with_seed(42),
        InMemoryCorpus::<BytesInput>::new(),
        InMemoryCorpus::new(),
        &mut feedback,
        &mut crash_objective,
    )
    .unwrap();

    let mut timeout_objective = TimeoutFeedback::new();
    timeout_objective.init_state(&mut state).unwrap();

    state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));
    state.add_metadata(TopRatedsMetadata::new());
    state.metadata_map_mut().insert(CmpValuesMetadata::new());

    let tracking = observer.track_indices();
    let scheduler = MinimizerScheduler::new(&tracking, ProbabilitySamplingScheduler::new());
    drop(tracking);
    (
        state,
        feedback,
        scheduler,
        crash_objective,
        timeout_objective,
    )
}

pub(crate) fn make_test_fuzzer(map_size: usize) -> Fuzzer {
    let mut coverage_map: Buffer = vec![0u8; map_size].into();
    let map_ptr = coverage_map.as_mut_ptr();
    let map_len = coverage_map.len();

    // SAFETY: coverage_map Buffer outlives Fuzzer; observer is consumed by track_indices below.
    let temp_observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };

    let mut feedback = MaxMapFeedback::new(&temp_observer);
    let mut crash_objective = CrashFeedback::new();
    let mut timeout_objective = TimeoutFeedback::new();

    let mut state = StdState::new(
        StdRand::with_seed(42),
        InMemoryCorpus::<BytesInput>::new(),
        InMemoryCorpus::new(),
        &mut feedback,
        &mut crash_objective,
    )
    .unwrap();

    timeout_objective.init_state(&mut state).unwrap();

    let tracking_observer = temp_observer.track_indices();
    let scheduler =
        MinimizerScheduler::new(&tracking_observer, ProbabilitySamplingScheduler::new());
    let mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));
    let i2s_mutator = I2SSpliceReplace::new();
    let grimoire_mutator = HavocScheduledMutator::with_max_stack_pow(
        tuple_list!(
            GrimoireExtensionMutator::new(),
            GrimoireRecursiveReplacementMutator::new(),
            GrimoireStringReplacementMutator::new(),
            // Two delete mutators: matches LibAFL's default grimoire mutations,
            // which intentionally double-weights deletions.
            GrimoireRandomDeleteMutator::new(),
            GrimoireRandomDeleteMutator::new(),
        ),
        GRIMOIRE_MAX_STACK_POW,
    );
    let unicode_mutator = HavocScheduledMutator::with_max_stack_pow(
        tuple_list!(
            UnicodeCategoryRandMutator,
            UnicodeSubcategoryRandMutator,
            UnicodeSubcategoryRandMutator,
            UnicodeSubcategoryRandMutator,
            UnicodeSubcategoryRandMutator,
            UnicodeCategoryTokenReplaceMutator,
            UnicodeSubcategoryTokenReplaceMutator,
            UnicodeSubcategoryTokenReplaceMutator,
            UnicodeSubcategoryTokenReplaceMutator,
            UnicodeSubcategoryTokenReplaceMutator,
        ),
        UNICODE_MAX_STACK_POW,
    );

    drop(tracking_observer);

    state.set_max_size(DEFAULT_MAX_INPUT_LEN as usize);
    state.metadata_map_mut().insert(CmpValuesMetadata::new());
    state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));
    state.add_metadata(TopRatedsMetadata::new());

    Fuzzer {
        state,
        scheduler,
        feedback,
        crash_objective,
        timeout_objective,
        mutator,
        i2s_mutator,
        grimoire_mutator,
        redqueen_mutator: AflppRedQueen::with_cmplog_options(true, true),
        redqueen_enabled: false,
        redqueen_ran_for_entry: false,
        redqueen_override: None,
        unicode_mutator,
        map_ptr,
        map_len,
        _coverage_map: coverage_map,
        max_input_len: DEFAULT_MAX_INPUT_LEN,
        total_execs: 0,
        solution_count: 0,
        start_time: Instant::now(),
        last_input: None,
        last_corpus_id: None,
        calibration_corpus_id: None,
        calibration_first_map: None,
        calibration_history_map: None,
        calibration_total_time: Duration::ZERO,
        calibration_iterations: 0,
        calibration_has_unstable: false,
        unstable_entries: HashSet::new(),
        token_candidates: HashMap::new(),
        promoted_tokens: HashSet::new(),
        stage_state: StageState::None,
        last_interesting_corpus_id: None,
        last_stage_input: None,
        grimoire_enabled: false,
        unicode_enabled: false,
        grimoire_override: None,
        unicode_override: None,
        deferred_detection_count: Some(0),
        auto_seed_count: 0,
    }
}

pub(crate) fn make_fuzzer_ready_for_stage(map_size: usize) -> Fuzzer {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = make_test_fuzzer(map_size);
    cmplog::enable();

    // Add a seed so the scheduler has something to select.
    fuzzer
        .add_seed(Buffer::from(b"seed_for_stage_test".to_vec()))
        .unwrap();

    // Simulate getNextInput to set last_input and last_corpus_id.
    let _ = fuzzer.get_next_input().unwrap();

    // Write novel coverage to trigger Interesting.
    // SAFETY: index 42 is within map_size bounds; no other observer is live.
    unsafe {
        *fuzzer.map_ptr.add(42) = 1;
    }

    // Push CmpLog entries so beginStage has data to work with.
    cmplog::push(
        CmpValues::Bytes((make_cmplog_bytes(b"hello"), make_cmplog_bytes(b"world"))),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    // report_result will evaluate coverage, drain CmpLog, and set
    // last_interesting_corpus_id if interesting.
    let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(
        result,
        IterationResult::Interesting,
        "should be Interesting for novel coverage"
    );

    // Simulate calibration (required before beginStage).
    // Write the same coverage for calibration runs.
    for _ in 0..3 {
        // SAFETY: index 42 is within map_size bounds; no other observer is live.
        unsafe {
            *fuzzer.map_ptr.add(42) = 1;
        }
        let needs_more = fuzzer.calibrate_run(50_000.0).unwrap();
        if !needs_more {
            break;
        }
    }
    fuzzer.calibrate_finish().unwrap();

    fuzzer
}

pub(crate) fn make_cmplog_bytes(data: &[u8]) -> CmplogBytes {
    let len = data.len().min(32) as u8;
    let mut buf = [0u8; 32];
    buf[..len as usize].copy_from_slice(&data[..len as usize]);
    CmplogBytes::from_buf_and_len(buf, len)
}

/// Create a fuzzer with a UTF-8 corpus entry ready for unicode stage testing.
///
/// Returns `(Fuzzer, CorpusId)` where the corpus entry contains the provided
/// input bytes and the fuzzer has `unicode_enabled = true`.
pub(crate) fn make_fuzzer_with_unicode_entry(map_size: usize, input: &[u8]) -> (Fuzzer, CorpusId) {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = make_test_fuzzer(map_size);
    fuzzer.unicode_enabled = true;
    fuzzer.deferred_detection_count = None;
    cmplog::enable();

    // Add a seed so scheduler works.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Add a corpus entry (UTF-8 input).
    let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
    testcase.add_metadata(MapNoveltiesMetadata::new(vec![10]));
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_n_fuzz_entry(0);
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![10]));
    *testcase.exec_time_mut() = Some(Duration::from_micros(100));

    let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
    fuzzer
        .scheduler
        .on_add(&mut fuzzer.state, corpus_id)
        .unwrap();

    // Establish coverage history.
    // SAFETY: index 10 is within map_size bounds; no other observer is live.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    {
        // SAFETY: temporary observer; dropped at end of block before returning.
        let observer = unsafe {
            StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, fuzzer.map_ptr, fuzzer.map_len)
        };
        let observers = tuple_list!(observer);
        let mut mgr = NopEventManager::new();
        let bytes_input = BytesInput::new(input.to_vec());
        let _ = fuzzer.feedback.is_interesting(
            &mut fuzzer.state,
            &mut mgr,
            &bytes_input,
            &observers,
            &LibaflExitKind::Ok,
        );
    }
    // SAFETY: zeroes the full map; pointer and length from same Buffer.
    unsafe {
        std::ptr::write_bytes(fuzzer.map_ptr, 0, fuzzer.map_len);
    }

    (fuzzer, corpus_id)
}

/// Create a fuzzer with a corpus entry that has GeneralizedInputMetadata,
/// ready for the Grimoire stage. Used by grimoire tests and pipeline tests.
pub(crate) fn make_fuzzer_with_grimoire_entry(map_size: usize, input: &[u8]) -> (Fuzzer, CorpusId) {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = make_test_fuzzer(map_size);
    fuzzer.grimoire_enabled = true;
    fuzzer.deferred_detection_count = None;
    cmplog::enable();

    // Add a seed so scheduler works.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Add a corpus entry with GeneralizedInputMetadata.
    let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
    testcase.add_metadata(MapNoveltiesMetadata::new(vec![10]));
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_n_fuzz_entry(0);
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![10]));
    *testcase.exec_time_mut() = Some(Duration::from_micros(100));

    // Create a simple GeneralizedInputMetadata.
    let payload: Vec<Option<u8>> = input.iter().map(|&b| Some(b)).collect();
    testcase.add_metadata(Fuzzer::payload_to_generalized(&payload));

    let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
    fuzzer
        .scheduler
        .on_add(&mut fuzzer.state, corpus_id)
        .unwrap();

    // Establish coverage history.
    // SAFETY: index 10 is within map_size bounds; no other observer is live.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    {
        // SAFETY: temporary observer; dropped at end of block before returning.
        let observer = unsafe {
            StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, fuzzer.map_ptr, fuzzer.map_len)
        };
        let observers = tuple_list!(observer);
        let mut mgr = NopEventManager::new();
        let bytes_input = BytesInput::new(input.to_vec());
        let _ = fuzzer.feedback.is_interesting(
            &mut fuzzer.state,
            &mut mgr,
            &bytes_input,
            &observers,
            &LibaflExitKind::Ok,
        );
    }
    // SAFETY: zeroes the full map; pointer and length from same Buffer.
    unsafe {
        std::ptr::write_bytes(fuzzer.map_ptr, 0, fuzzer.map_len);
    }

    (fuzzer, corpus_id)
}

/// Create a fuzzer with grimoire enabled and a corpus entry at the given
/// novelty map indices. Returns (fuzzer, corpus_id).
/// Used by generalization tests and pipeline tests.
pub(crate) fn make_fuzzer_with_generalization_entry(
    map_size: usize,
    input: &[u8],
    novelty_indices: &[usize],
) -> (Fuzzer, CorpusId) {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = make_test_fuzzer(map_size);
    fuzzer.grimoire_enabled = true;
    fuzzer.deferred_detection_count = None;
    cmplog::enable();

    // Add a seed so the scheduler has something.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Manually add a corpus entry with the given input and novelty metadata.
    let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
    testcase.add_metadata(MapNoveltiesMetadata::new(novelty_indices.to_vec()));

    // We need to add scheduler metadata too.
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_n_fuzz_entry(0);
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(novelty_indices.to_vec()));
    *testcase.exec_time_mut() = Some(Duration::from_micros(100));

    let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
    fuzzer
        .scheduler
        .on_add(&mut fuzzer.state, corpus_id)
        .unwrap();

    // Also need to make sure the feedback history knows about these indices
    // so they're recognized as "known" coverage.
    // Write coverage at novelty indices and evaluate to establish history.
    for &idx in novelty_indices {
        // SAFETY: caller must supply indices within map_size; no other observer is live.
        unsafe {
            *fuzzer.map_ptr.add(idx) = 1;
        }
    }
    {
        // SAFETY: temporary observer; dropped at end of block before returning.
        let observer = unsafe {
            StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, fuzzer.map_ptr, fuzzer.map_len)
        };
        let observers = tuple_list!(observer);
        let mut mgr = NopEventManager::new();
        let bytes_input = BytesInput::new(input.to_vec());
        // This call updates the feedback's history map.
        let _ = fuzzer.feedback.is_interesting(
            &mut fuzzer.state,
            &mut mgr,
            &bytes_input,
            &observers,
            &LibaflExitKind::Ok,
        );
    }
    // SAFETY: zeroes the full map; pointer and length from same Buffer.
    unsafe {
        std::ptr::write_bytes(fuzzer.map_ptr, 0, fuzzer.map_len);
    }

    (fuzzer, corpus_id)
}
