use super::helpers::{
    TestFuzzerBuilder, make_coverage_map, make_fuzzer, make_scheduler, make_seed_testcase,
};
use crate::engine::EDGES_OBSERVER_NAME;
use crate::engine::calibration::{CALIBRATION_STAGE_MAX, CALIBRATION_STAGE_START};
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
use libafl::schedulers::powersched::SchedulerMetadata;
use libafl::state::HasCorpus;
use libafl_bolts::tuples::tuple_list;
use std::collections::HashSet;
use std::time::Duration;

#[test]
fn test_calibrate_run_first_call_captures_baseline() {
    let (map_ptr, mut map) = make_coverage_map(256);
    let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
    let mut mgr = NopEventManager::new();

    // Add a seed.
    let tc = make_seed_testcase(b"seed");
    let seed_id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, seed_id).unwrap();

    // Simulate interesting coverage to set up calibration state.
    map[10] = 1;
    let observer =
        unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len()) };
    let observers = tuple_list!(observer);
    assert!(
        feedback
            .is_interesting(
                &mut state,
                &mut mgr,
                &BytesInput::new(b"x".to_vec()),
                &observers,
                &LibaflExitKind::Ok,
            )
            .unwrap()
    );
    let mut testcase = Testcase::new(BytesInput::new(b"x".to_vec()));
    testcase.set_exec_time(Duration::from_micros(100));
    feedback
        .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
        .unwrap();
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_bitmap_size(1);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    testcase.add_metadata(sched_meta);
    testcase.add_metadata(MapIndexesMetadata::new(vec![10]));
    let corpus_id = state.corpus_mut().add(testcase).unwrap();
    scheduler.on_add(&mut state, corpus_id).unwrap();

    // Set up calibration state manually (as report_result would).
    let calibration_corpus_id = Some(corpus_id);
    let calibration_total_time = Duration::from_micros(100);
    let calibration_iterations: usize = 1;
    let mut calibration_first_map: Option<Vec<u8>> = None;
    let mut calibration_history_map: Option<Vec<u8>> = None;
    let calibration_has_unstable = false;

    // Zero map and set calibration coverage.
    map.fill(0);
    map[10] = 1; // same stable coverage

    // Simulate first calibrate_run.
    let exec_time = Duration::from_micros(110);
    let _calibration_total_time = calibration_total_time + exec_time;
    let _calibration_iterations = calibration_iterations + 1;

    let current_map = map.to_vec();
    if calibration_first_map.is_none() {
        calibration_first_map = Some(current_map);
        calibration_history_map = Some(vec![0u8; map.len()]);
    }

    // After first call, baseline should be set.
    assert!(calibration_first_map.is_some());
    assert_eq!(calibration_first_map.as_ref().unwrap()[10], 1);

    // Should need more runs (2 < 4).
    let target_runs = if calibration_has_unstable {
        CALIBRATION_STAGE_MAX
    } else {
        CALIBRATION_STAGE_START
    };
    assert!(_calibration_iterations < target_runs);
    // Cleanup
    let _ = (
        calibration_corpus_id,
        calibration_has_unstable,
        calibration_history_map,
    );
}

#[test]
fn test_calibrate_run_detects_unstable_edges() {
    let (map_ptr, mut map) = make_coverage_map(256);

    // Simulate calibration with differing maps.
    let first_map = {
        map[10] = 1;
        map[20] = 1;
        map.to_vec()
    };
    let mut history_map = vec![0u8; map.len()];
    let mut has_unstable = false;

    // Second run: edge 20 is now 0 (unstable).
    let second_map = {
        map.fill(0);
        map[10] = 1;
        // map[20] = 0 - differs from first
        map.to_vec()
    };

    for (idx, (&first_val, &cur_val)) in first_map.iter().zip(second_map.iter()).enumerate() {
        if first_val != cur_val && history_map[idx] != u8::MAX {
            history_map[idx] = u8::MAX;
            has_unstable = true;
        }
    }

    assert!(has_unstable, "Should detect unstable edge at index 20");
    assert_eq!(
        history_map[20],
        u8::MAX,
        "Index 20 should be marked unstable"
    );
    assert_eq!(history_map[10], 0, "Index 10 should remain stable");

    // With unstable detected, target should extend to 8 runs.
    let target_runs = if has_unstable {
        CALIBRATION_STAGE_MAX
    } else {
        CALIBRATION_STAGE_START
    };
    assert_eq!(target_runs, CALIBRATION_STAGE_MAX);
    let _ = map_ptr;
}

