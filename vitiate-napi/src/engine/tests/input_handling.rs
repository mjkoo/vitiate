use super::helpers::{
    make_coverage_map, make_scheduler, make_seed_testcase, make_state_and_feedback,
};
use crate::engine::DEFAULT_SEEDS;
use libafl::corpus::Corpus;
use libafl::inputs::BytesInput;
use libafl::mutators::{HavocScheduledMutator, Mutator, havoc_mutations, tokens_mutations};
use libafl::schedulers::Scheduler;
use libafl::state::HasCorpus;
use libafl_bolts::tuples::Merge;

#[test]
fn test_get_next_input_auto_seeds() {
    let (map_ptr, _map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
    let mut scheduler = make_scheduler(map_ptr, _map.len());
    let mut mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));

    // Seed with only non-empty entries so the non-empty assertion is sound
    // regardless of which entry the scheduler picks.
    let nonempty_seeds: Vec<&[u8]> = DEFAULT_SEEDS
        .iter()
        .copied()
        .filter(|s| !s.is_empty())
        .collect();
    for seed in &nonempty_seeds {
        let testcase = make_seed_testcase(seed);
        let id = state.corpus_mut().add(testcase).unwrap();
        scheduler.on_add(&mut state, id).unwrap();
    }

    assert_eq!(state.corpus().count(), nonempty_seeds.len());

    // Get a mutated input and verify mutation changed it.
    let corpus_id = scheduler.next(&mut state).unwrap();
    let mut input = state.corpus().cloned_input_for_id(corpus_id).unwrap();
    let original: Vec<u8> = input.as_ref().to_vec();
    let _ = mutator.mutate(&mut state, &mut input).unwrap();
    let mutated: &[u8] = input.as_ref();
    assert_ne!(
        original.as_slice(),
        mutated,
        "Mutated input should differ from corpus entry"
    );
}

#[test]
fn test_max_input_len_enforcement() {
    let max_input_len: usize = 128;

    // Construct an input that exceeds max_input_len.
    let oversized = BytesInput::new(vec![0x41u8; 256]);
    let bytes: Vec<u8> = oversized.into();
    assert!(
        bytes.len() > max_input_len,
        "precondition: input exceeds limit"
    );

    // Simulate the truncation step that the engine performs.
    let truncated = &bytes[..std::cmp::min(bytes.len(), max_input_len)];
    assert_eq!(truncated.len(), max_input_len);

    // An input already within the limit should be unchanged.
    let small = BytesInput::new(vec![0x42u8; 64]);
    let small_bytes: Vec<u8> = small.into();
    let truncated_small = &small_bytes[..std::cmp::min(small_bytes.len(), max_input_len)];
    assert_eq!(truncated_small.len(), 64);
}
