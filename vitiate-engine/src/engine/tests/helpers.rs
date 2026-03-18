use std::time::Duration;

use libafl::HasMetadata;

/// Nominal execution time assigned to seeds when manually constructing
/// testcases in test helpers (not used in production - seeds are evaluated
/// through the normal coverage pipeline).
pub(crate) const SEED_EXEC_TIME: Duration = Duration::from_millis(1);
use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, SchedulerTestcaseMetadata, Testcase};
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::{
    CrashFeedback, Feedback, MapIndexesMetadata, MapNoveltiesMetadata, MaxMapFeedback,
    StateInitializer, TimeoutFeedback,
};
use libafl::inputs::{BytesInput, GeneralizedInputMetadata};
use libafl::observers::StdMapObserver;
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata, CmplogBytes};
use libafl::observers::map::CanTrack;
use libafl::schedulers::minimizer::TopRatedsMetadata;
use libafl::schedulers::powersched::{PowerSchedule, SchedulerMetadata};
use libafl::schedulers::{MinimizerScheduler, ProbabilitySamplingScheduler, Scheduler};
use libafl::state::{HasCorpus, StdState};
use libafl_bolts::rands::StdRand;
use libafl_bolts::tuples::tuple_list;
use napi::bindgen_prelude::*;

use crate::cmplog;
use crate::engine::{
    CrashObjective, EDGES_OBSERVER_NAME, Fuzzer, FuzzerFeedback, FuzzerScheduler, FuzzerState,
    StageState, TimeoutObjective,
};
use crate::types::{ExitKind, FuzzerConfig, IterationResult};

// # Safety patterns used throughout this module
//
// Most test helpers construct a `StdMapObserver::from_mut_ptr` from a raw
// pointer into a `Vec<u8>` or napi `Buffer`. This is sound because:
//
// 1. The backing allocation (`Vec` / `Buffer`) is kept alive for the entire
//    lifetime of the `Fuzzer` or the test scope - the observer never outlives
//    the allocation it points into.
// 2. Only one `StdMapObserver` over the same pointer is live at any time.
//    Temporary observers (used to seed feedback history) are dropped inside
//    the block before the function returns.
// 3. `ptr::write_bytes` calls zero the coverage map between phases; the
//    pointer and length originate from the same `Vec` / `Buffer`, so the
//    write stays in bounds.
//
// The model for per-site SAFETY comments is `make_scheduler` (below).

pub(super) fn make_coverage_map(size: usize) -> (*mut u8, Vec<u8>) {
    let mut map = vec![0u8; size];
    let ptr = map.as_mut_ptr();
    (ptr, map)
}

pub(super) fn make_state_and_feedback(
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
pub(super) fn make_scheduler(map_ptr: *mut u8, map_len: usize) -> FuzzerScheduler {
    let observer = unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };
    let tracking = observer.track_indices();
    let scheduler = MinimizerScheduler::new(&tracking, ProbabilitySamplingScheduler::new());
    drop(tracking);
    scheduler
}

/// Create a seed testcase with scheduler metadata (required by CorpusPowerTestcaseScore)
/// and empty MapIndexesMetadata (required by MinimizerScheduler::update_score).
pub(super) fn make_seed_testcase(data: &[u8]) -> Testcase<BytesInput> {
    let mut tc = Testcase::new(BytesInput::new(data.to_vec()));
    tc.set_exec_time(SEED_EXEC_TIME);
    let mut meta = SchedulerTestcaseMetadata::new(1);
    meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
    tc.add_metadata(meta);
    tc.add_metadata(MapIndexesMetadata::new(vec![]));
    tc
}