#[test]
fn test_calibrate_run_returns_false_when_complete() {
    // Without instability: 4 total runs needed.
    // After original (1) + 3 calibrate_run calls (total = 4), should return false.
    let mut iterations = 1usize; // original run
    let has_unstable = false;

    for i in 0..3 {
        iterations += 1;
        let target = if has_unstable {
            CALIBRATION_STAGE_MAX
        } else {
            CALIBRATION_STAGE_START
        };
        let needs_more = iterations < target;
        if i < 2 {
            assert!(needs_more, "Should need more at iteration {iterations}");
        } else {
            assert!(!needs_more, "Should be complete at iteration {iterations}");
        }
    }
    assert_eq!(iterations, 4);
}

#[test]
fn test_calibrate_run_extends_to_8_on_unstable() {
    // With instability: 8 total runs needed.
    let mut iterations = 1usize;
    let has_unstable = true;

    for _ in 0..7 {
        iterations += 1;
        let target = if has_unstable {
            CALIBRATION_STAGE_MAX
        } else {
            CALIBRATION_STAGE_START
        };
        let needs_more = iterations < target;
        if iterations < 8 {
            assert!(needs_more);
        } else {
            assert!(!needs_more);
        }
    }
    assert_eq!(iterations, 8);
}

#[test]
fn test_calibrate_finish_averages_exec_time() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a corpus entry with preliminary metadata.
    let mut tc = Testcase::new(BytesInput::new(b"test".to_vec()));
    tc.set_exec_time(Duration::from_micros(100));
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_bitmap_size(1);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    tc.add_metadata(sched_meta);
    tc.add_metadata(MapIndexesMetadata::new(vec![]));
    let id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, id).unwrap();

    // Simulate calibrate_finish with 4 runs totaling 400us.
    let total_time = Duration::from_micros(400);
    let iterations = 4usize;
    let avg_time = total_time / (iterations as u32);

    {
        let mut tc = state.corpus().get(id).unwrap().borrow_mut();
        tc.set_exec_time(avg_time);
        if let Ok(meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
            meta.set_cycle_and_time((total_time, iterations));
        }
    }

    // Verify averaged timing.
    let tc = state.corpus().get(id).unwrap().borrow();
    assert_eq!(*tc.exec_time(), Some(Duration::from_micros(100))); // 400/4
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    assert_eq!(meta.cycle_and_time(), (Duration::from_micros(400), 4));
}

#[test]
fn test_calibrate_finish_updates_global_metadata() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);

    // Initial global metadata should be zeroed.
    let psmeta = state.metadata::<SchedulerMetadata>().unwrap();
    assert_eq!(psmeta.exec_time(), Duration::ZERO);
    assert_eq!(psmeta.cycles(), 0);
    assert_eq!(psmeta.bitmap_entries(), 0);

    // Simulate calibrate_finish updating global metadata.
    let total_time = Duration::from_micros(400);
    let iterations = 4u64;
    let bitmap_size = 150u64;

    let psmeta = state.metadata_mut::<SchedulerMetadata>().unwrap();
    psmeta.set_exec_time(psmeta.exec_time() + total_time);
    psmeta.set_cycles(psmeta.cycles() + iterations);
    psmeta.set_bitmap_size(psmeta.bitmap_size() + bitmap_size);
    psmeta.set_bitmap_entries(psmeta.bitmap_entries() + 1);

    // Verify.
    let psmeta = state.metadata::<SchedulerMetadata>().unwrap();
    assert_eq!(psmeta.exec_time(), Duration::from_micros(400));
    assert_eq!(psmeta.cycles(), 4);
    assert_eq!(psmeta.bitmap_size(), 150);
    assert_eq!(psmeta.bitmap_entries(), 1);
}

