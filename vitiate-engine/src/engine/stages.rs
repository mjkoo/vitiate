use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, Testcase};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::inputs::BytesInput;
use libafl::mutators::Mutator;
use libafl::observers::cmp::CmpValuesMetadata;
use libafl::stages::UnicodeIdentificationMetadata;
use libafl::state::{HasCorpus, HasExecutions, HasRand, HasSolutions};
use libafl_bolts::rands::Rand;
use napi::bindgen_prelude::*;

use super::colorization;
use super::generalization::GeneralizationPhase;
use super::{Fuzzer, STAGE_MAX_ITERATIONS};
use crate::types::ExitKind;

/// Tracks the lifecycle of a multi-execution stage (I2S, Grimoire, etc.).
/// Designed for extensibility — future stages add new variants.
pub(crate) enum StageState {
    /// No stage is active.
    None,
    /// Colorization stage: identifies free byte ranges via binary search.
    Colorization {
        corpus_id: CorpusId,
        /// Coverage hash of the baseline (original) execution.
        original_hash: u64,
        /// Original corpus entry bytes.
        original_input: Vec<u8>,
        /// Type-replaced copy of the input.
        changed_input: Vec<u8>,
        /// Ranges still to test, processed largest-first via max-heap.
        /// Elements are `(size, start, end)` so the largest range is popped first.
        pending_ranges: std::collections::BinaryHeap<(usize, usize, usize)>,
        /// Confirmed free ranges (bytes that don't affect coverage).
        taint_ranges: Vec<std::ops::Range<usize>>,
        /// Number of colorization executions so far.
        executions: usize,
        /// Maximum allowed executions (2 * input_len).
        max_executions: usize,
        /// True after binary search, before dual trace execution.
        awaiting_dual_trace: bool,
        /// The range `(start, end)` being tested in the current execution.
        /// `None` for the baseline execution and the dual trace.
        testing_range: Option<(usize, usize)>,
    },
    /// REDQUEEN mutation stage: transform-aware targeted replacements.
    Redqueen {
        corpus_id: CorpusId,
        /// Pre-generated candidates from `multi_mutate()`.
        candidates: Vec<BytesInput>,
        /// Current candidate index.
        index: usize,
    },
    /// I2S mutational stage in progress.
    I2S {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
    },
    /// Generalization stage: identifies structural vs gap bytes in a corpus entry.
    Generalization {
        corpus_id: CorpusId,
        /// Novel coverage map indices to verify during gap-finding.
        novelties: Vec<usize>,
        /// Working buffer: `Some(byte)` = structural/untested, `None` = gap.
        payload: Vec<Option<u8>>,
        /// Current phase within the generalization algorithm.
        phase: GeneralizationPhase,
        /// Byte range `[start, end)` removed in the current candidate.
        candidate_range: Option<(usize, usize)>,
    },
    /// Grimoire mutational stage: structure-aware mutations using GeneralizedInputMetadata.
    Grimoire {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
    },
    /// Unicode mutational stage: category-aware character replacement mutations.
    Unicode {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
        /// Cached metadata identifying UTF-8 ranges, computed once at stage start.
        metadata: UnicodeIdentificationMetadata,
    },
}

impl Fuzzer {
    /// Implementation of `begin_stage` — dispatches to the appropriate stage.
    pub(super) fn begin_stage_impl(&mut self) -> Result<Option<Buffer>> {
        // Precondition: no stage currently active.
        if !matches!(self.stage_state, StageState::None) {
            return Ok(None);
        }

        // Read and clear last_interesting_corpus_id (consumed regardless of whether
        // the stage proceeds).
        let corpus_id = match self.last_interesting_corpus_id.take() {
            Some(id) => id,
            None => return Ok(None),
        };

        // Reset per-entry flag.
        self.redqueen_ran_for_entry = false;

        // Step 1: Attempt colorization if REDQUEEN is enabled and input fits.
        if self.features.redqueen_enabled {
            let input_len = self
                .state
                .corpus()
                .get(corpus_id)
                .ok()
                .map(|entry| {
                    let tc = entry.borrow();
                    if let Some(input) = tc.input() {
                        input.as_ref().len()
                    } else {
                        0
                    }
                })
                .unwrap_or(0);
            if input_len > 0 && input_len <= colorization::MAX_COLORIZATION_LEN {
                self.redqueen_ran_for_entry = true;
                return self.begin_colorization(corpus_id);
            }
        }

        // Step 2: Attempt I2S (only if REDQUEEN didn't run).
        if !self.redqueen_ran_for_entry {
            let has_cmp_data = self
                .state
                .metadata_map()
                .get::<CmpValuesMetadata>()
                .is_some_and(|m| !m.list.is_empty());
            if has_cmp_data {
                return self.begin_i2s(corpus_id);
            }
        }

        // Step 3: Fall through to Grimoire/unicode.
        self.begin_post_i2s_stages(corpus_id)
    }

