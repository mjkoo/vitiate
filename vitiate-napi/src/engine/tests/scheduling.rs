use std::time::Duration;

use super::helpers::{TestFuzzerBuilder, make_coverage_map, make_fuzzer};
use crate::types::{ExitKind, IterationResult};
use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, SchedulerTestcaseMetadata, Testcase};
use libafl::inputs::BytesInput;
use libafl::schedulers::TestcaseScore;
use libafl::schedulers::powersched::{N_FUZZ_SIZE, SchedulerMetadata};
use libafl::schedulers::testcase_score::CorpusPowerTestcaseScore;
use libafl::state::HasCorpus;
use napi::bindgen_prelude::Buffer;

#[test]
fn test_power_scoring_favors_fast_high_coverage_entry() {
    let (map_ptr, _map) = make_coverage_map(1024);
    let (mut state, ..) = make_fuzzer(map_ptr, 1024);

    // Set up global metadata with averages between the two entries so
    // scoring has a meaningful baseline to compare against.
    {
        let psmeta = state.metadata_mut::<SchedulerMetadata>().unwrap();
        psmeta.set_exec_time(Duration::from_micros(1100)); // total for 2 entries
        psmeta.set_cycles(2);
        psmeta.set_bitmap_size(550); // total for 2 entries
        psmeta.set_bitmap_size_log((500f64).log2() + (50f64).log2());
        psmeta.set_bitmap_entries(2);
    }

    // Entry A: fast (100us), high coverage (bitmap 500).
    let mut tc_a = Testcase::new(BytesInput::new(b"fast_high_cov".to_vec()));
    tc_a.set_exec_time(Duration::from_micros(100));
    let mut meta_a = SchedulerTestcaseMetadata::new(0);
    meta_a.set_bitmap_size(500);
    meta_a.set_n_fuzz_entry(0);
    meta_a.set_handicap(0);
    meta_a.set_cycle_and_time((Duration::from_micros(400), 4));
    tc_a.add_metadata(meta_a);

    // Entry B: slow (1ms), low coverage (bitmap 50).
    let mut tc_b = Testcase::new(BytesInput::new(b"slow_low_cov".to_vec()));
    tc_b.set_exec_time(Duration::from_millis(1));
    let mut meta_b = SchedulerTestcaseMetadata::new(0);
    meta_b.set_bitmap_size(50);
    meta_b.set_n_fuzz_entry(1);
    meta_b.set_handicap(0);
    meta_b.set_cycle_and_time((Duration::from_millis(4), 4));
    tc_b.add_metadata(meta_b);

    let score_a = CorpusPowerTestcaseScore::compute(&state, &mut tc_a).unwrap();
    let score_b = CorpusPowerTestcaseScore::compute(&state, &mut tc_b).unwrap();

    assert!(
        score_a > score_b,
        "Fast/high-coverage entry (score={score_a}) should score higher \
         than slow/low-coverage entry (score={score_b})"
    );
}

#[test]
fn test_n_fuzz_entry_set_on_interesting_input() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add a seed so the scheduler has something to select.
    fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

    // get_next_input selects and mutates.
    let _input = fuzzer.get_next_input().unwrap();

    // Write novel coverage.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }

    let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
    assert!(matches!(result, IterationResult::Interesting));

    // The interesting entry should have n_fuzz_entry = usize::from(id) % N_FUZZ_SIZE.
    let interesting_id = fuzzer
        .calibration
        .corpus_id
        .expect("calibration corpus_id should be set");
    let tc = fuzzer.state.corpus().get(interesting_id).unwrap().borrow();
    let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
    let expected = usize::from(interesting_id) % N_FUZZ_SIZE;
    assert_eq!(
        meta.n_fuzz_entry(),
        expected,
        "n_fuzz_entry should be corpus_id % N_FUZZ_SIZE, not default 0"
    );
    // For corpus ID > 0 (seed is ID 0, interesting entry is ID 1+), this should be nonzero.
    assert_ne!(
        meta.n_fuzz_entry(),
        0,
        "n_fuzz_entry for the second corpus entry should not be 0"
    );
}

#[test]
fn test_seed_has_n_fuzz_entry() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add two seeds.
    fuzzer.add_seed(Buffer::from(b"seed0".to_vec())).unwrap();
    fuzzer.add_seed(Buffer::from(b"seed1".to_vec())).unwrap();

    // Verify each seed has n_fuzz_entry = usize::from(id) % N_FUZZ_SIZE.
    for id in fuzzer.state.corpus().ids() {
        let tc = fuzzer.state.corpus().get(id).unwrap().borrow();
        let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
        let expected = usize::from(id) % N_FUZZ_SIZE;
        assert_eq!(
            meta.n_fuzz_entry(),
            expected,
            "seed {id:?} should have n_fuzz_entry = {expected}"
        );
    }
}

#[test]
fn test_n_fuzz_incremented_on_selection() {
    let mut fuzzer = TestFuzzerBuilder::new(256).build();

    // Add two seeds.
    fuzzer.add_seed(Buffer::from(b"seed0".to_vec())).unwrap();
    fuzzer.add_seed(Buffer::from(b"seed1".to_vec())).unwrap();

    // Record the initial n_fuzz values for both seeds' entries.
    let mut initial_counts: Vec<(CorpusId, usize, u32)> = Vec::new();
    for id in fuzzer.state.corpus().ids() {
        let tc = fuzzer.state.corpus().get(id).unwrap().borrow();
        let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
        let idx = meta.n_fuzz_entry();
        let count = fuzzer
            .state
            .metadata::<SchedulerMetadata>()
            .unwrap()
            .n_fuzz()[idx];
        initial_counts.push((id, idx, count));
    }

    // Call get_next_input multiple times to trigger n_fuzz increments.
    for _ in 0..20 {
        let _ = fuzzer.get_next_input().unwrap();
    }

    // Verify that at least one seed's n_fuzz counter was incremented.
    let mut any_incremented = false;
    for &(_, idx, initial) in &initial_counts {
        let current = fuzzer
            .state
            .metadata::<SchedulerMetadata>()
            .unwrap()
            .n_fuzz()[idx];
        if current > initial {
            any_incremented = true;
        }
    }
    assert!(
        any_incremented,
        "n_fuzz counters should be incremented after get_next_input selections"
    );

    // Verify total increments match total get_next_input calls.
    let total_increments: u32 = initial_counts
        .iter()
        .map(|&(_, idx, initial)| {
            fuzzer
                .state
                .metadata::<SchedulerMetadata>()
                .unwrap()
                .n_fuzz()[idx]
                - initial
        })
        .sum();
    assert_eq!(
        total_increments, 20,
        "total n_fuzz increments should equal the number of get_next_input calls"
    );
}
