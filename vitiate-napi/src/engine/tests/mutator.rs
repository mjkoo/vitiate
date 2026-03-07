use super::helpers::{make_cmplog_bytes, make_coverage_map, make_state_and_feedback};
use crate::engine::FuzzerState;
use libafl::observers::cmp::CmpValuesMetadata;

use crate::engine::mutator::I2SSpliceReplace;
use libafl::HasMetadata;
use libafl::inputs::{BytesInput, HasMutatorBytes};
use libafl::mutators::{MutationResult, Mutator};
use libafl::observers::cmp::CmpValues;
use libafl::state::{HasMaxSize, HasRand};
use libafl_bolts::rands::{Rand, StdRand};

/// Find a seed that produces the desired RNG sequence for I2SSpliceReplace::mutate()
/// when the selected entry is a `CmpValues::Bytes` variant.
///
/// The mutate() method makes these RNG calls in order for Bytes entries:
/// 1. `below(cmps_len)` → entry index
/// 2. `below(input_len)` → starting offset
/// 3. `coinflip(0.5)` → splice (true) or overwrite (false)
///
/// For non-Bytes entries, only call 1 is made before delegating to the inner mutator.
fn find_i2s_seed(
    cmps_len: usize,
    input_len: usize,
    want_idx: usize,
    want_off: usize,
    want_splice: bool,
) -> u64 {
    use core::num::NonZero;
    for seed in 0u64..100_000 {
        let mut rng = StdRand::with_seed(seed);
        let idx = rng.below(NonZero::new(cmps_len).unwrap());
        let off = rng.below(NonZero::new(input_len).unwrap());
        let flip = rng.coinflip(0.5);
        if idx == want_idx && off == want_off && flip == want_splice {
            return seed;
        }
    }
    panic!(
        "no seed found for cmps_len={cmps_len}, input_len={input_len}, want_idx={want_idx}, want_off={want_off}, want_splice={want_splice}"
    );
}

/// Create a FuzzerState with seeded RNG and CmpValuesMetadata containing the given entries.
fn make_i2s_state(seed: u64, entries: Vec<CmpValues>, max_size: usize) -> FuzzerState {
    let (map_ptr, _map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
    // Replace the default RNG with our seeded one.
    *state.rand_mut() = StdRand::with_seed(seed);
    state.set_max_size(max_size);
    state
        .metadata_map_mut()
        .insert(CmpValuesMetadata { list: entries });
    state
}

#[test]
fn test_i2s_splice_shorter_match_with_longer_operand() {
    let seed = find_i2s_seed(1, 18, 0, 0, true);
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"http"),
        make_cmplog_bytes(b"javascript"),
    ))];
    let mut state = make_i2s_state(seed, entries, 4096);
    let mut input = BytesInput::new(b"http://example.com".to_vec());
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(input.mutator_bytes(), b"javascript://example.com");
    assert_eq!(input.mutator_bytes().len(), 24);
}

#[test]
fn test_i2s_splice_longer_match_with_shorter_operand() {
    let seed = find_i2s_seed(1, 14, 0, 0, true);
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"javascript"),
        make_cmplog_bytes(b"ftp"),
    ))];
    let mut state = make_i2s_state(seed, entries, 4096);
    let mut input = BytesInput::new(b"javascript://x".to_vec());
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(input.mutator_bytes(), b"ftp://x");
    assert_eq!(input.mutator_bytes().len(), 7);
}

#[test]
fn test_i2s_overwrite_truncates_replacement() {
    let seed = find_i2s_seed(1, 18, 0, 0, false);
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"http"),
        make_cmplog_bytes(b"javascript"),
    ))];
    let mut state = make_i2s_state(seed, entries, 4096);
    let mut input = BytesInput::new(b"http://example.com".to_vec());
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(input.mutator_bytes(), b"java://example.com");
    assert_eq!(input.mutator_bytes().len(), 18);
}

#[test]
fn test_i2s_equal_length_always_overwrites() {
    for want_splice in [true, false] {
        let seed = find_i2s_seed(1, 4, 0, 0, want_splice);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"test"),
            make_cmplog_bytes(b"pass"),
        ))];
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(b"test".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(
            input.mutator_bytes(),
            b"pass",
            "equal-length operands should always overwrite, want_splice={want_splice}"
        );
        assert_eq!(input.mutator_bytes().len(), 4, "length should be unchanged");
    }
}

