use super::helpers::{make_coverage_map, make_state_and_feedback};
use crate::cmplog;
use libafl::HasMetadata;
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};

#[test]
fn test_cmplog_enable_disable_on_fuzzer_lifecycle() {
    // Reset cmplog state.
    cmplog::disable();
    cmplog::drain();
    assert!(!cmplog::is_enabled());

    // Simulate Fuzzer construction (enable cmplog + init metadata).
    cmplog::enable();
    assert!(cmplog::is_enabled());

    // Push should work while enabled.
    cmplog::push(
        CmpValues::U8((1, 2, false)),
        0,
        cmplog::CmpLogOperator::Equal,
    );
    let entries = cmplog::drain();
    assert_eq!(entries.len(), 1);

    // Simulate Fuzzer drop (disable cmplog).
    cmplog::disable();
    assert!(!cmplog::is_enabled());

    // Push should be silently dropped while disabled.
    cmplog::push(
        CmpValues::U8((3, 4, false)),
        0,
        cmplog::CmpLogOperator::Equal,
    );
    let entries = cmplog::drain();
    assert!(entries.is_empty());
}

#[test]
fn test_cmplog_entries_drained_into_metadata() {
    // Reset cmplog state.
    cmplog::disable();
    cmplog::drain();

    let (map_ptr, _map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);

    // Initialize CmpValuesMetadata on state (as Fuzzer::new() does).
    state.metadata_map_mut().insert(CmpValuesMetadata::new());

    // Simulate a fuzz iteration: enable, push entries, drain to metadata.
    cmplog::enable();
    cmplog::push(
        CmpValues::U8((10, 20, false)),
        0,
        cmplog::CmpLogOperator::Equal,
    );
    cmplog::push(
        CmpValues::U16((1000, 2000, false)),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    let entries = cmplog::drain();
    assert_eq!(entries.len(), 2);

    // Insert into state metadata (as reportResult does).
    let flat_entries: Vec<CmpValues> = entries.iter().map(|(v, _, _)| v.clone()).collect();
    state
        .metadata_map_mut()
        .insert(CmpValuesMetadata { list: flat_entries });

    // Verify metadata is accessible.
    let meta = state
        .metadata_map()
        .get::<CmpValuesMetadata>()
        .expect("CmpValuesMetadata should exist");
    assert_eq!(meta.list.len(), 2);
    assert_eq!(meta.list[0], CmpValues::U8((10, 20, false)));
    assert_eq!(meta.list[1], CmpValues::U16((1000, 2000, false)));

    cmplog::disable();
}
