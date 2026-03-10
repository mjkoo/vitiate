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
/// for `CmpValues::Bytes` entries. When a byte operand match is found, it splices
/// (delete matched bytes, insert full replacement) when operand lengths differ, or
/// overwrites in-place when lengths match.
///
/// Key differences from `I2SRandReplace`:
/// - Uses wrap-around scanning: starts from a random offset but checks ALL input
///   positions, ensuring matches at any position are found.
/// - Enforces a minimum match threshold (half the source length, ≥ 2 bytes) to
///   avoid wasting mutations on useless single-byte partial matches.
/// - Always uses splice when source and replacement have different lengths, since
///   overwriting a prefix of the replacement is incorrect for equality comparisons
///   (produces a truncated constant that won't satisfy the comparison).
/// - Handles empty operands: an empty source with a non-empty replacement triggers
///   insertion at the random offset; a non-empty source with an empty replacement
///   triggers deletion when the source is found in the input.
///
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
                let max_size = state.max_size();
                self.mutate_bytes_splice(input, &v.0, &v.1, off, max_size)
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
    /// Uses wrap-around scanning: starts from a random offset `off` but checks
    /// all `input_len` positions by wrapping to position 0 after reaching the end.
    /// This ensures matches at any position are found regardless of the starting
    /// offset, while the random start provides diversity when multiple matches exist.
    ///
    /// Enforces a minimum match threshold: at least half the source operand length
    /// and at least 2 bytes. This prevents wasting mutations on single-byte partial
    /// matches (which dominated the previous behavior at ~99% of all matches).
    ///
    /// When source and replacement have different lengths, always uses splice
    /// (length-changing mutation) since overwriting a prefix is incorrect for
    /// equality comparisons.
    ///
    /// Special cases for empty operands:
    /// - Non-empty source + empty replacement: scans for the source and deletes it
    ///   (splice with zero-length replacement).
    /// - Empty source + non-empty replacement: handled as an insertion fallback
    ///   after the scan loop — inserts the replacement at `off` when no scan match
    ///   was found. This ensures deletion/replacement of bytes already in the input
    ///   is preferred over blind insertion.
    fn mutate_bytes_splice<I>(
        &self,
        input: &mut I,
        v0: &libafl::observers::cmp::CmplogBytes,
        v1: &libafl::observers::cmp::CmplogBytes,
        off: usize,
        max_size: usize,
    ) -> std::result::Result<MutationResult, libafl::Error>
    where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let source_replacement_pairs: [(&[u8], &[u8]); 2] = [
            (v0.as_slice(), v1.as_slice()),
            (v1.as_slice(), v0.as_slice()),
        ];

        let input_len = input.len();

        // Wrap-around scan: check all positions starting from `off`.
        // Pairs with empty source are skipped here — they're handled by the
        // insertion fallback below.
        for k in 0..input_len {
            let i = (off + k) % input_len;
            for &(source, replacement) in &source_replacement_pairs {
                if source.is_empty() {
                    continue;
                }
                let max_match = core::cmp::min(source.len(), input_len - i);
                // Minimum match threshold: at least half the source length,
                // at least 2 bytes. Prevents useless single-byte partial matches.
                let min_match = core::cmp::max(2, source.len().div_ceil(2));
                if max_match < min_match {
                    continue;
                }
                // Try decreasing prefix lengths from max down to minimum threshold.
                let mut matched_prefix_len = max_match;
                while matched_prefix_len >= min_match {
                    if source[..matched_prefix_len]
                        == input.mutator_bytes()[i..i + matched_prefix_len]
                    {
                        return Ok(self.apply_mutation(
                            input,
                            replacement,
                            i,
                            matched_prefix_len,
                            max_size,
                        ));
                    }
                    matched_prefix_len -= 1;
                }
            }
        }

        // Insertion fallback: if no scan match was found, try inserting a
        // non-empty replacement at the random offset when its source is empty.
        // This handles the case where the comparison target isn't present in the
        // input yet (e.g., CmpLog entry ("", "javascript") from an empty scheme).
        for &(source, replacement) in &source_replacement_pairs {
            if source.is_empty() && !replacement.is_empty() {
                let new_len = input_len + replacement.len();
                if new_len <= max_size {
                    return Ok(self.apply_mutation(input, replacement, off, 0, max_size));
                }
            }
        }

        Ok(MutationResult::Skipped)
    }

    /// Apply the mutation at the match position.
    ///
    /// When the matched prefix length equals the replacement length, overwrites
    /// in-place (splice and overwrite are identical for equal-length operands).
    /// Otherwise, always uses splice: overwriting a prefix of a longer replacement
    /// produces a truncated constant that cannot satisfy an equality comparison.
    /// Splice respects max_size — falls back to overwrite if the spliced result
    /// would exceed the limit.
    fn apply_mutation<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
        max_size: usize,
    ) -> MutationResult
    where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let replacement_len = replacement.len();
        let current_len = input.len();

        // Invariant: at least one of these must be non-zero, otherwise the
        // mutation is a no-op that would falsely report Mutated.
        debug_assert!(
            matched_prefix_len > 0 || replacement_len > 0,
            "apply_mutation called with both matched_prefix_len=0 and empty replacement"
        );

        if matched_prefix_len == replacement_len {
            // Equal length: overwrite in-place (splice is identical).
            self.apply_overwrite(input, replacement, pos, matched_prefix_len);
        } else {
            // Different lengths: always splice to produce the full replacement.
            let new_len = current_len - matched_prefix_len + replacement_len;
            if new_len <= max_size {
                self.apply_splice(input, replacement, pos, matched_prefix_len);
            } else {
                // Splice would exceed max_size — fall back to overwrite as a
                // best-effort partial mutation.
                self.apply_overwrite(input, replacement, pos, matched_prefix_len);
            }
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