#[test]
fn test_i2s_non_bytes_delegates_to_inner() {
    use core::num::NonZero;

    // Use only U32 entries so the inner I2SRandReplace can only apply U32 mutations.
    // The outer mutate() draws one RNG value (idx), then delegates to the inner
    // I2SRandReplace which draws its own idx and off. Find a seed where the inner
    // mutator's off lands within the 4-byte input so it can find the match.
    let entries = vec![CmpValues::U32((42, 99, false))];
    let input_bytes = 42u32.to_ne_bytes().to_vec();

    let mut seed = None;
    for s in 0u64..100_000 {
        let mut rng = StdRand::with_seed(s);
        // Outer mutate: draws idx (cmps_len=1, always 0).
        let _outer_idx = rng.below(NonZero::new(1).unwrap());
        // Inner I2SRandReplace::mutate: draws idx then off.
        let _inner_idx = rng.below(NonZero::new(1).unwrap());
        let inner_off = rng.below(NonZero::new(input_bytes.len()).unwrap());
        // off must be 0 for a 4-byte U32 match in a 4-byte input.
        if inner_off == 0 {
            seed = Some(s);
            break;
        }
    }
    let seed = seed.expect("no suitable seed found");

    let mut state = make_i2s_state(seed, entries, 4096);
    let mut input = BytesInput::new(input_bytes);
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(
        result,
        MutationResult::Mutated,
        "U32 entry should delegate to inner I2SRandReplace and mutate"
    );

    assert_eq!(
        input.mutator_bytes(),
        &99u32.to_ne_bytes(),
        "inner I2SRandReplace should have replaced 42 with 99"
    );
}

#[test]
fn test_i2s_splice_exceeding_max_size_falls_back_to_overwrite() {
    let mut input_bytes = vec![0u8; 120];
    input_bytes[0..4].copy_from_slice(b"http");

    let seed = find_i2s_seed(1, 120, 0, 0, true);
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"http"),
        make_cmplog_bytes(b"12345678901234567890"),
    ))];
    let mut state = make_i2s_state(seed, entries, 128);
    let mut input = BytesInput::new(input_bytes);
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(&input.mutator_bytes()[0..4], b"1234");
    assert_eq!(
        input.mutator_bytes().len(),
        120,
        "length should be unchanged (overwrite fallback)"
    );
    assert_eq!(
        &input.mutator_bytes()[4..],
        &[0u8; 116],
        "tail bytes should be unchanged after overwrite fallback"
    );
}

#[test]
fn test_i2s_splice_within_max_size_proceeds() {
    let mut input_bytes = vec![0x41u8; 100];
    input_bytes[0..4].copy_from_slice(b"http");

    let seed = find_i2s_seed(1, 100, 0, 0, true);
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"http"),
        make_cmplog_bytes(b"javascript"),
    ))];
    let mut state = make_i2s_state(seed, entries, 4096);
    let mut input = BytesInput::new(input_bytes);
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(&input.mutator_bytes()[0..10], b"javascript");
    assert_eq!(
        input.mutator_bytes().len(),
        106,
        "splice should grow input by 6"
    );
    assert!(
        input.mutator_bytes()[10..].iter().all(|&b| b == 0x41),
        "tail bytes should be preserved after splice"
    );
}

#[test]
fn test_i2s_bidirectional_matching() {
    let entries_forward = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"abc"),
        make_cmplog_bytes(b"xyz"),
    ))];
    let entries_reverse = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"abc"),
        make_cmplog_bytes(b"xyz"),
    ))];

    let seed = find_i2s_seed(1, 3, 0, 0, false);
    let mut state = make_i2s_state(seed, entries_forward, 4096);
    let mut input = BytesInput::new(b"abc".to_vec());
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(input.mutator_bytes(), b"xyz", "forward match: abc → xyz");

    let mut state = make_i2s_state(seed, entries_reverse, 4096);
    let mut input = BytesInput::new(b"xyz".to_vec());

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(input.mutator_bytes(), b"abc", "reverse match: xyz → abc");
}

#[test]
fn test_i2s_partial_prefix_match_with_splice() {
    let input_bytes = b"htt://x".to_vec();
    let seed = find_i2s_seed(1, 7, 0, 0, true);
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"http"),
        make_cmplog_bytes(b"javascript"),
    ))];
    let mut state = make_i2s_state(seed, entries, 4096);
    let mut input = BytesInput::new(input_bytes);
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Mutated);
    assert_eq!(input.mutator_bytes(), b"javascript://x");
    assert_eq!(
        input.mutator_bytes().len(),
        14,
        "length should be 7 - 3 + 10 = 14"
    );
}

#[test]
fn test_i2s_empty_metadata_or_input_returns_skipped() {
    // Absent CmpValuesMetadata entirely → Skipped.
    let (map_ptr, _map) = make_coverage_map(65536);
    let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
    *state.rand_mut() = StdRand::with_seed(42);
    state.set_max_size(4096);
    let mut input = BytesInput::new(b"some data".to_vec());
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(
        result,
        MutationResult::Skipped,
        "absent metadata should skip"
    );

    // Empty CmpValuesMetadata → Skipped.
    let mut state = make_i2s_state(42, vec![], 4096);
    let mut input = BytesInput::new(b"some data".to_vec());
    let mut mutator = I2SSpliceReplace::new();

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(
        result,
        MutationResult::Skipped,
        "empty metadata should skip"
    );

    // Empty input → Skipped.
    let entries = vec![CmpValues::Bytes((
        make_cmplog_bytes(b"abc"),
        make_cmplog_bytes(b"xyz"),
    ))];
    let mut state = make_i2s_state(42, entries, 4096);
    let mut input = BytesInput::new(vec![]);

    let result = mutator.mutate(&mut state, &mut input).unwrap();
    assert_eq!(result, MutationResult::Skipped, "empty input should skip");
}