    /// Begin the I2S stage for the given corpus entry.
    fn begin_i2s(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        // Select random iteration count 1..=STAGE_MAX_ITERATIONS.
        // SAFETY of unwrap: STAGE_MAX_ITERATIONS is a non-zero constant.
        let max_iterations = self
            .state
            .rand_mut()
            .below(core::num::NonZero::new(STAGE_MAX_ITERATIONS).unwrap())
            + 1;

        // Clone the corpus entry and apply I2S mutation.
        let mut input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        let _ = self
            .i2s_mutator
            .mutate(&mut self.state, &mut input)
            .map_err(|e| Error::from_reason(format!("I2S mutation failed: {e}")))?;

        // Enforce max_input_len truncation.
        let mut bytes: Vec<u8> = input.into();
        bytes.truncate(self.max_input_len as usize);

        // Store the mutated input for advanceStage() corpus addition.
        self.last_stage_input = Some(bytes.clone());

        // Transition to I2S stage state.
        self.stage_state = StageState::I2S {
            corpus_id,
            iteration: 0,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Attempt to begin the post-I2S stages: generalization → Grimoire → unicode.
    pub(super) fn begin_post_i2s_stages(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if self.features.grimoire_enabled {
            if let Some(buf) = self.begin_generalization(corpus_id)? {
                return Ok(Some(buf));
            }
            if let Some(buf) = self.begin_grimoire(corpus_id)? {
                return Ok(Some(buf));
            }
        }
        if let Some(buf) = self.begin_unicode(corpus_id)? {
            return Ok(Some(buf));
        }
        Ok(None)
    }

    /// Implementation of `advance_stage` — processes stage result, returns next input.
    ///
    /// `exit_kind` is only used by the Redqueen stage (to decide whether to
    /// record a solution). All other stages evaluate coverage as `Ok` — stage
    /// crashes are handled via `abort_stage`, not `advance_stage`.
    pub(super) fn advance_stage_impl(
        &mut self,
        exit_kind: ExitKind,
        exec_time_ns: f64,
    ) -> Result<Option<Buffer>> {
        match &self.stage_state {
            StageState::None => return Ok(None),
            StageState::Generalization { .. } => {
                return self.advance_generalization(exec_time_ns);
            }
            StageState::Grimoire { .. } => {
                return self.advance_grimoire(exec_time_ns);
            }
            StageState::Unicode { .. } => {
                return self.advance_unicode(exec_time_ns);
            }
            StageState::I2S { .. } => {}
            StageState::Colorization { .. } => {
                return self.advance_colorization(exec_time_ns);
            }
            StageState::Redqueen { .. } => {
                return self.advance_redqueen(exit_kind, exec_time_ns);
            }
        }

        self.advance_i2s(exec_time_ns)
    }

    /// Advance the I2S stage: evaluate coverage, generate next candidate.
    fn advance_i2s(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        let (corpus_id, iteration, max_iterations) = match self.stage_state {
            StageState::I2S {
                corpus_id,
                iteration,
                max_iterations,
            } => (corpus_id, iteration, max_iterations),
            _ => {
                return Err(Error::from_reason(
                    "advance_i2s called with non-I2S stage state",
                ));
            }
        };

        // Drain and discard CmpLog accumulator (do not update CmpValuesMetadata
        // or promote tokens — stage CmpLog data is noise from I2S-mutated inputs).
        let _ = crate::cmplog::drain();

        // Reset stage state before the fallible evaluate_coverage call. On error,
        // the stage is cleanly abandoned (no zombie state). On success, stage_state
        // is overwritten below with the next iteration or StageState::None.
        self.stage_state = StageState::None;
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advanceStage: no stashed stage input"))?;
        // The target was invoked — count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        let _eval = self.evaluate_coverage(
            &stage_input,
            exec_time_ns,
            LibaflExitKind::Ok,
            Some(corpus_id),
        )?;

        let next_iteration = iteration + 1;
        if next_iteration >= max_iterations {
            // I2S stage complete — try transitioning to Generalization, Grimoire, or Unicode.
            // stage_state is already StageState::None (reset before evaluate_coverage above).
            return self.begin_post_i2s_stages(corpus_id);
        }

        // Generate next I2S candidate: clone original corpus entry, mutate.
        let mut input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        let _ = self
            .i2s_mutator
            .mutate(&mut self.state, &mut input)
            .map_err(|e| Error::from_reason(format!("I2S mutation failed: {e}")))?;

        let mut bytes: Vec<u8> = input.into();
        bytes.truncate(self.max_input_len as usize);

        // Store for next advanceStage() call.
        self.last_stage_input = Some(bytes.clone());

        // Update iteration counter.
        self.stage_state = StageState::I2S {
            corpus_id,
            iteration: next_iteration,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Implementation of `abort_stage` — cleanly terminates the current stage.
    pub(super) fn abort_stage_impl(&mut self, exit_kind: ExitKind) -> Result<()> {
        if matches!(self.stage_state, StageState::None) {
            return Ok(());
        }

        // Drain and discard CmpLog accumulator.
        let _ = crate::cmplog::drain();

        // Take the stage input into a local before cleanup — we may need it
        // for solution recording below.
        let stage_input = self.last_stage_input.take();

        // Reset stage state before the fallible add() call. On error, the
        // stage is cleanly abandoned (no zombie state).
        self.stage_state = StageState::None;

        // Zero the coverage map (may contain partial/corrupt data from the
        // crashed execution).
        // SAFETY: map_ptr is valid for map_len bytes (backed by _coverage_map
        // Buffer). No observer is alive at this point.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        // The aborted execution counts as a target invocation.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        // Record crash/timeout as a solution. This is the only fallible
        // operation — all cleanup is already done above.
        if matches!(exit_kind, ExitKind::Crash | ExitKind::Timeout)
            && let Some(input_bytes) = stage_input
        {
            let testcase = Testcase::new(BytesInput::new(input_bytes));
            self.state
                .solutions_mut()
                .add(testcase)
                .map_err(|e| Error::from_reason(format!("Failed to add solution: {e}")))?;
            self.solution_count += 1;
        }

        Ok(())
    }
}