#[test]
fn test_calibrate_finish_merges_unstable_edges() {
    let mut unstable_entries = HashSet::new();

    // First calibration: edges 42, 100.
    let history1 = {
        let mut h = vec![0u8; 256];
        h[42] = u8::MAX;
        h[100] = u8::MAX;
        h
    };
    for (idx, &v) in history1.iter().enumerate() {
        if v == u8::MAX {
            unstable_entries.insert(idx);
        }
    }
    assert!(unstable_entries.contains(&42));
    assert!(unstable_entries.contains(&100));

    // Second calibration: edges 100, 200.
    let history2 = {
        let mut h = vec![0u8; 256];
        h[100] = u8::MAX;
        h[200] = u8::MAX;
        h
    };
    for (idx, &v) in history2.iter().enumerate() {
        if v == u8::MAX {
            unstable_entries.insert(idx);
        }
    }

    // Should be union: {42, 100, 200}.
    assert_eq!(unstable_entries.len(), 3);
    assert!(unstable_entries.contains(&42));
    assert!(unstable_entries.contains(&100));
    assert!(unstable_entries.contains(&200));
}

#[test]
fn test_crash_during_calibration_partial_data() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);
    let mut scheduler = make_scheduler(map_ptr, _map.len());

    // Add a corpus entry with preliminary metadata.
    let mut tc = Testcase::new(BytesInput::new(b"crashing".to_vec()));
    tc.set_exec_time(Duration::from_micros(100));
    let mut sched_meta = SchedulerTestcaseMetadata::new(0);
    sched_meta.set_bitmap_size(1);
    sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
    tc.add_metadata(sched_meta);
    tc.add_metadata(MapIndexesMetadata::new(vec![]));
    let id = state.corpus_mut().add(tc).unwrap();
    scheduler.on_add(&mut state, id).unwrap();

    // Simulate partial calibration (crash after 2 total runs, out of 4 target).
    let total_time = Duration::from_micros(200);
    let iterations = 2usize;
    let avg_time = total_time / (iterations as u32);

    {
        let mut tc = state.corpus().get(id).unwrap().borrow_mut();
        tc.set_exec_time(avg_time);
        if let Ok(meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
            meta.set_cycle_and_time((total_time, iterations));
        }
    }

    // Entry should still be in corpus with partial data.
    assert_eq!(state.corpus().count(), 1);
    let tc = state.corpus().get(id).unwrap().borrow();
    assert_eq!(*tc.exec_time(), Some(Duration::from_micros(100))); // 200/2
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    assert_eq!(meta.cycle_and_time(), (Duration::from_micros(200), 2));
}

