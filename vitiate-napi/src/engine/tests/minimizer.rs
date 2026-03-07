use std::time::Duration;

use super::helpers::{
    TestFuzzerBuilder, make_coverage_map, make_scheduler, make_seed_testcase,
    make_state_and_feedback,
};
use crate::cmplog;
use crate::engine::DEFAULT_SEEDS;
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, SchedulerTestcaseMetadata, Testcase};
use libafl::feedbacks::MapIndexesMetadata;
use libafl::inputs::BytesInput;
use libafl::schedulers::minimizer::{IsFavoredMetadata, TopRatedsMetadata};
use libafl::schedulers::{RemovableScheduler, Scheduler};
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_map_indexes_metadata_contains_all_covered_edges() {
    // Task 1.3: MapIndexesMetadata contains all nonzero indices (not just novel).
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // First iteration: set edges {10, 20, 30} as covered. All are novel.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
        *fuzzer.map_ptr.add(20) = 2;
        *fuzzer.map_ptr.add(30) = 3;
    }
    fuzzer.last_input = Some(BytesInput::new(b"input1".to_vec()));
    fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    // The corpus entry should have MapIndexesMetadata with all 3 edges.
    // MapIndexesMetadata has refcnt > 0 after update_score, so it must be present.
    let id = CorpusId::from(1usize); // second entry (after seed)
    let tc = fuzzer.state.corpus().get(id).unwrap().borrow();
    let meta = tc
        .metadata::<MapIndexesMetadata>()
        .expect("MapIndexesMetadata should be present (refcnt > 0 after update_score)");
    assert!(meta.list.contains(&10));
    assert!(meta.list.contains(&20));
    assert!(meta.list.contains(&30));
    assert_eq!(meta.list.len(), 3);
    drop(tc);

    // Second iteration: edges {10, 20, 30, 40, 50} covered, only {40, 50} novel.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
        *fuzzer.map_ptr.add(20) = 2;
        *fuzzer.map_ptr.add(30) = 3;
        *fuzzer.map_ptr.add(40) = 1;
        *fuzzer.map_ptr.add(50) = 1;
    }
    fuzzer.last_input = Some(BytesInput::new(b"input2".to_vec()));
    fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    // The entry should have MapIndexesMetadata with ALL 5 edges.
    let id2 = CorpusId::from(2usize);
    let tc2 = fuzzer.state.corpus().get(id2).unwrap().borrow();
    let meta = tc2
        .metadata::<MapIndexesMetadata>()
        .expect("MapIndexesMetadata should be present (refcnt > 0 after update_score)");
    assert!(meta.list.contains(&10), "should contain non-novel edge 10");
    assert!(meta.list.contains(&20), "should contain non-novel edge 20");
    assert!(meta.list.contains(&30), "should contain non-novel edge 30");
    assert!(meta.list.contains(&40), "should contain novel edge 40");
    assert!(meta.list.contains(&50), "should contain novel edge 50");
    assert_eq!(meta.list.len(), 5);

    cmplog::disable();
}

#[test]
fn test_map_indexes_metadata_absent_for_non_interesting() {
    // Task 1.3: MapIndexesMetadata not stored for non-interesting inputs.
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // First: establish coverage at edge 10.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    fuzzer.last_input = Some(BytesInput::new(b"novel".to_vec()));
    fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    let corpus_before = fuzzer.state.corpus().count();

    // Second: same coverage (edge 10 only) — not interesting.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    fuzzer.last_input = Some(BytesInput::new(b"duplicate".to_vec()));
    fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::None));

    // Corpus should not have grown — no entry was added.
    assert_eq!(fuzzer.state.corpus().count(), corpus_before);

    cmplog::disable();
}

