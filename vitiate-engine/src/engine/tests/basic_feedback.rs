use super::helpers::{
    make_coverage_map, make_scheduler, make_seed_testcase, make_state_and_feedback,
};
use crate::engine::EDGES_OBSERVER_NAME;
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
