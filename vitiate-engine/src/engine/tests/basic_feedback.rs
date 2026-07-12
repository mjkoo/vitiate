use super::helpers::{
    TestFuzzerBuilder, make_coverage_map, make_scheduler, make_seed_testcase,
    make_state_and_feedback,
};
use crate::cmplog;
use crate::engine::EDGES_OBSERVER_NAME;
use crate::types::{ExitKind, IterationResult};
use libafl::corpus::Corpus;
use libafl::corpus::Testcase;
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::StateInitializer;
use libafl::feedbacks::{CrashFeedback, Feedback};
use libafl::inputs::BytesInput;
use libafl::observers::StdMapObserver;
use libafl::schedulers::Scheduler;
use libafl::state::{HasCorpus, HasSolutions};
use libafl_bolts::tuples::tuple_list;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_new_state_is_empty() {
    let (map_ptr, _map) = make_coverage_map(65536);
    let (state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    assert_eq!(state.corpus().count(), 0);
    assert_eq!(state.solutions().count(), 0);
}

#[test]
fn test_add_seed() {
    let (map_ptr, _map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    let testcase = make_seed_testcase(b"hello");
    let id = state.corpus_mut().add(testcase).unwrap();
    scheduler.on_add(&mut state, id).unwrap();

    assert_eq!(state.corpus().count(), 1);
}

#[test]
fn test_novel_coverage_is_interesting() {
    let (map_ptr, mut map) = make_coverage_map(65536);
    let (mut state, mut feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
    let mut mgr = NopEventManager::new();
    let input = BytesInput::new(b"test".to_vec());

    // Simulate novel coverage.
    map[0] = 1;
    map[42] = 3;

    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);

    let interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &input,
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(interesting);
}

#[test]
fn test_duplicate_coverage_not_interesting() {
    let (map_ptr, mut map) = make_coverage_map(65536);
    let (mut state, mut feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
    let mut mgr = NopEventManager::new();
    let input = BytesInput::new(b"test".to_vec());

    // First report: novel.
    map[0] = 1;
    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);
    let interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &input,
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(interesting);

    // Must call append_metadata to update history.
    let mut testcase = Testcase::new(input.clone());
    feedback
        .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
        .unwrap();

    // Zero and set same coverage again.
    map.fill(0);
    map[0] = 1;
    let observer2 =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers2 = tuple_list!(observer2);
    let interesting2 = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &input,
            &observers2,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(!interesting2);
}

#[test]
fn test_classify_counts_bucket_bits() {
    // The classification table maps each raw count to a one-hot bit identifying
    // its AFL hit-count bucket (count_class_lookup8), so OR-reduction feedback
    // admits on any never-seen (edge, bucket) feature.
    use crate::engine::classify_counts_in_place;

    let mut map: Vec<u8> = (0..=255u16).map(|v| v as u8).collect();
    classify_counts_in_place(&mut map);

    // One-hot bucket bits at each AFL bucket boundary.
    assert_eq!(map[0], 0);
    assert_eq!(map[1], 0x01);
    assert_eq!(map[2], 0x02);
    assert_eq!(map[3], 0x04);
    assert_eq!(map[4], 0x08);
    assert_eq!(map[7], 0x08);
    assert_eq!(map[8], 0x10);
    assert_eq!(map[15], 0x10);
    assert_eq!(map[16], 0x20);
    assert_eq!(map[31], 0x20);
    assert_eq!(map[32], 0x40);
    assert_eq!(map[127], 0x40);
    assert_eq!(map[128], 0x80);
    assert_eq!(map[255], 0x80);

    for (raw, &bit) in map.iter().enumerate() {
        // Nonzero counts stay nonzero (preserves bitmap_size / covered indices).
        assert_eq!(bit == 0, raw == 0, "nonzero-ness preserved at {raw}");
        // Exactly one bucket bit per nonzero count.
        if raw > 0 {
            assert_eq!(bit.count_ones(), 1, "not one-hot at {raw}");
        }
    }
}

#[test]
fn test_admission_keys_on_hitcount_bucket_features() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
    // Corpus admission keys on the set of (edge, hit-count-bucket) features
    // seen so far, matching AFL's virgin bitmap / libFuzzer's feature set. An
    // input that raises an edge's count within an already-seen bucket must NOT
    // be admitted; any never-seen bucket - higher OR lower than previous
    // observations - MUST be admitted.
    let mut fuzzer = TestFuzzerBuilder::new(256).build();
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // Iteration 1: establish history at edge 10 with count 4 (bucket [4,7]).
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 4;
    }
    let r1 = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(r1, IterationResult::Interesting, "first coverage is novel");
    fuzzer.calibrate_finish().unwrap();
    assert_eq!(fuzzer.state.corpus().count(), 1);

    // Iteration 2: same edge, count 5 -> raw 5 > 4, but still bucket [4,7].
    // Feature-set admission must reject this.
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 5;
    }
    let r2 = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(
        r2,
        IterationResult::None,
        "higher count within the same hit-count bucket must not be admitted"
    );
    assert_eq!(
        fuzzer.state.corpus().count(),
        1,
        "no corpus entry added for same-bucket input"
    );

    // Iteration 3: same edge, count 8 -> bucket [8,15], a new bucket.
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 8;
    }
    let r3 = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(
        r3,
        IterationResult::Interesting,
        "crossing into a higher hit-count bucket must be admitted"
    );
    fuzzer.calibrate_finish().unwrap();
    assert_eq!(fuzzer.state.corpus().count(), 2);

    // Iteration 4: same edge, count 2 -> bucket [2,2]. Lower than every
    // previous observation, but a never-seen feature: set semantics MUST admit
    // it (max-over-buckets admission wrongly rejected exactly this case).
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 2;
    }
    let r4 = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(
        r4,
        IterationResult::Interesting,
        "a never-seen lower hit-count bucket must be admitted"
    );
    fuzzer.calibrate_finish().unwrap();
    assert_eq!(fuzzer.state.corpus().count(), 3);

    // Iteration 5: count 2 again - the bucket is now seen, so no re-admission.
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 2;
    }
    let r5 = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(
        r5,
        IterationResult::None,
        "an already-seen bucket must not be re-admitted"
    );
    assert_eq!(fuzzer.state.corpus().count(), 3);
}

