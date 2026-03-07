use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::ops::Range;

use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, HasCurrentCorpusId};
use libafl::mutators::MultiMutator;
use libafl::observers::cmp::AflppCmpValuesMetadata;
use libafl::stages::colorization::TaintMetadata;
use libafl::state::{HasCorpus, HasExecutions, HasRand};
use libafl_bolts::rands::Rand;
use napi::bindgen_prelude::*;

use super::Fuzzer;

/// Maximum input size for colorization. Inputs exceeding this are skipped.
pub const MAX_COLORIZATION_LEN: usize = 4096;

/// Maximum number of REDQUEEN candidates per corpus entry.
const MAX_REDQUEEN_CANDIDATES: usize = 2048;

/// Compute a fast u64 hash of the set of nonzero coverage map indices.
///
/// Ignores hit counts (which fluctuate between runs) and focuses on which
/// edges were hit. This matches colorization's semantics: did the coverage
/// *pattern* change?
pub fn coverage_hash(map: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for (i, &val) in map.iter().enumerate() {
        if val > 0 {
            i.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// Produce a copy of the input with every byte replaced by a type-preserving
/// value guaranteed to differ from the original.
///
/// Ported from LibAFL's `type_replace` algorithm in `colorization.rs`.
/// Deterministic for a given RNG state.
pub fn type_replace(input: &[u8], rand: &mut impl Rand) -> Vec<u8> {
    /// Pick a random value from [range_start, range_start + class_size) excluding `original`.
    /// Requires `original` to be in the range and `class_size >= 2`.
    fn rand_in_class_excluding(
        rand: &mut impl Rand,
        range_start: u8,
        class_size: u8,
        original: u8,
    ) -> u8 {
        // Pick from [0, class_size - 1), then skip past `original`.
        let offset_of_original = original - range_start;
        // SAFETY-INVARIANT: class_size >= 2, so class_size - 1 >= 1
        let r = rand.below(core::num::NonZero::new(usize::from(class_size - 1)).unwrap()) as u8;
        if r >= offset_of_original {
            range_start + r + 1
        } else {
            range_start + r
        }
    }

    let mut output = input.to_vec();
    for byte in &mut output {
        let original = *byte;
        let replacement = match original {
            // Hex uppercase letters: 'A'-'F'
            0x41..=0x46 => rand_in_class_excluding(rand, 0x41, 6, original),
            // Hex lowercase letters: 'a'-'f'
            0x61..=0x66 => rand_in_class_excluding(rand, 0x61, 6, original),
            // '0' ↔ '1' swap deterministically
            0x30 => 0x31,
            0x31 => 0x30,
            // Digits '2'-'9'
            0x32..=0x39 => rand_in_class_excluding(rand, 0x32, 8, original),
            // Non-hex uppercase 'G'-'Z'
            0x47..=0x5a => rand_in_class_excluding(rand, 0x47, 20, original),
            // Non-hex lowercase 'g'-'z'
            0x67..=0x7a => rand_in_class_excluding(rand, 0x67, 20, original),
            // Punctuation groups
            0x21..=0x2a => rand_in_class_excluding(rand, 0x21, 10, original),
            0x2c..=0x2e => rand_in_class_excluding(rand, 0x2c, 3, original),
            0x3a..=0x40 => rand_in_class_excluding(rand, 0x3a, 7, original),
            0x5b..=0x60 => rand_in_class_excluding(rand, 0x5b, 6, original),
            0x7b..=0x7e => rand_in_class_excluding(rand, 0x7b, 4, original),
            // '+' ↔ '/' swap deterministically
            0x2b => 0x2f,
            0x2f => 0x2b,
            // Whitespace swaps
            0x20 => 0x09, // space → tab
            0x09 => 0x20, // tab → space
            0x0d => 0x0a, // CR → LF
            0x0a => 0x0d, // LF → CR
            // Special byte values
            0x00 => 0x01,
            0x01 | 0xff => 0x00,
            // Fallback: XOR-based replacement
            _ => {
                if original < 0x20 {
                    original ^ 0x1f
                } else {
                    original ^ 0x7f
                }
            }
        };
        *byte = replacement;
    }
    output
}

/// Merge adjacent/overlapping taint ranges into a minimal set.
pub fn merge_ranges(mut ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if last.end >= range.start {
                last.end = last.end.max(range.end);
            } else {
                merged.push(range);
            }
        } else {
            merged.push(range);
        }
    }
    merged
}

/// Build the fully-colorized input: all taint ranges filled with the changed
/// bytes, all non-taint bytes from the original.
fn build_colorized_input(
    original: &[u8],
    changed: &[u8],
    taint_ranges: &[Range<usize>],
) -> Vec<u8> {
    let mut result = original.to_vec();
    for range in taint_ranges {
        result[range.clone()].copy_from_slice(&changed[range.clone()]);
    }
    result
}

/// Group enriched CmpLog entries by site ID into a hashbrown HashMap
/// (matching `AflppCmpValuesMetadata.new_cmpvals` type).
pub fn group_cmplog_by_site(
    entries: &[crate::cmplog::CmpLogEntry],
) -> hashbrown::HashMap<usize, Vec<libafl::observers::cmp::CmpValues>> {
    let mut map = hashbrown::HashMap::new();
    for (cmp_values, site_id, _operator) in entries {
        map.entry(*site_id as usize)
            .or_insert_with(Vec::new)
            .push(cmp_values.clone());
    }
    map
}

impl Fuzzer {
    /// Attempt to begin the colorization stage for the given corpus entry.
    ///
    /// Returns `Some(Buffer)` containing the original corpus entry (for baseline
    /// hash computation) if colorization starts, or `None` if skipped.
    pub(crate) fn begin_colorization(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        let input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        let input_bytes: Vec<u8> = input.into();

        if input_bytes.len() > MAX_COLORIZATION_LEN {
            return Ok(None);
        }

        // Apply type_replace to produce the changed input.
        let changed_input = type_replace(&input_bytes, self.state.rand_mut());

        let max_executions = input_bytes.len() * 2;

        // Store the original for advanceStage() evaluation.
        self.last_stage_input = Some(input_bytes.clone());

        self.stage_state = super::StageState::Colorization {
            corpus_id,
            original_hash: 0, // Set after first advance (baseline execution)
            original_input: input_bytes.clone(),
            changed_input,
            pending_ranges: Vec::new(), // Populated after baseline hash
            taint_ranges: Vec::new(),
            executions: 0,
            max_executions,
            awaiting_dual_trace: false,
            testing_range: None, // Baseline has no range
        };

        // Return the original input for the baseline execution.
        Ok(Some(Buffer::from(input_bytes)))
    }

    /// Advance the colorization stage after an execution.
    ///
    /// Returns the next candidate input, or `None` if colorization is complete
    /// (signaling the caller to transition to REDQUEEN or the next stage).
    pub(crate) fn advance_colorization(&mut self, _exec_time_ns: f64) -> Result<Option<Buffer>> {
        // Extract state fields.
        let (
            corpus_id,
            mut original_hash,
            original_input,
            changed_input,
            mut pending_ranges,
            mut taint_ranges,
            mut executions,
            max_executions,
            awaiting_dual_trace,
            testing_range,
        ) = match std::mem::replace(&mut self.stage_state, super::StageState::None) {
            super::StageState::Colorization {
                corpus_id,
                original_hash,
                original_input,
                changed_input,
                pending_ranges,
                taint_ranges,
                executions,
                max_executions,
                awaiting_dual_trace,
                testing_range,
            } => (
                corpus_id,
                original_hash,
                original_input,
                changed_input,
                pending_ranges,
                taint_ranges,
                executions,
                max_executions,
                awaiting_dual_trace,
                testing_range,
            ),
            other => {
                // Put state back and error.
                self.stage_state = other;
                return Err(Error::from_reason(
                    "advance_colorization: not in Colorization state",
                ));
            }
        };

        // Count this execution.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;
        executions += 1;

        if awaiting_dual_trace {
            // This was the dual trace execution. Drain and RETAIN CmpLog.
            let cmp_entries = crate::cmplog::drain();
            let new_cmpvals = group_cmplog_by_site(&cmp_entries);

            // Update AflppCmpValuesMetadata with new_cmpvals.
            if let Some(meta) = self
                .state
                .metadata_map_mut()
                .get_mut::<AflppCmpValuesMetadata>()
            {
                meta.new_cmpvals = new_cmpvals;
            }

            // Store TaintMetadata now that dual trace succeeded.
            let merged = merge_ranges(taint_ranges);
            let colorized_input = build_colorized_input(&original_input, &changed_input, &merged);
            let taint_metadata = TaintMetadata::new(colorized_input, merged);
            self.state.metadata_map_mut().insert(taint_metadata);

            // Zero the coverage map.
            unsafe {
                std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
            }

            // Colorization complete — transition to REDQUEEN.
            self.stage_state = super::StageState::None;
            return self.begin_redqueen(corpus_id);
        }

        // Drain and discard CmpLog (stage data is noise, except for dual trace).
        let _ = crate::cmplog::drain();

        // Read coverage map.
        let map = unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) };

        if executions == 1 {
            // First advance: this was the baseline execution.
            // Compute original_hash from the coverage map.
            original_hash = coverage_hash(map);

            // Zero the coverage map.
            unsafe {
                std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
            }

            // Initialize pending_ranges with the full input range.
            if !original_input.is_empty() {
                pending_ranges.push((0, original_input.len()));
            }

            // Pop the next pending range and build candidate.
            if let Some((start, end)) = pending_ranges.pop() {
                let mut candidate = original_input.clone();
                candidate[start..end].copy_from_slice(&changed_input[start..end]);

                self.last_stage_input = Some(candidate.clone());
                self.stage_state = super::StageState::Colorization {
                    corpus_id,
                    original_hash,
                    original_input,
                    changed_input,
                    pending_ranges,
                    taint_ranges,
                    executions,
                    max_executions,
                    awaiting_dual_trace: false,
                    testing_range: Some((start, end)),
                };
                return Ok(Some(Buffer::from(candidate)));
            }

            // Empty input — go straight to dual trace.
            return self.transition_to_dual_trace(
                corpus_id,
                original_hash,
                original_input,
                changed_input,
                taint_ranges,
                executions,
                max_executions,
            );
        }

        // Subsequent advances: process the binary search result.
        let current_hash = coverage_hash(map);

        // Zero the coverage map.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        // Process the result of the last tested range.
        if let Some((start, end)) = testing_range {
            if current_hash == original_hash {
                // The range is free — add to taint_ranges.
                taint_ranges.push(start..end);
            } else {
                // The range affects coverage — split and re-add.
                let len = end - start;
                if len > 1 {
                    let mid = start + len / 2;
                    pending_ranges.push((start, mid));
                    pending_ranges.push((mid, end));
                }
                // Ranges of length 1 that differ are discarded (byte is not free).
            }
        }

        // Check termination: no more pending ranges or max_executions reached.
        if pending_ranges.is_empty() || executions >= max_executions {
            return self.transition_to_dual_trace(
                corpus_id,
                original_hash,
                original_input,
                changed_input,
                taint_ranges,
                executions,
                max_executions,
            );
        }

        // Pop the next pending range (largest first — sort by size descending).
        pending_ranges.sort_by(|a, b| (a.1 - a.0).cmp(&(b.1 - b.0)));
        let (start, end) = pending_ranges.pop().unwrap();

        // Build candidate: start from original, apply changed bytes for this range.
        let mut candidate = original_input.clone();
        candidate[start..end].copy_from_slice(&changed_input[start..end]);

        self.last_stage_input = Some(candidate.clone());
        self.stage_state = super::StageState::Colorization {
            corpus_id,
            original_hash,
            original_input,
            changed_input,
            pending_ranges,
            taint_ranges,
            executions,
            max_executions,
            awaiting_dual_trace: false,
            testing_range: Some((start, end)),
        };
        Ok(Some(Buffer::from(candidate)))
    }

    /// Transition from binary search to the dual trace step.
    #[allow(clippy::too_many_arguments)]
    fn transition_to_dual_trace(
        &mut self,
        corpus_id: CorpusId,
        original_hash: u64,
        original_input: Vec<u8>,
        changed_input: Vec<u8>,
        taint_ranges: Vec<Range<usize>>,
        executions: usize,
        max_executions: usize,
    ) -> Result<Option<Buffer>> {
        // Build the fully-colorized input for dual trace.
        let merged = merge_ranges(taint_ranges.clone());
        let colorized_input = build_colorized_input(&original_input, &changed_input, &merged);

        self.last_stage_input = Some(colorized_input.clone());
        self.stage_state = super::StageState::Colorization {
            corpus_id,
            original_hash,
            original_input,
            changed_input,
            pending_ranges: Vec::new(),
            taint_ranges,
            executions,
            max_executions,
            awaiting_dual_trace: true,
            testing_range: None,
        };
        Ok(Some(Buffer::from(colorized_input)))
    }

    /// Begin the REDQUEEN mutation stage. Called after colorization dual trace
    /// completes. Requires both `AflppCmpValuesMetadata` and `TaintMetadata` on
    /// the fuzzer state. Returns the first candidate, or `None` if no candidates
    /// are generated (triggering fall-through to subsequent stages).
    pub(crate) fn begin_redqueen(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        // Check that both required metadata types are present.
        let has_cmp_meta = self
            .state
            .metadata_map()
            .get::<AflppCmpValuesMetadata>()
            .is_some_and(|m| !m.orig_cmpvals.is_empty());
        let has_taint_meta = self.state.metadata_map().get::<TaintMetadata>().is_some();

        if !has_cmp_meta || !has_taint_meta {
            // Missing metadata — skip REDQUEEN and fall through.
            return self.transition_after_redqueen(corpus_id);
        }

        // Set the current corpus ID so AflppRedQueen can identify the testcase.
        self.state
            .set_corpus_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to set corpus ID: {e}")))?;

        // Get the corpus entry input for mutation.
        let input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        // Generate all candidates via multi_mutate.
        let candidates = self
            .redqueen_mutator
            .multi_mutate(&mut self.state, &input, Some(MAX_REDQUEEN_CANDIDATES))
            .map_err(|e| Error::from_reason(format!("REDQUEEN multi_mutate failed: {e}")))?;

        if candidates.is_empty() {
            // No candidates — fall through to subsequent stages.
            return self.transition_after_redqueen(corpus_id);
        }

        // Yield the first candidate.
        let first: Vec<u8> = candidates[0].clone().into();
        let mut bytes = first;
        bytes.truncate(self.max_input_len as usize);

        self.last_stage_input = Some(bytes.clone());
        self.stage_state = super::StageState::Redqueen {
            corpus_id,
            candidates,
            index: 0,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Advance the REDQUEEN stage: evaluate coverage for the previous candidate,
    /// yield the next one. Transitions to subsequent stages when exhausted.
    pub(crate) fn advance_redqueen(
        &mut self,
        _exit_kind: super::ExitKind,
        exec_time_ns: f64,
    ) -> Result<Option<Buffer>> {
        let (corpus_id, candidates, index) =
            match std::mem::replace(&mut self.stage_state, super::StageState::None) {
                super::StageState::Redqueen {
                    corpus_id,
                    candidates,
                    index,
                } => (corpus_id, candidates, index),
                other => {
                    self.stage_state = other;
                    return Err(Error::from_reason(
                        "advance_redqueen: not in Redqueen state",
                    ));
                }
            };

        // Drain and discard CmpLog accumulator.
        let _ = crate::cmplog::drain();

        // Take the stage input and evaluate coverage.
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advance_redqueen: no stashed stage input"))?;

        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        let _eval = self.evaluate_coverage(
            &stage_input,
            exec_time_ns,
            libafl::executors::ExitKind::Ok,
            corpus_id,
        )?;

        // Move to the next candidate.
        let next_index = index + 1;
        if next_index >= candidates.len() {
            // REDQUEEN exhausted — transition to subsequent stages.
            return self.transition_after_redqueen(corpus_id);
        }

        // Yield the next candidate.
        let next: Vec<u8> = candidates[next_index].clone().into();
        let mut bytes = next;
        bytes.truncate(self.max_input_len as usize);

        self.last_stage_input = Some(bytes.clone());
        self.stage_state = super::StageState::Redqueen {
            corpus_id,
            candidates,
            index: next_index,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Transition to the next stage after REDQUEEN completes or is skipped.
    /// Skips I2S (REDQUEEN ran) and falls through to generalization → Grimoire →
    /// unicode → None.
    fn transition_after_redqueen(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        self.begin_post_i2s_stages(corpus_id)
    }
}

#[cfg(test)]
#[allow(clippy::single_range_in_vec_init)]
mod tests {
    use super::*;
    use libafl::HasMetadata;
    use libafl::observers::cmp::{AflppCmpValuesMetadata, CmpValues};
    use libafl::stages::colorization::TaintMetadata;
    use libafl::state::HasCorpus;
    use libafl_bolts::rands::StdRand;

    #[test]
    fn test_type_replace_null_byte() {
        let input = [0x00];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], 0x01);
    }

    #[test]
    fn test_type_replace_one_byte() {
        let input = [0x01];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], 0x00);
    }

    #[test]
    fn test_type_replace_ff_byte() {
        let input = [0xff];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], 0x00);
    }

    #[test]
    fn test_type_replace_digit_zero_one_swap() {
        let input = [b'0', b'1'];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], b'1');
        assert_eq!(output[1], b'0');
    }

    #[test]
    fn test_type_replace_digit_stays_digit() {
        let input = [b'5'];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert!(output[0].is_ascii_digit());
        assert_ne!(output[0], b'5');
    }

    #[test]
    fn test_type_replace_hex_uppercase_stays_hex() {
        let input = [b'A'];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert!((b'A'..=b'F').contains(&output[0]));
        assert_ne!(output[0], b'A');
    }

    #[test]
    fn test_type_replace_hex_lowercase_stays_hex() {
        let input = [b'a'];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert!((b'a'..=b'f').contains(&output[0]));
        assert_ne!(output[0], b'a');
    }

    #[test]
    fn test_type_replace_whitespace_swaps() {
        let input = [0x20, 0x09, 0x0d, 0x0a];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], 0x09); // space → tab
        assert_eq!(output[1], 0x20); // tab → space
        assert_eq!(output[2], 0x0a); // CR → LF
        assert_eq!(output[3], 0x0d); // LF → CR
    }

    #[test]
    fn test_type_replace_plus_slash_swap() {
        let input = [b'+', b'/'];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], b'/');
        assert_eq!(output[1], b'+');
    }

    #[test]
    fn test_type_replace_xor_fallback() {
        let input = [0x80];
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], 0x80 ^ 0x7f);
    }

    #[test]
    fn test_type_replace_low_byte_xor() {
        let input = [0x05]; // < 0x20, not a special case
        let output = type_replace(&input, &mut StdRand::with_seed(42));
        assert_eq!(output[0], 0x05 ^ 0x1f);
    }

    #[test]
    fn test_type_replace_every_byte_differs() {
        let mut rand = StdRand::with_seed(42);
        for byte_val in 0u8..=255 {
            let input = [byte_val];
            let output = type_replace(&input, &mut rand);
            assert_ne!(
                output[0], byte_val,
                "type_replace failed to change byte 0x{byte_val:02x}"
            );
        }
    }

    #[test]
    fn test_coverage_hash_same_pattern() {
        let mut map1 = vec![0u8; 100];
        let mut map2 = vec![0u8; 100];
        map1[5] = 1;
        map1[10] = 3;
        map2[5] = 7; // Different hit count
        map2[10] = 42; // Different hit count
        assert_eq!(coverage_hash(&map1), coverage_hash(&map2));
    }

    #[test]
    fn test_coverage_hash_different_patterns() {
        let mut map1 = vec![0u8; 100];
        let mut map2 = vec![0u8; 100];
        map1[5] = 1;
        map2[10] = 1;
        assert_ne!(coverage_hash(&map1), coverage_hash(&map2));
    }

    #[test]
    fn test_coverage_hash_empty_maps() {
        let map = vec![0u8; 100];
        let hash = coverage_hash(&map);
        assert_eq!(hash, coverage_hash(&map));
    }

    #[test]
    fn test_merge_ranges_adjacent() {
        let ranges = vec![5..10, 10..15];
        let merged = merge_ranges(ranges);
        assert_eq!(merged, vec![5..15]);
    }

    #[test]
    fn test_merge_ranges_overlapping() {
        let ranges = vec![5..12, 10..15];
        let merged = merge_ranges(ranges);
        assert_eq!(merged, vec![5..15]);
    }

    #[test]
    fn test_merge_ranges_non_adjacent() {
        let ranges = vec![5..10, 15..20];
        let merged = merge_ranges(ranges);
        assert_eq!(merged, vec![5..10, 15..20]);
    }

    #[test]
    fn test_merge_ranges_empty() {
        let ranges: Vec<Range<usize>> = vec![];
        let merged = merge_ranges(ranges);
        assert!(merged.is_empty());
    }

    #[test]
    fn test_merge_ranges_single() {
        let ranges = vec![5..10];
        let merged = merge_ranges(ranges);
        assert_eq!(merged, vec![5..10]);
    }

    #[test]
    fn test_merge_ranges_unsorted() {
        let ranges = vec![15..20, 5..10, 10..15];
        let merged = merge_ranges(ranges);
        assert_eq!(merged, vec![5..20]);
    }

    #[test]
    fn test_build_colorized_input() {
        let original = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let changed = vec![10, 20, 30, 40, 50, 60, 70, 80];
        let taint_ranges = vec![2..4, 6..8];
        let result = build_colorized_input(&original, &changed, &taint_ranges);
        assert_eq!(result, vec![1, 2, 30, 40, 5, 6, 70, 80]);
    }

    // --- REDQUEEN tests ---

    #[test]
    fn test_begin_redqueen_skips_without_taint_metadata() {
        let mut fuzzer = super::super::test_helpers::make_fuzzer_ready_for_stage(64);

        // Add a corpus entry.
        let input = libafl::inputs::BytesInput::new(vec![1, 2, 3, 4]);
        let mut testcase = libafl::corpus::Testcase::new(input);
        testcase.set_exec_time(std::time::Duration::from_millis(1));
        let corpus_id = fuzzer
            .state
            .corpus_mut()
            .add(testcase)
            .expect("add testcase");

        // Add AflppCmpValuesMetadata with some data but NO TaintMetadata.
        let mut cmp_meta = AflppCmpValuesMetadata::new();
        cmp_meta.orig_cmpvals.insert(
            0,
            vec![CmpValues::Bytes((
                super::super::test_helpers::make_cmplog_bytes(&[1; 4]),
                super::super::test_helpers::make_cmplog_bytes(&[2; 4]),
            ))],
        );
        fuzzer.state.metadata_map_mut().insert(cmp_meta);

        // begin_redqueen should skip (no TaintMetadata) and return None.
        let result = fuzzer.begin_redqueen(corpus_id).expect("no error");
        assert!(result.is_none(), "should skip without TaintMetadata");
        assert!(
            matches!(fuzzer.stage_state, super::super::StageState::None),
            "stage should be None"
        );
    }

    #[test]
    fn test_begin_redqueen_skips_without_cmp_metadata() {
        let mut fuzzer = super::super::test_helpers::make_fuzzer_ready_for_stage(64);

        // Add a corpus entry.
        let input = libafl::inputs::BytesInput::new(vec![1, 2, 3, 4]);
        let mut testcase = libafl::corpus::Testcase::new(input);
        testcase.set_exec_time(std::time::Duration::from_millis(1));
        let corpus_id = fuzzer
            .state
            .corpus_mut()
            .add(testcase)
            .expect("add testcase");

        // Add TaintMetadata but no AflppCmpValuesMetadata.
        let taint = TaintMetadata::new(vec![1, 2, 3, 4], vec![0..4]);
        fuzzer.state.metadata_map_mut().insert(taint);

        // begin_redqueen should skip (no AflppCmpValuesMetadata) and return None.
        let result = fuzzer.begin_redqueen(corpus_id).expect("no error");
        assert!(result.is_none(), "should skip without CmpValuesMetadata");
    }

    #[test]
    fn test_begin_redqueen_skips_with_empty_orig_cmpvals() {
        let mut fuzzer = super::super::test_helpers::make_fuzzer_ready_for_stage(64);

        // Add a corpus entry.
        let input = libafl::inputs::BytesInput::new(vec![1, 2, 3, 4]);
        let mut testcase = libafl::corpus::Testcase::new(input);
        testcase.set_exec_time(std::time::Duration::from_millis(1));
        let corpus_id = fuzzer
            .state
            .corpus_mut()
            .add(testcase)
            .expect("add testcase");

        // Add empty AflppCmpValuesMetadata and TaintMetadata.
        let cmp_meta = AflppCmpValuesMetadata::new();
        fuzzer.state.metadata_map_mut().insert(cmp_meta);
        let taint = TaintMetadata::new(vec![1, 2, 3, 4], vec![0..4]);
        fuzzer.state.metadata_map_mut().insert(taint);

        // begin_redqueen should skip (empty orig_cmpvals) and return None.
        let result = fuzzer.begin_redqueen(corpus_id).expect("no error");
        assert!(result.is_none(), "should skip with empty orig_cmpvals");
    }

    #[test]
    fn test_begin_redqueen_sets_corpus_id() {
        use libafl::corpus::HasCurrentCorpusId;

        let mut fuzzer = super::super::test_helpers::make_fuzzer_ready_for_stage(64);

        // Add a corpus entry with data that can produce comparison matches.
        let input = libafl::inputs::BytesInput::new(vec![0x41, 0x42, 0x43, 0x44]);
        let mut testcase = libafl::corpus::Testcase::new(input);
        testcase.set_exec_time(std::time::Duration::from_millis(1));
        let corpus_id = fuzzer
            .state
            .corpus_mut()
            .add(testcase)
            .expect("add testcase");

        // Add both metadata types.
        let mut cmp_meta = AflppCmpValuesMetadata::new();
        cmp_meta.orig_cmpvals.insert(
            0,
            vec![CmpValues::Bytes((
                super::super::test_helpers::make_cmplog_bytes(&[0x41; 4]),
                super::super::test_helpers::make_cmplog_bytes(&[0x42; 4]),
            ))],
        );
        fuzzer.state.metadata_map_mut().insert(cmp_meta);
        let taint = TaintMetadata::new(vec![0x41, 0x42, 0x43, 0x44], vec![0..4]);
        fuzzer.state.metadata_map_mut().insert(taint);

        // Call begin_redqueen — multi_mutate may return empty candidates for this
        // simple input, but the corpus ID should be set.
        let _result = fuzzer.begin_redqueen(corpus_id);

        // The corpus ID should have been set on the state.
        let current_id = fuzzer
            .state
            .current_corpus_id()
            .expect("should not error")
            .expect("corpus_id should be Some");
        assert_eq!(
            current_id, corpus_id,
            "corpus_id on state should match the one we set"
        );
    }

    #[test]
    fn test_max_redqueen_candidates_constant() {
        assert_eq!(MAX_REDQUEEN_CANDIDATES, 2048);
    }

    // NOTE: A full integration test exercising the complete pipeline
    // (begin_colorization → advance_colorization → dual trace →
    // begin_redqueen → advance_redqueen) is intentionally absent here.
    // The setup requires a fully wired Fuzzer with coverage map, CmpLog
    // observer, and multi-step async iteration — complexity that belongs
    // in the end-to-end fuzz-pipeline.test.ts rather than unit tests.
}
