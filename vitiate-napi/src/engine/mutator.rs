use libafl::HasMetadata;
use libafl::corpus::CorpusId;
use libafl::inputs::{HasMutatorBytes, ResizableMutator};
use libafl::mutators::token_mutations::I2SRandReplace;
use libafl::mutators::{MutationResult, Mutator};
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
use libafl::state::{HasMaxSize, HasRand};
use libafl_bolts::rands::Rand;
use libafl_bolts::{AsSlice, HasLen, Named};

/// An I2S mutator that extends `I2SRandReplace` with a length-changing splice path
/// for `CmpValues::Bytes` entries. When a byte operand match is found, it randomly
/// chooses between overwrite (same-length, matching `I2SRandReplace` behavior) and
/// splice (delete matched bytes, insert full replacement, changing input length).
/// Non-`Bytes` variants delegate to the inner `I2SRandReplace`.
pub(crate) struct I2SSpliceReplace {
    inner: I2SRandReplace,
}

impl I2SSpliceReplace {
    pub(crate) fn new() -> Self {
        Self {
            inner: I2SRandReplace::new(),
        }
    }
}

impl Named for I2SSpliceReplace {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: std::borrow::Cow<'static, str> =
            std::borrow::Cow::Borrowed("I2SSpliceReplace");
        &NAME
    }
}

impl<I, S> Mutator<I, S> for I2SSpliceReplace
where
    S: HasMetadata + HasRand + HasMaxSize,
    I: ResizableMutator<u8> + HasMutatorBytes,
{
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut I,
    ) -> std::result::Result<MutationResult, libafl::Error> {
        let input_len = input.len();
        if input_len == 0 {
            return Ok(MutationResult::Skipped);
        }

        let cmps_len = {
            let Some(meta) = state.metadata_map().get::<CmpValuesMetadata>() else {
                return Ok(MutationResult::Skipped);
            };
            meta.list.len()
        };
        if cmps_len == 0 {
            return Ok(MutationResult::Skipped);
        }

        // SAFETY of unwraps: cmps_len and input_len are checked > 0 above.
        let idx = state
            .rand_mut()
            .below(core::num::NonZero::new(cmps_len).unwrap());
        let off = state
            .rand_mut()
            .below(core::num::NonZero::new(input_len).unwrap());
        // Pre-generate splice/overwrite coin flip while we have &mut state.
        let use_splice = state.rand_mut().coinflip(0.5);

        let meta = state.metadata_map().get::<CmpValuesMetadata>().unwrap();
        let cmp_values = meta.list[idx].clone();

        match &cmp_values {
            CmpValues::Bytes(v) => {
                let max_size = state.max_size();
                self.mutate_bytes_splice(input, &v.0, &v.1, off, max_size, use_splice)
            }
            // Non-Bytes variants: delegate entirely to inner I2SRandReplace.
            CmpValues::U8(_) | CmpValues::U16(_) | CmpValues::U32(_) | CmpValues::U64(_) => {
                self.inner.mutate(state, input)
            }
        }
    }

    #[inline]
    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> std::result::Result<(), libafl::Error> {
        Ok(())
    }
}

impl I2SSpliceReplace {
    /// Handle a `CmpValues::Bytes` match with splice/overwrite logic.
    ///
    /// Scans for both operands bidirectionally (v0 found → replace with v1,
    /// v1 found → replace with v0). Uses decreasing prefix lengths at each
    /// position. On match, randomly chooses between splice and overwrite
    /// (equal-length operands always use overwrite).
    fn mutate_bytes_splice<I>(
        &self,
        input: &mut I,
        v0: &libafl::observers::cmp::CmplogBytes,
        v1: &libafl::observers::cmp::CmplogBytes,
        off: usize,
        max_size: usize,
        use_splice: bool,
    ) -> std::result::Result<MutationResult, libafl::Error>
    where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let source_replacement_pairs: [(&[u8], &[u8]); 2] = [
            (v0.as_slice(), v1.as_slice()),
            (v1.as_slice(), v0.as_slice()),
        ];

        let input_len = input.len();

        for i in off..input_len {
            for &(source, replacement) in &source_replacement_pairs {
                if source.is_empty() {
                    continue;
                }
                if replacement.is_empty() {
                    continue;
                }
                let mut matched_prefix_len = core::cmp::min(source.len(), input_len - i);
                while matched_prefix_len > 0 {
                    if source[..matched_prefix_len]
                        == input.mutator_bytes()[i..i + matched_prefix_len]
                    {
                        return Ok(self.apply_splice_or_overwrite(
                            input,
                            replacement,
                            i,
                            matched_prefix_len,
                            max_size,
                            use_splice,
                        ));
                    }
                    matched_prefix_len -= 1;
                }
            }
        }

