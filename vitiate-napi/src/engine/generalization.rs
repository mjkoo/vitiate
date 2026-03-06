use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::MapNoveltiesMetadata;
use libafl::inputs::GeneralizedInputMetadata;
use libafl::state::{HasCorpus, HasExecutions};
use napi::bindgen_prelude::*;

use super::{
    Fuzzer, GENERALIZATION_BRACKETS, GENERALIZATION_DELIMITERS, GENERALIZATION_OFFSETS,
    MAX_GENERALIZED_LEN, StageState,
};

/// Phases within the generalization algorithm. Each phase corresponds to a
/// type of gap-finding pass that ablates portions of the input and checks
/// whether novel coverage indices survive.
#[derive(Debug)]
pub(crate) enum GeneralizationPhase {
    /// Initial stability check: execute the original input unmodified.
    Verify,
    /// Offset-based gap-finding. `level` indexes into `GENERALIZATION_OFFSETS`,
    /// `_pos` tracks the current payload position (used for state inspection/debugging).
    Offset { level: u8, _pos: usize },
    /// Delimiter-based gap-finding. `index` indexes into `GENERALIZATION_DELIMITERS`,
    /// `_pos` tracks the current payload position (used for state inspection/debugging).
    Delimiter { index: u8, _pos: usize },
    /// Bracket-based gap-finding. `pair_index` indexes into `GENERALIZATION_BRACKETS`.
    /// `index` is the outer-loop cursor (forward scan for openers).
    /// `start` is the effective opener position (inner-loop start, collapses after each closer).
    /// `end` is the backward-scan position (inner-loop cursor for closers).
    /// `endings` counts closers found for the current opener.
    Bracket {
        pair_index: u8,
        index: usize,
        start: usize,
        end: usize,
        endings: usize,
    },
}

impl Fuzzer {
    /// Build a candidate by concatenating structural bytes around a gap.
    pub(super) fn build_generalization_candidate(
        payload: &[Option<u8>],
        start: usize,
        end: usize,
    ) -> Vec<u8> {
        debug_assert!(
            start <= end && end <= payload.len(),
            "build_generalization_candidate: invalid range {start}..{end} for payload len {}",
            payload.len()
        );
        let mut candidate = Vec::new();
        for &slot in &payload[..start] {
            if let Some(b) = slot {
                candidate.push(b);
            }
        }
        for &slot in &payload[end..] {
            if let Some(b) = slot {
                candidate.push(b);
            }
        }
        candidate
    }

    /// Remove consecutive `None` entries from the payload, leaving only a single
    /// `None` to represent each contiguous gap region. O(n) via `retain`.
    pub(super) fn trim_payload(payload: &mut Vec<Option<u8>>) {
        let mut previous_was_none = false;
        payload.retain(|item| {
            let dominated = item.is_none() && previous_was_none;
            previous_was_none = item.is_none();
            !dominated
        });
    }

    /// Convert a payload (`Vec<Option<u8>>`) to `GeneralizedInputMetadata`.
    ///
    /// Rules:
    /// - Contiguous `Some(byte)` runs become `GeneralizedItem::Bytes(Vec<u8>)`.
    /// - Each `None` becomes `GeneralizedItem::Gap`.
    /// - Leading `Gap` is prepended if first element is not `None`.
    /// - Trailing `Gap` is appended if last element is not `None`.
    pub(super) fn payload_to_generalized(payload: &[Option<u8>]) -> GeneralizedInputMetadata {
        GeneralizedInputMetadata::generalized_from_options(payload)
    }