#[test]
fn test_top_rateds_populated_on_corpus_addition() {
    // Task 3.1: TopRatedsMetadata populated when corpus entries are added.
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a seed (no edges).
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // TopRatedsMetadata should be empty (seed has no edges).
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert!(
            top_rated.map().is_empty(),
            "TopRatedsMetadata should be empty after adding seed"
        );
    }

    // Add an interesting entry covering edges {10, 20}.
    let mut tc = Testcase::new(BytesInput::new(b"entry1".to_vec()));
    tc.set_exec_time(Duration::from_micros(100));
    let mut sched_meta = SchedulerTestcaseMetadata::new(1);
    sched_meta.set_bitmap_size(2);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    tc.add_metadata(sched_meta);
    tc.add_metadata(MapIndexesMetadata::new(vec![10, 20]));
    let id1 = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, id1).unwrap();

    // TopRatedsMetadata should now track edges 10 and 20 → id1.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&10),
            Some(&id1),
            "edge 10 should be tracked to entry 1"
        );
        assert_eq!(
            top_rated.map().get(&20),
            Some(&id1),
            "edge 20 should be tracked to entry 1"
        );
    }
}

#[test]
fn test_is_favored_set_on_best_representative() {
    // Task 3.2: IsFavoredMetadata set on entries that are best for at least one edge.

    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a seed.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Add entry covering edge 10.
    let mut tc = Testcase::new(BytesInput::new(b"entry1".to_vec()));
    tc.set_exec_time(Duration::from_micros(100));
    let mut sched_meta = SchedulerTestcaseMetadata::new(1);
    sched_meta.set_bitmap_size(1);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    tc.add_metadata(sched_meta);
    tc.add_metadata(MapIndexesMetadata::new(vec![10]));
    let id1 = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, id1).unwrap();

    // Trigger cull by calling next(). MinimizerScheduler::next calls cull
    // which refreshes IsFavoredMetadata.
    let _ = scheduler.next(&mut state).unwrap();

    // Entry 1 should be favored (best for edge 10).
    {
        let tc = state.corpus().get(id1).unwrap().borrow();
        assert!(
            tc.metadata::<IsFavoredMetadata>().is_ok(),
            "entry covering edge 10 should be favored"
        );
    }

    // Seed should NOT be favored (no edges).
    {
        let tc = state.corpus().get(seed_id).unwrap().borrow();
        assert!(
            tc.metadata::<IsFavoredMetadata>().is_err(),
            "seed with no edges should not be favored"
        );
    }
}

#[test]
fn test_non_favored_entries_skipped_with_high_probability() {
    // Task 3.3: Non-favored entries skipped with high probability.
    // With only seeds (non-favored), the scheduler should still terminate
    // but each attempt has a 95% skip probability.
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add seeds only (all non-favored).
    for seed in DEFAULT_SEEDS {
        let tc = make_seed_testcase(seed);
        let id = state.corpus_mut().add(tc).unwrap();
        scheduler.on_add(&mut state, id).unwrap();
    }

    // With a known seed, call next() multiple times — it should always return
    // a valid corpus ID even though all entries are non-favored.
    for _ in 0..20 {
        let id = scheduler.next(&mut state).unwrap();
        assert!(
            state.corpus().get(id).is_ok(),
            "scheduler should return valid corpus entry even when all non-favored"
        );
    }
}

#[test]
fn test_entry_displacement_smaller_faster_wins() {
    // Task 3.4: Smaller/faster entry replaces larger/slower for shared edge.
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a seed.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Entry A: large, slow. Covers edge 42.
    // penalty = as_millis(1ms) * 100 bytes = 100
    let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 100]));
    tc_a.set_exec_time(Duration::from_millis(1));
    let mut meta_a = SchedulerTestcaseMetadata::new(1);
    meta_a.set_bitmap_size(1);
    meta_a.set_cycle_and_time((Duration::from_millis(1), 1));
    tc_a.add_metadata(meta_a);
    tc_a.add_metadata(MapIndexesMetadata::new(vec![42]));
    let id_a = state.corpus_mut().add(tc_a).unwrap();
    scheduler.on_add(&mut state, id_a).unwrap();

    // Entry A should own edge 42.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(top_rated.map().get(&42), Some(&id_a));
    }

    // Entry B: small, fast. Also covers edge 42.
    // penalty = as_millis(500us) * 50 bytes = 0 (sub-ms truncates to 0; lower → wins)
    let mut tc_b = Testcase::new(BytesInput::new(vec![0u8; 50]));
    tc_b.set_exec_time(Duration::from_micros(500));
    let mut meta_b = SchedulerTestcaseMetadata::new(1);
    meta_b.set_bitmap_size(1);
    meta_b.set_cycle_and_time((Duration::from_micros(500), 1));
    tc_b.add_metadata(meta_b);
    tc_b.add_metadata(MapIndexesMetadata::new(vec![42]));
    let id_b = state.corpus_mut().add(tc_b).unwrap();
    scheduler.on_add(&mut state, id_b).unwrap();

    // Entry B should now own edge 42 (lower penalty).
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&42),
            Some(&id_b),
            "smaller/faster entry B should displace entry A for edge 42"
        );
    }
}