        Ok(MutationResult::Skipped)
    }

    /// Apply either splice or overwrite at the match position.
    ///
    /// For equal-length operands, always overwrites. Otherwise, uses the
    /// pre-generated coin flip.
    /// Splice respects max_size — falls back to overwrite if exceeded.
    fn apply_splice_or_overwrite<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
        max_size: usize,
        use_splice: bool,
    ) -> MutationResult
    where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let replacement_len = replacement.len();
        let current_len = input.len();

        if matched_prefix_len == replacement_len {
            // Equal length: always overwrite (splice and overwrite are identical).
            self.apply_overwrite(input, replacement, pos, matched_prefix_len);
        } else if use_splice {
            let new_len = current_len - matched_prefix_len + replacement_len;
            if new_len <= max_size {
                self.apply_splice(input, replacement, pos, matched_prefix_len);
            } else {
                // Splice would exceed max_size — fall back to overwrite.
                self.apply_overwrite(input, replacement, pos, matched_prefix_len);
            }
        } else {
            self.apply_overwrite(input, replacement, pos, matched_prefix_len);
        }

        MutationResult::Mutated
    }

    /// Overwrite: write `matched_prefix_len` bytes of replacement at pos.
    fn apply_overwrite<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
    ) where
        I: HasMutatorBytes,
    {
        let write_len = core::cmp::min(matched_prefix_len, replacement.len());
        input.mutator_bytes_mut()[pos..pos + write_len].copy_from_slice(&replacement[..write_len]);
    }

    /// Splice: delete matched_prefix_len bytes at pos, insert full replacement.
    fn apply_splice<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
    ) where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let current_len = input.len();
        let replacement_len = replacement.len();
        let tail_start = pos + matched_prefix_len;
        let tail_len = current_len - tail_start;
        let new_len = current_len - matched_prefix_len + replacement_len;

        if replacement_len > matched_prefix_len {
            // Growing: resize first, shift tail right, write replacement.
            input.resize(new_len, 0);
            let new_tail_start = pos + replacement_len;
            // SAFETY: after resize, new_tail_start + tail_len == new_len <= capacity.
            // `from` and `to` ranges may overlap, but `core::ptr::copy` handles that.
            if tail_len > 0 {
                let bytes = input.mutator_bytes_mut();
                unsafe {
                    core::ptr::copy(
                        bytes.as_ptr().add(tail_start),
                        bytes.as_mut_ptr().add(new_tail_start),
                        tail_len,
                    );
                }
            }
        } else {
            // Shrinking: shift tail left, then resize.
            let new_tail_start = pos + replacement_len;
            if tail_len > 0 {
                let bytes = input.mutator_bytes_mut();
                unsafe {
                    core::ptr::copy(
                        bytes.as_ptr().add(tail_start),
                        bytes.as_mut_ptr().add(new_tail_start),
                        tail_len,
                    );
                }
            }
            input.resize(new_len, 0);
        }

        // Write the full replacement.
        input.mutator_bytes_mut()[pos..pos + replacement_len].copy_from_slice(replacement);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::test_helpers::{make_coverage_map, make_state_and_feedback};
    use libafl::inputs::BytesInput;
    use libafl::observers::cmp::CmpValues;
    use libafl::state::HasMaxSize;
    use libafl_bolts::rands::StdRand;

    use crate::engine::FuzzerState;
    use crate::engine::test_helpers::make_cmplog_bytes;

    /// Find a seed that produces the desired RNG sequence for I2SSpliceReplace::mutate().
    ///
    /// The mutate() method makes three RNG calls in order:
    /// 1. `below(cmps_len)` → entry index
    /// 2. `below(input_len)` → starting offset
    /// 3. `coinflip(0.5)` → splice (true) or overwrite (false)
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

        let mut seed = 0u64;
        for s in 0u64..100_000 {
            let mut rng = StdRand::with_seed(s);
            let idx = rng.below(NonZero::new(2).unwrap());
            if idx == 0 {
                seed = s;
                break;
            }
        }

        let entries = vec![
            CmpValues::U32((42, 99, false)),
            CmpValues::Bytes((make_cmplog_bytes(b"abc"), make_cmplog_bytes(b"xyz"))),
        ];

        let input_bytes = 42u32.to_ne_bytes().to_vec();
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(input_bytes.clone());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert!(
            result == MutationResult::Mutated || result == MutationResult::Skipped,
            "non-Bytes entry should delegate to inner I2SRandReplace"
        );

        let mutated = input.mutator_bytes();
        assert!(
            !mutated.windows(3).any(|w| w == b"xyz" || w == b"abc"),
            "Bytes entry should not have been applied; \
             the U32 path (delegation) should have been taken instead"
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
}