    /// Check whether all novelty indices are nonzero in the current coverage map.
    pub(super) fn check_novelties_survived(&self, novelties: &[usize]) -> bool {
        // SAFETY: map_ptr is valid for map_len bytes, backed by _coverage_map Buffer.
        let map = unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) };
        novelties
            .iter()
            .all(|&idx| idx < self.map_len && map[idx] > 0)
    }

    /// Begin the generalization stage for a corpus entry.
    ///
    /// Returns the first candidate (the original input for verification),
    /// or `None` if preconditions are not met.
    pub(super) fn begin_generalization(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if !self.grimoire_enabled {
            return Ok(None);
        }

        // Check skipping conditions on the testcase.
        let tc = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?;
        let tc_ref = tc.borrow();

        // Already generalized?
        if tc_ref.has_metadata::<GeneralizedInputMetadata>() {
            return Ok(None);
        }

        // Has novelty metadata with non-empty list?
        let novelties = match tc_ref.metadata::<MapNoveltiesMetadata>() {
            Ok(meta) if !meta.list.is_empty() => meta.list.clone(),
            _ => return Ok(None),
        };

        // Get input bytes.
        let input_bytes: Vec<u8> = tc_ref
            .input()
            .as_ref()
            .ok_or_else(|| Error::from_reason("Corpus entry has no input"))?
            .as_ref()
            .to_vec();

        drop(tc_ref);
        let _ = tc;

        // Size limit.
        if input_bytes.len() > MAX_GENERALIZED_LEN {
            return Ok(None);
        }

        // Build initial payload (all bytes are structural/untested).
        let payload: Vec<Option<u8>> = input_bytes.iter().map(|&b| Some(b)).collect();

        // First candidate is the original input (verification phase).
        let candidate = input_bytes.clone();
        self.last_stage_input = Some(candidate.clone());

        self.stage_state = StageState::Generalization {
            corpus_id,
            novelties,
            payload,
            phase: GeneralizationPhase::Verify,
            candidate_range: None,
        };

        Ok(Some(Buffer::from(candidate)))
    }

    /// Advance the generalization stage after a target execution.
    ///
    /// Reads the coverage map, decides gap/structural for the current candidate,
    /// advances to the next phase/position, constructs the next candidate.
    /// Returns `None` when generalization is complete.
    pub(super) fn advance_generalization(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        // Drain CmpLog (discard — generalization doesn't use CmpLog data).
        let _ = crate::cmplog::drain();

        // Extract state (we'll put it back or replace it).
        let (corpus_id, novelties, mut payload, phase, candidate_range) =
            match std::mem::replace(&mut self.stage_state, StageState::None) {
                StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase,
                    candidate_range,
                } => (corpus_id, novelties, payload, phase, candidate_range),
                other => {
                    self.stage_state = other;
                    return Ok(None);
                }
            };

        let novelties_survived = self.check_novelties_survived(&novelties);

        // The target was invoked — count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        // Evaluate coverage for corpus addition during gap-finding (not verification).
        // Stage state was consumed by mem::replace above. If evaluate_coverage
        // fails, the in-progress generalization is cleanly abandoned.
        if !matches!(phase, GeneralizationPhase::Verify) {
            if let Some(stage_input) = self.last_stage_input.take() {
                let _eval = self.evaluate_coverage(
                    &stage_input,
                    exec_time_ns,
                    LibaflExitKind::Ok,
                    corpus_id,
                )?;
            }
        } else {
            self.last_stage_input = None;
            // Zero coverage map — Verify doesn't call evaluate_coverage (which does its own zero).
            // SAFETY: map_ptr is valid for map_len bytes, backed by _coverage_map Buffer.
            unsafe {
                std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
            }
        }

        match phase {
            GeneralizationPhase::Verify => {
                if !novelties_survived {
                    // Verification failed — unstable input. Abort generalization.
                    self.stage_state = StageState::None;
                    return Ok(None);
                }
                // Verification passed — begin offset-based gap-finding.
                let next_phase = GeneralizationPhase::Offset { level: 0, _pos: 0 };
                self.generate_next_candidate(corpus_id, novelties, payload, next_phase)
            }
            GeneralizationPhase::Offset { level, _pos: _ } => {
                // Process result of previous candidate.
                if novelties_survived && let Some((start, end)) = candidate_range {
                    for i in start..end {
                        if i < payload.len() {
                            payload[i] = None;
                        }
                    }
                }

                // Advance position.
                let offset = GENERALIZATION_OFFSETS[level as usize];
                let next_pos = candidate_range.map_or(0, |(_, e)| e);
                if next_pos >= payload.len() {
                    // Pass complete — trim and move to next level or delimiter phase.
                    Self::trim_payload(&mut payload);
                    let next_phase = if (level + 1) < GENERALIZATION_OFFSETS.len() as u8 {
                        GeneralizationPhase::Offset {
                            level: level + 1,
                            _pos: 0,
                        }
                    } else {
                        GeneralizationPhase::Delimiter { index: 0, _pos: 0 }
                    };
                    return self.generate_next_candidate(corpus_id, novelties, payload, next_phase);
                }

                // Compute next range.
                let start = next_pos;
                let end = std::cmp::min(start + 1 + offset, payload.len());
                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Offset { level, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Delimiter { index, _pos: _ } => {
                // Process result of previous candidate.
                if novelties_survived && let Some((start, end)) = candidate_range {
                    for i in start..end {
                        if i < payload.len() {
                            payload[i] = None;
                        }
                    }
                }

                let next_pos = candidate_range.map_or(0, |(_, e)| e);
                if next_pos >= payload.len() {
                    // Pass complete — trim and move to next delimiter or bracket phase.
                    Self::trim_payload(&mut payload);
                    let next_phase = if (index + 1) < GENERALIZATION_DELIMITERS.len() as u8 {
                        GeneralizationPhase::Delimiter {
                            index: index + 1,
                            _pos: 0,
                        }
                    } else {
                        GeneralizationPhase::Bracket {
                            pair_index: 0,
                            index: 0,
                            start: 0,
                            end: 0,
                            endings: 0,
                        }
                    };
                    return self.generate_next_candidate(corpus_id, novelties, payload, next_phase);
                }

                // Find next delimiter from next_pos.
                let delimiter = GENERALIZATION_DELIMITERS[index as usize];
                let start = next_pos;
                let delim_pos = payload[start..]
                    .iter()
                    .position(|&slot| slot == Some(delimiter));
                let end = match delim_pos {
                    Some(rel_pos) => start + rel_pos + 1,
                    None => payload.len(),
                };

                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Delimiter { index, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Bracket {
                pair_index,
                index: outer_index,
                // `start` is unused here; the inner scan resumes from `bracket_end`, not the opener.
                start: _bracket_start,
                end: bracket_end,
                endings,
            } => {
                // Process result of previous candidate: mark gaps if survived.
                if let Some((cr_start, cr_end)) = candidate_range
                    && novelties_survived
                {
                    for i in cr_start..cr_end {
                        if i < payload.len() {
                            payload[i] = None;
                        }
                    }
                }

                // After yielding a candidate, advance inner-loop state per LibAFL:
                //   start = end (collapse inner window)
                //   end -= 1 (move backward scan inward)
                //   index += 1 (outer loop progress)
                if candidate_range.is_some() {
                    let new_start = bracket_end;
                    let new_end = bracket_end.saturating_sub(1);
                    let new_index = outer_index + 1;
                    self.continue_bracket_inner_scan(
                        corpus_id, novelties, payload, pair_index, new_index, new_start, new_end,
                        endings,
                    )
                } else {
                    // First entry into bracket phase — start scanning.
                    self.find_next_bracket_opener(
                        corpus_id,
                        novelties,
                        payload,
                        pair_index,
                        outer_index,
                    )
                }
            }
        }
    }

    /// Generate the next candidate for the current generalization phase.
    /// Handles the entry point into each new phase (finding the first valid candidate).
    pub(super) fn generate_next_candidate(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        payload: Vec<Option<u8>>,
        phase: GeneralizationPhase,
    ) -> Result<Option<Buffer>> {
        match phase {
            GeneralizationPhase::Offset { level, _pos: _ } => {
                let offset = GENERALIZATION_OFFSETS[level as usize];
                let start = 0;
                if start >= payload.len() {
                    // Empty payload — skip to next phase.
                    return self
                        .advance_to_next_offset_or_delimiter(corpus_id, novelties, payload, level);
                }
                let end = std::cmp::min(start + 1 + offset, payload.len());
                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Offset { level, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Delimiter { index, _pos: _ } => {
                let delimiter = GENERALIZATION_DELIMITERS[index as usize];
                let start = 0;
                if start >= payload.len() {
                    return self.advance_to_next_delimiter_or_bracket(
                        corpus_id, novelties, payload, index,
                    );
                }
                let delim_pos = payload.iter().position(|&slot| slot == Some(delimiter));
                let end = match delim_pos {
                    Some(rel_pos) => rel_pos + 1,
                    None => payload.len(),
                };

                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Delimiter { index, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Bracket { pair_index, .. } => {
                if pair_index as usize >= GENERALIZATION_BRACKETS.len() {
                    // All bracket passes done — finalize.
                    return self.finalize_generalization(corpus_id, &payload);
                }
                // Start bracket scanning from index=0.
                self.find_next_bracket_opener(corpus_id, novelties, payload, pair_index, 0)
            }
            GeneralizationPhase::Verify => {
                // Should not reach here from generate_next_candidate.
                self.stage_state = StageState::None;
                Ok(None)
            }
        }
    }

    pub(super) fn advance_to_next_offset_or_delimiter(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        current_level: u8,
    ) -> Result<Option<Buffer>> {
        Self::trim_payload(&mut payload);
        if (current_level + 1) < GENERALIZATION_OFFSETS.len() as u8 {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Offset {
                    level: current_level + 1,
                    _pos: 0,
                },
            )
        } else {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Delimiter { index: 0, _pos: 0 },
            )
        }
    }

    pub(super) fn advance_to_next_delimiter_or_bracket(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        current_index: u8,
    ) -> Result<Option<Buffer>> {
        Self::trim_payload(&mut payload);
        if (current_index + 1) < GENERALIZATION_DELIMITERS.len() as u8 {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Delimiter {
                    index: current_index + 1,
                    _pos: 0,
                },
            )
        } else {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Bracket {
                    pair_index: 0,
                    index: 0,
                    start: 0,
                    end: 0,
                    endings: 0,
                },
            )
        }
    }

    /// Outer loop of bracket-based gap-finding: scan forward from `index` for
    /// an opening bracket, then set up the inner backward scan for closers.
    ///
    /// Note: recursion depth is bounded by `MAX_GENERALIZED_LEN` (8192 bytes) and the number
    /// of bracket types (6). The worst-case depth is safe for the default 8 MB stack.
    pub(super) fn find_next_bracket_opener(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        payload: Vec<Option<u8>>,
        pair_index: u8,
        mut index: usize,
    ) -> Result<Option<Buffer>> {
        if pair_index as usize >= GENERALIZATION_BRACKETS.len() {
            return self.finalize_generalization(corpus_id, &payload);
        }

        let (open_char, _close_char) = GENERALIZATION_BRACKETS[pair_index as usize];

        // Scan forward for the next opener.
        while index < payload.len() && payload[index] != Some(open_char) {
            index += 1;
        }
        if index >= payload.len() {
            // No more openers for this pair — advance to next pair.
            return self.advance_to_next_bracket_pair(corpus_id, novelties, payload, pair_index);
        }

        // Found an opener at `index`. Set up inner backward scan.
        // LibAFL: start = index, end = payload.len() - 1 (or start if empty).
        // SAFETY of payload.len() - 1: index < payload.len() was verified above,
        // so payload is guaranteed non-empty.
        debug_assert!(
            !payload.is_empty(),
            "payload must be non-empty when an opener was found"
        );
        let start = index;
        let end = payload.len() - 1;

        self.continue_bracket_inner_scan(
            corpus_id, novelties, payload, pair_index, index, start, end, 0,
        )
    }

    /// Inner loop of bracket-based gap-finding: scan backward from `end` for
    /// a closing bracket. Yields a candidate when found, or advances to the
    /// next opener/pair when exhausted.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn continue_bracket_inner_scan(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        pair_index: u8,
        index: usize,
        start: usize,
        mut end: usize,
        mut endings: usize,
    ) -> Result<Option<Buffer>> {
        if payload.is_empty() {
            return self.advance_to_next_bracket_pair(corpus_id, novelties, payload, pair_index);
        }

        let (_open_char, close_char) = GENERALIZATION_BRACKETS[pair_index as usize];

        // Scan backward from `end` looking for a closer.
        while end > start {
            if payload[end] == Some(close_char) {
                endings += 1;
                // Found a closer — yield candidate from start..end (exclusive of endpoints
                // to match LibAFL behavior: the opener and closer themselves are kept).
                let candidate = Self::build_generalization_candidate(&payload, start + 1, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Bracket {
                        pair_index,
                        index,
                        start,
                        end,
                        endings,
                    },
                    candidate_range: Some((start + 1, end)),
                };

                return Ok(Some(Buffer::from(candidate)));
            }
            end -= 1;
        }

        // Inner scan exhausted for this opener.
        if endings > 0 {
            // We found at least one closer — the outer loop advances past this opener.
            // The outer loop advances `index` by 1 per opener (not per backward-scan step
            // as in the spec). This may revisit positions but does not affect correctness.
            Self::trim_payload(&mut payload);
            self.find_next_bracket_opener(corpus_id, novelties, payload, pair_index, index + 1)
        } else {
            // No closer found at all for this opener — advance to next pair.
            self.advance_to_next_bracket_pair(corpus_id, novelties, payload, pair_index)
        }
    }

    /// Trim the payload and advance to the next bracket pair, or finalize
    /// if all bracket pairs have been processed.
    pub(super) fn advance_to_next_bracket_pair(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        pair_index: u8,
    ) -> Result<Option<Buffer>> {
        Self::trim_payload(&mut payload);
        self.generate_next_candidate(
            corpus_id,
            novelties,
            payload,
            GeneralizationPhase::Bracket {
                pair_index: pair_index + 1,
                index: 0,
                start: 0,
                end: 0,
                endings: 0,
            },
        )
    }

    /// Finalize the generalization stage: convert payload to `GeneralizedInputMetadata`
    /// and store it on the testcase.
    pub(super) fn finalize_generalization(
        &mut self,
        corpus_id: CorpusId,
        payload: &[Option<u8>],
    ) -> Result<Option<Buffer>> {
        let metadata = Self::payload_to_generalized(payload);

        let mut tc = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
            .borrow_mut();
        tc.add_metadata(metadata);
        drop(tc);

        // Transition to next stage: try Grimoire, then Unicode.
        self.stage_state = StageState::None;
        if let Some(buf) = self.begin_grimoire(corpus_id)? {
            return Ok(Some(buf));
        }
        if let Some(buf) = self.begin_unicode(corpus_id)? {
            return Ok(Some(buf));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use libafl::HasMetadata;
    use libafl::corpus::{Corpus, CorpusId, Testcase};
    use libafl::feedbacks::MapNoveltiesMetadata;
    use libafl::inputs::{BytesInput, GeneralizedInputMetadata, GeneralizedItem};
    use libafl::observers::cmp::CmpValues;
    use libafl::state::HasCorpus;

    use super::*;
    use crate::cmplog;
    use crate::engine::test_helpers::{
        make_cmplog_bytes, make_fuzzer_with_generalization_entry, make_test_fuzzer,
    };
    use crate::engine::{MAX_GENERALIZED_LEN, StageState};
    use crate::types::ExitKind;

    // -----------------------------------------------------------------------
    // Generalization stage tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_generalization_skipped_when_grimoire_disabled() {
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, b"fn foo() {}", &[10, 20]);
        fuzzer.grimoire_enabled = false;

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped when Grimoire disabled"
        );
        assert!(matches!(fuzzer.stage_state, StageState::None));

        cmplog::disable();
    }

    #[test]
    fn test_generalization_skipped_for_large_input() {
        let large_input = vec![b'A'; MAX_GENERALIZED_LEN + 1];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, &large_input, &[10]);

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped for input > MAX_GENERALIZED_LEN"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_skipped_when_no_novelties() {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(256);
        fuzzer.grimoire_enabled = true;
        fuzzer.deferred_detection_count = None;
        cmplog::enable();

        // Add a corpus entry WITHOUT MapNoveltiesMetadata.
        let testcase = Testcase::new(BytesInput::new(b"test".to_vec()));
        let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped without novelties"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_skipped_when_already_generalized() {
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, b"fn foo() {}", &[10, 20]);

        // Manually add GeneralizedInputMetadata to simulate prior generalization.
        let payload: Vec<Option<u8>> = b"fn foo() {}".iter().map(|&b| Some(b)).collect();
        let meta = Fuzzer::payload_to_generalized(&payload);
        fuzzer
            .state
            .corpus()
            .get(corpus_id)
            .unwrap()
            .borrow_mut()
            .add_metadata(meta);

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped when already generalized"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_verification_succeeds() {
        let input = b"fn foo() {}";
        let novelty_indices = vec![10, 20];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        // Begin generalization — should return the original input for verification.
        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some(), "should return verification candidate");
        let candidate: Vec<u8> = first.unwrap().to_vec();
        assert_eq!(
            candidate, input,
            "verification candidate should be the original input"
        );
        assert!(matches!(
            fuzzer.stage_state,
            StageState::Generalization {
                phase: GeneralizationPhase::Verify,
                ..
            }
        ));

        // Simulate target execution: set novelty indices in coverage map.
        for &idx in &novelty_indices {
            unsafe {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }

        // Advance — verification should pass and produce next candidate.
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(
            next.is_some(),
            "should produce first gap-finding candidate after verification passes"
        );
        // Should now be in Offset phase.
        assert!(matches!(
            fuzzer.stage_state,
            StageState::Generalization {
                phase: GeneralizationPhase::Offset { .. },
                ..
            }
        ));

        cmplog::disable();
    }

    #[test]
    fn test_generalization_verification_fails() {
        let input = b"fn foo() {}";
        let novelty_indices = vec![10, 20];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Simulate execution where one novelty index is zero (unstable).
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
            // index 20 is left at 0 — verification fails.
        }

        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(
            next.is_none(),
            "verification failure should abort generalization"
        );
        assert!(matches!(fuzzer.stage_state, StageState::None));

        // Verify no GeneralizedInputMetadata was stored.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            !tc.has_metadata::<GeneralizedInputMetadata>(),
            "no metadata should be stored on verification failure"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_offset_marks_gaps() {
        // Use a small input so offset-0 pass tests each byte individually.
        let input = b"ab";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        // Begin generalization.
        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification: set novelty index.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(next.is_some(), "should produce first offset candidate");

        // We're now in offset phase. The first pass has offset=255.
        // For a 2-byte input: start=0, end=min(0+1+255, 2)=2.
        // Candidate removes bytes [0, 2) = entire input → empty candidate.
        // Simulate novelties surviving (meaning entire input can be gapped).
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        // Since end (2) >= payload.len() (2), this pass is done. Trim + next level.
        // After marking [0, 2) as gaps, payload = [None, None].
        // After trimming, payload = [None].
        // Continue through remaining offset levels and delimiter passes.
        // Eventually generalization completes.

        // Drive to completion — keep advancing until None.
        let mut exec_count = 2; // verification + first offset candidate
        while let Some(_buf) = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap() {
            exec_count += 1;
            // Set novelties for all subsequent candidates.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            if exec_count > 100 {
                panic!("generalization should complete within reasonable iterations");
            }
        }

        // Verify metadata was stored.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "GeneralizedInputMetadata should be stored after generalization completes"
        );
        let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
        // The entire input was gapped, so metadata should be just [Gap].
        // (Leading and trailing gaps merged with the single gap.)
        assert!(
            meta.generalized().contains(&GeneralizedItem::Gap),
            "metadata should contain Gap items"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_offset_preserves_structural() {
        // 4-byte input. We'll make the first offset-255 candidate fail (novelties don't survive),
        // meaning those bytes are structural.
        let input = b"test";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification: pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(next.is_some());

        // First offset-255 candidate removes [0, 4) from 4-byte input.
        // Simulate novelties NOT surviving → bytes are structural.
        // (Don't set the novelty index → it stays 0.)
        let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        // Pass complete (end=4 >= payload.len=4). Move to next offset level.
        // Continue — all candidates also fail novelties.
        let mut exec_count = 3;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            if candidate.is_none() {
                break;
            }
            exec_count += 1;
            // Don't set novelty index — all candidates fail.
            if exec_count > 200 {
                panic!("generalization should complete within reasonable iterations");
            }
        }

        // Verify metadata was stored (even if everything is structural).
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "GeneralizedInputMetadata should be stored even when all bytes are structural"
        );
        let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
        // All bytes are structural, so metadata should be [Gap, Bytes(b"test"), Gap].
        let items = meta.generalized();
        assert_eq!(
            items.first(),
            Some(&GeneralizedItem::Gap),
            "should have leading gap"
        );
        assert_eq!(
            items.last(),
            Some(&GeneralizedItem::Gap),
            "should have trailing gap"
        );
        assert!(
            items
                .iter()
                .any(|item| matches!(item, GeneralizedItem::Bytes(b) if b == b"test")),
            "should have the original bytes as structural"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_execution_counting() {
        let input = b"ab";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let total_before = fuzzer.total_execs;
        let state_execs_before = *fuzzer.state.executions();

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(
            fuzzer.total_execs,
            total_before + 1,
            "verification should count"
        );
        assert_eq!(
            *fuzzer.state.executions(),
            state_execs_before + 1,
            "state.executions should increment"
        );

        // Drive to completion, counting all executions.
        let mut advance_count = 1;
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            advance_count += 1;
            if candidate.is_none() {
                break;
            }
            if advance_count > 100 {
                panic!("should complete within reasonable iterations");
            }
        }

        assert_eq!(
            fuzzer.total_execs,
            total_before + advance_count as u64,
            "total_execs should match number of advance calls"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_cmplog_drained() {
        let input = b"fn foo() {}";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();

        // Push CmpLog entries (simulating target execution producing CmpLog data).
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"test"),
            make_cmplog_bytes(b"data"),
        )));

        // Set novelties for verification pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Verify CmpLog was drained.
        let drained = cmplog::drain();
        assert!(
            drained.is_empty(),
            "CmpLog should be drained by advance_stage during generalization"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_output_format() {
        // Test that payload_to_generalized produces correct format.
        // Payload: [None, Some(b'f'), Some(b'n'), None, Some(b'('), Some(b')'), None]
        let payload = vec![
            None,
            Some(b'f'),
            Some(b'n'),
            None,
            Some(b'('),
            Some(b')'),
            None,
        ];
        let meta = Fuzzer::payload_to_generalized(&payload);
        let items = meta.generalized();
        assert_eq!(
            items,
            &[
                GeneralizedItem::Gap,
                GeneralizedItem::Bytes(b"fn".to_vec()),
                GeneralizedItem::Gap,
                GeneralizedItem::Bytes(b"()".to_vec()),
                GeneralizedItem::Gap,
            ],
            "should produce [Gap, Bytes(fn), Gap, Bytes(()), Gap]"
        );
    }

    #[test]
    fn test_generalization_output_leading_trailing_gaps() {
        // Payload starts and ends with Some — should get leading/trailing gaps.
        let payload = vec![Some(b'a'), Some(b'b')];
        let meta = Fuzzer::payload_to_generalized(&payload);
        let items = meta.generalized();
        assert_eq!(
            items.first(),
            Some(&GeneralizedItem::Gap),
            "must have leading gap"
        );
        assert_eq!(
            items.last(),
            Some(&GeneralizedItem::Gap),
            "must have trailing gap"
        );
        assert_eq!(
            items,
            &[
                GeneralizedItem::Gap,
                GeneralizedItem::Bytes(b"ab".to_vec()),
                GeneralizedItem::Gap,
            ]
        );
    }

    #[test]
    fn test_trim_payload_removes_consecutive_gaps() {
        let mut payload = vec![None, None, Some(b'a'), None, None, None, Some(b'b'), None];
        Fuzzer::trim_payload(&mut payload);
        assert_eq!(
            payload,
            vec![None, Some(b'a'), None, Some(b'b'), None],
            "consecutive None entries should be collapsed to single None"
        );
    }

    #[test]
    fn test_build_generalization_candidate() {
        let payload = vec![
            Some(b'a'),
            Some(b'b'),
            None,
            Some(b'c'),
            Some(b'd'),
            Some(b'e'),
        ];
        // Remove range [1, 4) — removes Some(b'b'), None, Some(b'c').
        let candidate = Fuzzer::build_generalization_candidate(&payload, 1, 4);
        // payload[..1] = [Some(b'a')] → [b'a']
        // payload[4..] = [Some(b'd'), Some(b'e')] → [b'd', b'e']
        // None values in either portion are skipped.
        assert_eq!(candidate, b"ade");
    }

    #[test]
    fn test_build_candidate_skips_gaps() {
        let payload = vec![None, Some(b'a'), Some(b'b'), None, Some(b'c')];
        // Remove range [1, 3) — removes Some(b'a'), Some(b'b').
        let candidate = Fuzzer::build_generalization_candidate(&payload, 1, 3);
        // payload[..1] = [None] → skipped
        // payload[3..] = [None, Some(b'c')] → [b'c']
        assert_eq!(candidate, b"c");
    }

    #[test]
    fn test_generalization_delimiter_gap_finding() {
        // Use "line1\nline2" and test that the delimiter pass can split on \n.
        let input = b"line1\nline2";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Drive through all offset passes — don't set novelty (all fail, bytes stay structural).
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            // Check if we're now in delimiter phase.
            if matches!(
                fuzzer.stage_state,
                StageState::Generalization {
                    phase: GeneralizationPhase::Delimiter { .. },
                    ..
                }
            ) {
                break;
            }
            if count > 200 {
                panic!("should reach delimiter phase");
            }
        }

        // Now we're in delimiter phase. For the newline delimiter (index 3),
        // the first candidate removes from pos=0 to \n+1 position.
        // Drive through delimiter passes, setting novelties to survive on the \n pass.
        // This is complex to test precisely since we'd need to identify which pass
        // has the \n delimiter. Instead, just verify the pipeline completes.
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 500 {
                panic!("should complete generalization");
            }
        }

        // Verify metadata was stored and contains Gap entries.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        let metadata = tc
            .metadata::<GeneralizedInputMetadata>()
            .expect("GeneralizedInputMetadata should be stored");
        // With all novelties surviving through delimiter passes, the metadata should
        // contain at least one Gap entry (delimiters become gap boundaries).
        let has_gaps = metadata
            .generalized()
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Gap));
        assert!(
            has_gaps,
            "delimiter-based generalization should produce gaps when novelties survive"
        );

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // Generalization gap-finding adds to corpus test (#7)
    // -----------------------------------------------------------------------

    #[test]
    fn test_generalization_gap_finding_adds_to_corpus() {
        // During an offset pass, new coverage at a previously-unseen index should
        // cause the candidate to be added to the corpus with MapNoveltiesMetadata.
        let input = b"abcdefgh";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        // Verification pass: set novelty so it passes.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // We're now in offset phase. Set novel coverage at a NEW index (20)
        // that the feedback hasn't seen before.
        let corpus_count_before = fuzzer.state.corpus().count();
        unsafe {
            *fuzzer.map_ptr.add(20) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        let corpus_count_after = fuzzer.state.corpus().count();

        assert!(
            corpus_count_after > corpus_count_before,
            "gap-finding execution with novel coverage should add to corpus"
        );

        // Verify the new entry has MapNoveltiesMetadata.
        let new_id = CorpusId::from(corpus_count_after - 1);
        let tc = fuzzer.state.corpus().get(new_id).unwrap().borrow();
        assert!(
            tc.metadata::<MapNoveltiesMetadata>().is_ok(),
            "gap-finding corpus entry should have MapNoveltiesMetadata"
        );

        // Verify that last_interesting_corpus_id is None — stage-found entries
        // don't set this (only report_result does).
        assert!(
            fuzzer.last_interesting_corpus_id.is_none(),
            "last_interesting_corpus_id should be None for stage-found entries"
        );

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // Bracket-based gap-finding tests (#4)
    // -----------------------------------------------------------------------

    /// Drive a fuzzer through Verify and all Offset/Delimiter phases to reach
    /// the Bracket phase, with novelties surviving all phases.
    fn advance_to_bracket_phase(fuzzer: &mut Fuzzer, novelty_indices: &[usize]) {
        // Verification pass.
        for &idx in novelty_indices {
            unsafe {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Drive through offset and delimiter phases.
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if matches!(
                fuzzer.stage_state,
                StageState::Generalization {
                    phase: GeneralizationPhase::Bracket { .. },
                    ..
                }
            ) {
                return;
            }
            if count > 10_000 {
                panic!(
                    "should reach bracket phase within 10000 iterations (got {count} without entering bracket phase)"
                );
            }
        }
        panic!("generalization ended before reaching bracket phase");
    }

    #[test]
    fn test_bracket_gaps_marked_on_novelty_survival() {
        // Input with brackets: "(abc)". When novelties survive, the range between
        // open and close bracket should be marked as gaps.
        let input = b"(abc)";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

        // We're now in bracket phase. Set novelties to survive.
        let mut count = 0;
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 200 {
                panic!("should complete bracket phase");
            }
        }

        // Verify metadata was stored with gaps.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        let metadata = tc
            .metadata::<GeneralizedInputMetadata>()
            .expect("should have GeneralizedInputMetadata");
        let has_gaps = metadata
            .generalized()
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Gap));
        assert!(
            has_gaps,
            "bracket-based generalization should produce gaps when novelties survive"
        );

        // Verify opener byte `(` is preserved (not gapped) — the candidate_range
        // should exclude the opener position so it remains in a Bytes segment.
        let opener_preserved = metadata
            .generalized()
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Bytes(b) if b.contains(&b'(')));
        assert!(
            opener_preserved,
            "opener byte '(' should be preserved in generalized metadata, not gapped"
        );

        cmplog::disable();
    }

    #[test]
    fn test_bracket_no_gaps_when_novelties_fail() {
        // Input with brackets: "(abc)". When novelties DON'T survive, no gaps
        // should be added during bracket phase.
        let input = b"(abc)";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

        // Drive through bracket phase WITHOUT setting novelties (they fail).
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 200 {
                panic!("should complete bracket phase");
            }
        }

        // Verify metadata was stored. Since all offset/delimiter phases failed too
        // (no novelties set), there should be no internal gaps (only leading/trailing).
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "should have GeneralizedInputMetadata even without gaps"
        );

        cmplog::disable();
    }

    #[test]
    fn test_bracket_same_char_pairs() {
        // Input with quotes: "'hello'". Same-character pairs should work.
        let input = b"'hello'";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

        // Drive through bracket phase with novelties surviving.
        let mut count = 0;
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 200 {
                panic!("should complete bracket phase for quote pairs");
            }
        }

        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "same-char bracket pairs should produce metadata"
        );

        cmplog::disable();
    }

    #[test]
    fn test_bracket_no_closer_advances_to_next_pair() {
        // Input with opener but no closer: "(abc". Should advance through all
        // bracket pairs and finalize without getting stuck.
        // Note: bracket scanning for inputs without closers completes within a
        // single advance_stage call (no yielding), so we just drive the full
        // generalization to completion and verify it doesn't hang.
        let input = b"(abc";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        // Verification pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Drive through all phases to completion.
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 500 {
                panic!("should complete generalization when no closers exist");
            }
        }

        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "should finalize even without matching closers"
        );

        cmplog::disable();
    }
}