#[test]
fn test_calibrate_run_and_finish_integration() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add a seed so the scheduler has something to select.
    let seed_tc = make_seed_testcase(b"seed");
    let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
    fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

    // Set up last_input and last_corpus_id (simulating get_next_input).
    fuzzer.last_input = Some(BytesInput::new(b"test_input".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);

    // Write novel coverage to the map.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }

    // report_result should detect novel coverage and return Interesting.
    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    // Map was zeroed by report_result. Run 3 calibration iterations
    // (report_result counted as iteration 1, so we need 3 more for 4 total).
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let needs_more = fuzzer.calibrate_run(110_000.0).unwrap();
    assert!(needs_more, "2 < CALIBRATION_STAGE_START");

    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let needs_more = fuzzer.calibrate_run(120_000.0).unwrap();
    assert!(needs_more, "3 < CALIBRATION_STAGE_START");

    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let needs_more = fuzzer.calibrate_run(130_000.0).unwrap();
    assert!(!needs_more, "4 >= CALIBRATION_STAGE_START");

    // Read calibration corpus_id before calibrate_finish() consumes it.
    let interesting_id = fuzzer
        .calibration
        .corpus_id
        .expect("calibration corpus_id should be set after report_result(Interesting)");

    // Finalize calibration.
    fuzzer.calibrate_finish().unwrap();

    // Verify the coverage map is zeroed after calibrate_finish
    // (prevents stale calibration data from affecting the next iteration).
    let map_after = unsafe { std::slice::from_raw_parts(fuzzer.map_ptr, fuzzer.map_len) };
    assert!(
        map_after.iter().all(|&b| b == 0),
        "coverage map should be zeroed after calibrate_finish"
    );

    // Verify per-testcase metadata: avg_time = (100+110+120+130)us / 4 = 115us.
    let tc = fuzzer.state.corpus().get(interesting_id).unwrap().borrow();
    assert_eq!(
        *tc.exec_time(),
        Some(Duration::from_nanos(115_000)),
        "exec_time should be the average of all calibration runs"
    );
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    let total_time = Duration::from_nanos(100_000 + 110_000 + 120_000 + 130_000);
    assert_eq!(meta.cycle_and_time(), (total_time, 4));
    drop(tc);

    // Verify global SchedulerMetadata was updated.
    let psmeta = fuzzer.state.metadata::<SchedulerMetadata>().unwrap();
    assert_eq!(psmeta.bitmap_entries(), 1);
    assert_eq!(
        psmeta.bitmap_size(),
        1,
        "bitmap_size should match the single covered map index"
    );
    assert_eq!(psmeta.exec_time(), total_time);
    assert_eq!(psmeta.cycles(), 4);
}

#[test]
fn test_calibrate_finish_without_calibrate_run() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add a seed so the scheduler has something to select.
    let seed_tc = make_seed_testcase(b"seed");
    let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
    fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

    // Set up last_input and last_corpus_id (simulating get_next_input).
    fuzzer.last_input = Some(BytesInput::new(b"test_input".to_vec()));
    fuzzer.last_corpus_id = Some(seed_id);

    // Write novel coverage to the map (2 edges hit).
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
        *fuzzer.map_ptr.add(20) = 1;
    }

    // report_result should detect novel coverage and return Interesting.
    let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    // Simulate: the JS-side target re-runs during calibration and writes
    // coverage, then crashes before calibrate_run() can zero the map.
    // This leaves stale calibration data that calibrate_finish must clear.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }

    // calibrate_finish() without ever calling calibrate_run().
    // calibration_first_map is None - the fallback should use the
    // bitmap_size from the testcase's SchedulerTestcaseMetadata.
    fuzzer.calibrate_finish().unwrap();

    // Verify the coverage map is zeroed after calibrate_finish
    // (this is the broken-calibration path where calibrate_run never ran).
    let map_after = unsafe { std::slice::from_raw_parts(fuzzer.map_ptr, fuzzer.map_len) };
    assert!(
        map_after.iter().all(|&b| b == 0),
        "coverage map should be zeroed after calibrate_finish (broken calibration path)"
    );

    // Verify global metadata has correct bitmap_size (from the fallback).
    // report_result saw 2 nonzero map indices (10 and 20).
    let psmeta = fuzzer.state.metadata::<SchedulerMetadata>().unwrap();
    assert_eq!(
        psmeta.bitmap_size(),
        2,
        "bitmap_size should match the two covered map indices via fallback"
    );
    assert_eq!(psmeta.bitmap_entries(), 1);
}

#[test]
fn test_calibrate_finish_errors_without_pending_calibration() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // calibrate_finish() on a fresh fuzzer with no prior Interesting result
    // should return an error because calibration_corpus_id is None.
    let err = fuzzer.calibrate_finish().unwrap_err();
    assert!(
        err.to_string().contains("without pending calibration"),
        "Expected 'without pending calibration' error, got: {err}"
    );
}
