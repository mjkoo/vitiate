use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::MapNoveltiesMetadata;
use libafl::inputs::GeneralizedInputMetadata;
use libafl::state::{HasCorpus, HasExecutions};
use napi::bindgen_prelude::*;

use super::{Fuzzer, MAX_GENERALIZED_LEN, StageState};

/// Offset values for the offset-based gap-finding passes.
const GENERALIZATION_OFFSETS: [usize; 5] = [255, 127, 63, 31, 0];

/// Delimiter characters for delimiter-based gap-finding passes.
const GENERALIZATION_DELIMITERS: [u8; 7] = [b'.', b';', b',', b'\n', b'\r', b'#', b' '];

/// Bracket pairs for bracket-based gap-finding passes: (open, close).
const GENERALIZATION_BRACKETS: [(u8, u8); 6] = [
    (b'(', b')'),
    (b'[', b']'),
    (b'{', b'}'),
    (b'<', b'>'),
    (b'\'', b'\''),
    (b'"', b'"'),
];

/// Phases within the generalization algorithm. Each phase corresponds to a
/// type of gap-finding pass that ablates portions of the input and checks
/// whether novel coverage indices survive.
#[derive(Debug)]
pub(super) enum GeneralizationPhase {
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

/// Mark a range of payload slots as gaps (`None`) if novelties survived.
fn mark_gaps(payload: &mut [Option<u8>], range: Option<(usize, usize)>, novelties_survived: bool) {
    if novelties_survived && let Some((start, end)) = range {
        for slot in payload.iter_mut().take(end).skip(start) {
            *slot = None;
        }
    }
}

impl Fuzzer {
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
        if !self.features.grimoire_enabled {
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
        self.last_stage_input = Some(input_bytes.clone());

        self.stage_state = StageState::Generalization {
            corpus_id,
            novelties,
            payload,
            phase: GeneralizationPhase::Verify,
            candidate_range: None,
        };

        Ok(Some(Buffer::from(input_bytes)))
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
                mark_gaps(&mut payload, candidate_range, novelties_survived);

                // Advance position.
                let offset = GENERALIZATION_OFFSETS[level as usize];
                let next_pos = candidate_range.map_or(0, |(_, e)| e);
                if next_pos >= payload.len() {
                    // Pass complete — trim and move to next level or delimiter phase.
                    trim_payload(&mut payload);
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
                let candidate = build_generalization_candidate(&payload, start, end);
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
                mark_gaps(&mut payload, candidate_range, novelties_survived);

                let next_pos = candidate_range.map_or(0, |(_, e)| e);
                if next_pos >= payload.len() {
                    // Pass complete — trim and move to next delimiter or bracket phase.
                    trim_payload(&mut payload);
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

                let candidate = build_generalization_candidate(&payload, start, end);
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
                mark_gaps(&mut payload, candidate_range, novelties_survived);

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
                let candidate = build_generalization_candidate(&payload, start, end);
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

                let candidate = build_generalization_candidate(&payload, start, end);
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
        trim_payload(&mut payload);
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
        trim_payload(&mut payload);
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
                let candidate = build_generalization_candidate(&payload, start + 1, end);
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
            trim_payload(&mut payload);
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
        trim_payload(&mut payload);
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
        let metadata = GeneralizedInputMetadata::generalized_from_options(payload);

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