/// Build a full Fuzzer for integration-style tests using raw pointer/map.
pub(super) fn make_fuzzer(
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

pub(super) fn make_cmplog_bytes(data: &[u8]) -> CmplogBytes {
    let len = data.len().min(32) as u8;
    let mut buf = [0u8; 32];
    buf[..len as usize].copy_from_slice(&data[..len as usize]);
    CmplogBytes::from_buf_and_len(buf, len)
}

/// Force the current stage to complete on the next `advance_stage()` call.
///
/// # Panics
/// Panics if no iterative stage (I2S, Grimoire, Unicode) is active.
pub(super) fn force_single_iteration(fuzzer: &mut Fuzzer) {
    fuzzer.stage_state = match std::mem::replace(&mut fuzzer.stage_state, StageState::None) {
        StageState::I2S {
            corpus_id,
            iteration,
            ..
        } => StageState::I2S {
            corpus_id,
            iteration,
            max_iterations: iteration + 1,
        },
        StageState::Grimoire {
            corpus_id,
            iteration,
            ..
        } => StageState::Grimoire {
            corpus_id,
            iteration,
            max_iterations: iteration + 1,
        },
        StageState::Unicode {
            corpus_id,
            iteration,
            metadata,
            ..
        } => StageState::Unicode {
            corpus_id,
            iteration,
            max_iterations: iteration + 1,
            metadata,
        },
        _ => panic!("force_single_iteration: no iterative stage active"),
    };
}

/// Builder for constructing `Fuzzer` instances in tests. Wraps `Fuzzer::new()`
/// with a synthetic `Buffer`, eliminating field-by-field drift between test
/// construction and the real constructor.
pub(super) struct TestFuzzerBuilder {
    map_size: usize,
    grimoire: Option<bool>,
    unicode: Option<bool>,
    redqueen: Option<bool>,
    max_input_len: Option<u32>,
}

impl TestFuzzerBuilder {
    pub(super) fn new(map_size: usize) -> Self {
        Self {
            map_size,
            grimoire: None,
            unicode: None,
            redqueen: None,
            max_input_len: None,
        }
    }

    pub(super) fn grimoire(mut self, enabled: bool) -> Self {
        self.grimoire = Some(enabled);
        self
    }

    pub(super) fn unicode(mut self, enabled: bool) -> Self {
        self.unicode = Some(enabled);
        self
    }

    #[allow(dead_code)]
    pub(super) fn redqueen(mut self, enabled: bool) -> Self {
        self.redqueen = Some(enabled);
        self
    }

    #[allow(dead_code)]
    pub(super) fn max_input_len(mut self, len: u32) -> Self {
        self.max_input_len = Some(len);
        self
    }

    /// Build a basic `Fuzzer` instance via `Fuzzer::new()`.
    pub(super) fn build(self) -> Fuzzer {
        let config = FuzzerConfig {
            max_input_len: self.max_input_len,
            seed: Some(42), // deterministic seed for tests
            grimoire: self.grimoire,
            unicode: self.unicode,
            redqueen: self.redqueen,
            dictionary_path: None,
            detector_tokens: None,
        };
        let coverage_map: Buffer = vec![0u8; self.map_size].into();
        Fuzzer::new(coverage_map, Some(config), None, None).unwrap()
    }

    /// Build a `Fuzzer` ready for stage testing: seeded, with novel coverage
    /// reported and calibration completed.
    pub(super) fn build_ready_for_stage(self) -> Fuzzer {
        cmplog::disable();
        cmplog::drain();
        // Fuzzer::new (called by build) re-enables cmplog.
        let mut fuzzer = self.build();

        fuzzer
            .add_seed(Buffer::from(b"seed_for_stage_test".to_vec()))
            .unwrap();
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

        let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(
            result,
            IterationResult::Interesting,
            "should be Interesting for novel coverage"
        );

        // Simulate calibration (required before beginStage).
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

    /// Build a `Fuzzer` with a corpus entry at the given novelty map indices.
    /// Returns `(Fuzzer, CorpusId)`.
    ///
    /// When feature overrides are set (grimoire/unicode/redqueen), deferred
    /// detection is disabled to prevent interference.
    pub(super) fn build_with_corpus_entry(
        self,
        input: &[u8],
        novelty_indices: &[usize],
    ) -> (Fuzzer, CorpusId) {
        cmplog::disable();
        cmplog::drain();
        let has_feature_override =
            self.grimoire.is_some() || self.unicode.is_some() || self.redqueen.is_some();
        // Fuzzer::new (called by build) re-enables cmplog.
        let mut fuzzer = self.build();
        if has_feature_override {
            fuzzer.features.deferred_detection_count = None;
        }

        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
        testcase.add_metadata(MapNoveltiesMetadata::new(novelty_indices.to_vec()));
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

        // Establish coverage history at novelty indices.
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

    /// Build a `Fuzzer` with a corpus entry that has `GeneralizedInputMetadata`,
    /// ready for the Grimoire stage. Novelty index is hardcoded to `[10]`.
    pub(super) fn build_with_grimoire_entry(self, input: &[u8]) -> (Fuzzer, CorpusId) {
        cmplog::disable();
        cmplog::drain();
        let has_feature_override =
            self.grimoire.is_some() || self.unicode.is_some() || self.redqueen.is_some();
        // Fuzzer::new (called by build) re-enables cmplog.
        let mut fuzzer = self.build();
        if has_feature_override {
            fuzzer.features.deferred_detection_count = None;
        }

        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
        testcase.add_metadata(MapNoveltiesMetadata::new(vec![10]));
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_n_fuzz_entry(0);
        testcase.add_metadata(sched_meta);
        testcase.add_metadata(MapIndexesMetadata::new(vec![10]));
        *testcase.exec_time_mut() = Some(Duration::from_micros(100));

        // Create GeneralizedInputMetadata from the input bytes.
        let payload: Vec<Option<u8>> = input.iter().map(|&b| Some(b)).collect();
        testcase.add_metadata(GeneralizedInputMetadata::generalized_from_options(&payload));

        let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
        fuzzer
            .scheduler
            .on_add(&mut fuzzer.state, corpus_id)
            .unwrap();

        // Establish coverage history at index 10.
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
}