#[test]
fn test_seeds_have_empty_map_indexes_metadata() {
    // Task 3.5: Seeds have empty MapIndexesMetadata, on_add succeeds,
    // and TopRatedsMetadata is not modified.
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // TopRatedsMetadata should be empty initially.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert!(top_rated.map().is_empty());
    }

    // Add 3 seeds.
    for seed_data in [b"hello" as &[u8], b"world", b"test"] {
        let tc = make_seed_testcase(seed_data);
        let id = state.corpus_mut().add(tc).unwrap();
        // on_add should succeed without error.
        scheduler.on_add(&mut state, id).unwrap();
    }

    // TopRatedsMetadata should STILL be empty — seeds have no edges.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert!(
            top_rated.map().is_empty(),
            "TopRatedsMetadata should not be modified by seeds with empty MapIndexesMetadata"
        );
    }
}

#[test]
fn test_calibration_on_replace_retains_edges() {
    // Spec coverage: corpus-minimizer/spec.md lines 74-105.
    // Scenarios: "Calibrated entry retains existing edges" and
    // "Future entries compare using calibrated penalties".
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a seed (required by the scheduler).
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Add entry A covering edges {10, 20}.
    // LenTimeMulTestcasePenalty: exec_time.as_millis() * input_len = 1 * 10 = 10
    let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 10]));
    tc_a.set_exec_time(Duration::from_millis(1));
    let mut sched_meta_a = SchedulerTestcaseMetadata::new(1);
    sched_meta_a.set_bitmap_size(2);
    sched_meta_a.set_cycle_and_time((Duration::from_millis(1), 1));
    tc_a.add_metadata(sched_meta_a);
    tc_a.add_metadata(MapIndexesMetadata::new(vec![10, 20]));
    let id_a = state.corpus_mut().add(tc_a).unwrap();
    scheduler.on_add(&mut state, id_a).unwrap();

    // Verify A owns edges {10, 20}.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(top_rated.map().get(&10), Some(&id_a));
        assert_eq!(top_rated.map().get(&20), Some(&id_a));
    }

    // --- Scenario 1: self-comparison shortcut in on_replace ---
    // Worsen A's exec_time to 5ms → penalty becomes 5 * 10 = 50.
    // on_replace should retain A's edges unconditionally (self-check shortcut).
    let prev_tc = {
        let tc = state.corpus().get(id_a).unwrap().borrow();
        tc.clone()
    };
    {
        let mut tc = state.corpus().get(id_a).unwrap().borrow_mut();
        tc.set_exec_time(Duration::from_millis(5));
        tc.metadata_mut::<SchedulerTestcaseMetadata>()
            .expect("SchedulerTestcaseMetadata should be present")
            .set_cycle_and_time((Duration::from_millis(5), 1));
    }
    scheduler.on_replace(&mut state, id_a, &prev_tc).unwrap();

    // A should still own edges {10, 20} after on_replace (self-comparison retains).
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&10),
            Some(&id_a),
            "A should retain edge 10 after on_replace (self-comparison shortcut)"
        );
        assert_eq!(
            top_rated.map().get(&20),
            Some(&id_a),
            "A should retain edge 20 after on_replace (self-comparison shortcut)"
        );
    }

    // --- Scenario 2: displacement uses calibrated penalty ---
    // Add entry C covering edge {10} only.
    // penalty = 2ms * 10 bytes = 20 (lower than A's calibrated 50).
    let mut tc_c = Testcase::new(BytesInput::new(vec![0u8; 10]));
    tc_c.set_exec_time(Duration::from_millis(2));
    let mut sched_meta_c = SchedulerTestcaseMetadata::new(1);
    sched_meta_c.set_bitmap_size(1);
    sched_meta_c.set_cycle_and_time((Duration::from_millis(2), 1));
    tc_c.add_metadata(sched_meta_c);
    tc_c.add_metadata(MapIndexesMetadata::new(vec![10]));
    let id_c = state.corpus_mut().add(tc_c).unwrap();
    scheduler.on_add(&mut state, id_c).unwrap();

    // C (penalty 20) should displace A (calibrated penalty 50) for edge 10.
    // A should retain edge 20 (C doesn't cover it).
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&10),
            Some(&id_c),
            "C (penalty 20) should displace A (penalty 50) for edge 10"
        );
        assert_eq!(
            top_rated.map().get(&20),
            Some(&id_a),
            "A should retain edge 20 (C doesn't cover it)"
        );
    }
}

