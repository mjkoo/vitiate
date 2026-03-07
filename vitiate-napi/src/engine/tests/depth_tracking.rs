use super::helpers::{TestFuzzerBuilder, make_coverage_map, make_fuzzer, make_seed_testcase};
use crate::engine::EDGES_OBSERVER_NAME;
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::Corpus;
use libafl::corpus::SchedulerTestcaseMetadata;
use libafl::corpus::Testcase;
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::{Feedback, MapIndexesMetadata};
use libafl::inputs::BytesInput;
use libafl::observers::StdMapObserver;
use libafl::schedulers::Scheduler;
use libafl::state::HasCorpus;
use libafl_bolts::tuples::tuple_list;
use napi::bindgen_prelude::Buffer;
use std::time::Duration;

#[test]
fn test_depth_root_entry_has_depth_zero() {
    let (map_ptr, mut map) = make_coverage_map(1024);
    let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // Add a seed and select it.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Simulate novel coverage from a first iteration (no parent).
    map[0] = 1;
    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);
    let is_interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &BytesInput::new(b"input1".to_vec()),
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(is_interesting);

    let mut testcase = Testcase::new(BytesInput::new(b"input1".to_vec()));
    testcase.set_exec_time(Duration::from_micros(100));
    feedback
        .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
        .unwrap();

    // Compute depth with no parent (last_corpus_id = None).
    let depth = 0u64; // No parent → depth 0
    let mut sched_meta = SchedulerTestcaseMetadata::new(depth);
    sched_meta.set_bitmap_size(1);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![0]));

    let id = state.corpus_mut().add(testcase).unwrap();
    scheduler.on_add(&mut state, id).unwrap();

    // Verify depth is 0.
    let tc = state.corpus().get(id).unwrap().borrow();
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    assert_eq!(meta.depth(), 0);
}

#[test]
fn test_depth_increments_from_parent() {
    let (map_ptr, mut map) = make_coverage_map(1024);
    let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // Add a seed at depth 0.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Add an interesting entry with seed as parent (depth 0 → child depth 1).
    map[0] = 1;
    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);
    let is_interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &BytesInput::new(b"child".to_vec()),
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(is_interesting);

    let mut testcase = Testcase::new(BytesInput::new(b"child".to_vec()));
    testcase.set_exec_time(Duration::from_micros(100));
    feedback
        .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
        .unwrap();

    // Read parent depth, compute child depth.
    let parent_depth = state
        .corpus()
        .get(seed_id)
        .unwrap()
        .borrow()
        .metadata::<SchedulerTestcaseMetadata>()
        .unwrap()
        .depth();
    assert_eq!(parent_depth, 0);
    let child_depth = parent_depth + 1;

    let mut sched_meta = SchedulerTestcaseMetadata::new(child_depth);
    sched_meta.set_bitmap_size(1);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![0]));

    let child_id = state.corpus_mut().add(testcase).unwrap();
    scheduler.on_add(&mut state, child_id).unwrap();

    // Verify child depth is 1.
    let tc = state.corpus().get(child_id).unwrap().borrow();
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    assert_eq!(meta.depth(), 1);
}

#[test]
fn test_depth_parent_without_metadata_defaults_to_zero() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);

    // Add an entry without SchedulerTestcaseMetadata.
    let tc = Testcase::new(BytesInput::new(b"bare".to_vec()));
    let bare_id = state.corpus_mut().add(tc).unwrap();

    // Attempt to read parent metadata — should fail, default to 0.
    let depth = match state.corpus().get(bare_id) {
        Ok(entry) => {
            let parent_tc = entry.borrow();
            match parent_tc.metadata::<SchedulerTestcaseMetadata>() {
                Ok(meta) => meta.depth() + 1,
                Err(_) => 0, // No metadata → depth 0
            }
        }
        Err(_) => 0,
    };
    assert_eq!(depth, 0);
}

#[test]
fn test_depth_chain_across_three_levels() {
    let mut fuzzer = TestFuzzerBuilder::new(1024).build();

    // Add a seed at depth 0.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // --- Level 0 → 1: first interesting input ---
    let _input = fuzzer.get_next_input().unwrap();
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));
    let id_depth1 = fuzzer
        .calibration
        .corpus_id
        .expect("should have calibration corpus_id");
    fuzzer.calibrate_finish().unwrap();

    // Verify depth 1.
    {
        let tc = fuzzer.state.corpus().get(id_depth1).unwrap().borrow();
        let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
        assert_eq!(
            meta.depth(),
            1,
            "first interesting entry should have depth 1"
        );
    }

    // --- Level 1 → 2: second interesting input (child of depth-1 entry) ---
    // Set up last_input and last_corpus_id directly (simulating get_next_input
    // having selected the depth-1 entry) to avoid a non-deterministic loop.
    fuzzer.last_input = Some(BytesInput::new(b"depth1_child".to_vec()));
    fuzzer.last_corpus_id = Some(id_depth1);

    // Trigger novel coverage at a new edge.
    unsafe {
        *fuzzer.map_ptr.add(20) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));
    let id_depth2 = fuzzer
        .calibration
        .corpus_id
        .expect("should have calibration corpus_id");
    fuzzer.calibrate_finish().unwrap();

    // Verify depth 2.
    {
        let tc = fuzzer.state.corpus().get(id_depth2).unwrap().borrow();
        let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
        assert_eq!(
            meta.depth(),
            2,
            "second interesting entry should have depth 2"
        );
    }
}
