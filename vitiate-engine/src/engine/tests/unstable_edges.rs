use super::helpers::{make_coverage_map, make_fuzzer};
use crate::engine::EDGES_OBSERVER_NAME;
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::Feedback;
use libafl::inputs::BytesInput;
use libafl::observers::StdMapObserver;
use libafl_bolts::tuples::tuple_list;
use std::collections::HashSet;

#[test]
fn test_unstable_edge_masked_during_feedback() {
    let (map_ptr, mut map) = make_coverage_map(1024);
    let (mut state, mut feedback, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // Pre-populate the unstable set with index 42.
    let mut unstable = HashSet::new();
    unstable.insert(42usize);

    // Set coverage only at index 42 (unstable).
    map[42] = 1;

    // Manually mask (simulating what report_result does).
    for &idx in &unstable {
        if idx < map.len() {
            map[idx] = 0;
        }
    }

    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);

    let is_interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &BytesInput::new(b"test".to_vec()),
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(
        !is_interesting,
        "Input with only unstable edge coverage should not be interesting"
    );
}

#[test]
fn test_stable_edges_unaffected_by_masking() {
    let (map_ptr, mut map) = make_coverage_map(1024);
    let (mut state, mut feedback, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // Unstable set contains index 42.
    let mut unstable = HashSet::new();
    unstable.insert(42usize);

    // Set coverage at index 42 (unstable) AND index 99 (stable).
    map[42] = 1;
    map[99] = 1;

    // Mask unstable edges.
    for &idx in &unstable {
        if idx < map.len() {
            map[idx] = 0;
        }
    }

    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);

    let is_interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &BytesInput::new(b"test".to_vec()),
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(
        is_interesting,
        "Stable edge (99) should still make the input interesting"
    );
}

#[test]
fn test_no_masking_without_unstable_metadata() {
    let (map_ptr, mut map) = make_coverage_map(1024);
    let (mut state, mut feedback, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // No unstable set — all edges evaluated normally.
    map[42] = 1;

    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);

    let is_interesting = feedback
        .is_interesting(
            &mut state,
            &mut mgr,
            &BytesInput::new(b"test".to_vec()),
            &observers,
            &LibaflExitKind::Ok,
        )
        .unwrap();
    assert!(
        is_interesting,
        "Without unstable masking, edge 42 should be interesting"
    );
}