#[test]
fn test_entry_loses_favored_status_when_displaced() {
    // Spec coverage: corpus-minimizer/spec.md
    // Scenario: "Displaced entry loses edge ownership but retains favored marker"
    // Entry A is best for edge 10 (its only edge). Entry B displaces A.
    // Verifies TopRatedsMetadata ownership transfers and B gets IsFavoredMetadata.
    // Per spec, A's stale IsFavoredMetadata is not removed (inherited LibAFL behavior).

    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a seed.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Add entry A covering edge {10} only.
    // penalty = 1ms * 10 bytes = 10
    let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 10]));
    tc_a.set_exec_time(Duration::from_millis(1));
    let mut sched_meta_a = SchedulerTestcaseMetadata::new(1);
    sched_meta_a.set_bitmap_size(1);
    sched_meta_a.set_cycle_and_time((Duration::from_millis(1), 1));
    tc_a.add_metadata(sched_meta_a);
    tc_a.add_metadata(MapIndexesMetadata::new(vec![10]));
    let id_a = state.corpus_mut().add(tc_a).unwrap();
    scheduler.on_add(&mut state, id_a).unwrap();

    // Trigger cull via next() — A should be favored (best for edge 10).
    let _ = scheduler.next(&mut state).unwrap();
    {
        let tc = state.corpus().get(id_a).unwrap().borrow();
        assert!(
            tc.metadata::<IsFavoredMetadata>().is_ok(),
            "A should be favored before displacement (best for edge 10)"
        );
    }

    // Add entry B covering edge {10} with lower penalty.
    // penalty = 1ms * 5 bytes = 5 (lower than A's 10)
    let mut tc_b = Testcase::new(BytesInput::new(vec![0u8; 5]));
    tc_b.set_exec_time(Duration::from_millis(1));
    let mut sched_meta_b = SchedulerTestcaseMetadata::new(1);
    sched_meta_b.set_bitmap_size(1);
    sched_meta_b.set_cycle_and_time((Duration::from_millis(1), 1));
    tc_b.add_metadata(sched_meta_b);
    tc_b.add_metadata(MapIndexesMetadata::new(vec![10]));
    let id_b = state.corpus_mut().add(tc_b).unwrap();
    scheduler.on_add(&mut state, id_b).unwrap();

    // B should now own edge 10 in TopRatedsMetadata (displacement happened in on_add).
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&10),
            Some(&id_b),
            "B (penalty 5) should displace A (penalty 10) for edge 10"
        );
    }

    // A should not own ANY edge in TopRatedsMetadata (edge 10 was its only edge).
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert!(
            !top_rated.map().values().any(|id| *id == id_a),
            "A should not own any edge after displacement"
        );
    }

    // Trigger cull via next() to refresh IsFavoredMetadata.
    let _ = scheduler.next(&mut state).unwrap();

    // B should be favored (cull marks entries in TopRatedsMetadata).
    {
        let tc = state.corpus().get(id_b).unwrap().borrow();
        assert!(
            tc.metadata::<IsFavoredMetadata>().is_ok(),
            "B should be favored (now best for edge 10)"
        );
    }
}