#[test]
fn test_crash_detection() {
    let (map_ptr, map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
    let mut crash_obj = CrashFeedback::new();
    crash_obj.init_state(&mut state).unwrap();
    let mut mgr = NopEventManager::new();
    let input = BytesInput::new(b"crash_input".to_vec());

    let observer = unsafe {
        StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_ptr() as *mut u8, map.len())
    };
    let observers = tuple_list!(observer);

    let is_crash = crash_obj
        .is_interesting(
            &mut state,
            &mut mgr,
            &input,
            &observers,
            &LibaflExitKind::Crash,
        )
        .unwrap();
    assert!(is_crash);

    let is_ok = crash_obj
        .is_interesting(
            &mut state,
            &mut mgr,
            &input,
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(!is_ok);
}

#[test]
fn test_solution_added_on_crash() {
    let (map_ptr, map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
    let mut crash_obj = CrashFeedback::new();
    crash_obj.init_state(&mut state).unwrap();
    let mut mgr = NopEventManager::new();
    let input = BytesInput::new(b"crash_input".to_vec());

    let observer = unsafe {
        StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_ptr() as *mut u8, map.len())
    };
    let observers = tuple_list!(observer);

    // Crash objective should fire on ExitKind::Crash.
    let is_crash = crash_obj
        .is_interesting(
            &mut state,
            &mut mgr,
            &input,
            &observers,
            &LibaflExitKind::Crash,
        )
        .unwrap();
    assert!(is_crash);

    // Add to solutions corpus.
    let testcase = Testcase::new(input);
    state.solutions_mut().add(testcase).unwrap();
    assert_eq!(state.solutions().count(), 1);
}

#[test]
fn test_coverage_map_pointer_stash() {
    // Verify that an observer created from a raw pointer correctly reads
    // data written through that pointer (simulates JS writing to the buffer).
    let (map_ptr, map) = make_coverage_map(1024);

    // Write through the raw pointer (simulating JS instrumentation writing to the buffer).
    unsafe {
        *map_ptr.add(10) = 5;
        *map_ptr.add(100) = 42;
    }

    // Create observer from the same pointer - it should see the writes.
    let observer = unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map.len()) };

    // Verify observer reads the written values.

    assert_eq!(observer.get(10), Some(&5));
    assert_eq!(observer.get(100), Some(&42));
    assert_eq!(observer.first(), Some(&0)); // untouched position

    // Also verify the underlying map was modified.
    assert_eq!(map[10], 5);
    assert_eq!(map[100], 42);
}
