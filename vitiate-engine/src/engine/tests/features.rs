use super::helpers::{TestFuzzerBuilder, make_seed_testcase};
use crate::cmplog;
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
    // 10 edges each seen only in bucket "1" (bit 0x01) -> 1 feature each.
    for slot in map.iter_mut().take(10) {
        *slot = 0x01;
    }
    assert_eq!(compute_coverage_features(&map), 10);
}

#[test]
fn features_count_seen_buckets_per_edge() {
    let mut map = vec![0u8; 256];
    // The history map holds the bitmask of hit-count buckets seen per edge;
    // each set bit is one (edge, bucket) feature.
    map[0] = 0x01; // only bucket "1" seen -> 1 feature
    map[1] = 0x08; // only bucket "4-7" seen -> 1 feature
    map[2] = 0x01 | 0x08 | 0x80; // buckets "1", "4-7", "128+" seen -> 3 features
    assert_eq!(compute_coverage_features(&map), 5);
}

#[test]
fn features_popcount_boundary_values() {
    // Every one-hot bucket bit contributes exactly one feature; accumulated
    // masks contribute their popcount.
    for bit in 0..8u32 {
        let map = vec![1u8 << bit; 1];
        assert_eq!(compute_coverage_features(&map), 1, "one-hot bit {bit}");
    }
    assert_eq!(compute_coverage_features(&[0u8]), 0);
    assert_eq!(compute_coverage_features(&[0xFFu8]), 8);
}

#[test]
fn features_integrates_with_stats() {
    let _cmplog_cleanup = cmplog::TestCleanupGuard;
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

    // Add a second coverage edge with a higher hit count.
    // The history_map stores the bitmask of hit-count buckets seen per edge;
    // the feedback ORs it on is_interesting, so a new novel edge triggers the
    // update.
    fuzzer.last_input = Some(BytesInput::new(b"test2".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);
    // SAFETY: indices 10 and 20 are within bounds.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1; // existing edge, bucket "1" already seen
        *fuzzer.map_ptr.add(20) = 5; // new edge, hit count 5 -> bucket "4-7"
    }
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert_eq!(result, IterationResult::Interesting);

    let stats = fuzzer.stats();
    assert_eq!(stats.coverage_edges, 2);
    // Edge 10: buckets {"1"} = 1 feature. Edge 20: buckets {"4-7"} = 1 feature.
    assert_eq!(stats.coverage_features, 2);
}