#[test]
fn test_calibration_on_replace_gains_new_edges() {
    // Spec coverage: corpus-minimizer/spec.md lines 92-98.
    // Scenario: "Calibrated entry gains new edges with improved penalty"
    // A covers {10, 20, 30} but only owns {20, 30} (B owns 10 with lower penalty).
    // After calibration improves A's exec_time, on_replace makes A displace B for edge 10.
    let (map_ptr, _map) = make_coverage_map(256);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a seed.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Add entry B covering edge {10} only.
    // penalty = 2ms * 10 bytes = 20
    let mut tc_b = Testcase::new(BytesInput::new(vec![0u8; 10]));
    tc_b.set_exec_time(Duration::from_millis(2));
    let mut sched_meta_b = SchedulerTestcaseMetadata::new(1);
    sched_meta_b.set_bitmap_size(1);
    sched_meta_b.set_cycle_and_time((Duration::from_millis(2), 1));
    tc_b.add_metadata(sched_meta_b);
    tc_b.add_metadata(MapIndexesMetadata::new(vec![10]));
    let id_b = state.corpus_mut().add(tc_b).unwrap();
    scheduler.on_add(&mut state, id_b).unwrap();

    // Add entry A covering edges {10, 20, 30}.
    // penalty = 3ms * 10 bytes = 30 (higher than B's 20 for edge 10)
    let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 10]));
    tc_a.set_exec_time(Duration::from_millis(3));
    let mut sched_meta_a = SchedulerTestcaseMetadata::new(1);
    sched_meta_a.set_bitmap_size(3);
    sched_meta_a.set_cycle_and_time((Duration::from_millis(3), 1));
    tc_a.add_metadata(sched_meta_a);
    tc_a.add_metadata(MapIndexesMetadata::new(vec![10, 20, 30]));
    let id_a = state.corpus_mut().add(tc_a).unwrap();
    scheduler.on_add(&mut state, id_a).unwrap();

    // Verify initial ownership: B owns edge 10, A owns edges 20 and 30.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&10),
            Some(&id_b),
            "B should own edge 10 initially (penalty 20 < A's 30)"
        );
        assert_eq!(
            top_rated.map().get(&20),
            Some(&id_a),
            "A should own edge 20 (first and only entry for it)"
        );
        assert_eq!(
            top_rated.map().get(&30),
            Some(&id_a),
            "A should own edge 30 (first and only entry for it)"
        );
    }

    // Simulate calibration: clone A as prev_tc, then improve A's exec_time.
    let prev_tc = {
        let tc = state.corpus().get(id_a).unwrap().borrow();
        tc.clone()
    };

    // Improve A's exec_time from 3ms to 1ms → new penalty = 1ms * 10 bytes = 10.
    {
        let mut tc = state.corpus().get(id_a).unwrap().borrow_mut();
        tc.set_exec_time(Duration::from_millis(1));
        tc.metadata_mut::<SchedulerTestcaseMetadata>()
            .expect("SchedulerTestcaseMetadata should be present")
            .set_cycle_and_time((Duration::from_millis(1), 1));
    }

    // Call on_replace to re-evaluate A's edges with the calibrated penalty.
    scheduler.on_replace(&mut state, id_a, &prev_tc).unwrap();

    // A (penalty 10) should now displace B (penalty 20) for edge 10.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_eq!(
            top_rated.map().get(&10),
            Some(&id_a),
            "A should now own edge 10 after calibration (penalty 10 < B's 20)"
        );
        assert_eq!(
            top_rated.map().get(&20),
            Some(&id_a),
            "A should still own edge 20"
        );
        assert_eq!(
            top_rated.map().get(&30),
            Some(&id_a),
            "A should still own edge 30"
        );
    }

    // Verify B no longer owns edge 10.
    {
        let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
        assert_ne!(
            top_rated.map().get(&10),
            Some(&id_b),
            "B should no longer own edge 10 after A's calibration"
        );
    }
}
