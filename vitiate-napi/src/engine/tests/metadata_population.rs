use super::helpers::{make_coverage_map, make_fuzzer, make_scheduler, make_seed_testcase};
use crate::engine::DEFAULT_SEEDS;
use crate::engine::{EDGES_OBSERVER_NAME, SEED_EXEC_TIME};
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
use std::time::Duration;

#[test]
fn test_metadata_populated_on_interesting_input() {
    let (map_ptr, mut map) = make_coverage_map(1024);
    let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // Add a seed so the scheduler has something.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Simulate novel coverage.
    map[0] = 1;
    map[5] = 2;
    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);

    let is_interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &BytesInput::new(b"novel".to_vec()),
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(is_interesting);

    let exec_time = Duration::from_micros(500);

    let mut testcase = Testcase::new(BytesInput::new(b"novel".to_vec()));
    testcase.set_exec_time(exec_time);
    feedback
        .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
        .unwrap();

    // Drop observers before reading the raw map pointer to avoid aliasing.
    drop(observers);

    let bitmap_size = unsafe { std::slice::from_raw_parts(map_ptr, map.len()) }
        .iter()
        .filter(|&&b| b > 0)
        .count() as u64;

    // Compute depth from parent (seed at depth 0).
    let depth = state
        .corpus()
        .get(seed_id)
        .unwrap()
        .borrow()
        .metadata::<SchedulerTestcaseMetadata>()
        .unwrap()
        .depth()
        + 1;

    let mut sched_meta = SchedulerTestcaseMetadata::new(depth);
    sched_meta.set_bitmap_size(bitmap_size);
    sched_meta.set_cycle_and_time((exec_time, 1));
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![0, 5]));

    let id = state.corpus_mut().add(testcase).unwrap();
    scheduler.on_add(&mut state, id).unwrap();

    // Verify metadata.
    let tc = state.corpus().get(id).unwrap().borrow();
    assert!(tc.exec_time().is_some());
    assert_eq!(tc.exec_time().unwrap(), Duration::from_micros(500));
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    assert_eq!(meta.depth(), 1);
    assert_eq!(meta.bitmap_size(), 2); // two nonzero bytes
    assert_eq!(meta.cycle_and_time(), (exec_time, 1));
}

#[test]
fn test_explicit_seed_has_scheduler_metadata() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    let tc = make_seed_testcase(b"hello");
    let id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, id).unwrap();

    let tc = state.corpus().get(id).unwrap().borrow();
    let meta = tc
        .metadata::<SchedulerTestcaseMetadata>()
        .expect("seed should have SchedulerTestcaseMetadata");
    assert_eq!(meta.depth(), 0);
    assert_eq!(*tc.exec_time(), Some(Duration::from_millis(1)));
}

#[test]
fn test_auto_seed_has_scheduler_metadata() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add auto-seeds the same way Fuzzer::get_next_input does.
    for seed in DEFAULT_SEEDS {
        let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));
        testcase.set_exec_time(SEED_EXEC_TIME);
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
        testcase.add_metadata(sched_meta);
        testcase.add_metadata(MapIndexesMetadata::new(vec![]));

        let id = state.corpus_mut().add(testcase).unwrap();
        scheduler.on_add(&mut state, id).unwrap();
    }

    assert_eq!(state.corpus().count(), DEFAULT_SEEDS.len());

    // Verify each auto-seed has metadata.
    for id in state.corpus().ids() {
        let tc = state.corpus().get(id).unwrap().borrow();
        let meta = tc
            .metadata::<SchedulerTestcaseMetadata>()
            .expect("auto-seed should have SchedulerTestcaseMetadata");
        assert_eq!(meta.depth(), 0);
        assert_eq!(*tc.exec_time(), Some(Duration::from_millis(1)));
    }
}
