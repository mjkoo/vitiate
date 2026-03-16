use super::helpers::{TestFuzzerBuilder, make_seed_testcase};
use crate::engine::compute_coverage_features;
use crate::types::{ExitKind, IterationResult};
use libafl::corpus::Corpus;
use libafl::inputs::BytesInput;
use libafl::schedulers::Scheduler;
use libafl::state::HasCorpus;

#[test]
fn features_zero_for_empty_map() {
    let map = vec![0u8; 256];
    assert_eq!(compute_coverage_features(&map), 0);
}

#[test]
fn features_equals_edges_when_all_hit_once() {
    let mut map = vec![0u8; 256];
    // 10 edges each hit exactly once -> bucket index 1 each -> 10 features.
    for slot in map.iter_mut().take(10) {
        *slot = 1;
    }
    assert_eq!(compute_coverage_features(&map), 10);
}

#[test]
fn features_exceeds_edges_with_higher_counts() {
    let mut map = vec![0u8; 256];
    // Edge hit counts: 1 (bucket 1), 5 (bucket 4), 200 (bucket 8).
    map[0] = 1;
    map[1] = 5;
    map[2] = 200;
    // Features: 1 + 4 + 8 = 13.
    assert_eq!(compute_coverage_features(&map), 13);
}

#[test]
fn bucket_index_boundary_values() {
    // Test each bucket boundary explicitly.
    let cases: &[(u8, u32)] = &[
        (0, 0),   // not hit
        (1, 1),   // bucket 1
        (2, 2),   // bucket 2
        (3, 3),   // bucket 3
        (4, 4),   // bucket 4 lower bound
        (7, 4),   // bucket 4 upper bound
        (8, 5),   // bucket 5 lower bound
        (15, 5),  // bucket 5 upper bound
        (16, 6),  // bucket 6 lower bound
        (31, 6),  // bucket 6 upper bound
        (32, 7),  // bucket 7 lower bound
        (127, 7), // bucket 7 upper bound
        (128, 8), // bucket 8 lower bound
        (255, 8), // bucket 8 upper bound
    ];

    for &(count, expected_bucket) in cases {
        let map = vec![count; 1];
        assert_eq!(
            compute_coverage_features(&map),
            expected_bucket,
            "count {count} should yield bucket index {expected_bucket}"
        );
    }
}

#[test]
fn features_integrates_with_stats() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Initially: no coverage -> 0 features.
    assert_eq!(fuzzer.stats().coverage_features, 0);

    let seed_tc = make_seed_testcase(b"seed");
    let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
    fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

    // Trigger novel coverage at index 10 with hit count 1.
    fuzzer.last_input = Some(BytesInput::new(b"test".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: index 10 is within 256-byte map bounds.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    // After one edge with hit count 1: features == edges == 1.
    let stats = fuzzer.stats();
    assert_eq!(stats.coverage_edges, 1);
    assert_eq!(stats.coverage_features, 1);

    // Complete calibration for the first entry.
    for _ in 0..3 {
        // SAFETY: index 10 is within bounds.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.calibrate_run(50_000.0).unwrap();
    }
    fuzzer.calibrate_finish().unwrap();

    // Add a second coverage edge with higher hit count.
    // The history_map stores the max hit count seen per edge.
    // MaxMapFeedback updates history_map on is_interesting, so we need
    // a new novel edge to trigger the update.
    fuzzer.last_input = Some(BytesInput::new(b"test2".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: indices 10 and 20 are within bounds.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1; // existing edge
        *fuzzer.map_ptr.add(20) = 5; // new edge, hit count 5 -> bucket 4
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    let stats = fuzzer.stats();
    assert_eq!(stats.coverage_edges, 2);
    // Edge 10: max=1, bucket=1. Edge 20: max=5, bucket=4. Total: 5.
    assert_eq!(stats.coverage_features, 5);
}
