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
pub(super) struct I2SSpliceReplace {
    inner: I2SRandReplace,
}

impl I2SSpliceReplace {
    pub(super) fn new() -> Self {
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

        // SAFETY of unwrap: cmps_len is checked > 0 above.
        let idx = state
            .rand_mut()
            .below(core::num::NonZero::new(cmps_len).unwrap());

        let meta = state.metadata_map().get::<CmpValuesMetadata>().unwrap();
        let cmp_values = meta.list[idx].clone();

        match &cmp_values {
            CmpValues::Bytes(v) => {
                // SAFETY of unwrap: input_len is checked > 0 above.
                let off = state
                    .rand_mut()
                    .below(core::num::NonZero::new(input_len).unwrap());
                let use_splice = state.rand_mut().coinflip(0.5);
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
